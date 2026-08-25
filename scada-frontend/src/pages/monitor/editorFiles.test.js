import test from 'node:test'
import assert from 'node:assert/strict'
import { createMimicExport, parseMimicImport } from './editorFiles.js'

const active = { slug: 'active', name: 'Active plant' }
const doc = { version: 2, name: 'Imported name', viewBox: { w: 1000, h: 600 }, nodes: [], edges: [] }

test('exports use the client envelope', () => {
  const out = createMimicExport(active, doc, new Date('2026-08-25T00:00:00Z'))
  assert.equal(out.kind, 'mml-mimic')
  assert.equal(out.exportVersion, 1)
  assert.equal(out.slug, 'active')
})

test('imports accept an envelope or raw doc and preserve active identity', () => {
  const envelope = createMimicExport({ slug: 'other', name: 'Other' }, doc)
  assert.deepEqual(parseMimicImport(envelope, active).name, 'Active plant')
  assert.deepEqual(parseMimicImport(doc, active).viewBox, doc.viewBox)
})

test('imports reject unsupported or malformed documents', () => {
  assert.throws(() => parseMimicImport({ kind: 'mml-mimic', exportVersion: 99, doc }, active), /version/i)
  assert.throws(() => parseMimicImport({ ...doc, version: 99 }, active), /version/i)
  assert.throws(() => parseMimicImport({ nodes: 'bad', edges: [] }, active), /layout/i)
  assert.throws(() => parseMimicImport({
    ...doc,
    nodes: [{ id: 'n1', type: 'pump', x: 0, y: 0, w: 10, h: 10 }],
    edges: [{ id: 'e1', from: { node: 'n1', port: 'out' }, to: { node: 'missing', port: 'in' } }],
  }, active), /wire|endpoint/i)
})
