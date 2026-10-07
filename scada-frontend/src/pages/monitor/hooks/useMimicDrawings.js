import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { fetchMimicLayouts } from '@/api/mimic'
import { FALLBACK_SLUG } from '../layoutDoc'

/**
 * Which drawing is open (`?mimic=<slug>`) and the list it is chosen from.
 *
 * The first render waits for the list, then picks the URL's slug, else the
 * first drawing, else the fallback plant. After that the URL follows the
 * selection, and a deleted drawing falls back to whatever is left.
 */
export default function useMimicDrawings() {
  const [searchParams, setSearchParams] = useSearchParams()

  const layoutsQuery = useQuery({ queryKey: ['mimic-layouts'], queryFn: fetchMimicLayouts })
  const layouts = useMemo(() => layoutsQuery.data || [], [layoutsQuery.data])

  const [activeSlug, setActiveSlug] = useState(null)
  const initializedRef = useRef(false)

  const putSlugInUrl = useCallback((slug) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('mimic', slug)
      return p
    }, { replace: true })
  }, [setSearchParams])

  useEffect(() => {
    if (initializedRef.current || layoutsQuery.isPending) return
    initializedRef.current = true
    const wanted = searchParams.get('mimic')
    const next = layouts.find((l) => l.slug === wanted)?.slug
      ?? layouts[0]?.slug
      ?? FALLBACK_SLUG
    setActiveSlug(next)
    putSlugInUrl(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutsQuery.isPending, layouts])

  // The open drawing was deleted — here or in another admin's tab. Fall back to
  // whatever is left rather than polling a slug the server no longer knows.
  //
  // Guards on `activeSlug` being set rather than just `initializedRef`: the
  // effect above sets `initializedRef.current = true` synchronously but its
  // `setActiveSlug` call doesn't land until the next render, so on the very
  // first run after `layouts` loads this effect would otherwise still see the
  // pre-init `null` and stomp the URL's requested slug with `layouts[0]`.
  useEffect(() => {
    if (!initializedRef.current || !layouts.length || !activeSlug) return
    if (layouts.some((l) => l.slug === activeSlug)) return
    setActiveSlug(layouts[0].slug)
    putSlugInUrl(layouts[0].slug)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts])

  const selectMimic = useCallback((slug) => {
    if (!slug || slug === activeSlug) return
    setActiveSlug(slug)
    putSlugInUrl(slug)
  }, [activeSlug, putSlugInUrl])

  return { layouts, activeSlug, selectMimic }
}
