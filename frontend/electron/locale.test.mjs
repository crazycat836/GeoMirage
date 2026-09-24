// @vitest-environment node
import { describe, it, expect } from 'vitest'
import locale from './locale.js'

const { pickUiLang, adminPrompt } = locale

describe('pickUiLang', () => {
  it.each([
    [['zh-Hant-TW', 'en-US'], 'zh'],
    [['en-TW', 'zh-Hant-TW'], 'zh'],
    [['en-US', 'ja-JP', 'zh-CN'], 'zh'],
    [['ZH-TW'], 'zh'],
    [['en-US', 'ja-JP'], 'en'],
    [[], 'en'],
    [undefined, 'en'],
  ])('%j → %s', (languages, expected) => {
    expect(pickUiLang(languages)).toBe(expected)
  })
})

describe('adminPrompt', () => {
  it('matches the UI language', () => {
    expect(adminPrompt('zh')).toMatch(/管理員權限/)
    expect(adminPrompt('en')).toMatch(/administrator rights/)
  })
  it('falls back to English', () => {
    expect(adminPrompt('fr')).toBe(adminPrompt('en'))
  })
})
