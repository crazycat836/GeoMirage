const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const os = require('os')
const fs = require('fs')
const { spawn } = require('child_process')
const { buildElevatedBackendCommand, buildElevatedBackendScript } = require('./backend-command')
const { DEV_SERVER_URL, isAppUrl, isExternalHttps } = require('./navigation')
const { pickUiLang, adminPrompt } = require('./locale')

// Single source of truth for the app version — same file Electron already
// consumes for `app.getVersion()` / auto-updater metadata.
const APP_VERSION = require('../package.json').version

// Session token written by the backend on startup. See backend/config.py
// TOKEN_FILE and backend/main.py lifespan. We read it lazily (after the
// backend is up) so the value we inject into the renderer is the fresh
// one for this run, not a stale file from a previous crash.
const TOKEN_FILE = path.join(os.homedir(), '.geomirage', 'token')

// Only an unpackaged run loads the dev server. A packaged build ignores
// `--dev`, so whatever holds port 5173 can't serve the UI (and receive
// the session token) there.
const isDev = !app.isPackaged
const INDEX_HTML = path.join(__dirname, '../dist/index.html')
// The page the main window loads; the only page allowed to stay in it.
const APP_URL = isDev ? DEV_SERVER_URL : pathToFileURL(INDEX_HTML).href

function readSessionToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

// Deliver the session token to the renderer via a one-time IPC handshake
// instead of `additionalArguments`. argv is visible to other same-user
// processes (`ps aux`, `/proc/<pid>/cmdline`) on macOS/Linux, so a
// session-scoped auth token has no business being on the command line.
//
// The handler is registered at module load — well before any
// BrowserWindow is created — so the channel is always wired up by the
// time the renderer's preload invokes it.
//
// The file is re-read on every call: the backend writes a new token each
// time it starts, which in a packaged build is after this process is
// already up. The renderer asks again after a 401, and gets the new one.
//
// Only the app's own page gets the token. If the window ever ends up on
// another page (same preload), the call is refused.
ipcMain.handle('session:get-token', (event) => {
  const url = event.senderFrame?.url ?? ''
  if (!isAppUrl(url, APP_URL)) {
    console.warn('[electron] session:get-token refused for', url)
    throw new Error('session token is only available to the app page')
  }
  return readSessionToken()
})

// Strip the default "File Edit View Window Help" menubar — GeoMirage has its
// own in-window controls and the native menu only adds noise on Windows.
Menu.setApplicationMenu(null)

let mainWindow
let backendProc = null

// Where the packaged backend is in its start-up, pushed to the renderer so
// the not-yet-connected banner can say what it is waiting on:
//   'awaiting_auth' — macOS administrator-password dialog is up
//   'starting'      — a backend process has been launched
//   'exited'        — the unprivileged backend process quit
// Stays null in dev, where the backend is started by hand.
let backendPhase = null

function setBackendPhase(phase) {
  backendPhase = phase
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend:phase', phase)
  }
}

ipcMain.handle('backend:get-phase', () => backendPhase)

function resolveBackendExe() {
  // In a packaged build, extraResources places files under
  // process.resourcesPath (e.g. .../resources/backend/<binary>). PyInstaller
  // names the binary `.exe` on Windows and leaves it unsuffixed on macOS,
  // so we branch on process.platform. In dev we don't spawn; the developer
  // runs `python start.py` (or similar) manually.
  if (!app.isPackaged) return null
  const binName = process.platform === 'win32'
    ? 'geomirage-backend.exe'
    : 'geomirage-backend'
  return path.join(process.resourcesPath, 'backend', binName)
}

// macOS: the iOS 17+ device tunnel needs root, and an .app has no
// equivalent of the Windows `requireAdministrator` manifest. Ask for an
// administrator password through the system dialog and start the backend
// with those rights. The command is backgrounded so osascript returns as
// soon as the backend is launched; its exit code tells us whether the user
// authorised it.
//
// A root process can't be signalled from here, so the backend is handed our
// pid (GEOMIRAGE_PARENT_PID) and exits by itself once this process is gone.
// SUDO_UID / SUDO_GID / HOME make it write its files under the user's home
// and hand their ownership back, same as a `sudo python3 start.py` run.
let elevatedBackendStarted = false

// UI language from the OS preferred-language list (any Chinese entry → zh).
// Shared by the renderer (additionalArguments) and the password prompt.
// Called after `ready`, when the language list is available.
function systemUiLang() {
  const list = typeof app.getPreferredSystemLanguages === 'function'
    ? app.getPreferredSystemLanguages()
    : [app.getLocale()]
  return pickUiLang(list)
}

function startBackendElevated(exe) {
  const { uid, gid } = os.userInfo()
  const command = buildElevatedBackendCommand({
    exe,
    homeDir: os.homedir(),
    uid,
    gid,
    parentPid: process.pid,
    version: APP_VERSION,
  })
  const script = buildElevatedBackendScript(command, adminPrompt(systemUiLang()))
  console.log('[electron] starting backend with administrator rights:', exe)
  elevatedBackendStarted = true
  setBackendPhase('awaiting_auth')
  const osa = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
  osa.stderr.on('data', (d) => process.stderr.write(`[osascript] ${d}`))
  osa.on('exit', (code) => {
    if (code === 0) {
      setBackendPhase('starting')
      return
    }
    // Declined or failed: run unprivileged so the UI and iOS 16 and older
    // devices still work.
    console.warn('[electron] administrator start declined (code %s) — starting unprivileged', code)
    elevatedBackendStarted = false
    spawnBackend(exe)
  })
}

