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

import BusBar from './BusBar'
import Breaker from './Breaker'
import Disconnector from './Disconnector'
import Transformer from './Transformer'
import MccStarter from './MccStarter'
import Vfd from './Vfd'
import CapBank from './CapBank'

import Plc from './Plc'
import RemoteIo from './RemoteIo'
import NetworkSwitch from './NetworkSwitch'
import HmiPanel from './HmiPanel'
import ControlLoop from './ControlLoop'
import SafetyRelay from './SafetyRelay'
import EdgeGateway from './EdgeGateway'

import Clarifier from './Clarifier'
import SandFilter from './SandFilter'
import DosingPump from './DosingPump'
import UvReactor from './UvReactor'
import Membrane from './Membrane'
import Blower from './Blower'
import Weir from './Weir'

import TobaccoFeed from './TobaccoFeed'
import RodMaker from './RodMaker'
import Tipper from './Tipper'
import Packer from './Packer'
import Cellophaner from './Cellophaner'
import Cartoner from './Cartoner'
import RejectStation from './RejectStation'

import Ats from './Ats'
import Generator from './Generator'
import Ups from './Ups'
import Pdu from './Pdu'
import Rack from './Rack'
import Crah from './Crah'
import ColdAisle from './ColdAisle'

import IpCamera from './IpCamera'
import Lighting from './Lighting'
import PcBased from './PcBased'

import Counter from './Counter'
import DataTable from './DataTable'
import DisplayBox from './DisplayBox'
import Led from './Led'
import AlertBadge from './AlertBadge'

import CustomSymbol from './CustomSymbol'

/**
 * Symbol registry — `type -> descriptor`. Mirrors the barrel pattern in
 * src/components/live/options/index.js so the two "pluggable renderer" sets
 * in this app are shaped alike.
 *
 * Descriptor fields:
 *   label        palette caption
 *   category     which discipline's drawing this symbol belongs to; groups the
 *                palette. Must be one of SYMBOL_CATEGORIES below.
 *   Component    pure <g>-returning component, props { node, tag, selected }
 *   defaultSize  {w,h} used when the palette drops a new symbol
 *   ports        name -> [fx, fy], fractions of the node box. The edge router
 *                resolves these against the node's *current* x/y/w/h every
 *                render, which is why edge geometry is never stored.
 *   binding      which fields the symbol reads off its tag entry
 *   text         true if the symbol can render a *word*, so the binding dialog
 *                offers text columns beside the numeric ones. Absent means
 *                numeric only, which is the honest default: a gauge, a level or
 *                a trend has nothing to do with 'FAULT'. Only the symbols that
 *                print their reading set it.
 *   bubble       { anchor: [fx,fy], offset: [dx,dy] } — where the ISA balloon
 *                sits and where its lead line lands. null = no instrument.
 *                A node may override this per-drawing; see bubbleSpec().
 *
 * Adding a type here is the whole job. The server stores any well-formed
 * symbol slug and never checks it against a list of known symbols, so a new
 * symbol needs no backend change and no deploy ordering — this registry is the
 * only place the vocabulary lives. Keep the key a lowercase slug (`[a-z]` then
 * `[a-z0-9_-]`, 40 max); that shape is the one thing mimic.py still enforces.
 *
 * The reverse direction still matters: an *older* bundle opening a drawing
 * that uses a symbol it lacks reports it via layoutDoc.unknownTypes(), draws
 * placeholders and holds the drawing read-only, so saving from that build
 * cannot silently discard what it could not render.
 */
