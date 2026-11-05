import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SKIN_MAX_BYTES, formatSize, isSkinnable, skinAssetId, skinFileKind, skinFileProblem, skinPatch, skinSizeProblem,
} from './symbolSkin.js'

const file = (name, type = '') => ({ name, type })

test('file kind comes from the declared type', () => {
  assert.equal(skinFileKind(file('a.bin', 'image/png')), 'png')
  assert.equal(skinFileKind(file('a.bin', 'image/jpeg')), 'jpeg')
  assert.equal(skinFileKind(file('a.bin', 'image/gif')), 'gif')
  assert.equal(skinFileKind(file('a.bin', 'image/bmp')), 'bmp')
  assert.equal(skinFileKind(file('a.bin', 'image/x-ms-bmp')), 'bmp')
})

test('file kind falls back to the extension when the type is empty or generic', () => {
  assert.equal(skinFileKind(file('pump.BMP')), 'bmp')
  assert.equal(skinFileKind(file('pump.JPG')), 'jpeg')
  assert.equal(skinFileKind(file('pump.jpeg', 'application/octet-stream')), 'jpeg')
})

test('a declared type for another format beats a lookalike extension', () => {
  assert.equal(skinFileKind(file('photo.png', 'image/webp')), null)
  assert.equal(skinFileKind(file('doc.png', 'application/pdf')), null)
  assert.equal(skinFileKind(file('noextension')), null)
  assert.equal(skinFileKind(file('icon.svg', 'image/svg+xml')), null)
})

test('an unsupported file is explained by name', () => {
  assert.match(skinFileProblem(file('plan.pdf', 'application/pdf')), /plan\.pdf.*PNG, JPG, BMP or GIF/)
  assert.equal(skinFileProblem(file('ok.gif', 'image/gif')), null)
})

test('size limit is 3 MB, inclusive, and reported in readable units', () => {
  assert.equal(SKIN_MAX_BYTES, 3 * 1024 * 1024)
  assert.equal(skinSizeProblem('a.png', SKIN_MAX_BYTES), null)
  assert.match(skinSizeProblem('big.png', 5 * 1024 * 1024 + 300 * 1024), /big\.png is 5\.3 MB\. The limit is 3 MB\./)
  assert.equal(formatSize(850 * 1024), '850 KB')
  assert.equal(formatSize(2 * 1024 * 1024), '2 MB')
})

test('only a positive integer asset id counts as a skin', () => {
  assert.equal(skinAssetId({ options: { image: { assetId: 7 } } }), 7)
  assert.equal(skinAssetId({ options: { image: { assetId: '7' } } }), null)
  assert.equal(skinAssetId({ options: { image: { assetId: 0 } } }), null)
  assert.equal(skinAssetId({ options: {} }), null)
  assert.equal(skinAssetId({}), null)
  assert.equal(skinAssetId(null), null)
})

test('skinning and restoring are one options patch', () => {
  assert.deepEqual(skinPatch(12), { image: { assetId: 12 } })
  assert.deepEqual(skinPatch(null), { image: undefined })
})

test('readout and picture symbols have no artwork to replace', () => {
  assert.equal(isSkinnable({ category: 'process' }), true)
  assert.equal(isSkinnable({ category: 'electrical' }), true)
  assert.equal(isSkinnable({ category: 'utility' }), false)
  assert.equal(isSkinnable({ category: 'custom' }), false)
  assert.equal(isSkinnable(undefined), false)
})
