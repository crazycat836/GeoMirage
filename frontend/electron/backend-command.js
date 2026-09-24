// Pure builders for the macOS elevated-backend launch. Kept free of any
// `electron` import so the quoting can be unit-tested under plain Node
// (see backend-command.test.mjs).

const path = require('path')

// POSIX single-quote a value for /bin/sh.
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// Quote a value as an AppleScript string literal.
function appleScriptQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Shell command that starts the backend from its own directory with the
// user's HOME / uid / gid, our pid and the app version in its environment.
// The redirect covers the whole group: `do shell script` waits for every
// holder of its output pipe, including the subshell that runs the group.
function buildElevatedBackendCommand({ exe, homeDir, uid, gid, parentPid, version }) {
  return [
    '(cd', shQuote(path.dirname(exe)), '&&',
    `HOME=${shQuote(homeDir)}`,
    `SUDO_UID=${uid}`,
    `SUDO_GID=${gid}`,
    `GEOMIRAGE_PARENT_PID=${parentPid}`,
    `GEOMIRAGE_VERSION=${shQuote(version)}`,
    `${shQuote(exe)})`,
    '> /dev/null 2>&1 &',
  ].join(' ')
}

// AppleScript that runs `command` as root after the system password prompt.
function buildElevatedBackendScript(command, prompt) {
  return (
    `do shell script ${appleScriptQuote(command)} ` +
    `with prompt ${appleScriptQuote(prompt)} ` +
    'with administrator privileges'
  )
}

module.exports = {
  shQuote,
  appleScriptQuote,
  buildElevatedBackendCommand,
  buildElevatedBackendScript,
}
