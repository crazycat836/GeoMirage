// @vitest-environment node
/**
 * The elevated-backend launch quotes every path twice: once for /bin/sh
 * and once as an AppleScript string. These tests decode both layers and
 * check the values survive unchanged when paths contain ', ", \ and
 * spaces.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cmd from './backend-command.js'

const { shQuote, appleScriptQuote, buildElevatedBackendCommand, buildElevatedBackendScript } = cmd

const NASTY = [
  "plain",
  "with space",
  "it's",
  'say "hi"',
  'back\\slash',
  "mix 'a' \"b\" \\c\\ $HOME `id` ;&|",
  '',
]

// Decode an AppleScript string literal (the subset appleScriptQuote emits).
function decodeAppleScriptLiteral(literal) {
  expect(literal.startsWith('"') && literal.endsWith('"')).toBe(true)
  const body = literal.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\') {
      out += body[++i]
    } else {
      // An unescaped quote would end the literal early.
      expect(c).not.toBe('"')
      out += c
    }
  }
  return out
}

// Pull the command literal back out of the generated `do shell script`.
function extractCommand(script) {
  const m = /^do shell script ("(?:[^"\\]|\\.)*") with prompt ("(?:[^"\\]|\\.)*") with administrator privileges$/.exec(script)
  expect(m).not.toBeNull()
  return { command: decodeAppleScriptLiteral(m[1]), prompt: decodeAppleScriptLiteral(m[2]) }
}

describe('shQuote', () => {
  it.each(NASTY)('round-trips %j through /bin/sh', (value) => {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shQuote(value)}`], { encoding: 'utf8' })
    expect(out).toBe(value)
  })
})

describe('appleScriptQuote', () => {
  it.each(NASTY)('round-trips %j as an AppleScript literal', (value) => {
    expect(decodeAppleScriptLiteral(appleScriptQuote(value))).toBe(value)
  })

  it.runIf(process.platform === 'darwin')('osascript decodes it back to the same value', () => {
    for (const value of NASTY) {
      const out = execFileSync('/usr/bin/osascript', ['-e', `return ${appleScriptQuote(value)}`], { encoding: 'utf8' })
      expect(out.replace(/\n$/, '')).toBe(value)
    }
  })
})

describe('elevated backend command', () => {
  const tmpDirs = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('starts the exe from its directory with the right environment after both decoding layers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geomirage-cmd-'))
    tmpDirs.push(root)
    const appDir = path.join(root, `Geo "Mirage" it's \\ app`)
    const homeDir = path.join(root, `home 'o' "x" \\y`)
    fs.mkdirSync(appDir)
    fs.mkdirSync(homeDir)
    const outFile = path.join(root, 'out.txt')
    const exe = path.join(appDir, "geomirage backend's")
    fs.writeFileSync(exe, [
      '#!/bin/sh',
      `{ pwd; printf '%s\\n' "$HOME" "$SUDO_UID" "$SUDO_GID" "$GEOMIRAGE_PARENT_PID" "$GEOMIRAGE_VERSION" "$0"; } > ${shQuote(outFile)}.tmp`,
      `mv ${shQuote(outFile)}.tmp ${shQuote(outFile)}`,
      '',
    ].join('\n'))
    fs.chmodSync(exe, 0o755)

    const version = `1.2.3 "beta" it's`
    const command = buildElevatedBackendCommand({ exe, homeDir, uid: 501, gid: 20, parentPid: 4242, version })
    const prompt = 'GeoMirage needs "admin" rights'
    const script = buildElevatedBackendScript(command, prompt)

    const decoded = extractCommand(script)
    expect(decoded.command).toBe(command)
    expect(decoded.prompt).toBe(prompt)

    // `do shell script` hands the decoded command to /bin/sh.
    execFileSync('/bin/sh', ['-c', decoded.command])
    const deadline = Date.now() + 5000
    while (!fs.existsSync(outFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const [cwd, home, uid, gid, ppid, ver, argv0] = fs.readFileSync(outFile, 'utf8').split('\n')
    expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(appDir))
    expect(home).toBe(homeDir)
    expect(uid).toBe('501')
    expect(gid).toBe('20')
    expect(ppid).toBe('4242')
    expect(ver).toBe(version)
    expect(argv0).toBe(exe)
  })
})
