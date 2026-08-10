import Tank from './Tank'
import Pump from './Pump'
import Valve from './Valve'
import Motor from './Motor'
import HeatExchanger from './HeatExchanger'
import FlowMeter from './FlowMeter'
import Gauge from './Gauge'
import PipeTee from './PipeTee'
import Conveyor from './Conveyor'
import StackLight from './StackLight'
import SensorEye from './SensorEye'
import Actuator from './Actuator'

/**
 * Symbol registry — `type -> descriptor`. Mirrors the barrel pattern in
 * src/components/live/options/index.js so the two "pluggable renderer" sets
 * in this app are shaped alike.
 *
 * Descriptor fields:
 *   label        palette caption
 *   Component    pure <g>-returning component, props { node, tag, selected }
 *   defaultSize  {w,h} used when the palette drops a new symbol
 *   ports        name -> [fx, fy], fractions of the node box. The edge router
 *                resolves these against the node's *current* x/y/w/h every
 *                render, which is why edge geometry is never stored.
 *   binding      which fields the symbol reads off its tag entry
 *   bubble       { anchor: [fx,fy], offset: [dx,dy] } — where the ISA balloon
 *                sits and where its lead line lands. null = no instrument.
 */
export const SYMBOLS = {
  tank: {
    label: 'Tank / drum',
    Component: Tank,
    defaultSize: { w: 160, h: 180 },
    // `flue` leaves the bottom-left: on a fired drum the flue pass drops to
    // the economiser and the stack, so routing it downward is not a shortcut.
    ports: { in: [0, 0.3], out: [1, 0.5], fuel: [0.5, 1], flue: [0.18, 1] },
    binding: 'analog',
    bubble: { anchor: [0.14, 0.32], offset: [-78, -58] },
  },
  pump: {
    label: 'Pump',
    Component: Pump,
    defaultSize: { w: 96, h: 86 },
    ports: { in: [0, 0.44], out: [1, 0.44] },
    binding: 'both',
    bubble: { anchor: [0.5, 0.1], offset: [0, -74] },
  },
  valve: {
    label: 'Control valve',
    Component: Valve,
    defaultSize: { w: 96, h: 72 },
    ports: { in: [0, 0.67], out: [1, 0.67] },
    binding: 'analog',
    bubble: { anchor: [0.5, 0.1], offset: [0, -76] },
  },
  motor: {
    label: 'Motor',
    Component: Motor,
    defaultSize: { w: 90, h: 90 },
    ports: { in: [0, 0.44], out: [1, 0.44] },
    binding: 'both',
    bubble: { anchor: [0.9, 0.44], offset: [82, 0] },
  },
  heatexchanger: {
    label: 'Heat exchanger',
    Component: HeatExchanger,
    defaultSize: { w: 150, h: 110 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'analog',
    bubble: { anchor: [0.5, 0], offset: [0, -74] },
  },
  flowmeter: {
    label: 'Flow meter',
    Component: FlowMeter,
    defaultSize: { w: 86, h: 70 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'analog',
    bubble: { anchor: [0.5, 1], offset: [0, 92] },
  },
  gauge: {
    label: 'Gauge / analyser',
    Component: Gauge,
    defaultSize: { w: 96, h: 96 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'analog',
    bubble: { anchor: [0.5, 1], offset: [0, 96] },
  },
  pipetee: {
    label: 'Pipe tee',
    Component: PipeTee,
    defaultSize: { w: 64, h: 64 },
    ports: { in: [0, 0.5], out: [1, 0.5], branch: [0.5, 1] },
    binding: 'none',
    bubble: null,
  },
  conveyor: {
    label: 'Conveyor',
    Component: Conveyor,
    defaultSize: { w: 240, h: 70 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'both',
    bubble: { anchor: [0.5, 0], offset: [0, -72] },
  },
  stacklight: {
    label: 'Stack light',
    Component: StackLight,
    defaultSize: { w: 54, h: 130 },
    ports: { in: [0.5, 1], out: [0.5, 0] },
    binding: 'discrete',
    bubble: { anchor: [0, 0.3], offset: [-84, -18] },
  },
  sensoreye: {
    label: 'Photo eye',
    Component: SensorEye,
    defaultSize: { w: 76, h: 80 },
    ports: { in: [0, 0.42], out: [1, 0.42] },
    binding: 'discrete',
    bubble: { anchor: [0.2, 0.22], offset: [0, -70] },
  },
  actuator: {
    label: 'Damper actuator',
    Component: Actuator,
    defaultSize: { w: 96, h: 100 },
    ports: { in: [0, 0.68], out: [1, 0.68] },
    binding: 'both',
    bubble: { anchor: [0.9, 0.68], offset: [84, 22] },
  },
}

export const SYMBOL_TYPES = Object.keys(SYMBOLS)

/** Absolute logical coordinates of one port on one node. */
export function portPoint(node, portName) {
  const def = SYMBOLS[node.type]
  const frac = def?.ports?.[portName] ?? def?.ports?.out ?? [0.5, 0.5]
  return { x: node.x + frac[0] * node.w, y: node.y + frac[1] * node.h }
}