function startBackend() {
  const exe = resolveBackendExe()
  if (!exe) return
  if (process.platform === 'darwin') {
    // Still running from an earlier window of this same app session.
    if (elevatedBackendStarted || backendProc) return
    startBackendElevated(exe)
    return
  }
  spawnBackend(exe)
}

function spawnBackend(exe) {
  console.log('[electron] spawning backend:', exe)
  const spawnOpts = {
    cwd: path.dirname(exe),
    // The frozen backend has no package.json to read its version from.
    env: { ...process.env, GEOMIRAGE_VERSION: APP_VERSION },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  if (process.platform === 'win32') {
    spawnOpts.windowsHide = true
  }
  backendProc = spawn(exe, [], spawnOpts)
  setBackendPhase('starting')
  backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backendProc.on('exit', (code) => {
    console.log('[electron] backend exited with code', code)
    backendProc = null
    setBackendPhase('exited')
  })
}

function stopBackend() {
  if (!backendProc) return
  try { backendProc.kill() } catch {}
  backendProc = null
}

async function createWindow() {
  // OSM tile policy (https://operations.osmfoundation.org/policies/tiles/)
  // requires an identifying User-Agent; Electron's default Chrome UA is
  // blocked with HTTP 418. Rewrite the UA on requests to the OSM tile
  // endpoints so we can use the 'Standard' (Mapnik) style for free.
  try {
    const { session } = require('electron')
    const OSM_HOSTS = [
      'tile.openstreetmap.org',
      'a.tile.openstreetmap.org',
      'b.tile.openstreetmap.org',
      'c.tile.openstreetmap.org',
      'tile.openstreetmap.fr',
      'a.tile.openstreetmap.fr',
      'b.tile.openstreetmap.fr',
      'c.tile.openstreetmap.fr',
    ]
    session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
      try {
        const u = new URL(details.url)
        if (OSM_HOSTS.includes(u.hostname)) {
          details.requestHeaders['User-Agent'] =
            `GeoMirage/${APP_VERSION} (+https://github.com/crazycat836/GeoMirage)`
          details.requestHeaders['Referer'] = 'https://github.com/crazycat836/GeoMirage'
        }
      } catch {}
      cb({ requestHeaders: details.requestHeaders })
    })
  } catch (e) { console.error('[electron] UA hook failed:', e) }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'GeoMirage',
    // Match the app's dark theme so the initial frame isn't white while
    // the renderer attaches — previously caused a jarring white flash.
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      // Chromium's OS-level sandbox: required for a defence-in-depth
      // posture even with contextIsolation on. Forces the preload to
      // run in the isolated world without `node:*` access.
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      // `webSecurity` defaults to `true` in Electron, but spell it out
      // here so a future reviewer doesn't have to consult the docs to
      // confirm same-origin / mixed-content protections are on. CSP
      // (declared in index.html) is the layered defence on top.
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
      // Only the version and UI language are forwarded via argv — both
      // non-sensitive — so preload can expose them synchronously without
      // an IPC round trip. The session token is delivered via the
      // `session:get-token` IPC handshake instead (see ipcMain.handle
      // above) to keep it out of `process.argv`.
      additionalArguments: [
        `--gps-version=${APP_VERSION}`,
        `--gps-lang=${systemUiLang()}`,
      ],
    },
  })
  // Show the window once the first frame is painted. Combined with
  // backgroundColor above, this eliminates the blank/white boot state.
  mainWindow.once('ready-to-show', () => { mainWindow.show() })

  // Open target="_blank" / external links in the user's default browser.
  // Only `https:` URLs are forwarded to the OS; `http:`, `file:`,
  // `javascript:`, and any custom scheme are blocked. Parsing failure is
  // also treated as deny so a malformed URL can't slip through.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttps(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Keep the main window on the app page. A plain link (the map's
  // attribution) or a file / link dropped on the window would otherwise
  // replace the UI, and there is no menu to get back. `https:` links open
  // in the default browser instead; everything else is just dropped.
  mainWindow.webContents.on('will-navigate', (event, legacyUrl) => {
    const url = event.url ?? legacyUrl
    if (isAppUrl(url, APP_URL)) return
    event.preventDefault()
    if (isExternalHttps(url)) shell.openExternal(url)
  })
  mainWindow.webContents.on('will-redirect', (event, legacyUrl) => {
    const url = event.url ?? legacyUrl
    if (!isAppUrl(url, APP_URL)) event.preventDefault()
  })

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL)
  } else {
    // Spawn the backend in parallel and load the UI immediately. The
    // renderer already has fetch-with-retry so it rides out the backend
    // startup race — no need to block loadFile on a readiness probe and
    // stare at a blank window for seconds.
    startBackend()
    mainWindow.loadFile(INDEX_HTML)
  }
}

// Electron keeps localStorage under a per-product folder in appData, so the
// rename to GeoMirage would otherwise start from empty settings. Copy the
// folder from the previous product name once, before anything opens it.
function adoptLegacyUserData() {
  try {
    const current = app.getPath('userData')
    const legacy = path.join(app.getPath('appData'), 'GPSController')
    if (legacy === current || fs.existsSync(current) || !fs.existsSync(legacy)) return
    fs.cpSync(legacy, current, { recursive: true })
  } catch (err) {
    console.warn('[electron] legacy userData copy failed:', err)
  }
}
adoptLegacyUserData()

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  // macOS keeps the app (and its backend) running with no windows open;
  // reopening from the Dock must not ask for the password again.
  if (process.platform === 'darwin') return
  stopBackend()
  app.quit()
})
app.on('before-quit', stopBackend)
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
