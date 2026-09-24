// URL policy for the main window, kept free of any `electron` import so it
// can be unit-tested under plain Node (see navigation.test.mjs).

// Vite dev server the unpackaged app loads its UI from.
const DEV_SERVER_URL = 'http://localhost:5173'

// True when `url` is the app's own page. `appUrl` is what the main window
// loads: the bundled `file://…/dist/index.html` (only that exact file, any
// query or hash) or the dev server (its whole origin).
function isAppUrl(url, appUrl) {
  let target
  let app
  try {
    target = new URL(url)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') {
    return target.protocol === 'file:' && target.host === app.host &&
      filePathKey(target.pathname) === filePathKey(app.pathname)
  }
  return target.origin === app.origin
}

// Compare file paths by their decoded form: Node and Chromium don't escape
// exactly the same characters. Windows drive paths compare case-insensitively.
function filePathKey(pathname) {
  let p
  try {
    p = decodeURIComponent(pathname)
  } catch {
    p = pathname
  }
  return /^\/[A-Za-z]:\//.test(p) ? p.toLowerCase() : p
}

// Only `https:` links are handed to the OS browser; `http:`, `file:`,
// `javascript:`, custom schemes and unparseable URLs are not.
function isExternalHttps(url) {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

module.exports = { DEV_SERVER_URL, isAppUrl, isExternalHttps }
