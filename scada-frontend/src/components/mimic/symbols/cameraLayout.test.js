import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLATE_MIN_W, REF_H, REF_W, cameraLayout, plateTurn, plateWidth, squeezedCodeWidth, titleAbove,
} from './cameraLayout.js'

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`)

/** The four corners of an axis-aligned rectangle given by its centre and half sizes. */
const corners = (cx, cy, hw, hh) => [
  [cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh],
]

const turn = ([x, y], deg, [cx, cy]) => {
  const th = (deg * Math.PI) / 180
  const dx = x - cx
  const dy = y - cy
  return [cx + dx * Math.cos(th) - dy * Math.sin(th), cy + dx * Math.sin(th) + dy * Math.cos(th)]
}

test('at the default size the drawing is drawn 1:1 in the node box', () => {
  const L = cameraLayout({ w: 110, h: 80, rot: 0 })
  assert.equal(L.k, 1)
  assert.equal(L.ox, 0)
  assert.equal(L.oy, 0)
  close(L.plate.x, 51)
  close(L.plate.y, 72.4)
})

test('the drawing is scaled uniformly and centred, never stretched', () => {
  // Wider than the 110:80 box allows: height decides, the spare width is split either side.
  const wide = cameraLayout({ w: 400, h: 160 })
  close(wide.k, 2)
  close(wide.ox, (400 - REF_W * 2) / 2)
  close(wide.oy, 0)

  // Taller than it allows: width decides.
  const tall = cameraLayout({ w: 216, h: 168 })
  close(tall.k, 216 / REF_W)
  close(tall.ox, 0)
  close(tall.oy, (168 - REF_H * tall.k) / 2)
})

test('the node on the Line 13 sheet (312 x 227) fills its box', () => {
  const L = cameraLayout({ w: 312, h: 227 })
  close(L.k, 312 / 110, 0.003)
  assert.ok(L.ox < 0.1 && L.oy < 0.1)
})

test('a camera lying down keeps its title with its plate: below the right way up, above upside down', () => {
  for (const rot of [0, 15, 30, 44, 45, 315, 330, 345, -15]) assert.equal(titleAbove(rot), false, `rot ${rot}`)
  for (const rot of [135, 136, 150, 180, 210, 224, 225]) assert.equal(titleAbove(rot), true, `rot ${rot}`)
})

test('a camera standing up has its title at the bracket end, away from the lens', () => {
  // Lens down (90°): the title is above. Lens up (270°): below, where it has always been.
  for (const rot of [46, 60, 90, 120, 134]) assert.equal(titleAbove(rot), true, `rot ${rot}`)
  for (const rot of [226, 240, 270, 300, 314, -90]) assert.equal(titleAbove(rot), false, `rot ${rot}`)
})

test('the title changes sides exactly twice in a full turn, at 45° and at 225°', () => {
  const flips = []
  for (let rot = 0; rot < 360; rot += 1) {
    if (titleAbove(rot) !== titleAbove((rot + 359) % 360)) flips.push(rot)
  }
  assert.deepEqual(flips, [46, 226])
})

test('turned 90°, the title is above the bracket instead of printed across the lens', () => {
  const L = cameraLayout({ w: 312, h: 227, rot: 90 })
  // Turned 90°, the bracket bar is the top of the drawing, 54.2 above the centre (55 - 0.8). The
  // plate beside the camera is lower than that. The title's frame reaches 1.3 title-heights
  // under its baseline — 15.6 for a 12-unit title — and keeps the usual margin of 2.
  const barTop = 227 / 2 - L.k * (55 - 0.8)
  close(L.labelY, barTop - 2 - 12 * 1.3)
  assert.ok(L.labelY < barTop, 'above the bar')
})

test('turned 270°, the title stays below the bracket, as it always was', () => {
  const L = cameraLayout({ w: 312, h: 227, rot: 270 })
  // The bracket bar is now the bottom of the drawing, 54.2 below the centre.
  close(L.labelY, 227 / 2 + L.k * (55 - 0.8) + 12 * 1.9 + 2)
})

test('upside down, the title is above the plate, which is on top', () => {
  const L = cameraLayout({ w: 110, h: 80, rot: 180 })
  // The plate's top edge is 1.3 down the box: the title's frame ends 2 above that.
  close(L.labelY, 1.3 - 2 - 12 * 1.3)
  assert.ok(L.labelY < 0, 'above the node box')
})

test('a title below the camera is never closer than the long-standing 18 under the node box', () => {
  for (let rot = 0; rot < 360; rot += 15) {
    if (titleAbove(rot)) continue
    assert.ok(cameraLayout({ w: 110, h: 80, rot }).labelY >= 80 + 18 - 1e-9, `rot ${rot}`)
  }
})

test('the title keeps clear of the drawing and the plate on its side, at every angle, size and placement', () => {
  const plateHalfW = 58 / 2
  const plateHalfH = 12.6 / 2
  for (const plateUpright of [false, true]) {
    for (const [w, h] of [[110, 80], [312, 227], [216, 168]]) {
      for (let rot = 0; rot < 360; rot += 15) {
        for (const labelSize of [8, 12, 24]) {
          const L = cameraLayout({ w, h, rot, labelSize, plateUpright })
          const centre = [w / 2, h / 2]
          // What is drawn: the camera's envelope, turned about the node centre, and the plate.
          const envelope = [[0.8, 16], [REF_W, 16], [REF_W, 62.1], [0.8, 62.1]]
            .map(([x, y]) => [L.ox + L.k * x, L.oy + L.k * y])
            .map((p) => turn(p, rot, centre))
          const plate = corners(L.plate.x, L.plate.y, plateHalfW * L.k, plateHalfH * L.k)
            .map((p) => turn(p, L.plate.turn, [L.plate.x, L.plate.y]))
          const ys = [...envelope, ...plate].map((p) => p[1])
          // What the title paints: its frame 1.9 title-heights up and 1.3 down, and the status
          // line, which hangs 15.5 below the baseline whatever the size.
          const top = L.labelY - labelSize * 1.9
          const bottom = L.labelY + Math.max(labelSize * 1.3, 15.5)
          const where = `${w}x${h} rot ${rot} size ${labelSize} ${plateUpright ? 'upright' : 'following'}`
          if (titleAbove(rot)) {
            assert.ok(bottom <= Math.min(...ys) - 2 + 1e-9, `${where}: title reaches ${bottom}, drawing starts ${Math.min(...ys)}`)
          } else {
            assert.ok(top >= Math.max(...ys) + 2 - 1e-9, `${where}: title starts ${top}, drawing reaches ${Math.max(...ys)}`)
          }
        }
      }
    }
  }
})

test('the title\'s plate clears the drawing, at any title size', () => {
  // Lying flat, the lowest thing drawn is the identity plate, 78.7 down the reference box.
  // The plate behind a title reaches about 1.9 title-heights above its baseline.
  for (const labelSize of [undefined, 8, 12, 16, 24, 32]) {
    const L = cameraLayout({ w: 110, h: 80, labelSize })
    const frameTop = L.labelY - (labelSize ?? 12) * 1.9
    assert.ok(frameTop >= 78.7 - 1e-9, `size ${labelSize}: frame top ${frameTop} is inside the drawing`)
  }
  // A small title is no closer than the long-standing 18 below the box.
  assert.equal(cameraLayout({ w: 110, h: 80, labelSize: 8 }).labelY, 98)
})

test('the plate keeps clear of the camera at every angle, however it is placed', () => {
  const W = 58
  const plateHalfW = W / 2
  const plateHalfH = 12.6 / 2
  const cases = []
  for (const plateUpright of [false, true]) {
    for (const size of [[110, 80], [312, 227], [216, 168]]) cases.push({ plateUpright, size })
  }
  for (const { plateUpright, size: [w, h] } of cases) {
    for (let rot = 0; rot < 360; rot += 15) {
      const L = cameraLayout({ w, h, rot, plateW: W, plateUpright })
      const centre = [w / 2, h / 2]
      // The camera's envelope — bracket bar to front glass, bar top to bracket bottom — in the
      // reference box, scaled into the node and turned about the node centre.
      const envelope = [[0.8, 16], [88.7, 16], [88.7, 62.1], [0.8, 62.1]]
        .map(([x, y]) => [L.ox + L.k * x, L.oy + L.k * y])
        .map((p) => turn(p, rot, centre))
      // The plate as drawn: a rectangle about its own centre, turned by plate.turn.
      const plateCentre = [L.plate.x, L.plate.y]
      const plate = corners(L.plate.x, L.plate.y, plateHalfW * L.k, plateHalfH * L.k)
        .map((p) => turn(p, L.plate.turn, plateCentre))

      // "Down" for the camera is its (0, 1) turned by the rotation. The camera's own underside is
      // the envelope's far edge along it; the plate's near edge along it must be further out.
      const th = (rot * Math.PI) / 180
      const u = [-Math.sin(th), Math.cos(th)]
      const along = (p) => p[0] * u[0] + p[1] * u[1]
      const cameraEdge = Math.max(...envelope.map(along))
      const plateEdge = Math.min(...plate.map(along))
      const gap = (plateEdge - cameraEdge) / L.k
      assert.ok(gap > 3.9, `${w}x${h} rot ${rot} ${plateUpright ? 'upright' : 'following'}: gap ${gap.toFixed(2)}`)
    }
  }
})

test('an upright plate stays flat at every angle, where a following one turns with the camera', () => {
  for (let rot = 0; rot < 360; rot += 15) {
    assert.equal(cameraLayout({ w: 110, h: 80, rot, plateUpright: true }).plate.turn, 0, `rot ${rot}`)
  }
  assert.equal(cameraLayout({ w: 110, h: 80, rot: 90 }).plate.turn, -90)
  assert.equal(cameraLayout({ w: 110, h: 80, rot: 90, plateUpright: false }).plate.turn, -90)
})

test('lying down, upright and following are the same plate', () => {
  for (const rot of [0, 15, 30, 44, 180, 195, 210, 224]) {
    const following = cameraLayout({ w: 110, h: 80, rot })
    const upright = cameraLayout({ w: 110, h: 80, rot, plateUpright: true })
    assert.deepEqual(upright, following, `rot ${rot}`)
  }
})

test('beside a standing camera an upright plate sits a plate-width out, as it was first drawn', () => {
  const a = cameraLayout({ w: 110, h: 80, rot: 90, plateUpright: true })
  const b = cameraLayout({ w: 110, h: 80, rot: 270, plateUpright: true })
  close(a.plate.x, -0.1)
  close(a.plate.y, 36)
  close(b.plate.x, 110.1)
  close(b.plate.y, 44)
  // Further out than the plate that follows the camera by what its width exceeds its height.
  const following = cameraLayout({ w: 110, h: 80, rot: 90 })
  close(following.plate.x - a.plate.x, 58 / 2 - 12.6 / 2)
})

test('the plate is never upside down and follows the nearer of the camera\'s two axes', () => {
  for (const rot of [0, 15, 30, 44, 180, 195, 210, 224, 360, -15]) assert.equal(plateTurn(rot), 0, `rot ${rot}`)
  for (const rot of [46, 60, 90, 120, 134, 226, 270, 300, 314, -90]) assert.equal(plateTurn(rot), -90, `rot ${rot}`)
  // Square to the camera in all four quarter turns.
  for (const rot of [0, 90, 180, 270]) {
    assert.equal((((plateTurn(rot) - rot) % 180) + 180) % 180, 0, `rot ${rot}`)
  }
})

test('a standing camera keeps its plate as close as a lying one: a plate-height away, not a plate-width', () => {
  const lying = cameraLayout({ w: 110, h: 80, rot: 0 })
  const standing = cameraLayout({ w: 110, h: 80, rot: 90 })
  // Same distance from the camera's axis in both: the plate sits flush along the body.
  close(Math.abs(lying.plate.y - 40), Math.abs(standing.plate.x - 55), 1e-6)
})

test('the plate swings to the side of a camera turned 90° and to the other side at 270°', () => {
  const a = cameraLayout({ w: 110, h: 80, rot: 90 })
  const b = cameraLayout({ w: 110, h: 80, rot: 270 })
  assert.ok(a.plate.x < 55 && b.plate.x > 55, 'left of the body one way, right of it the other')
  const flipped = cameraLayout({ w: 110, h: 80, rot: 180 })
  assert.ok(flipped.plate.y < 40, 'upside down, the underside is the top')
})

test('the plate grows for a long code and stops growing', () => {
  assert.equal(plateWidth(''), PLATE_MIN_W)
  assert.equal(plateWidth('CAM001-13'), PLATE_MIN_W, 'the code the plate was drawn for fits as drawn')
  assert.ok(plateWidth('CAM-LINE13-ST-04') > PLATE_MIN_W)
  assert.ok(plateWidth('CAM-LINE13-ST-04') < 100)
  assert.equal(plateWidth('X'.repeat(200)), 100)
})

test('a code too long for the widest plate is squeezed, one that fits is left alone', () => {
  assert.equal(squeezedCodeWidth('CAM001-13'), null)
  assert.equal(squeezedCodeWidth('CAM-LINE13-ST-04'), null)
  // 21 characters is past what the widest plate holds at the code's size.
  assert.ok(squeezedCodeWidth('CAM-LINE13-STATION-04') > 0)
  assert.ok(squeezedCodeWidth('X'.repeat(40)) > 0)
})

test('a code is measured in characters people see, not UTF-16 units', () => {
  assert.equal(plateWidth('กล้อง 1'), plateWidth('abcdefg'))
  assert.equal(plateWidth('😀😀'), plateWidth('ab'))
})
