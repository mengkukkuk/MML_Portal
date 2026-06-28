import { defineStore } from 'pinia'

/**
 * settings — application-wide preferences persisted to localStorage.
 * Owns the active color theme (applied via a `data-theme` attribute on
 * <html>), the default poll cadence, and the critical-alarm notification
 * toggle. Saved database connections are NOT here — they live server-side
 * (datasources table, see api/datasources.js) so panels can reference them.
 *
 * Theme palettes live in styles/tokens.css keyed by `[data-theme]`; the
 * `preview` colors below mirror those values so the faceplate chips on the
 * Settings page can render a true-to-theme thumbnail without reading the DOM.
 */

const THEME_KEY = 'mml.theme'
const PREFS_KEY = 'mml.prefs'

export const THEMES = [
  {
    id: 'cobalt',
    name: 'Cobalt',
    blurb: 'Deep navy control room',
    preview: { bg: '#0a111f', panel: '#16213a', accent: '#3aa0ff', fg: '#e6edf7' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    blurb: 'Gunmetal + safety amber',
    preview: { bg: '#15161b', panel: '#262932', accent: '#f5a524', fg: '#edeef2' },
  },
  {
    id: 'carbon',
    name: 'Carbon',
    blurb: 'Carbon black + teal HMI',
    preview: { bg: '#090d0e', panel: '#17211f', accent: '#2dd4bf', fg: '#e4f0ec' },
  },
]

const THEME_IDS = THEMES.map((t) => t.id)

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback }
  } catch {
    return { ...fallback }
  }
}

export const useSettingsStore = defineStore('settings', {
  state: () => {
    const prefs = readJSON(PREFS_KEY, { pollSeconds: 5, notifyOnCritical: true })
    const stored = localStorage.getItem(THEME_KEY)
    return {
      theme: THEME_IDS.includes(stored) ? stored : 'cobalt',
      pollSeconds: prefs.pollSeconds,
      notifyOnCritical: prefs.notifyOnCritical,
    }
  },

  actions: {
    /** Apply the data-theme attribute and persist. Called eagerly so the
     *  whole app re-skins live, not just the Settings page. */
    applyTheme(id) {
      if (!THEME_IDS.includes(id)) return
      this.theme = id
      document.documentElement.dataset.theme = id
      localStorage.setItem(THEME_KEY, id)
    },

    /** Run once at app start to reflect persisted theme on first paint. */
    init() {
      document.documentElement.dataset.theme = this.theme
    },

    savePrefs() {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ pollSeconds: this.pollSeconds, notifyOnCritical: this.notifyOnCritical }),
      )
    },
  },
})
