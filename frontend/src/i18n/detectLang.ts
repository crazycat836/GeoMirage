import type { Lang } from './strings'

// System-language half of the UI language decision (the saved preference
// is checked by the callers first). React-free so services/http.ts can
// share it with the I18nProvider.

/** Chinese when any preferred language is Chinese, English otherwise —
 *  same rule as Electron main's `pickUiLang` (electron/locale.js). */
export function pickLangFromList(languages: readonly string[]): Lang {
  return languages.some((l) => l.toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

/**
 * The OS-derived UI language. In the packaged app Electron main decides it
 * from `app.getPreferredSystemLanguages()` and passes it through the preload
 * bridge (`geoMirage.systemLang`), so the UI matches the administrator-
 * password prompt. Elsewhere, the browser's full `navigator.languages`
 * list is used, not only its first entry.
 */
export function detectSystemLang(): Lang {
  const bridged = (globalThis as unknown as { geoMirage?: { systemLang?: unknown } }).geoMirage?.systemLang
  if (bridged === 'zh' || bridged === 'en') return bridged
  if (typeof navigator === 'undefined') return 'zh'
  const list = navigator.languages?.length ? navigator.languages : [navigator.language ?? '']
  return pickLangFromList(list)
}
