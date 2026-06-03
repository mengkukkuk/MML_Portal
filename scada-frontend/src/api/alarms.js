const MOCK_ALARMS = [
  { id: 1, time: '2026-06-02 09:14:02', severity: 'critical', source: 'PLC-09', message: 'Packaging PLC unreachable', ack: false },
  { id: 2, time: '2026-06-02 09:12:48', severity: 'warning', source: 'RTU-07', message: 'Tank 3 level above 85%', ack: false },
  { id: 3, time: '2026-06-02 08:55:11', severity: 'warning', source: 'PLC-02', message: 'Compressor CPU > 50%', ack: true },
  { id: 4, time: '2026-06-02 08:40:00', severity: 'info', source: 'HMI-12', message: 'Shift change acknowledged', ack: true },
]

export async function fetchActiveAlarms() {
  await new Promise((r) => setTimeout(r, 200))
  return [...MOCK_ALARMS]
}
