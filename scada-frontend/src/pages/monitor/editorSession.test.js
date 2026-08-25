import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cancelSession, commitDraft, createSession, finishGesture, previewDraft,
  redoDraft, saveSession, startGesture, undoDraft,
} from './editorSession.js'

const doc = (x = 0) => ({ version: 2, name: 'Plant', viewBox: { w: 1600, h: 900 }, nodes: [{ id: 'n1', x, y: 0, w: 80, h: 60 }], edges: [] })

test('commands undo and redo in order and a new command invalidates redo', () => {
  let state = createSession(doc(), 'rev-1')
  state = commitDraft(state, doc(8))
  state = commitDraft(state, doc(16))
  assert.equal(state.draft.nodes[0].x, 16)
  state = undoDraft(state)
  assert.equal(state.draft.nodes[0].x, 8)
  state = undoDraft(state)
  assert.equal(state.draft.nodes[0].x, 0)
  state = redoDraft(state)
  assert.equal(state.draft.nodes[0].x, 8)
  state = commitDraft(state, doc(24))
  assert.equal(state.future.length, 0)
})

test('a pointer gesture coalesces previews into one history entry', () => {
  let state = startGesture(createSession(doc(), 'rev-1'))
  state = previewDraft(state, doc(8))
  state = previewDraft(state, doc(16))
  state = previewDraft(state, doc(24))
  state = finishGesture(state)
  assert.equal(state.past.length, 1)
  assert.equal(undoDraft(state).draft.nodes[0].x, 0)
})

test('save resets history and cancel restores the published document', () => {
  let state = commitDraft(createSession(doc(), 'rev-1'), doc(8))
  state = saveSession(state, doc(8), 'rev-2')
  assert.equal(state.dirty, false)
  assert.deepEqual(state.past, [])
  state = commitDraft(state, doc(20))
  state = cancelSession(state)
  assert.equal(state.draft.nodes[0].x, 8)
  assert.equal(state.revision, 'rev-2')
})
