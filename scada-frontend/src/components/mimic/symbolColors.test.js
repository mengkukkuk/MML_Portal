import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CATEGORY_COLORS, PALETTE_HEXES, categoryColor, cleanHex, resolveSymbolColor, symbolColorStyle,
} from './symbolColors.js'

const pump = { category: 'process' }

test('a symbol with no colour and no category theme draws as it always did', () => {
  assert.equal(resolveSymbolColor({ options: {} }, pump, undefined), null)
  assert.equal(resolveSymbolColor({ options: {} }, pump, { byCategory: false }), null)
  assert.equal(symbolColorStyle(null), undefined)
})

test('the symbol\'s own colour wins over its category', () => {
  const theme = { byCategory: true, categories: { process: '#34c759' } }
  assert.equal(resolveSymbolColor({ options: { color: '#FF3B30' } }, pump, theme), '#ff3b30')
  assert.equal(resolveSymbolColor({ options: {} }, pump, theme), '#34c759')
})

test('category colouring falls back to the built-in defaults', () => {
  const theme = { byCategory: true }
  assert.equal(resolveSymbolColor({}, pump, theme), CATEGORY_COLORS.process)
  assert.equal(categoryColor(theme, 'nonexistent'), null)
  assert.equal(resolveSymbolColor({}, undefined, theme), null)
})

test('every default category colour is one the palette can show', () => {
  for (const hex of Object.values(CATEGORY_COLORS)) assert.ok(PALETTE_HEXES.has(hex), hex)
})

test('a colour from a saved document never reaches CSS unless it is #rrggbb', () => {
  for (const bad of ['red', '#fff', 'url(x)', '#ff0000; background:url(x)', 42, null]) {
    assert.equal(cleanHex(bad), null, String(bad))
  }
  assert.equal(resolveSymbolColor({ options: { color: 'red;x' } }, pump, { byCategory: true }),
    CATEGORY_COLORS.process, 'a bad own colour falls through to the category')
})

test('the style sets the symbol variables, never the app accent', () => {
  const style = symbolColorStyle('#007aff')
  assert.equal(style['--sym-accent'], '#007aff')
  assert.equal(style['--sym-stroke'], '#007aff')
  assert.match(style['--sym-fill'], /color-mix\(in srgb, #007aff 12%, var\(--bg-panel\)\)/)
  assert.equal('--accent' in style, false)
})
