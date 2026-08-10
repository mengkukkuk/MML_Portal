/**
 * defaultLayout — the seeded Boiler House 1 steam skid.
 *
 * Coordinates are logical units inside MimicCanvas's fixed 1600x900 viewBox,
 * never pixels. Edges store only their two {node, port} endpoints; the elbow
 * geometry is recomputed on every render, so moving a node re-routes its
 * pipes for free.
 *
 * All 12 registry symbol types appear here. Keep it that way — the fuel
 * branch is where the three discrete symbols (conveyor, photo eye, damper
 * actuator) live, and dropping one would leave a symbol nothing draws.
 *
 * Every node ships `binding: null` — the seed is an *uncommissioned* drawing.
 * `tagId` is the loop number printed in the ISA balloon and nothing more; the
 * numbers arrive only once an admin points each symbol at a real column
 * (see SymbolBindingDialog), or the Demo data toggle hands the simulator's
 * matching tag over instead.
 */
export const LAYOUT_VERSION = 2

export const DEFAULT_LAYOUT = {
  version: LAYOUT_VERSION,
  plant: 'boiler-1',
  name: 'Boiler House 1',
  viewBox: { w: 1600, h: 900 },
  nodes: [
    // --- feedwater train ---------------------------------------------------
    { id: 'n-tank', type: 'tank', tagId: 'LT-100', binding: null, label: 'T-100 condensate', x: 110, y: 190, w: 150, h: 175, rot: 0 },
    { id: 'n-pump-a', type: 'pump', tagId: 'P-101A', binding: null, label: 'P-101A', x: 360, y: 150, w: 96, h: 86, rot: 0 },
    { id: 'n-pump-b', type: 'pump', tagId: 'P-101B', binding: null, label: 'P-101B', x: 360, y: 430, w: 96, h: 86, rot: 0 },
    { id: 'n-fm', type: 'flowmeter', tagId: 'FT-101', binding: null, label: 'FT-101', x: 530, y: 225, w: 86, h: 70, rot: 0 },
    { id: 'n-hx', type: 'heatexchanger', tagId: 'HX-701', binding: null, label: 'HX-701 economiser', x: 690, y: 200, w: 150, h: 110, rot: 0 },

    // --- boiler + steam header --------------------------------------------
    { id: 'n-drum', type: 'tank', tagId: 'LT-102', binding: null, label: 'D-200 steam drum', x: 930, y: 140, w: 180, h: 200, rot: 0 },
    { id: 'n-tee', type: 'pipetee', tagId: null, binding: null, label: 'header', x: 1150, y: 180, w: 64, h: 64, rot: 0 },
    { id: 'n-fcv', type: 'valve', tagId: 'FCV-301', binding: null, label: 'FCV-301', x: 1260, y: 180, w: 96, h: 72, rot: 0 },
    { id: 'n-pt', type: 'gauge', tagId: 'PT-201', binding: null, label: 'PT-201', x: 1420, y: 160, w: 96, h: 96, rot: 0 },
    // TT-202 hangs off the header tee to the left of PT-201's column: a gauge
    // carries its balloon *below* the dial, so stacking the two in one column
    // would drop PT-201's bubble onto TT-202's dial.
    { id: 'n-tt', type: 'gauge', tagId: 'TT-202', binding: null, label: 'TT-202', x: 1260, y: 380, w: 96, h: 96, rot: 0 },

    // --- fuel branch -------------------------------------------------------
    { id: 'n-conv', type: 'conveyor', tagId: 'CV-501', binding: null, label: 'CV-501 fuel belt', x: 110, y: 600, w: 240, h: 70, rot: 0 },
    { id: 'n-motor', type: 'motor', tagId: 'M-505', binding: null, label: 'M-505 belt drive', x: 180, y: 730, w: 90, h: 90, rot: 0 },
    { id: 'n-eye', type: 'sensoreye', tagId: 'ZS-502', binding: null, label: 'ZS-502', x: 496, y: 580, w: 76, h: 80, rot: 0 },
    { id: 'n-act', type: 'actuator', tagId: 'XV-503', binding: null, label: 'XV-503 damper', x: 592, y: 580, w: 96, h: 100, rot: 0 },
    { id: 'n-bcv', type: 'valve', tagId: 'BR-401', binding: null, label: 'BR-401 burner', x: 850, y: 590, w: 96, h: 72, rot: 0 },

    // --- flue + beacon -----------------------------------------------------
    { id: 'n-o2', type: 'gauge', tagId: 'O2-402', binding: null, label: 'O2-402 analyser', x: 1150, y: 560, w: 96, h: 96, rot: 0 },
    { id: 'n-sl', type: 'stacklight', tagId: 'SL-601', binding: null, label: 'SL-601', x: 1470, y: 600, w: 54, h: 130, rot: 0 },
  ],
  edges: [
    { id: 'e-tank-a', from: { node: 'n-tank', port: 'out' }, to: { node: 'n-pump-a', port: 'in' }, service: 'feedwater', flowNode: 'n-pump-a' },
    { id: 'e-tank-b', from: { node: 'n-tank', port: 'out' }, to: { node: 'n-pump-b', port: 'in' }, service: 'feedwater', flowNode: 'n-pump-b' },
    { id: 'e-a-fm', from: { node: 'n-pump-a', port: 'out' }, to: { node: 'n-fm', port: 'in' }, service: 'feedwater', flowNode: 'n-pump-a' },
    { id: 'e-b-fm', from: { node: 'n-pump-b', port: 'out' }, to: { node: 'n-fm', port: 'in' }, service: 'feedwater', flowNode: 'n-pump-b' },
    { id: 'e-fm-hx', from: { node: 'n-fm', port: 'out' }, to: { node: 'n-hx', port: 'in' }, service: 'feedwater' },
    { id: 'e-hx-drum', from: { node: 'n-hx', port: 'out' }, to: { node: 'n-drum', port: 'in' }, service: 'feedwater' },

    { id: 'e-drum-tee', from: { node: 'n-drum', port: 'out' }, to: { node: 'n-tee', port: 'in' }, service: 'steam' },
    { id: 'e-tee-fcv', from: { node: 'n-tee', port: 'out' }, to: { node: 'n-fcv', port: 'in' }, service: 'steam' },
    { id: 'e-fcv-pt', from: { node: 'n-fcv', port: 'out' }, to: { node: 'n-pt', port: 'in' }, service: 'steam' },
    { id: 'e-tee-tt', from: { node: 'n-tee', port: 'branch' }, to: { node: 'n-tt', port: 'in' }, service: 'steam' },

    { id: 'e-conv-eye', from: { node: 'n-conv', port: 'out' }, to: { node: 'n-eye', port: 'in' }, service: 'fuelgas', flowNode: 'n-conv' },
    { id: 'e-eye-act', from: { node: 'n-eye', port: 'out' }, to: { node: 'n-act', port: 'in' }, service: 'fuelgas', flowNode: 'n-conv' },
    { id: 'e-act-bcv', from: { node: 'n-act', port: 'out' }, to: { node: 'n-bcv', port: 'in' }, service: 'fuelgas', flowNode: 'n-act' },
    { id: 'e-bcv-drum', from: { node: 'n-bcv', port: 'out' }, to: { node: 'n-drum', port: 'fuel' }, service: 'fuelgas', flowNode: 'n-act' },

    { id: 'e-drum-o2', from: { node: 'n-drum', port: 'flue' }, to: { node: 'n-o2', port: 'in' }, service: 'fluegas' },
  ],
}

/** Deep clone so callers can never mutate the seed. */
export function cloneDefaultLayout() {
  return JSON.parse(JSON.stringify(DEFAULT_LAYOUT))
}
