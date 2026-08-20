import dayjs from 'dayjs'

/**
 * Date-range presets, shared by the filter bar, the URL serialiser and the
 * template defaults.
 *
 * A preset is stored in the URL by *name*, not as resolved timestamps, so a
 * bookmarked "last 7 days" report keeps meaning the last 7 days tomorrow. Only
 * `custom` pins absolute values.
 */

export const PRESETS = {
  today: { label: 'Today', resolve: () => [dayjs().startOf('day'), dayjs()] },
  yesterday: {
    label: 'Yesterday',
    resolve: () => [
      dayjs().subtract(1, 'day').startOf('day'),
      dayjs().subtract(1, 'day').endOf('day'),
    ],
  },
  last24h: { label: 'Last 24 hours', resolve: () => [dayjs().subtract(24, 'hour'), dayjs()] },
  last7d: { label: 'Last 7 days', resolve: () => [dayjs().subtract(7, 'day'), dayjs()] },
  last30d: { label: 'Last 30 days', resolve: () => [dayjs().subtract(30, 'day'), dayjs()] },
  thisMonth: { label: 'This month', resolve: () => [dayjs().startOf('month'), dayjs()] },
  lastMonth: {
    label: 'Last month',
    resolve: () => [
      dayjs().subtract(1, 'month').startOf('month'),
      dayjs().subtract(1, 'month').endOf('month'),
    ],
  },
  custom: { label: 'Custom', resolve: null },
}

export const DEFAULT_PRESET = 'last7d'

/** Turn a filter state into the concrete [start, end] dayjs pair to query. */
export function resolveRange(filters) {
  const preset = PRESETS[filters.preset] ?? PRESETS[DEFAULT_PRESET]
  if (preset.resolve) return preset.resolve()
  return [filters.start, filters.end]
}

/** Read filter state out of a URLSearchParams. */
export function filtersFromParams(params, fallbackPreset = DEFAULT_PRESET) {
  const preset = params.get('preset') || fallbackPreset
  const start = params.get('start')
  const end = params.get('end')
  return {
    preset: PRESETS[preset] ? preset : fallbackPreset,
    start: start ? dayjs(start) : null,
    end: end ? dayjs(end) : null,
    locations: params.getAll('location'),
    tagNames: params.getAll('tag'),
  }
}

/** Inverse of filtersFromParams — only non-defaults are written. */
export function paramsFromFilters(filters) {
  const params = new URLSearchParams()
  params.set('preset', filters.preset)
  if (filters.preset === 'custom') {
    if (filters.start) params.set('start', filters.start.format('YYYY-MM-DDTHH:mm:ss'))
    if (filters.end) params.set('end', filters.end.format('YYYY-MM-DDTHH:mm:ss'))
  }
  filters.locations.forEach((l) => params.append('location', l))
  filters.tagNames.forEach((t) => params.append('tag', t))
  return params
}

/** Human label for the resolved window, shown in the header and the export. */
export function describeRange(start, end) {
  if (!start || !end) return '—'
  return `${dayjs(start).format('DD MMM YYYY HH:mm')} → ${dayjs(end).format('DD MMM YYYY HH:mm')}`
}
