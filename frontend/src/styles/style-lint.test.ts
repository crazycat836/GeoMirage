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

  it('type stays inside the design scale: weight <= 600, no whole-pixel font size below --text-2xs (10px)', () => {
    const css = walk(SRC, ['.css'])
    const re = /font-weight:\s*[7-9]00|fontWeight:\s*['"]?[7-9]00|\bfont-(bold|extrabold|black)\b|font-size:\s*[0-9](\.\d+)?px|fontSize:\s*[0-9](\.\d+)?\b|text-\[[0-9]px\]/
    expect(scan([...TSX, ...css], re)).toEqual([])
  })

  it('components/**/*.tsx add no new hard-coded colours (DESIGN.md §10: use tokens)', () => {
    // Known leftovers, as lines per file that contain a hex or rgb()/rgba()
    // literal. A file may not exceed its count, and a count must be lowered
    // when a leftover is moved onto a token, so the list only shrinks.
    // Leaflet SVG attributes and var() fallbacks are legitimate reasons to
    // keep a literal; everything else here is debt.
    const BASELINE: Record<string, number> = {
      'components/ErrorBoundary.tsx': 3,
      'components/JoystickPad.tsx': 8,
      'components/WaypointChain.tsx': 2,
      'components/device/DeviceAddView.tsx': 1,
      'components/device/DeviceListView.tsx': 1,
      'components/device/deviceRowParts.tsx': 2,
      'components/library/BookmarkRow.tsx': 4,
      'components/library/BookmarksFooter.tsx': 1,
      'components/shell/BottomDock.tsx': 5,
      'components/shell/BottomModeBar.tsx': 2,
      'components/shell/DdiMountingOverlay.tsx': 3,
      'components/shell/DeviceLostBanner.tsx': 1,
      'components/shell/Drawer.tsx': 5,
      'components/shell/MiniStatusBar.tsx': 2,
      'components/shell/SettingsMenu.tsx': 1,
      'components/shell/dock/ActionGroup.tsx': 2,
      'components/shell/dock/DockRouteCard.tsx': 1,
      'components/shell/dock/ModeStatsCard.tsx': 4,
      'components/shell/dock/SpeedToggle.tsx': 2,
      'components/shell/dock/WaypointList.tsx': 2,
    }
    const re = /#[0-9a-fA-F]{3,8}\b|rgba?\(/
    const components = walk(join(SRC, 'components'), ['.tsx'])
    const actual: Record<string, number> = {}
    for (const hit of scan(components, re)) actual[hit.file] = (actual[hit.file] ?? 0) + 1
    expect(actual).toEqual(BASELINE)
  })
})
