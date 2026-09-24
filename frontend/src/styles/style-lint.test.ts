// Static checks over component sources for styling mistakes that tsc and
// vite build accept silently. Runs as part of `npm test` (and so in CI).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url))

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'generated') continue
      out.push(...walk(p, exts))
    } else if (exts.some((e) => name.endsWith(e)) && !/\.test\.tsx?$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

interface Hit { file: string; line: number; text: string }

function scan(files: string[], re: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      re.lastIndex = 0
      if (re.test(text)) hits.push({ file: relative(SRC, file), line: i + 1, text: text.trim() })
    })
  }
  return hits
}

const TSX = walk(SRC, ['.tsx', '.ts'])

describe('style lint', () => {
  it('Tailwind arbitrary values contain no whitespace (Tailwind splits classes on spaces, so the rule is silently dropped)', () => {
    // A utility prefix followed by `[`, then a space before the closing `]`
    // on the same class-like token, e.g. `hover:border-[rgba(1, 2, 3,0.5)]`.
    const re = /[a-z0-9]-\[[^\]\s"'`]*\s[^\]"'`]*\]/
    expect(scan(TSX, re)).toEqual([])
  })

  it('no leftovers of the old blue accent (use --color-accent-* tokens or ACCENT_HEX)', () => {
    const re = /108,\s*140|#6c8cff|#a8bdff|#8aa3ff|#6b8afd|#4a6cf7|74,\s*108,\s*247/i
    const css = walk(SRC, ['.css'])
    expect(scan([...TSX, ...css], re)).toEqual([])
  })

  it('every var(--x) used in src is defined somewhere (an undefined var with no fallback silently drops the declaration)', () => {
    const css = walk(SRC, ['.css'])
    const defined = new Set<string>()
    const used = new Map<string, string>()
    for (const file of [...TSX, ...css]) {
      const src = readFileSync(file, 'utf8')
      // CSS declarations: `--name: value`
      for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
      // Inline-style custom properties set from TSX: `['--name' as string]: …`
      for (const m of src.matchAll(/['"](--[\w-]+)['"]/g)) defined.add(m[1])
      for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!used.has(m[1])) used.set(m[1], relative(SRC, file))
      }
    }
    const undefinedVars = [...used]
      .filter(([name]) => !defined.has(name) && !name.startsWith('--tw-'))
      .map(([name, file]) => `${name} (${file})`)
    expect(undefinedVars).toEqual([])
  })
})
