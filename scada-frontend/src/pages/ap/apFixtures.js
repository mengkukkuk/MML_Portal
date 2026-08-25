const RANGE_HOURS = { '8h': 8, '24h': 24, '7d': 168 }
const HORIZON_SCALE = { 30: 0.82, 60: 1, 120: 1.12 }

export const AP_RANGES = [
  { value: '8h', label: 'Last 8 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
]

export const AP_HORIZONS = [30, 60, 120]

export const AP_LINES = [
  {
    value: 'line-1',
    label: 'Packaging Line 1',
    machines: [
      { value: 'all', label: 'All machines' },
      { value: 'packer-01', label: 'Packer 01' },
      { value: 'labeler-01', label: 'Labeler 01' },
    ],
  },
  {
    value: 'line-2',
    label: 'Packaging Line 2',
    machines: [
      { value: 'all', label: 'All machines' },
      { value: 'packer-02', label: 'Packer 02' },
      { value: 'conveyor-04', label: 'Conveyor 04' },
      { value: 'inspection-03', label: 'Inspection 03' },
      { value: 'case-erector-03', label: 'Case Erector 03' },
    ],
  },
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value, digits = 0) => Number(value.toFixed(digits))

function outcome(id, label, value, unit, meta, tone = 'neutral') {
  return { id, label, value, unit, meta, tone }
}

function signalSeries({ hot = false } = {}) {
  const temperature = [58, 59, 59, 61, 63, 66, 70, 75, 81, 86, hot ? 91 : 84, hot ? 94 : 82]
  const vibration = [1.8, 1.9, 1.8, 2, 2.2, 2.5, 2.9, 3.4, 4.2, 4.8, hot ? 5.4 : 4.5, hot ? 5.8 : 4.1]
  return {
    summary: 'Seal motor temperature and drive vibration trend toward Now.',
    labels: ['-55m', '-50m', '-45m', '-40m', '-35m', '-30m', '-25m', '-20m', '-15m', '-10m', '-5m', 'Now'],
    series: [
      { name: 'Seal motor temperature', unit: '°C', values: temperature, color: '#F5A524' },
      { name: 'Drive vibration', unit: 'mm/s', values: vibration, color: '#9B8CFF', axis: 1 },
    ],
  }
}

function conveyorSeries({ jam = false } = {}) {
  return {
    summary: jam
      ? 'Transfer motor current rises while conveyor speed becomes unstable before the jam.'
      : 'Transfer motor current is elevated while conveyor speed remains inside its operating band.',
    labels: ['-55m', '-50m', '-45m', '-40m', '-35m', '-30m', '-25m', '-20m', '-15m', '-10m', '-5m', 'Now'],
    series: [
      { name: 'Transfer motor current', unit: 'A', values: jam ? [14, 14, 15, 15, 17, 18, 21, 24, 28, 31, 34, 36] : [14, 15, 14, 15, 16, 17, 18, 18, 19, 18, 19, 18], color: '#F5A524' },
      { name: 'Conveyor speed', unit: 'm/min', values: jam ? [32, 32, 31, 32, 30, 29, 31, 27, 25, 28, 20, 0] : [32, 32, 31, 32, 31, 32, 31, 31, 32, 31, 31, 32], color: '#58C7FA', axis: 1 },
    ],
  }
}

function sealQualitySeries({ unstable = false } = {}) {
  return {
    summary: unstable
      ? 'Seal temperature variance widens as the measured reject rate climbs above its normal band.'
      : 'Seal temperature and reject rate remain close to their configured targets.',
    labels: ['-55m', '-50m', '-45m', '-40m', '-35m', '-30m', '-25m', '-20m', '-15m', '-10m', '-5m', 'Now'],
    series: [
      { name: 'Seal temperature', unit: '°C', values: unstable ? [168, 169, 170, 172, 167, 174, 166, 176, 165, 178, 169, 177] : [169, 170, 170, 171, 169, 170, 171, 170, 170, 169, 170, 170], color: '#F5A524' },
      { name: 'Reject rate', unit: '%', values: unstable ? [1.3, 1.4, 1.6, 1.8, 2.1, 2.4, 2.7, 3.1, 3.6, 4.2, 4.8, 5.1] : [1.2, 1.1, 1.3, 1.2, 1.4, 1.3, 1.5, 1.2, 1.3, 1.2, 1.4, 1.3], color: '#F05A5A', axis: 1 },
    ],
  }
}

function heaterFailureSeries() {
  return {
    summary: 'Heater duty reaches 100% while seal temperature continues to fall before the stop.',
    labels: ['-55m', '-50m', '-45m', '-40m', '-35m', '-30m', '-25m', '-20m', '-15m', '-10m', '-5m', 'Now'],
    series: [
      { name: 'Heater duty', unit: '%', values: [62, 64, 66, 70, 74, 82, 91, 98, 100, 100, 100, 100], color: '#F5A524' },
      { name: 'Seal temperature', unit: '°C', values: [170, 170, 169, 168, 167, 165, 161, 156, 151, 146, 142, 139], color: '#F05A5A', axis: 1 },
    ],
  }
}

function labelFeedSeries() {
  return {
    summary: 'Label-web tension stays controlled while line speed follows the planned material-change profile.',
    labels: ['-55m', '-50m', '-45m', '-40m', '-35m', '-30m', '-25m', '-20m', '-15m', '-10m', '-5m', 'Now'],
    series: [
      { name: 'Label-web tension', unit: 'N', values: [12, 12, 13, 12, 12, 11, 9, 8, 10, 12, 12, 12], color: '#58C7FA' },
      { name: 'Line speed', unit: 'packs/min', values: [118, 119, 118, 118, 116, 92, 48, 42, 76, 110, 118, 118], color: '#9B8CFF', axis: 1 },
    ],
  }
}

function stablePackerSeries() {
  return {
    summary: 'Packer motor current and temperature remain inside their learned operating bands.',
    labels: ['-55m', '-50m', '-45m', '-40m', '-35m', '-30m', '-25m', '-20m', '-15m', '-10m', '-5m', 'Now'],
    series: [
      { name: 'Packer motor temperature', unit: '°C', values: [55, 56, 55, 56, 57, 56, 57, 57, 58, 57, 58, 57], color: '#58C7FA' },
      { name: 'Packer motor current', unit: 'A', values: [12, 12, 13, 12, 13, 12, 12, 13, 12, 13, 12, 12], color: '#22C55E', axis: 1 },
    ],
  }
}

const line2Incidents = [
  {
    id: 'inc-jam-204',
    title: 'Conveyor jam stopped downstream packing',
    machine: 'Conveyor 04',
    occurred: '10:18',
    ageMinutes: 212,
    durationMinutes: 27,
    lostUnits: 486,
    severity: 'high',
    lossType: 'unplanned',
    summary: 'Product accumulation at the transfer point stopped the packer and inspection cell for 27 minutes.',
    contributors: [
      { label: 'Transfer motor current climbed 31% above baseline', weight: 78 },
      { label: 'Three photo-eye blockage events occurred in 12 minutes', weight: 64 },
      { label: 'Conveyor speed oscillated before the stop', weight: 49 },
    ],
    alarms: [
      { time: '10:06', text: 'Transfer motor high current', severity: 'Warning' },
      { time: '10:14', text: 'Photo-eye blocked', severity: 'Warning' },
      { time: '10:18', text: 'Conveyor drive trip', severity: 'Critical' },
    ],
    similarIncidents: 4,
    chart: conveyorSeries({ jam: true }),
  },
  {
    id: 'inc-reject-118',
    title: 'Seal defects pushed rejects above limit',
    machine: 'Packer 02',
    occurred: '12:46',
    ageMinutes: 64,
    durationMinutes: 18,
    lostUnits: 214,
    severity: 'watch',
    lossType: 'quality',
    summary: 'Seal temperature drift produced 214 rejected packs before the operator adjusted the heater zone.',
    contributors: [
      { label: 'Seal temperature varied ±8.4°C around the recipe target', weight: 84 },
      { label: 'Heater duty cycle remained above 92% for 16 minutes', weight: 71 },
      { label: 'Film tension increased during the same production batch', weight: 43 },
    ],
    alarms: [
      { time: '12:35', text: 'Seal temperature deviation', severity: 'Warning' },
      { time: '12:43', text: 'Reject rate above 4%', severity: 'Critical' },
    ],
    similarIncidents: 6,
    chart: sealQualitySeries({ unstable: true }),
  },
  {
    id: 'inc-drift-076',
    title: 'Packer motor temperature drifted from baseline',
    machine: 'Packer 02',
    occurred: '13:32',
    ageMinutes: 18,
    durationMinutes: 9,
    lostUnits: 0,
    severity: 'observed',
    lossType: 'observation',
    summary: 'No stop occurred, but the historian pattern resembles six earlier incidents that preceded a drive trip.',
    contributors: [
      { label: 'Motor temperature rose 14°C in 20 minutes', weight: 88 },
      { label: 'Vibration remained above the normal band for 11 minutes', weight: 76 },
      { label: 'Two overcurrent warnings occurred this shift', weight: 52 },
    ],
    alarms: [
      { time: '13:28', text: 'Drive vibration high', severity: 'Warning' },
    ],
    similarIncidents: 6,
    chart: signalSeries({ hot: true }),
  },
  {
    id: 'inc-heater-061',
    title: 'Seal heater relay fault interrupted production',
    machine: 'Packer 02',
    occurred: 'Yesterday · 21:34',
    ageMinutes: 978,
    durationMinutes: 22,
    lostUnits: 396,
    severity: 'high',
    lossType: 'unplanned',
    summary: 'A heater relay stopped cycling and forced the line to hold product until seal temperature recovered.',
    contributors: [
      { label: 'Heater duty stayed at 100% while temperature fell', weight: 91 },
      { label: 'Relay feedback changed state 14 times in 9 minutes', weight: 77 },
      { label: 'The fault cleared after the relay was reseated', weight: 61 },
    ],
    alarms: [
      { time: '21:28', text: 'Seal heater response low', severity: 'Warning' },
      { time: '21:34', text: 'Seal temperature below stop limit', severity: 'Critical' },
    ],
    similarIncidents: 3,
    chart: heaterFailureSeries(),
  },
  {
    id: 'inc-transfer-039',
    title: 'Transfer motor overload stopped the conveyor',
    machine: 'Conveyor 04',
    occurred: 'Friday · 06:42',
    ageMinutes: 4288,
    durationMinutes: 31,
    lostUnits: 558,
    severity: 'high',
    lossType: 'unplanned',
    summary: 'An accumulation at the case transfer overloaded the conveyor motor and stopped downstream packing.',
    contributors: [
      { label: 'Motor current stayed above 32 A for 74 seconds', weight: 89 },
      { label: 'Conveyor speed fell while upstream speed remained unchanged', weight: 73 },
    ],
    alarms: [
      { time: '06:41', text: 'Transfer motor overload', severity: 'Critical' },
    ],
    similarIncidents: 4,
    chart: conveyorSeries({ jam: true }),
  },
]

const line1Incidents = [
  {
    id: 'inc-label-012',
    title: 'Label roll change briefly slowed output',
    machine: 'Labeler 01',
    occurred: '09:24',
    ageMinutes: 266,
    durationMinutes: 8,
    lostUnits: 62,
    severity: 'observed',
    lossType: 'planned',
    summary: 'A planned material change reduced line speed without creating an unplanned stop.',
    contributors: [
      { label: 'Label stock reached its configured change threshold', weight: 96 },
      { label: 'Line speed reduction matched the standard change procedure', weight: 82 },
    ],
    alarms: [],
    similarIncidents: 9,
    chart: labelFeedSeries(),
  },
  {
    id: 'inc-packer-008',
    title: 'Packer interlock caused an unplanned stop',
    machine: 'Packer 01',
    occurred: 'Yesterday · 16:12',
    ageMinutes: 1308,
    durationMinutes: 11,
    lostUnits: 126,
    severity: 'watch',
    lossType: 'unplanned',
    summary: 'A guard interlock opened during production and held the packer until the switch was checked.',
    contributors: [
      { label: 'Guard interlock changed state immediately before the stop', weight: 94 },
      { label: 'Motor temperature and current remained normal', weight: 58 },
    ],
    alarms: [{ time: '16:12', text: 'Packer guard interlock open', severity: 'Critical' }],
    similarIncidents: 2,
    chart: stablePackerSeries(),
  },
]

const line2Predictions = [
  {
    id: 'pred-drive-031',
    title: 'Seal drive malfunction',
    machine: 'Packer 02',
    baseRisk: 0.72,
    expectedMinutes: [35, 50],
    unitsAtRisk: 710,
    forecastRatio: 0.3,
    evidence: [
      'Motor temperature is 14°C above its rolling baseline',
      'Drive vibration has exceeded 4.5 mm/s for 11 minutes',
      'The pattern matches 6 earlier drive-trip incidents',
    ],
    focus: 'Inspect the seal drive cooling fan, bearing temperature, and motor current before the next batch.',
    chart: signalSeries({ hot: true }),
  },
  {
    id: 'pred-reject-044',
    title: 'Reject rate above 4%',
    machine: 'Inspection 03',
    baseRisk: 0.43,
    expectedMinutes: [12, 24],
    unitsAtRisk: 260,
    forecastRatio: 0.58,
    evidence: [
      'Seal temperature variance is widening during the current batch',
      'Vision rejects increased from 1.6% to 2.9% in 20 minutes',
      'Film tension is near the upper recipe limit',
    ],
    focus: 'Check seal temperature stability and film tension before increasing line speed.',
    chart: sealQualitySeries({ unstable: true }),
  },
  {
    id: 'pred-jam-052',
    title: 'Transfer-point jam',
    machine: 'Conveyor 04',
    baseRisk: 0.28,
    expectedMinutes: [18, 32],
    unitsAtRisk: 390,
    forecastRatio: 0.82,
    evidence: [
      'Photo-eye blockage frequency is slightly above shift baseline',
      'Transfer motor current is stable but elevated',
    ],
    focus: 'Clear loose packaging at the transfer point during the next planned pause.',
    chart: conveyorSeries(),
  },
]

const line1Predictions = [
  {
    id: 'pred-label-011',
    title: 'Label feed interruption',
    machine: 'Labeler 01',
    baseRisk: 0.18,
    expectedMinutes: [6, 12],
    unitsAtRisk: 110,
    forecastRatio: 0.42,
    evidence: ['Label feed tension is stable', 'No repeated feed alarms in the current shift'],
    focus: 'No immediate inspection is required; continue routine monitoring.',
    chart: labelFeedSeries(),
  },
  {
    id: 'pred-packer-010',
    title: 'Packer interruption',
    machine: 'Packer 01',
    baseRisk: 0.12,
    expectedMinutes: [8, 15],
    unitsAtRisk: 135,
    forecastRatio: 0.72,
    evidence: ['Motor current and temperature remain inside the learned operating band'],
    focus: 'No immediate inspection is required; continue routine monitoring.',
    chart: stablePackerSeries(),
  },
]

function riskBand(risk) {
  if (risk >= 0.65) return 'high'
  if (risk >= 0.35) return 'watch'
  return 'stable'
}

function filterByMachine(rows, machine) {
  if (machine === 'all') return rows
  const label = AP_LINES.flatMap((line) => line.machines).find((item) => item.value === machine)?.label
  return rows.filter((row) => row.machine === label)
}

function buildTimeline(incidents, predictions, range, horizon) {
  const pastWindow = RANGE_HOURS[range] * 60
  const past = incidents.map((incident, index) => ({
    id: `timeline-${incident.id}`,
    entityId: incident.id,
    entityType: 'incident',
    title: incident.title,
    label: incident.occurred,
    minutes: -Math.min(incident.ageMinutes, pastWindow * 0.92),
    lane: index % 2,
    tone: incident.severity,
  }))
  const future = predictions
    .filter((prediction) => prediction.status !== 'insufficient_data')
    .map((prediction, index) => ({
      id: `timeline-${prediction.id}`,
      entityId: prediction.id,
      entityType: 'prediction',
      title: prediction.title,
      label: `${Math.round(prediction.risk * 100)}% risk`,
      minutes: prediction.forecastAtMinutes,
      windowMinutes: Math.min(
        Math.max(5, Math.round(horizon * 0.18)),
        Math.max(1, horizon - prediction.forecastAtMinutes),
      ),
      lane: index % 2,
      tone: prediction.band,
    }))
  return { pastWindow, futureWindow: horizon, past, future }
}

function buildDashboard({ range = '24h', line = 'line-2', machine = 'all', horizon = 60 }) {
  const horizonScale = HORIZON_SCALE[horizon] ?? 1
  const isLine2 = line === 'line-2'
  const insufficient = machine === 'case-erector-03'
  const baseIncidents = isLine2 ? line2Incidents : line1Incidents
  const basePredictions = isLine2 ? line2Predictions : line1Predictions
  const rangeMinutes = RANGE_HOURS[range] * 60
  const incidents = insufficient
    ? []
    : filterByMachine(baseIncidents, machine).filter((incident) => incident.ageMinutes <= rangeMinutes)
  let predictions = insufficient ? [] : filterByMachine(basePredictions, machine)

  predictions = predictions.map((prediction) => {
    const risk = clamp(prediction.baseRisk * horizonScale, 0.04, 0.94)
    return {
      ...prediction,
      risk,
      band: riskBand(risk),
      leadMinutes: horizon,
      forecastAtMinutes: Math.max(5, Math.round(horizon * prediction.forecastRatio)),
      unitsAtRisk: Math.round(prediction.unitsAtRisk * horizonScale),
      status: 'ready',
    }
  })

  if (insufficient) {
    predictions = [{
      id: 'pred-insufficient-001',
      title: 'Failure and reject risk',
      machine: 'Case Erector 03',
      status: 'insufficient_data',
      band: 'unknown',
      risk: null,
      leadMinutes: horizon,
      unitsAtRisk: null,
      evidence: ['Only 18% of the required historian window is available'],
      focus: 'Collect at least 14 operating days before enabling prediction.',
      chart: null,
    }]
  }

  const unplannedIncidents = incidents.filter((item) => item.lossType === 'unplanned')
  const lossMinutes = unplannedIncidents.reduce((sum, item) => sum + item.durationMinutes, 0)
  const lostUnits = incidents.reduce((sum, item) => sum + item.lostUnits, 0)
  const unitsAtRisk = predictions.reduce((sum, item) => sum + (item.unitsAtRisk ?? 0), 0)
  const rejectBase = isLine2 ? 3.8 : 1.2
  const availability = insufficient ? null : clamp(100 - (lossMinutes / rangeMinutes) * 100, 0, 100)
  const rejectRate = insufficient ? null : clamp(rejectBase + (machine === 'packer-02' ? 0.9 : 0), 0, 12)
  const coverage = insufficient ? 18 : machine === 'inspection-03' ? 82 : isLine2 ? 96 : 99

  return {
    generatedAt: '2026-08-25T13:50:00+07:00',
    filters: { range, line, machine, horizon },
    outcomes: [
      outcome('availability', 'Availability', availability == null ? '—' : round(availability, 1), availability == null ? '' : '%', availability == null ? 'Not enough historian data' : `Target 95% · ${availability >= 95 ? 'above' : 'below'} target`, availability == null ? 'unknown' : availability >= 95 ? 'positive' : 'critical'),
      outcome('loss', 'Unplanned loss', insufficient ? '—' : lossMinutes, insufficient ? '' : 'min', insufficient ? 'No measured state history' : `${unplannedIncidents.length} unplanned incidents`, lossMinutes > 30 ? 'critical' : 'neutral'),
      outcome('units', 'Estimated lost units', insufficient ? '—' : lostUnits, '', insufficient ? 'Quality mapping incomplete' : `Across ${RANGE_HOURS[range]} operating hours`, lostUnits > 300 ? 'critical' : 'neutral'),
      outcome('reject', 'Reject rate', rejectRate == null ? '—' : round(rejectRate, 1), rejectRate == null ? '' : '%', rejectRate == null ? 'Quality mapping incomplete' : `Limit 4% · ${rejectRate >= 4 ? 'above' : 'inside'} limit`, rejectRate != null && rejectRate >= 4 ? 'critical' : 'positive'),
      outcome('risk', 'Units at risk', insufficient ? '—' : unitsAtRisk, '', insufficient ? 'Prediction unavailable' : `Next ${horizon} minutes`, predictions.some((item) => item.band === 'high') ? 'prediction' : 'neutral'),
    ],
    incidents,
    predictions,
    timeline: buildTimeline(incidents, predictions, range, horizon),
    dataCoverage: {
      percent: coverage,
      status: coverage >= 95 ? 'complete' : coverage >= 70 ? 'partial' : 'insufficient',
      message: coverage >= 95
        ? `${coverage}% of expected historian samples are available.`
        : coverage >= 70
          ? `${coverage}% coverage; one signal source has gaps.`
          : `${coverage}% coverage; predictions require more operating history.`,
    },
    model: {
      name: 'Packaging risk model',
      version: 'prototype-0.4',
      trainedThrough: '18 Aug 2026',
      validation: 'Shadow evaluation',
      disclaimer: 'Fixture explanations demonstrate a future tree-model evidence contract; no model is running.',
    },
  }
}

/**
 * Prototype adapter with the intended future API boundary. It performs no
 * network request and always resolves deterministic fixture data.
 */
export async function fetchAPDashboard(filters) {
  return buildDashboard(filters)
}
