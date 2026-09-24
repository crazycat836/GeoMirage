// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import TagChip, { tagChipColors, TAG_CHIP_SELECTED_TINT } from './TagChip'
import { getTagColor } from '../../lib/bookmarks'

afterEach(cleanup)

// ── Contrast helpers (WCAG 2.x relative luminance) ────────────────────
type RGB = [number, number, number]

function parseColor(c: string): RGB {
  const hex = c.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const hsl = c.match(/^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/)
  if (hsl) {
    const h = Number(hsl[1]) / 360
    const s = Number(hsl[2]) / 100
    const l = Number(hsl[3]) / 100
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const hue = (t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((x) => x * 255) as RGB
  }
  throw new Error(`unparsed color ${c}`)
}

function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function over(fg: RGB, bg: RGB, alpha: number): RGB {
  return fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as RGB
}

// Values from styles/tokens.css
const TEXT_1 = parseColor('#e8eaf0')
const ACCENT = '#a78bfa'
const SURFACES = ['#0a0a0c', '#131416', '#1a1b20', '#222328'].map(parseColor)

describe('tagChipColors', () => {
  it('takes the selected fill from getTagColor, so an uncoloured tag matches every other surface', () => {
    const tag = { name: '花' }
    const selected = tagChipColors(tag, true)
    expect(selected.background).toContain(getTagColor(tag))
    expect(selected.borderColor).toBe(getTagColor(tag))
  })

  it('keeps text at >= 4.5:1 for every colour getTagColor can produce, plus the accent', () => {
    const names = Array.from({ length: 720 }, (_, i) => `tag-${i}`)
    const colors = [
      ...names.map((name) => getTagColor({ name })),
      ...['掃描器', '菇', '花'].map((name) => getTagColor({ name })),
      ACCENT,
    ]
    let worst = Infinity
    for (const c of colors) {
      for (const surface of SURFACES) {
        const fill = over(parseColor(c), surface, TAG_CHIP_SELECTED_TINT / 100)
        worst = Math.min(worst, contrast(TEXT_1, fill))
      }
    }
    expect(tagChipColors({ name: 'x' }, true).color).toBe('var(--color-text-1)')
    expect(worst).toBeGreaterThanOrEqual(4.5)
  })

  it('unselected chips stay neutral', () => {
    const c = tagChipColors({ name: '花' }, false)
    expect(c.background).toBe('transparent')
    expect(c.color).toBe('var(--color-text-2)')
  })
})

describe('<TagChip>', () => {
  it('renders aria-pressed and toggles on click', () => {
    const onToggle = vi.fn()
    render(<TagChip tag={{ name: '菇' }} selected onToggle={onToggle} />)
    const btn = screen.getByRole('button', { name: '菇' })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
