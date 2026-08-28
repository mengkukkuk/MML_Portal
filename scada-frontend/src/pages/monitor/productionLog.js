export const SHIFT_HOURS = Object.freeze(Array.from({ length: 10 }, (_, index) => index + 8))

export const PRODUCTION_LOG_COPY = Object.freeze({
  heading: ['ผลผลิตรายชั่วโมง', 'Hourly production'],
  good: ['ผลิต', 'Good'],
  reject: ['เสีย', 'Reject'],
  rejectRate: ['อัตราเสีย', 'Reject rate'],
  empty: ['ยังไม่มีข้อมูลในกะนี้', 'No production samples in this shift.'],
})


export function rejectRate(produced, rejected) {
  const good = Math.max(0, Number(produced) || 0)
  const ng = Math.max(0, Number(rejected) || 0)
  const total = good + ng
  return total ? Number(((ng / total) * 100).toFixed(2)) : 0
}


export function formatRejectRate(bucket) {
  const supplied = Number(bucket?.reject_rate)
  const value = Number.isFinite(supplied)
    ? supplied
    : rejectRate(bucket?.produced, bucket?.rejected)
  return `${value.toFixed(2)}%`
}


export function defaultProductionHour(log) {
  if (SHIFT_HOURS.includes(log?.current_hour)) return log.current_hour
  const encodedHour = String(log?.generated_at ?? '').match(/T(\d{2}):/)?.[1]
  const hour = encodedHour == null ? new Date().getHours() : Number(encodedHour)
  return hour < SHIFT_HOURS[0] ? SHIFT_HOURS[0] : SHIFT_HOURS.at(-1)
}


export function productionHourIsFuture(log, hour) {
  const encodedHour = String(log?.generated_at ?? '').match(/T(\d{2}):/)?.[1]
  return encodedHour == null ? false : hour > Number(encodedHour)
}


export function productionBarHeight(value, maxValue) {
  const n = Math.max(0, Number(value) || 0)
  const max = Math.max(0, Number(maxValue) || 0)
  if (!n || !max) return 0
  return Math.max(4, (n / max) * 100)
}
