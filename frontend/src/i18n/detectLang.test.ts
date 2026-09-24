import { describe, it, expect, vi, afterEach } from 'vitest'
import { detectSystemLang, pickLangFromList } from './detectLang'

afterEach(() => { vi.unstubAllGlobals() })

describe('pickLangFromList', () => {
  it('picks zh when Chinese is anywhere in the list', () => {
    expect(pickLangFromList(['en-TW', 'zh-Hant-TW'])).toBe('zh')
    expect(pickLangFromList(['zh-TW'])).toBe('zh')
  })
  it('picks en otherwise', () => {
    expect(pickLangFromList(['en-US', 'ja-JP'])).toBe('en')
    expect(pickLangFromList([])).toBe('en')
  })
})

describe('detectSystemLang', () => {
  it('uses the language Electron main passed through the preload bridge', () => {
    vi.stubGlobal('geoMirage', { systemLang: 'zh' })
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    expect(detectSystemLang()).toBe('zh')
  })
  it('reads the whole navigator.languages list, not only the first entry', () => {
    vi.stubGlobal('navigator', { language: 'en-TW', languages: ['en-TW', 'zh-Hant-TW'] })
    expect(detectSystemLang()).toBe('zh')
  })
  it('falls back to navigator.language when languages is empty', () => {
    vi.stubGlobal('navigator', { language: 'en-US', languages: [] })
    expect(detectSystemLang()).toBe('en')
  })
})
