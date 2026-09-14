import test from 'node:test'
import assert from 'node:assert/strict'
import { messages } from './messages.js'
import { translate } from './translate.js'

test('every mapped label switches EN → TH → EN without losing the source', () => {
  for (const [english, thai] of Object.entries(messages)) {
    assert.ok(thai.trim(), `Missing Thai text: ${english}`)
    assert.equal(translate('en', english), english)
    assert.equal(translate('th', english), thai)
    assert.equal(translate('en', english), english)
    assert.deepEqual(english.match(/\{\w+\}/g), thai.match(/\{\w+\}/g))
  }
})

test('unmapped server messages and brand names fall back unchanged', () => {
  for (const text of ['Engineering Off-Site', 'Plant A', 'Unexpected server detail', 'toString']) {
    assert.equal(translate('th', text), text)
  }
  assert.equal(translate('fr', 'Settings'), 'Settings')
})

test('interpolation preserves values and does not interpret HTML or replacement patterns', () => {
  assert.equal(translate('th', 'Connection {status}', { status: 'ออฟไลน์' }), 'การเชื่อมต่อ: ออฟไลน์')
  assert.equal(translate('en', 'Connection {status}', { status: '<b>$&</b>' }), 'Connection <b>$&</b>')
  assert.equal(translate('th', 'Connection {status}'), 'การเชื่อมต่อ: {status}')
})

test('language preference validates, persists, restores, and works without storage', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const saved = new Map([['mml.language', 'th']])
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } })
  try {
    const { useLanguageStore, readLanguage } = await import('./index.js')
    assert.equal(useLanguageStore.getState().language, 'th')
    assert.equal(document.documentElement.lang, 'th')
    useLanguageStore.getState().setLanguage('en')
    assert.equal(readLanguage(), 'en')
    assert.equal(document.documentElement.lang, 'en')
    useLanguageStore.getState().setLanguage('invalid')
    assert.equal(useLanguageStore.getState().language, 'en')
    saved.set('mml.language', 'invalid')
    assert.equal(readLanguage(), 'en')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked') } })
    assert.equal(readLanguage(), 'en')
    useLanguageStore.getState().setLanguage('th')
    assert.equal(useLanguageStore.getState().language, 'th')
    assert.equal(document.documentElement.lang, 'th')
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete globalThis.localStorage
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete globalThis.document
  }
})
