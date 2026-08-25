import { useCallback, useState } from 'react'
import {
  cancelGesture, cancelSession, commitDraft, createSession, finishGesture,
  previewDraft, redoDraft, saveSession, startGesture, undoDraft,
} from './editorSession'

const resolve = (current, update) => (
  typeof update === 'function' ? update(current) : update
)

export default function useMimicEditorSession() {
  const [session, setSession] = useState(null)

  const load = useCallback((document, revision = null) => {
    setSession(document ? createSession(document, revision) : null)
  }, [])

  const preview = useCallback((update) => {
    setSession((state) => (state
      ? previewDraft(state, resolve(state.draft, update))
      : state))
  }, [])

  const commit = useCallback((update) => {
    setSession((state) => (state
      ? commitDraft(state, resolve(state.draft, update))
      : state))
  }, [])

  const beginGesture = useCallback(() => setSession((state) => (
    state ? startGesture(state) : state
  )), [])
  const endGesture = useCallback(() => setSession((state) => (
    state ? finishGesture(state) : state
  )), [])
  const abortGesture = useCallback(() => setSession((state) => (
    state ? cancelGesture(state) : state
  )), [])
  const undo = useCallback(() => setSession((state) => (state ? undoDraft(state) : state)), [])
  const redo = useCallback(() => setSession((state) => (state ? redoDraft(state) : state)), [])
  const cancel = useCallback(() => setSession((state) => (state ? cancelSession(state) : state)), [])
  const saved = useCallback((document, revision) => setSession((state) => (
    state ? saveSession(state, document, revision) : state
  )), [])

  return {
    session,
    document: session?.draft ?? null,
    load,
    preview,
    commit,
    beginGesture,
    endGesture,
    abortGesture,
    undo,
    redo,
    cancel,
    saved,
  }
}
