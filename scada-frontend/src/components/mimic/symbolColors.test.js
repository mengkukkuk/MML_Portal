import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CATEGORY_COLORS, DEFAULT_FILL_OPACITY, PALETTE_HEXES, categoryColor, cleanHex, cleanOpacity,
  resolveSymbolColor, resolveSymbolPaint, symbolColorStyle,
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
  assert.equal('--sym-stroke' in style, false, 'outlines stay ink; colour never recolours a line')
  assert.match(style['--sym-fill'], /color-mix\(in srgb, #007aff 12%, var\(--bg-panel\)\)/)
  assert.equal('--accent' in style, false)
})

test('fill opacity comes from the same layer as the colour', () => {
  const theme = { byCategory: true, opacities: { process: 60 } }
  assert.deepEqual(resolveSymbolPaint({ options: {} }, pump, theme), { color: CATEGORY_COLORS.process, opacity: 60 })
  // Own colour: its own opacity, never the category slider's.
  assert.deepEqual(resolveSymbolPaint({ options: { color: '#ff3b30' } }, pump, theme),
    { color: '#ff3b30', opacity: DEFAULT_FILL_OPACITY })
  assert.deepEqual(resolveSymbolPaint({ options: { color: '#ff3b30', colorOpacity: 90 } }, pump, theme),
    { color: '#ff3b30', opacity: 90 })
  assert.equal(resolveSymbolPaint({ options: {} }, pump, { byCategory: false }), null)
})

test('opacity sets the body wash; raised parts take double, capped at solid', () => {
  assert.match(symbolColorStyle('#007aff', 40)['--sym-fill'], /#007aff 40%/)
  assert.match(symbolColorStyle('#007aff', 40)['--sym-fill-elev'], /#007aff 80%/)
  assert.match(symbolColorStyle('#007aff', 75)['--sym-fill-elev'], /#007aff 100%/)
  assert.equal(symbolColorStyle('#007aff', 0)['--sym-accent'], '#007aff', 'accents keep the colour at 0% fill')
})

test('a stored opacity is clamped to a whole 0..100, junk falls back to default', () => {
  assert.equal(cleanOpacity(150), 100)
  assert.equal(cleanOpacity(-5), 0)
  assert.equal(cleanOpacity(33.6), 34)
  for (const bad of ['50', null, NaN, undefined]) assert.equal(cleanOpacity(bad), null, String(bad))
  assert.match(symbolColorStyle('#007aff', '50%;x')['--sym-fill'], new RegExp(`${DEFAULT_FILL_OPACITY}%`))
})
