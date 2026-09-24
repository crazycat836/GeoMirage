import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { STRINGS, StringKey, Lang } from './strings';

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

import { STORAGE_KEYS } from '../lib/storage-keys';
import { readLS, writeLS } from '../lib/local-storage';

const STORAGE_KEY = STORAGE_KEYS.lang;

/** Stored language, else the browser locale. Also used outside the
 *  provider (ErrorBoundary renders when the React tree is gone). */
export function detectInitialLang(): Lang {
  const saved = readLS(STORAGE_KEY) as Lang | null;
  if (saved === 'zh' || saved === 'en') return saved;
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'zh';
  return nav && nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

/** Hook-free lookup for code that cannot call `useT` (class components,
 *  tests). Same fallback chain as the provider's `t`. */
export function translate(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  const raw = entry[lang] ?? entry.zh ?? key;
  return interpolate(raw, vars);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writeLS(STORAGE_KEY, l);
  }, []);

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  }, [lang]);

  return React.createElement(I18nContext.Provider, { value: { lang, setLang, t } }, children);
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

export function useT() {
  return useI18n().t;
}

export type { Lang, StringKey };
