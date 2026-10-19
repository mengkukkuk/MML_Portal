import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchDatasources, saveSelection } from '@/api/datasources'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'

/**
 * Which plant databases the pages read from — the state behind the account
 * menu's "Data sources" list.
 *
 * Multi-select: an operator responsible for several plants sees them merged
 * rather than having to switch back and forth. Live draws one series per source,
 * Events and Alarms merge rows tagged with their origin, and Monitor uses the
 * first — a mimic symbol is one physical asset, so overlaying plants on it would
 * be meaningless.
 *
 * The selection is stored server-side per user; this hook only reflects and
 * writes it. After a successful write every query is invalidated, but that alone
 * would not be enough: the polling hooks key their accumulated history by query
 * key and would splice the new plant's points onto the old plant's series. The
 * store's `selectionKey` is part of those keys, which is what makes them reseed.
 *
 * Must be called from something always mounted (the sidebar's account button,
 * not its menu): it is what hydrates the selection store on sign-in.
 */
export function useDatasourceSelection() {
  const queryClient = useQueryClient()
  const selected = useDatasourceSelectionStore((s) => s.selected)
  const implicit = useDatasourceSelectionStore((s) => s.implicit)
  const hydrate = useDatasourceSelectionStore((s) => s.hydrate)
  const apply = useDatasourceSelectionStore((s) => s.apply)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const { data: sources = [] } = useQuery({
    queryKey: ['datasources'],
    queryFn: fetchDatasources,
    staleTime: 60_000,
  })

  const { mutate, isPending } = useMutation({
    mutationFn: saveSelection,
    onSuccess: (data) => {
      apply(data)
      // Coarse on purpose: every data query in the app is now reading from a
      // different set of databases.
      queryClient.invalidateQueries()
    },
  })

  const ids = selected.map((d) => d.id)

  // Deselecting everything is meaningful — it restores the implicit default —
  // so an empty array is sent rather than ignored.
  const toggle = (id) => mutate(ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id])

  return { sources, selected, ids, implicit, toggle, isPending }
}
