import { apiClient } from './client'

/**
 * Status-tag API — backs the live dashboard against public.variables_tag.
 * Mirrors the /api/tags router in scada-mml-backend/tags.py.
 */

/** Tag names across every selected source, each tagged with its origin. */
export async function fetchTags() {
  const { data } = await apiClient.get('/tags')
  return data.tags ?? [] // [{ tag_name, datasource_id, datasource_name }]
}

/**
 * Numeric columns offerable in the panel editor — the *union* across sources,
 * not the intersection. A field only one plant has must still be bindable; a
 * panel using it simply renders no series for the plants that lack it.
 */
export async function fetchTagFields() {
  const { data } = await apiClient.get('/tags/fields')
  return data // [{ field, label }]
}

/**
 * Newest row for `tagName`, one per source that has it. A source missing the tag
 * is absent from the list rather than an error — with several plants selected,
 * "this one has no Pump 1" is normal.
 */
export async function fetchTagLatest(tagName) {
  const { data } = await apiClient.get('/tags/latest', { params: { tag_name: tagName } })
  return { tags: data.tags ?? [], sources: data.sources ?? [] }
}
