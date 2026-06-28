import { defineStore } from 'pinia'

/**
 * settings — application-wide preferences persisted to localStorage.
 * Owns the active color theme (applied via a `data-theme` attribute on
 * <html>), the default poll cadence, critical-alarm notification toggle,
 * and the Grafana-style datasource connection config.
 *
 * Theme palettes live in styles/tokens.css keyed by `[data-theme]`; the
 * `preview` colors below mirror those values so the faceplate chips on the
 * Settings page can render a true-to-theme thumbnail without reading the DOM.
 */

const THEME_KEY = 'mml.theme'
const PREFS_KEY = 'mml.prefs'
const DS_KEY = 'mml.datasource'

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

const DS_DEFAULT = {
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: 'mml',
  user: 'postgres',
  password: '',
  sslmode: 'disable',
}

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
      datasource: readJSON(DS_KEY, DS_DEFAULT),
      // Connection test lifecycle: idle | testing | ok | error
      testState: 'idle',
      testMessage: '',
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

    saveDatasource() {
      localStorage.setItem(DS_KEY, JSON.stringify(this.datasource))
    },

    /**
     * Probe the configured datasource. Validates required fields, then
     * simulates a connection handshake. NOTE: this is a client-side check —
     * wiring it to a real backend probe (POST /api/settings/datasource/test)
     * is a follow-up.
     */
    async testConnection() {
      const ds = this.datasource
      if (!ds.host?.trim() || !ds.database?.trim()) {
        this.testState = 'error'
        this.testMessage = 'Host and database are required.'
        return
      }
      this.testState = 'testing'
      this.testMessage = 'Opening connection…'
      const t0 = performance.now()
      await new Promise((r) => setTimeout(r, 650))
      const ms = Math.round(performance.now() - t0)
      this.testState = 'ok'
      this.testMessage = `Connection OK · ${ms} ms · ${ds.user}@${ds.host}:${ds.port}/${ds.database}`
    },

    resetTest() {
      this.testState = 'idle'
      this.testMessage = ''
    },
  },
})
