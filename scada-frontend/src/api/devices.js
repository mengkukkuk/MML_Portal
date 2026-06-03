const MOCK_DEVICES = [
  { id: 'PLC-01', name: 'Boiler PLC', location: 'Plant A · Line 1', status: 'online', cpu: 38, uptime: '14d 3h' },
  { id: 'PLC-02', name: 'Compressor PLC', location: 'Plant A · Line 2', status: 'online', cpu: 52, uptime: '8d 11h' },
  { id: 'RTU-07', name: 'Tank Farm RTU', location: 'Plant B · West Yard', status: 'degraded', cpu: 71, uptime: '3d 19h' },
  { id: 'PLC-09', name: 'Packaging PLC', location: 'Plant C · Line 4', status: 'offline', cpu: 0, uptime: '—' },
  { id: 'HMI-12', name: 'Control Room HMI', location: 'Plant A · Control', status: 'online', cpu: 22, uptime: '27d 6h' },
]

export async function fetchDevices() {
  await new Promise((r) => setTimeout(r, 200))
  return [...MOCK_DEVICES]
}
