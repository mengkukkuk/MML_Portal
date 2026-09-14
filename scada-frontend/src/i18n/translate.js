import { messages } from './messages.js'

export const LANGUAGES = Object.freeze([
  { id: 'en', label: 'English' },
  { id: 'th', label: 'ไทย' },
])

export function isLanguage(value) {
  return LANGUAGES.some(({ id }) => id === value)
}

/** English is also the stable key and fallback. Never translate user-entered values. */
export function translate(language, text, params = {}) {
  if (typeof text !== 'string') return text
  const message = language === 'th' && Object.hasOwn(messages, text) ? messages[text] : text
  return message.replace(/\{(\w+)\}/g, (token, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : token,
  )
}
