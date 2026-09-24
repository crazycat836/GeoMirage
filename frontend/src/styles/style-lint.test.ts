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
})
