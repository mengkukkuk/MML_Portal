/**
 * kpiFormulas — the ⓘ "how it's calculated" text of each management block.
 *
 * Thai first: every line is a [th, en] pair and the popover opens in Thai. The
 * equations restate kpi_engine.py / kpi.py in plant words, with the block's own
 * settings filled in (run ratio, stop cutoff, working hours), so a manager reads
 * the rule that produced *this* tile rather than a generic one. No React here,
 * so kpiFormulas.test.js runs under `node --test`.
 */

const SEVERITY_TH = { crit: 'วิกฤต', warn: 'เตือน', info: 'ข้อมูล' }
const SEVERITY_EN = { crit: 'Critical', warn: 'Warning', info: 'Info' }
const DAYS_TH = ['', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา']
const DAYS_EN = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** "จ–ส 07:00–17:30" / "Mon–Sat 07:00–17:30"; null without working hours. */
export function hoursText(hours, lang) {
  if (!hours?.start || !hours?.end) return null
  const names = lang === 'th' ? DAYS_TH : DAYS_EN
  const days = [...(hours.days?.length ? hours.days : [1, 2, 3, 4, 5, 6, 7])].sort((a, b) => a - b)
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  const dayText = days.length === 7 ? (lang === 'th' ? 'ทุกวัน' : 'every day')
    : contiguous && days.length > 2 ? `${names[days[0]]}–${names[days[days.length - 1]]}`
      : days.map((d) => names[d]).join(', ')
  return `${dayText} ${hours.start}–${hours.end}`
}

function settingsOf(kpi = {}) {
  return {
    runPct: Math.round(100 * (kpi.run_ratio ?? 0.8)),
    minStop: kpi.min_stop_sec ?? 60,
    cutoff: kpi.max_loss_stop_min ?? 120,
    flat: kpi.flat_min ?? 10,
    hours: kpi.working_hours || null,
    mode: kpi.mode || 'defects',
    metrics: kpi.metrics?.length ? kpi.metrics : ['plan_pct', 'yield', 'availability'],
    place: kpi.response_location || null,
    severityTh: SEVERITY_TH[kpi.alert_min_severity] || SEVERITY_TH.warn,
    severityEn: SEVERITY_EN[kpi.alert_min_severity] || SEVERITY_EN.warn,
  }
}

/** The shared rules every speed-based block stands on: buckets, minute states, targets. */
function stateRules(s) {
  return [
    ['ชิ้นงาน = Σ ความเร็ว × วินาทีที่วัดได้ ÷ 60 (ความเร็วเป็นชิ้น/นาที)',
      'Pieces = Σ speed × covered seconds ÷ 60 (speed is pieces/min)'],
    ['ของเสีย = Σ อัตราของเสีย × วินาทีที่วัดได้ ÷ 60', 'Defects = Σ defect rate × covered seconds ÷ 60'],
    ['ไม่มีข้อมูล: ในนาทีนั้นไม่มีค่าที่ใช้ได้ ≥ 30 วินาที', 'No data: ≥ 30 s of the minute without a valid reading'],
    ['หยุด: ความเร็ว ≤ เกณฑ์หยุด ≥ 30 วินาทีของนาที', 'Stopped: speed at or below the stop threshold for ≥ 30 s'],
    [`ช้า: ความเร็วเฉลี่ย < ${s.runPct}% ของเป้า`, `Slow: mean speed < ${s.runPct}% of target`],
    ['เดิน: นอกเหนือจากข้างบน', 'Running: anything else'],
    [`หยุดสั้นกว่า ${s.minStop} วินาที นับเป็นเดิน`, `Stops shorter than ${s.minStop} s count as running`],
    ['เป้า = ค่าที่ตั้งไว้ หรือ P95 ของความเร็วขณะเดิน (อัตโนมัติ)',
      'Target = the value set, else P95 of running speed (auto)'],
  ]
}

function lossRules(s) {
  const hours = [hoursText(s.hours, 'th'), hoursText(s.hours, 'en')]
  return [
    ['ชิ้นที่เสียไปต่อนาที = max(0, เป้า × วินาทีที่วัดได้ ÷ 60 − ชิ้นที่ทำได้)',
      'Lost per minute = max(0, target × covered s ÷ 60 − pieces made)'],
    hours[0]
      ? [`หยุดในเวลาทำงาน (${hours[0]}) นับทุกครั้ง ไม่ว่านานเท่าไร`,
        `A stop inside working hours (${hours[1]}) always counts, however long`]
      : ['ไม่ได้ตั้งเวลาทำงาน: ทุกการหยุดใช้เกณฑ์ความยาวด้านล่าง',
        'No working hours set: every stop is judged by length below'],
    [`นอกเวลาทำงาน หยุด ≤ ${s.cutoff} นาที นับเป็นความสูญเสีย ยาวกว่านั้น = ไม่ได้วางแผนผลิต (สีเทา)`,
      `Outside working hours a stop ≤ ${s.cutoff} min counts; longer = not scheduled (grey)`],
    ['หยุดที่ยังไม่จบและยังไม่ถึงเกณฑ์ = รอสรุป (ยังไม่นับ)', 'A stop still open and under the cutoff = pending (not counted yet)'],
    ['ไม่มีข้อมูล ไม่นับเป็นความสูญเสีย — ไม่รู้ ≠ หยุด', 'No data loses nothing — not knowing is not stopping'],
  ]
}

const METRIC_LINES = {
  plan_pct: [
    ['ได้ตามแผน = ชิ้นดี ÷ แผนถึงตอนนี้', 'Good vs plan = good ÷ plan to date'],
    ['แผนถึงตอนนี้ = แผนรวม × นาทีทำงานที่ผ่านไป ÷ นาทีทำงานทั้งงวด',
      'Plan to date = plan × planned minutes so far ÷ planned minutes in the period'],
  ],
  yield: [['ผลได้ = ชิ้นดี ÷ ชิ้นที่ผลิต', 'Yield = good ÷ pieces made']],
  availability: [
    ['เวลาเดินเครื่อง = (เดิน + ช้า) ÷ (เดิน + ช้า + หยุดที่นับ)', 'Running time = (run + slow) ÷ (run + slow + counted stop)'],
  ],
  risk_pieces: [['ชิ้นงานเสี่ยง = ชิ้นที่ผลิตในนาทีที่เซนเซอร์ใดหลุดช่วงหรือค้าง',
    'Pieces at risk = pieces made in minutes any sensor was out of band or frozen']],
  blind_min: [['เวลามองไม่เห็น = นาทีที่วางแผนผลิตและเซนเซอร์ใดค้างหรือขาดหาย',
    'Blind time = scheduled minutes any sensor was frozen or missing']],
  avg_response_min: [['เวลาตอบสนอง = เฉลี่ย(เวลาที่ปรับพารามิเตอร์ครั้งแรก − เวลาเริ่มเหตุการณ์)',
    'Response time = mean(first parameter change − incident start)']],
  good: [['ชิ้นดี = ชิ้นที่ผลิต − ของเสีย', 'Good = pieces − defects']],
  pieces: [['ชิ้นที่ผลิต = Σ ความเร็ว × เวลา', 'Pieces made = Σ speed × time']],
  defects: [['ของเสีย = Σ ของเสียจากทุกกล้องในไลน์', 'Defects = Σ rejects from every camera on the line']],
  defect_rate: [['อัตราของเสีย = ของเสีย ÷ ชิ้นที่ผลิต', 'Defect rate = defects ÷ pieces']],
  lost: [['ผลผลิตที่เสียไป = เสียจากการหยุด + เสียจากเดินช้า', 'Production lost = stop loss + slow loss']],
  cost_total: [['ความสูญเสียรวม = (ของเสีย + ผลผลิตที่เสียไป) × ราคาต่อชิ้น',
    'Total loss = (defects + production lost) × price per piece']],
  incidents: [['เหตุการณ์ = ช่วงที่เซนเซอร์หลุดช่วง (ห่างกัน ≤ 3 นาที รวมเป็นครั้งเดียว)',
    'Incidents = out-of-band spans (gaps ≤ 3 min joined)']],
}

const LOSSMETER_LINES = {
  defects: ['ค่าของเสีย = ของเสีย × ราคาต่อชิ้น', 'Defect cost = defects × price per piece'],
  lost: ['ผลผลิตที่เสียไป = (เสียจากการหยุด + เสียจากเดินช้า) × ราคาต่อชิ้น',
    'Production lost = (stop loss + slow loss) × price per piece'],
  total: ['ความสูญเสียรวม = (ของเสีย + ผลผลิตที่เสียไป) × ราคาต่อชิ้น',
    'Total loss = (defects + production lost) × price per piece'],
}

/**
 * Per block: the question it answers, its equations, why a manager reads it,
 * and which shared rule sets it rests on.
 */
const BLOCKS = {
  kpistrip: (s) => ({
    question: ['ตัวเลขหลักของงวดนี้เป็นอย่างไร', 'How is this period doing, at a glance?'],
    lines: s.metrics.flatMap((m) => METRIC_LINES[m] || []),
    why: ['ตอบคำถาม "ได้ตามแผนไหม คุณภาพดีไหม เครื่องเดินไหม ควบคุมได้ไหม" ในแถวเดียว สีเหลือง/แดงบอกปัญหาก่อนอ่านตัวเลข',
      'Answers "on plan, on quality, running, in control?" in one row — colour flags a problem before the digits are read.'],
    rules: ['states', 'loss'],
  }),
  pace: () => ({
    question: ['ผลิตได้ทันแผนไหม', 'Are we keeping pace with the plan?'],
    lines: [
      ['เส้นทึบ = ชิ้นดีสะสม', 'Solid line = cumulative good pieces'],
      ['เส้นประ = แผนสะสม ตามสัดส่วนนาทีทำงาน', 'Dashed line = cumulative plan, by planned minutes'],
      ['เส้นบน = ผลิตได้ถ้าไม่เสีย = ชิ้นที่ผลิต + ผลผลิตที่เสียไป (สะสม)',
        'Upper line = could have made = pieces + production lost (cumulative)'],
      ['แถบพื้นหลัง = ช่วงหยุด / ไม่มีข้อมูล', 'Bands = stopped / no-data stretches'],
    ],
    why: ['ช่องว่างระหว่างชิ้นดีกับแผน = ตามหลังเท่าไร ช่องว่างระหว่างเส้นบนกับชิ้นดี = ส่วนที่ไลน์เสียเอง (หยุด/ช้า/ของเสีย)',
      'Good-to-plan gap = how far behind; upper-line-to-good gap = how much of it the line lost itself (stops, slow, defects).'],
    rules: ['states', 'loss'],
  }),
  hourly: () => ({
    question: ['ของเสียเกิดช่วงไหน', 'When did the defects happen?'],
    lines: [
      ['อัตราต่อแท่ง = ของเสีย ÷ ชิ้นที่ผลิต ในช่วงนั้น', 'Bar rate = defects ÷ pieces in that bucket'],
      ['แท่งแดง = สูงกว่าค่าเฉลี่ยของงวด (Σ ของเสีย ÷ Σ ชิ้นที่ผลิต)',
        'Red bar = above the period average (Σ defects ÷ Σ pieces)'],
      ['วันนี้: แท่งละ 1 ชม. · สัปดาห์/เดือน: แท่งละ 1 วัน', 'Today: one bar per hour · week/month: one per day'],
    ],
    why: ['ชี้ว่ากะหรือวันไหนผิดปกติ — รู้ว่าต้องไปดูช่วงไหน ไม่ใช่แค่เสียเท่าไร',
      'Points to the shift or day that went wrong — when to look, not just how much.'],
    rules: ['states'],
  }),
  sensors: (s) => ({
    question: ['เซนเซอร์เชื่อถือได้ไหม', 'Can the sensor readings be trusted?'],
    lines: [
      ['ปกติ: ค่าอยู่ในช่วง ต่ำ–สูง ของตัวเอง', 'OK: reading inside its own low–high band'],
      ['หลุดช่วง: นอกช่วง ≥ 30 วินาทีของนาที', 'Out: outside the band for ≥ 30 s of the minute'],
      [`ค้าง: ค่าไม่เปลี่ยนเลย ≥ ${s.flat} นาที (สำคัญกว่าหลุดช่วง — มักเป็นเซนเซอร์เสีย)`,
        `Frozen: value unchanged for ≥ ${s.flat} min (outranks out — usually a dead sensor)`],
      ['ขาดหาย: มีค่าน้อยกว่า 30 วินาทีของนาที', 'Missing: under 30 s of readings in the minute'],
    ],
    why: ['ถ้าเซนเซอร์ค้างหรือขาด ตัวเลขอื่นที่อิงเซนเซอร์ก็เชื่อไม่ได้ — ต้องซ่อมก่อนตัดสินใจ',
      'A frozen or missing sensor makes every figure built on it doubtful — fix it before acting on them.'],
    rules: [],
  }),
  pareto: () => ({
    question: ['ของเสียมาจากไหน', 'Where do the defects come from?'],
    lines: [
      ['แท่ง = Σ ของเสียของแต่ละประเภทในแต่ละกล้อง เรียงมากไปน้อย',
        'Bar = Σ defects per camera and defect type, largest first'],
      ['เส้นสะสม = ผลรวมสะสม ÷ ของเสียทั้งหมด', 'Cumulative line = running total ÷ all defects'],
    ],
    why: ['หลัก 80/20: แก้แท่งแรก ๆ ที่รวมกันถึง ~80% ได้ผลมากที่สุด',
      '80/20 rule: fixing the first few bars that reach ~80% pays back most.'],
    rules: ['states'],
  }),
  response: (s) => ({
    question: ['มีการแจ้งเตือนอะไร และใครต้องดำเนินการ', 'What is the plant alerting, and who has to act?'],
    lines: [
      ['ที่มา = แหล่งการแจ้งเตือนที่ตั้งไว้ใน ตั้งค่า → Alert messages', 'Source = the alert source in Settings → Alert messages'],
      ['เหตุการณ์ = การแจ้งเตือนที่ซ้ำกัน (ตำแหน่ง · ระดับ · ผู้รับผิดชอบ · ข้อความก่อน ":") ห่างกัน ≤ 5 นาที รวมเป็นครั้งเดียว',
        'Event = repeats of one alert (location · level · owner · text before ":") ≤ 5 min apart, joined'],
      ['ผู้ต้องดำเนินการ: ① Role ID ในแถวการแจ้งเตือน ② กฎของตำแหน่งนั้น ③ กฎ global (ตามลำดับความสำคัญ)',
        'Who must act: ① the row’s Role ID ② the rule for its location ③ a global rule (by priority)'],
      [`แสดงตั้งแต่ระดับ ${s.severityTh} ขึ้นไป — ระดับต่ำกว่านับไว้แต่ไม่แสดง`,
        `Listed from ${s.severityEn} up — lower levels are counted, not listed`],
      s.place
        ? [`ตำแหน่ง: เฉพาะการแจ้งเตือนที่ ${s.place}`, `Location: only alerts at ${s.place}`]
        : ['ตำแหน่ง: ทุกตำแหน่ง', 'Location: every location'],
      ['ตำแหน่งที่ไม่มีกฎของตัวเอง จะถูกเตือนไว้ด้านบน (การแจ้งเตือนไปที่กฎ global)',
        'A location with no rule of its own is flagged on top (its alerts go to a global rule)'],
    ],
    why: ['บอกว่าใครมีงานค้างกี่เรื่อง และการแจ้งเตือนแต่ละเรื่องส่งถึงคนที่ถูกต้องหรือไม่',
      'Shows who has how much to act on, and whether each alert reaches the right person.'],
    rules: [],
  }),
  andon: () => ({
    question: ['ตอนนี้เครื่องไหนหยุด และนานเท่าไร', 'Which machine is down right now, and for how long?'],
    lines: [
      ['สถานะ = สถานะของนาทีล่าสุด · เวลา = นับจากเริ่มสถานะนั้น', 'State = latest minute · time = since that state began'],
      ['ความเร็ว เทียบ เป้า ของแต่ละเครื่อง', 'Speed against each machine’s own target'],
      ['% เดินเครื่อง = (เดิน + ช้า) ÷ (เดิน + ช้า + หยุดที่นับ)', 'Running % = (run + slow) ÷ (run + slow + counted stop)'],
      ['แถบสี 24 ชม.: หยุดนานนอกเวลาทำงานแสดงเป็นสีเทา ไม่ใช่สีแดง',
        '24 h strip: a long stop outside working hours shows grey, not red'],
    ],
    why: ['บอกว่าต้องเดินไปที่เครื่องไหนเดี๋ยวนี้', 'Tells you which machine to walk to now.'],
    rules: ['states', 'loss'],
  }),
  kpitrend: () => ({
    question: ['7 วันที่ผ่านมาดีขึ้นหรือแย่ลง', 'Better or worse over the last 7 days?'],
    lines: [
      ['ทุกจุด = การคำนวณเดียวกันกับบล็อกอื่น แยกตามวันปฏิทิน', 'Each point = the same calculation, per calendar day'],
      ['ผลได้ = ชิ้นดี ÷ ชิ้นที่ผลิต · เวลาเดินเครื่อง = (เดิน + ช้า) ÷ เวลาที่วางแผน',
        'Yield = good ÷ pieces · running time = (run + slow) ÷ scheduled'],
      ['ผลผลิตที่เสียไป · ค่าของเสีย · เวลามองไม่เห็น ต่อวัน', 'Production lost · defect cost · blind time per day'],
    ],
    why: ['แยก "วันแย่วันเดียว" ออกจาก "แนวโน้มจริง" และยืนยันว่าการแก้ไขได้ผลต่อเนื่อง',
      'Separates one bad day from a real trend, and shows whether a fix held.'],
    rules: ['states', 'loss'],
  }),
  lossmeter: (s) => ({
    question: ['งวดนี้เสียเงินไปเท่าไร', 'How much has this period cost us?'],
    lines: [
      LOSSMETER_LINES[s.mode] || LOSSMETER_LINES.defects,
      ['ลูกศร = เทียบกับช่วงเวลาเดียวกันของงวดก่อน (▲ = แย่ลง)', 'Arrow = vs the same elapsed time last period (▲ = worse)'],
      ['ตัวเลขรอสรุป = การหยุดที่ยังไม่จบ อาจถูกนับภายหลัง', 'Pending = a stop still open, may be counted later'],
    ],
    why: ['ตัวเลขเงินตัวเดียวสำหรับ "ความไม่มีประสิทธิภาพทำให้เสียเท่าไร" — ภาษาที่ผู้บริหารใช้',
      'One money figure for "what inefficiency cost us" — the language management uses.'],
    rules: s.mode === 'defects' ? ['states'] : ['states', 'loss'],
  }),
  waterfall: () => ({
    question: ['ผลผลิตหายไปไหน', 'Where did the output go?'],
    lines: [
      ['ผลิตได้ถ้าไม่เสีย = ชิ้นที่ผลิต + เสียจากการหยุด + เสียจากเดินช้า',
        'Potential = pieces + stop loss + slow loss'],
      ['ผลิตได้ถ้าไม่เสีย − หยุด − เดินช้า − ของเสีย = ชิ้นดี', 'Potential − stops − slow − defects = good'],
      ['แท่งที่เน้น = ความสูญเสียที่ใหญ่ที่สุด', 'Highlighted bar = the largest loss'],
    ],
    why: ['บอกว่าควรแก้อะไรก่อน: หยุด (ซ่อมบำรุง) · ช้า (ปรับกระบวนการ) · ของเสีย (คุณภาพ)',
      'Shows what to fix first: stops (maintenance) · slow (process) · defects (quality).'],
    rules: ['states', 'loss'],
  }),
}

export const EXPLAIN_TYPES = Object.freeze(Object.keys(BLOCKS))

const HEADINGS = {
  how: ['คำนวณอย่างไร', 'How it is calculated'],
  states: ['สถานะรายนาที', 'Minute states'],
  loss: ['การนับความสูญเสีย', 'Counting losses'],
  why: ['ประโยชน์ต่อผู้จัดการ', 'Why it matters'],
}

/**
 * The popover's content for `chartType` in `lang` ('th' | 'en'), or null for
 * a type with no explanation. `kpi` is the block's saved settings.
 */
export function explainBlock(chartType, kpi, lang = 'th') {
  const build = BLOCKS[chartType]
  if (!build) return null
  const s = settingsOf(kpi)
  const k = lang === 'en' ? 1 : 0
  const pick = (pair) => pair[k]
  const b = build(s)
  const sections = [{ heading: pick(HEADINGS.how), lines: b.lines.map(pick), formula: true }]
  if (b.rules.includes('states')) sections.push({ heading: pick(HEADINGS.states), lines: stateRules(s).map(pick) })
  if (b.rules.includes('loss')) sections.push({ heading: pick(HEADINGS.loss), lines: lossRules(s).map(pick) })
  return { question: pick(b.question), sections, why: { heading: pick(HEADINGS.why), text: pick(b.why) } }
}