export const SYMBOLS = {
  tank: {
    label: 'Tank / drum',
    category: 'process',
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
    category: 'process',
    Component: Pump,
    defaultSize: { w: 96, h: 86 },
    ports: { in: [0, 0.44], out: [1, 0.44] },
    binding: 'both',
    bubble: { anchor: [0.5, 0.1], offset: [0, -74] },
  },
  valve: {
    label: 'Control valve',
    category: 'process',
    Component: Valve,
    defaultSize: { w: 96, h: 72 },
    ports: { in: [0, 0.67], out: [1, 0.67] },
    binding: 'analog',
    bubble: { anchor: [0.5, 0.1], offset: [0, -76] },
  },
  motor: {
    label: 'Motor',
    category: 'process',
    Component: Motor,
    defaultSize: { w: 90, h: 90 },
    ports: { in: [0, 0.44], out: [1, 0.44] },
    binding: 'both',
    bubble: { anchor: [0.9, 0.44], offset: [82, 0] },
  },
  heatexchanger: {
    label: 'Heat exchanger',
    category: 'process',
    Component: HeatExchanger,
    defaultSize: { w: 150, h: 110 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'analog',
    bubble: { anchor: [0.5, 0], offset: [0, -74] },
  },
  flowmeter: {
    label: 'Flow meter',
    category: 'process',
    Component: FlowMeter,
    defaultSize: { w: 86, h: 70 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'analog',
    bubble: { anchor: [0.5, 1], offset: [0, 92] },
  },
  gauge: {
    label: 'Gauge / analyser',
    category: 'process',
    Component: Gauge,
    defaultSize: { w: 96, h: 96 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'analog',
    bubble: { anchor: [0.5, 1], offset: [0, 96] },
  },
  pipetee: {
    label: 'Pipe tee',
    category: 'process',
    Component: PipeTee,
    defaultSize: { w: 64, h: 64 },
    ports: { in: [0, 0.5], out: [1, 0.5], branch: [0.5, 1] },
    binding: 'none',
    bubble: null,
  },
  conveyor: {
    label: 'Conveyor',
    category: 'process',
    Component: Conveyor,
    defaultSize: { w: 240, h: 70 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'both',
    bubble: { anchor: [0.5, 0], offset: [0, -72] },
  },
  stacklight: {
    label: 'Stack light',
    category: 'process',
    Component: StackLight,
    defaultSize: { w: 54, h: 130 },
    ports: { in: [0.5, 1], out: [0.5, 0] },
    binding: 'discrete',
    bubble: { anchor: [0, 0.3], offset: [-84, -18] },
  },
  sensoreye: {
    label: 'Photo eye',
    category: 'process',
    Component: SensorEye,
    defaultSize: { w: 76, h: 80 },
    ports: { in: [0, 0.42], out: [1, 0.42] },
    binding: 'discrete',
    bubble: { anchor: [0.2, 0.22], offset: [0, -70] },
  },
  actuator: {
    label: 'Damper actuator',
    category: 'process',
    Component: Actuator,
    defaultSize: { w: 96, h: 100 },
    ports: { in: [0, 0.68], out: [1, 0.68] },
    binding: 'both',
    bubble: { anchor: [0.9, 0.68], offset: [84, 22] },
  },

  // --- electrical (IEC 60617 single-line) --------------------------------
  // Power flows top-to-bottom on a single-line diagram, so these carry `in`
  // on the top edge and `out` on the bottom rather than left-to-right.
  busbar: {
    label: 'Bus bar',
    category: 'electrical',
    Component: BusBar,
    defaultSize: { w: 240, h: 44 },
    ports: {
      in: [0, 0.5], out: [1, 0.5], tap1: [0.33, 1], tap2: [0.67, 1],
    },
    binding: 'both',
    bubble: { anchor: [0.5, 0], offset: [0, -66] },
  },
  breaker: {
    label: 'Circuit breaker',
    category: 'electrical',
    Component: Breaker,
    defaultSize: { w: 84, h: 120 },
    ports: { in: [0.5, 0], out: [0.5, 1] },
    binding: 'both',
    bubble: { anchor: [0.8, 0.5], offset: [82, 0] },
  },
  disconnector: {
    label: 'Disconnector',
    category: 'electrical',
    Component: Disconnector,
    defaultSize: { w: 76, h: 120 },
    ports: { in: [0.5, 0], out: [0.5, 1] },
    binding: 'discrete',
    bubble: null,
  },
  transformer: {
    label: 'Transformer',
    category: 'electrical',
    Component: Transformer,
    defaultSize: { w: 120, h: 150 },
    ports: { in: [0.5, 0], out: [0.5, 1] },
    binding: 'analog',
    bubble: { anchor: [0.85, 0.34], offset: [86, -14] },
  },
  mccstarter: {
    label: 'MCC starter',
    category: 'electrical',
    Component: MccStarter,
    defaultSize: { w: 116, h: 160 },
    ports: { in: [0.5, 0], out: [0.5, 1] },
    binding: 'both',
    bubble: { anchor: [0.9, 0.3], offset: [88, -20] },
  },
  vfd: {
    label: 'VFD / drive',
    category: 'electrical',
    Component: Vfd,
    defaultSize: { w: 130, h: 104 },
    ports: { in: [0, 0.46], out: [1, 0.46] },
    binding: 'both',
    bubble: { anchor: [0.5, 0], offset: [0, -72] },
  },
  capbank: {
    label: 'Capacitor bank',
    category: 'electrical',
    Component: CapBank,
    defaultSize: { w: 120, h: 120 },
    ports: { in: [0.5, 0], out: [0.5, 1] },
    binding: 'both',
    bubble: { anchor: [0.9, 0.16], offset: [88, -34] },
  },

  // --- automation (ISA-101 control-system layer) -------------------------
  plc: {
    label: 'PLC rack',
    category: 'automation',
    Component: Plc,
    defaultSize: { w: 160, h: 110 },
    ports: { in: [0, 0.4], out: [1, 0.4], net: [0.5, 0] },
    binding: 'both',
    bubble: { anchor: [0.5, 1], offset: [0, 92] },
  },
  remoteio: {
    label: 'Remote I/O',
    category: 'automation',
    Component: RemoteIo,
    defaultSize: { w: 130, h: 96 },
    ports: { in: [0, 0.33], out: [1, 0.33], net: [0.5, 0] },
    binding: 'both',
    bubble: { anchor: [0.5, 1], offset: [0, 86] },
  },
  networkswitch: {
    label: 'Network switch',
    category: 'automation',
    Component: NetworkSwitch,
    defaultSize: { w: 150, h: 72 },
    ports: { in: [0, 0.31], out: [1, 0.31], uplink: [0.5, 0] },
    binding: 'both',
    bubble: { anchor: [0.5, 0], offset: [0, -62] },
  },
  hmipanel: {
    label: 'HMI panel',
    category: 'automation',
    Component: HmiPanel,
    defaultSize: { w: 120, h: 110 },
    ports: { in: [0, 0.34], net: [0.5, 0] },
    binding: 'both',
    bubble: { anchor: [0.9, 0.34], offset: [88, -12] },
  },
  controlloop: {
    label: 'Control loop',
    category: 'automation',
    Component: ControlLoop,
    defaultSize: { w: 104, h: 104 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'analog',
    // The face already carries the value, so a balloon on top of it would be
    // the same number twice.
    bubble: null,
  },
  safetyrelay: {
    label: 'Safety relay',
    category: 'automation',
    Component: SafetyRelay,
    defaultSize: { w: 120, h: 100 },
    ports: { in: [0, 0.26], out: [1, 0.26] },
    binding: 'discrete',
    bubble: null,
  },
  edgegateway: {
    label: 'Edge gateway',
    category: 'automation',
    Component: EdgeGateway,
    defaultSize: { w: 120, h: 120 },
    ports: { in: [0, 0.6], out: [1, 0.6], uplink: [0.5, 0] },
    binding: 'both',
    bubble: { anchor: [0.16, 0.6], offset: [-86, 8] },
  },

  // --- water treatment ---------------------------------------------------
  clarifier: {
    label: 'Clarifier',
    category: 'water',
    Component: Clarifier,
    defaultSize: { w: 160, h: 160 },
    ports: {
      in: [0, 0.5], out: [1, 0.5], sludge: [0.5, 1],
    },
    binding: 'both',
    bubble: { anchor: [0.15, 0.15], offset: [-84, -56] },
  },
  sandfilter: {
    label: 'Sand filter',
    category: 'water',
    Component: SandFilter,
    defaultSize: { w: 116, h: 160 },
    // A filter that can only be drawn in service cannot be commissioned:
    // backwash and drain are half of how the vessel is actually operated.
    ports: {
      in: [0.5, 0], out: [0.5, 1], backwash: [0, 0.3], drain: [1, 0.82],
    },
    binding: 'both',
    bubble: { anchor: [0.9, 0.24], offset: [88, -36] },
  },
  dosingpump: {
    label: 'Dosing pump',
    category: 'water',
    Component: DosingPump,
    defaultSize: { w: 104, h: 140 },
    ports: { in: [0, 0.34], out: [1, 0.34] },
    binding: 'both',
    bubble: { anchor: [0.9, 0.34], offset: [86, -18] },
  },
  uvreactor: {
    label: 'UV reactor',
    category: 'water',
    Component: UvReactor,
    defaultSize: { w: 160, h: 86 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'both',
    bubble: { anchor: [0.5, 0], offset: [0, -66] },
  },
  membrane: {
    label: 'RO membrane',
    category: 'water',
    Component: Membrane,
    // Three ports: a membrane drawn with one outlet hides the reject stream,
    // which is where most of a plant's water goes.
    defaultSize: { w: 170, h: 126 },
    ports: { in: [0, 0.45], out: [1, 0.45], concentrate: [1, 0.86] },
    binding: 'analog',
    bubble: { anchor: [0.5, 0.2], offset: [0, -66] },
  },
  blower: {
    label: 'Blower',
    category: 'water',
    Component: Blower,
    ports: { in: [0, 0.5], out: [0.86, 0.14] },
    defaultSize: { w: 150, h: 116 },
    binding: 'both',
    bubble: { anchor: [0.5, 0.1], offset: [0, -74] },
  },
  weir: {
    label: 'V-notch weir',
    category: 'water',
    Component: Weir,
    defaultSize: { w: 140, h: 96 },
    ports: { in: [0, 0.7], out: [1, 0.7] },
    binding: 'analog',
    bubble: { anchor: [0.5, 0.24], offset: [0, -66] },
  },

  // --- cigarette production line (maker-packer) --------------------------
  tobaccofeed: {
    label: 'Tobacco feeder',
    category: 'tobacco',
    Component: TobaccoFeed,
    defaultSize: { w: 130, h: 150 },
    ports: { in: [0.5, 0], out: [1, 0.76] },
    binding: 'both',
    bubble: { anchor: [0.12, 0.2], offset: [-84, -46] },
  },
  rodmaker: {
    label: 'Rod maker',
    category: 'tobacco',
    Component: RodMaker,
    defaultSize: { w: 220, h: 120 },
    ports: { in: [0, 0.56], out: [1, 0.56], paper: [0.1, 0] },
    binding: 'both',
    bubble: { anchor: [0.5, 0.3], offset: [0, -68] },
  },
  tipper: {
    label: 'Tipper',
    category: 'tobacco',
    Component: Tipper,
    defaultSize: { w: 170, h: 120 },
    ports: { in: [0, 0.64], out: [1, 0.64], reel: [0.24, 0.06] },
    binding: 'both',
    bubble: { anchor: [0.85, 0.3], offset: [84, -34] },
  },
  packer: {
    label: 'Packer',
    category: 'tobacco',
    Component: Packer,
    defaultSize: { w: 170, h: 140 },
    ports: { in: [0, 0.48], out: [1, 0.48] },
    binding: 'both',
    bubble: { anchor: [0.5, 0.06], offset: [0, -68] },
  },
  cellophaner: {
    label: 'Cellophaner',
    category: 'tobacco',
    Component: Cellophaner,
    defaultSize: { w: 160, h: 120 },
    ports: { in: [0, 0.66], out: [1, 0.66], film: [0.18, 0.06] },
    binding: 'both',
    bubble: { anchor: [0.85, 0.4], offset: [84, -26] },
  },
  cartoner: {
    label: 'Cartoner',
    category: 'tobacco',
    Component: Cartoner,
    defaultSize: { w: 160, h: 120 },
    ports: { in: [0, 0.44], out: [1, 0.44] },
    binding: 'both',
    bubble: { anchor: [0.5, 0.08], offset: [0, -66] },
  },
  rejectstation: {
    label: 'Reject station',
    category: 'tobacco',
    Component: RejectStation,
    defaultSize: { w: 130, h: 110 },
    ports: { in: [0, 0.42], out: [1, 0.42], reject: [0.94, 0.94] },
    binding: 'both',
    bubble: { anchor: [0.5, 0.18], offset: [0, -62] },
  },

  // --- data centre infrastructure ----------------------------------------
  // The power chain runs top-to-bottom like the rest of the switchgear above;
  // the cooling chain runs left-to-right. Keeping the two at right angles is
  // what lets an operator trace either one across a crowded sheet.
  ats: {
    label: 'Transfer switch',
    category: 'dcim',
    Component: Ats,
    defaultSize: { w: 130, h: 130 },
    // Two incomers, not one: an ATS drawn with a single input is just a
    // breaker, and the whole point of the device is which source it is on.
    ports: { in: [0.2, 0], alt: [0.8, 0], out: [0.5, 1] },
    binding: 'discrete',
    bubble: null,
  },
  generator: {
    label: 'Standby generator',
    category: 'dcim',
    Component: Generator,
    defaultSize: { w: 130, h: 140 },
    ports: { out: [0.5, 1], fuel: [0, 0.82] },
    binding: 'both',
    bubble: { anchor: [0.86, 0.36], offset: [86, -20] },
  },
  ups: {
    label: 'UPS',
    category: 'dcim',
    Component: Ups,
    defaultSize: { w: 170, h: 130 },
    // `bypass` leaves the top edge: the static bypass is drawn over the
    // conversion path, so routing it upward matches the symbol's own geometry.
    ports: {
      in: [0.14, 0], out: [0.86, 1], bypass: [0.5, 0], battery: [0.5, 1],
    },
    binding: 'both',
    bubble: { anchor: [0.86, 0.2], offset: [84, -46] },
  },
  pdu: {
    label: 'Rack PDU',
    category: 'dcim',
    Component: Pdu,
    defaultSize: { w: 90, h: 150 },
    ports: { in: [0.5, 0], out: [0.5, 1] },
    binding: 'both',
    bubble: { anchor: [0.86, 0.2], offset: [80, -40] },
  },
  rack: {
    label: 'Server rack',
    category: 'dcim',
    Component: Rack,
    defaultSize: { w: 110, h: 180 },
    // A rack is a terminus on the power chain — nothing is fed from it — so it
    // carries an inlet and a network drop and no outlet.
    ports: { in: [0.5, 0], net: [0, 0.18] },
    binding: 'analog',
    bubble: { anchor: [0.9, 0.16], offset: [82, -38] },
  },
  crah: {
    label: 'CRAH unit',
    category: 'dcim',
    Component: Crah,
    defaultSize: { w: 170, h: 110 },
    ports: {
      in: [0, 0.45], out: [1, 0.45], chw: [0.25, 0.9], chwr: [0.6, 0.9],
    },
    binding: 'both',
    bubble: { anchor: [0.5, 0.1], offset: [0, -64] },
  },
  coldaisle: {
    label: 'Cold aisle',
    category: 'dcim',
    Component: ColdAisle,
    defaultSize: { w: 300, h: 130 },
    ports: { in: [0, 0.5], out: [1, 0.5] },
    binding: 'analog',
    bubble: { anchor: [0.5, 0], offset: [0, -60] },
  },

  // --- vision inspection ---------------------------------------------------
  // Leaf devices, not process equipment: nothing flows through a camera or a
  // light the way it flows through a valve, so each carries only the wire it
  // actually has rather than a borrowed in/out pair.
  ipcamera: {
    label: 'IP camera',
    category: 'vision',
    Component: IpCamera,
    defaultSize: { w: 110, h: 80 },
    ports: { net: [0, 0.5] },
    binding: 'discrete',
    bubble: null,
  },
  lighting: {
    label: 'Lighting',
    category: 'vision',
    Component: Lighting,
    defaultSize: { w: 90, h: 90 },
    ports: { in: [0.5, 0] },
    binding: 'discrete',
    bubble: null,
  },
  pcbased: {
    label: 'PC-based',
    category: 'vision',
    Component: PcBased,
    defaultSize: { w: 140, h: 100 },
    ports: { in: [0.5, 1], net: [0.5, 0] },
    binding: 'both',
    bubble: { anchor: [0.5, 0], offset: [0, -70] },
  },

  // --- utility annotations -----------------------------------------------
  // These draw a reading, not a piece of plant. Each carries a single `signal`
  // port on one edge so it can be tethered by a dotted line to the equipment it
  // reports on — the ISA convention for an instrument signal — and none of them
  // take a balloon, because the face already is the readout.
  counter: {
    label: 'Number counter',
    category: 'utility',
    Component: Counter,
    defaultSize: { w: 176, h: 82 },
    ports: { signal: [0, 0.5] },
    binding: 'analog',
    bubble: null,
  },
  table: {
    label: 'Table',
    category: 'utility',
    Component: DataTable,
    // Wider and deeper than anything else in this group: the others report one
    // reading, this one reports a projection, and a table that arrives too
    // small to show its own headers is a table nobody will configure.
    defaultSize: { w: 340, h: 180 },
    ports: { signal: [0, 0.5] },
    // The anchor column may be a word — a batch id, a state, an operator name —
    // and it is the column the table falls back to before an admin has designed
    // any structure, so it must be pickable from the text list too.
    binding: 'both',
    text: true,
    bubble: null,
  },
  displaybox: {
    label: 'Display box',
    category: 'utility',
    Component: DisplayBox,
    defaultSize: { w: 176, h: 74 },
    ports: { signal: [0, 0.5] },
    // `both`: the box prints a mapped state as a word when one is configured
    // and the formatted number otherwise, so it needs to read either.
    binding: 'both',
    text: true,
    bubble: null,
  },
  led: {
    label: 'LED indicator',
    category: 'utility',
    Component: Led,
    defaultSize: { w: 64, h: 64 },
    ports: { signal: [0.5, 1] },
    binding: 'both',
    // Text-capable for the same reason alertbadge is: a colour rule can test
    // a word (`a == 'FAULT'`), and state.map names a beacon by word too — the
    // binding dialog has to offer a status column for either to ever be
    // reachable, the same way it already does for the tile beside it.
    text: true,
    bubble: null,
  },
  alertbadge: {
    label: 'Alarm annunciator',
    category: 'utility',
    Component: AlertBadge,
    defaultSize: { w: 156, h: 68 },
    ports: { signal: [0.5, 1] },
    binding: 'both',
    // Text-capable because the most direct way to annunciate is to read the
    // column that already says so — `status == 'FAULT'` rather than a numeric
    // code the operator has to translate.
    text: true,
    // The tile's own legend is the label, drawn inside the window, so it is the
    // one symbol here that prints nothing beneath itself.
    bubble: null,
  },

  // --- admin-authored ----------------------------------------------------
  /**
   * The one type that is not a drawing in this folder.
   *
   * A `custom` node's picture, size, ports and motion come from a row in
   * `mimic_symbols` that an admin authored from an uploaded image, resolved by
   * `symbolDef()` below. One registry entry covers the whole library, which is
   * what keeps this catalogue finite no matter how many symbols get uploaded,
   * and why `custom` is the one type the server knows by name: it is the only
   * one carrying a reference it has to check.
   *
   * The fields here are only the fallbacks used before the library resolves, or
   * if a node points at an entry that has been deleted.
   */
  custom: {
    label: 'Custom symbol',
    category: 'custom',
    Component: CustomSymbol,
    defaultSize: { w: 120, h: 120 },
    ports: {
      in: [0, 0.5], out: [1, 0.5], top: [0.5, 0], bottom: [0.5, 1],
    },
    binding: 'both',
    bubble: { anchor: [0.5, 0], offset: [0, -66] },
  },
}

export const SYMBOL_TYPES = Object.keys(SYMBOLS)

/**
 * Palette groups, in the order an engineer builds a drawing: the process
 * first, then what powers it, then what controls it, then the two plant
 * types this system was commissioned against.
 */
export const SYMBOL_CATEGORIES = [
  { id: 'process', label: 'Process' },
  { id: 'electrical', label: 'Electrical' },
  { id: 'automation', label: 'Automation' },
  { id: 'vision', label: 'Vision inspection' },
  { id: 'water', label: 'Water treatment' },
  { id: 'tobacco', label: 'Cigarette line' },
  { id: 'dcim', label: 'Data centre' },
  // After the disciplines, because these annotate a drawing rather than build
  // one: you reach for a counter once the plant it counts is already on the
  // sheet.
  { id: 'utility', label: 'Utility' },
  // Last on purpose: the uploaded library grows without bound, and it should
  // never push the drawn catalogue off the bottom of the palette.
  { id: 'custom', label: 'Custom' },
]

/**
 * SYMBOL_TYPES bucketed into SYMBOL_CATEGORIES order, for the palette.
 *
 * A type whose category is missing or unrecognised lands in a trailing
 * "Other" group rather than disappearing — a half-registered symbol should be
 * visibly wrong in the palette, not silently absent from it.
 */
export const SYMBOL_GROUPS = (() => {
  const groups = SYMBOL_CATEGORIES.map((c) => ({ ...c, types: [] }))
  const byId = new Map(groups.map((g) => [g.id, g]))
  const other = { id: 'other', label: 'Other', types: [] }

  SYMBOL_TYPES.forEach((type) => {
    (byId.get(SYMBOLS[type].category) ?? other).types.push(type)
  })

  return [...groups, other].filter((g) => g.types.length > 0)
})()

/**
 * The custom library, keyed by symbol id, as descriptors.
 *
 * Module-level mutable state, which needs justifying. Every consumer of a symbol
 * definition here is synchronous and hot: `portPoint` runs for every port of
 * every node on every render, the edge router calls it twice per wire, and
 * `resizeBox` needs a size mid-drag. The library, by contrast, arrives over the
 * network. Threading an async value through all of that would mean either
 * turning those pure functions into hooks or passing the library down through
 * every layer of the canvas — and the canvas would still have to render before
 * it landed.
 *
 * So the query populates this once on load (see setCustomDefs) and every call
 * site stays a plain function call. The cost is that a definition can be absent,
 * which is why `symbolDef` is documented to return the fallback rather than
 * throwing, and why nothing here assumes the map is populated.
 */
const CUSTOM_DEFS = new Map()

/**
 * Publish the custom library. Called once per fetch by MonitorPage.
 *
 * Each row is turned into the same descriptor shape as a native entry, so
 * everything downstream — the canvas, the palette, the port router, the balloon
 * placement — reads one shape and never branches on where the symbol came from.
 */
export function setCustomDefs(rows) {
  CUSTOM_DEFS.clear()
  ;(rows ?? []).forEach((row) => CUSTOM_DEFS.set(row.id, customDescriptor(row)))
}

/**
 * One library row as a registry descriptor.
 *
 * Exported because the palette has to preview an authored symbol before it is on
 * any drawing — and a preview built from different fields than the canvas uses
 * would be a preview of something else.
 */
export function customDescriptor(row) {
  return {
    ...SYMBOLS.custom,
    label: row.name,
    defaultSize: { w: row.w, h: row.h },
    // An authored symbol with no ports set still has to be wireable, so it
    // inherits the four compass points rather than becoming un-connectable.
    ports: row.ports && Object.keys(row.ports).length > 0
      ? row.ports
      : SYMBOLS.custom.ports,
    binding: row.binding || SYMBOLS.custom.binding,
    bubble: row.bubble ?? SYMBOLS.custom.bubble,
    asset_id: row.asset_id,
    dynamics: row.dynamics ?? [],
    symbolId: row.id,
  }
}

/** How many authored symbols this bundle currently knows about. */
export const customDefCount = () => CUSTOM_DEFS.size

/**
 * The descriptor for one node, whether it is drawn in this folder or authored by
 * an admin. **The single resolver — prefer this to indexing SYMBOLS directly.**
 *
 * May return undefined, for a node whose *type* this bundle has no renderer for
 * at all (a drawing saved by a newer build). Every caller has to tolerate that;
 * MimicCanvas turns it into a visible placeholder and MonitorPage locks the
 * drawing read-only.
 *
 * A custom node whose library entry is missing is a different case and is *not*
 * undefined: it falls back to the base `custom` descriptor, which draws the frame
 * and label with no picture. That is the right answer both while the library is
 * still in flight — the common case, on every page load — and if the entry was
 * deleted. Treating it as an unknown type would flash a placeholder on every
 * load and lock a perfectly good drawing.
 */
export function symbolDef(node) {
  if (!node) return undefined
  if (node.type === 'custom') {
    return CUSTOM_DEFS.get(node.symbolId) ?? SYMBOLS.custom
  }
  return SYMBOLS[node.type]
}

/**
 * True for an IP-camera symbol — the one type whose view-mode rail is not the
 * generic tag readout but the camera detail panel (see MonitorPage.jsx and
 * CameraRail.jsx). A function rather than an inline `type === 'ipcamera'`
 * check so a future custom-authored camera symbol is one edit away.
 */
export function isCameraNode(node) {
  return node?.type === 'ipcamera'
}

/** Absolute logical coordinates of one port on one node. */
export function portPoint(node, portName) {
  const def = symbolDef(node)
  const frac = def?.ports?.[portName] ?? def?.ports?.out ?? [0.5, 0.5]
  return { x: node.x + frac[0] * node.w, y: node.y + frac[1] * node.h }
}

/**
 * Where this node's balloon goes: its own `bubble` override if an admin has
 * dragged it, otherwise the symbol's default placement.
 *
 * The default is a sensible starting point for one symbol in isolation, but a
 * real drawing is crowded — two gauges in a column put one balloon on the
 * other's dial. So placement is per-node data, not a property of the type.
 * Returns null for symbols that carry no instrument at all.
 */
export function bubbleSpec(node) {
  const def = symbolDef(node)?.bubble
  if (!def) return null
  const own = node.bubble
  return {
    anchor: Array.isArray(own?.anchor) ? own.anchor : def.anchor,
    offset: Array.isArray(own?.offset) ? own.offset : def.offset,
  }
}

/** True when the node's balloon has been moved off its symbol default. */
export function bubbleMoved(node) {
  const def = symbolDef(node)?.bubble
  if (!def || !Array.isArray(node.bubble?.offset)) return false
  return node.bubble.offset[0] !== def.offset[0] || node.bubble.offset[1] !== def.offset[1]
}
