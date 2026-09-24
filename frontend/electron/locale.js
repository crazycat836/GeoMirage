// UI language for the packaged app, picked from the OS preferred-language
// list: Chinese when any entry is Chinese (e.g. `en-TW` first and
// `zh-Hant-TW` second still counts), English otherwise. The renderer gets
// it via `additionalArguments` and the administrator-password prompt uses
// the same answer, so the two always agree.
function pickUiLang(languages) {
  const list = Array.isArray(languages) ? languages : []
  return list.some((l) => typeof l === 'string' && l.toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

const ADMIN_PROMPT = {
  zh: 'GeoMirage 需要管理員權限才能連線 iOS 17 以上的裝置。',
  en: 'GeoMirage needs administrator rights to connect to devices on iOS 17 and later.',
}

function adminPrompt(lang) {
  return ADMIN_PROMPT[lang] ?? ADMIN_PROMPT.en
}

module.exports = { pickUiLang, adminPrompt }
