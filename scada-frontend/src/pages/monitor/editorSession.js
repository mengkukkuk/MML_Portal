const MAX_HISTORY = 100

const sameDocument = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function createSession(published, revision = null) {
  return {
    published: structuredClone(published),
    draft: structuredClone(published),
    revision,
    past: [],
    future: [],
    gestureBase: null,
    dirty: false,
  }
}

export function previewDraft(state, draft) {
  return {
    ...state,
    draft,
    dirty: !sameDocument(draft, state.published),
  }
}

export function commitDraft(state, draft) {
  if (sameDocument(draft, state.draft)) return state
  return {
    ...state,
    draft,
    past: [...state.past.slice(-(MAX_HISTORY - 1)), state.draft],
    future: [],
    gestureBase: null,
    dirty: !sameDocument(draft, state.published),
  }
}

export function startGesture(state) {
  return state.gestureBase ? state : { ...state, gestureBase: state.draft }
}

export function finishGesture(state) {
  if (!state.gestureBase) return state
  const base = state.gestureBase
  if (sameDocument(base, state.draft)) return { ...state, gestureBase: null }
  return {
    ...state,
    past: [...state.past.slice(-(MAX_HISTORY - 1)), base],
    future: [],
    gestureBase: null,
    dirty: !sameDocument(state.draft, state.published),
  }
}

export function cancelGesture(state) {
  if (!state.gestureBase) return state
  return previewDraft({ ...state, gestureBase: null }, state.gestureBase)
}

export function undoDraft(state) {
  if (!state.past.length) return state
  const previous = state.past.at(-1)
  return {
    ...state,
    draft: previous,
    past: state.past.slice(0, -1),
    future: [state.draft, ...state.future],
    gestureBase: null,
    dirty: !sameDocument(previous, state.published),
  }
}

export function redoDraft(state) {
  if (!state.future.length) return state
  const next = state.future[0]
  return {
    ...state,
    draft: next,
    past: [...state.past, state.draft],
    future: state.future.slice(1),
    gestureBase: null,
    dirty: !sameDocument(next, state.published),
  }
}

export function saveSession(state, published, revision) {
  return createSession(published, revision)
}

export function cancelSession(state) {
  return createSession(state.published, state.revision)
}
