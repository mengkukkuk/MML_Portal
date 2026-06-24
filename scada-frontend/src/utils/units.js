/**
 * units.js — curated catalogue of common measurement units for the Live panel
 * editor's per-value-column Unit picker (Grafana-style grouped dropdown).
 *
 * Each unit's `value` is the suffix string appended after a reading when it is
 * displayed (e.g. `4.4 bar`); `label` is the human-friendly dropdown entry.
 * Units are DISPLAY-ONLY — no value conversion or auto-scaling is performed.
 * Per-panel scaling (e.g. raw count → percent) is done with the Expression field.
 *
 * Unit `value`s are de-duplicated across the whole catalogue (each suffix appears
 * exactly once, in its most natural category) so el-option keys/values stay unique.
 */
export const UNIT_GROUPS = [
  {
    category: 'Misc',
    units: [
      { label: 'Percent (%)', value: '%' },
      { label: 'Per mille (‰)', value: '‰' },
      { label: 'Parts per million (ppm)', value: 'ppm' },
    ],
  },
  {
    category: 'Temperature',
    units: [
      { label: 'Celsius (°C)', value: '°C' },
      { label: 'Fahrenheit (°F)', value: '°F' },
      { label: 'Kelvin (K)', value: 'K' },
    ],
  },
  {
    category: 'Pressure',
    units: [
      { label: 'Pascal (Pa)', value: 'Pa' },
      { label: 'Kilopascal (kPa)', value: 'kPa' },
      { label: 'Bar (bar)', value: 'bar' },
      { label: 'Millibar (mbar)', value: 'mbar' },
      { label: 'Pounds/sq inch (psi)', value: 'psi' },
      { label: 'Atmosphere (atm)', value: 'atm' },
      { label: 'Millimetre mercury (mmHg)', value: 'mmHg' },
    ],
  },
  {
    category: 'Flow',
    units: [
      { label: 'Litres/second (L/s)', value: 'L/s' },
      { label: 'Litres/minute (L/min)', value: 'L/min' },
      { label: 'Cubic metres/hour (m³/h)', value: 'm³/h' },
      { label: 'Cubic metres/second (m³/s)', value: 'm³/s' },
      { label: 'Gallons/minute (GPM)', value: 'GPM' },
    ],
  },
  {
    category: 'Volume',
    units: [
      { label: 'Millilitre (mL)', value: 'mL' },
      { label: 'Litre (L)', value: 'L' },
      { label: 'Cubic metre (m³)', value: 'm³' },
      { label: 'Gallon (gal)', value: 'gal' },
    ],
  },
  {
    category: 'Mass',
    units: [
      { label: 'Milligram (mg)', value: 'mg' },
      { label: 'Gram (g)', value: 'g' },
      { label: 'Kilogram (kg)', value: 'kg' },
      { label: 'Tonne (t)', value: 't' },
      { label: 'Pound (lb)', value: 'lb' },
    ],
  },
  {
    category: 'Length / Level',
    units: [
      { label: 'Millimetre (mm)', value: 'mm' },
      { label: 'Centimetre (cm)', value: 'cm' },
      { label: 'Metre (m)', value: 'm' },
      { label: 'Kilometre (km)', value: 'km' },
      { label: 'Inch (in)', value: 'in' },
      { label: 'Foot (ft)', value: 'ft' },
    ],
  },
  {
    category: 'Speed',
    units: [
      { label: 'Metres/second (m/s)', value: 'm/s' },
      { label: 'Kilometres/hour (km/h)', value: 'km/h' },
      { label: 'Revolutions/minute (rpm)', value: 'rpm' },
    ],
  },
  {
    category: 'Frequency',
    units: [
      { label: 'Hertz (Hz)', value: 'Hz' },
      { label: 'Kilohertz (kHz)', value: 'kHz' },
    ],
  },
  {
    category: 'Electrical',
    units: [
      { label: 'Millivolt (mV)', value: 'mV' },
      { label: 'Volt (V)', value: 'V' },
      { label: 'Kilovolt (kV)', value: 'kV' },
      { label: 'Milliamp (mA)', value: 'mA' },
      { label: 'Amp (A)', value: 'A' },
      { label: 'Ohm (Ω)', value: 'Ω' },
      { label: 'Kilo-ohm (kΩ)', value: 'kΩ' },
      { label: 'Watt (W)', value: 'W' },
      { label: 'Kilowatt (kW)', value: 'kW' },
      { label: 'Megawatt (MW)', value: 'MW' },
      { label: 'Watt-hour (Wh)', value: 'Wh' },
      { label: 'Kilowatt-hour (kWh)', value: 'kWh' },
      { label: 'Megawatt-hour (MWh)', value: 'MWh' },
      { label: 'Volt-amp (VA)', value: 'VA' },
      { label: 'Kilovolt-amp (kVA)', value: 'kVA' },
      { label: 'Reactive power (var)', value: 'var' },
      { label: 'Power factor (pf)', value: 'pf' },
    ],
  },
  {
    category: 'Time',
    units: [
      { label: 'Millisecond (ms)', value: 'ms' },
      { label: 'Second (s)', value: 's' },
      { label: 'Minute (min)', value: 'min' },
      { label: 'Hour (h)', value: 'h' },
    ],
  },
  {
    category: 'Data',
    units: [
      { label: 'Bytes (B)', value: 'B' },
      { label: 'Kilobytes (KB)', value: 'KB' },
      { label: 'Megabytes (MB)', value: 'MB' },
      { label: 'Gigabytes (GB)', value: 'GB' },
      { label: 'Bits/second (bit/s)', value: 'bit/s' },
      { label: 'Kilobits/second (kbit/s)', value: 'kbit/s' },
      { label: 'Megabits/second (Mbit/s)', value: 'Mbit/s' },
    ],
  },
  {
    category: 'Angle / Accel / Force / Energy',
    units: [
      { label: 'Degree (°)', value: '°' },
      { label: 'Radian (rad)', value: 'rad' },
      { label: 'Metres/second² (m/s²)', value: 'm/s²' },
      { label: 'G-force (g)', value: 'g' },
      { label: 'Newton (N)', value: 'N' },
      { label: 'Kilonewton (kN)', value: 'kN' },
      { label: 'Joule (J)', value: 'J' },
      { label: 'Kilojoule (kJ)', value: 'kJ' },
      { label: 'Calorie (cal)', value: 'cal' },
    ],
  },
  {
    category: 'Concentration',
    units: [
      { label: 'Moles/litre (mol/L)', value: 'mol/L' },
      { label: 'Milligrams/litre (mg/L)', value: 'mg/L' },
      { label: 'Acidity (pH)', value: 'pH' },
    ],
  },
]
