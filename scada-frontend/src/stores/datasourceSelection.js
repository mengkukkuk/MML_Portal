import { create } from 'zustand'

import { fetchSelection } from '../api/datasources'

/**
 * datasourceSelection — which plant databases the pages currently read from.
 *
 * The selection itself is owned by the server (per user, resolved from the JWT)
 * so that what the header shows is exactly what the API is about to query. This
 * store is a local mirror of it, kept here rather than in react-query because
 * `selectionKey` has to be readable synchronously from inside the query keys of
 * a dozen other hooks.
 *
 * `selectionKey` is the load-bearing part. Every polling hook keys its
 * accumulated series cache by the query key, and takes the incremental "poll"
 * path whenever that key is already known. If the selection changed but the key
 * did not, the next fetch would merge a different plant's points onto the
 * previous plant's history — one chart line silently spliced out of two
 * unrelated machines. Putting the selection in the key makes the hooks reseed
 * instead, with no other change to them.
 *
 * It is a string, not the array, precisely so it can go into a query key without
 * allocating a new identity on every render.
 */
const keyOf = (selected) => selected.map((d) => d.id).join(',')

export const useDatasourceSelectionStore = create((set) => ({
  /** [{ id, name, host, database, position }] in the operator's chosen order. */
  selected: [],
  /** True when nobody chose anything and the backend fell back to a default. */
  implicit: true,
  /** Comma-joined ids — for query keys. */
  selectionKey: '',
  /** False until the first fetch resolves, so pages can hold off on a reseed. */
  ready: false,

  apply: ({ selected = [], implicit = true }) =>
    set({ selected, implicit, selectionKey: keyOf(selected), ready: true }),

  /**
   * Load the selection from the server. Failures leave the store empty rather
   * than throwing: an unreachable API is already surfaced by the connection
   * pill, and a header that renders no chips is a better outcome than a page
   * that will not mount.
   */
  hydrate: async () => {
    try {
      const data = await fetchSelection()
      set({
        selected: data.selected ?? [],
        implicit: data.implicit ?? true,
        selectionKey: keyOf(data.selected ?? []),
        ready: true,
      })
    } catch {
      set({ ready: true })
    }
  },

  /** Back to signed-out state — the next user's selection is not this one's. */
  reset: () =>
    set({ selected: [], implicit: true, selectionKey: '', ready: false }),
}))
