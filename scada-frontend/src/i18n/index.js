import { create } from 'zustand'
import { translate, isLanguage } from './translate.js'

const STORAGE_KEY = 'mml.language'

export function readLanguage() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY)
    return isLanguage(saved) ? saved : 'en'
  } catch {
    return 'en'
  }
}

function reflectLanguage(language) {
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

const initialLanguage = readLanguage()
reflectLanguage(initialLanguage)

export const useLanguageStore = create((set) => ({
  language: initialLanguage,
  setLanguage(language) {
    if (!isLanguage(language)) return
    reflectLanguage(language)
    set({ language })
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, language)
    } catch {
      // The interface still switches when browser storage is unavailable.
    }
  },
}))

// Stable per-language functions keep effect dependencies and memoized props stable.
const translators = {
  en: (text, params) => translate('en', text, params),
  th: (text, params) => translate('th', text, params),
}

export function useTranslation() {
  const language = useLanguageStore((state) => state.language)
  return translators[language]
}
