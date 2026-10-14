import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { captionFont, labelPlace, labelProps, uprightFrame } from './labelPlacement.js'

const node = (over = {}) => ({ w: 176, h: 82, rot: 0, options: {}, ...over })

describe('labelPlace', () => {
  it('defaults to below and ignores unknown values', () => {
    assert.equal(labelPlace(undefined), 'below')
    assert.equal(labelPlace({ labelPlace: 'sideways' }), 'below')
    assert.equal(labelPlace({ labelPlace: 'left' }), 'left')
  })
})

describe('labelProps', () => {
  it('keeps the historical h + 18 baseline at the default size', () => {
    const p = labelProps(node())
    assert.equal(p.x, 88)
    assert.ok(Math.abs(p.y - (82 + 9 + 12 * 0.72)) < 1e-9)
    assert.equal(p.textAnchor, 'middle')
    assert.equal(p.transform, undefined)
  })

  it('stays outside the box at any size', () => {
    for (const h of [40, 82, 300]) {
      assert.ok(labelProps(node({ h })).y > h)
      assert.ok(labelProps(node({ h, options: { labelPlace: 'above' } })).y < 0)
    }
  })

  it('anchors side placements to the facing edge', () => {
    const l = labelProps(node({ options: { labelPlace: 'left' } }))
    const r = labelProps(node({ options: { labelPlace: 'right' } }))
    assert.equal(l.textAnchor, 'end')
    assert.ok(l.x < 0)
    assert.equal(r.textAnchor, 'start')
    assert.ok(r.x > 176)
  })

  it('uses the rotated bounding box so a quarter turn clears the visual edge', () => {
    const p = labelProps(node({ rot: 90 }))
    // Rotated, the box is 176 tall on screen: half-height 88 below centre 41.
    assert.ok(p.y > 41 + 88)
    assert.equal(p.transform, 'rotate(-90 88 41)')
  })

  it('returns null when hidden', () => {
    assert.equal(labelProps(node({ options: { labelPlace: 'hidden' } })), null)
  })
})

describe('captionFont', () => {
  it('uses the automatic size when it fits', () => {
    assert.equal(captionFont(node(), { auto: 10, width: 200, text: 'total' }), 10)
  })

  it('shrinks a long caption to its width, never below 6px', () => {
    const size = captionFont(node(), { auto: 10, width: 60, text: 'a_very_long_tag_id' })
    assert.ok(size < 10 && size >= 6)
    assert.equal(captionFont(node(), { auto: 10, width: 5, text: 'x'.repeat(50) }), 6)
  })

  it('honours an explicit size and the hidden flag', () => {
    assert.equal(captionFont(node({ options: { captionSize: 16 } }), { auto: 10, width: 10, text: 'long text' }), 16)
    assert.equal(captionFont(node({ options: { captionHidden: true } }), { auto: 10, width: 200, text: 'x' }), null)
  })
})

describe('uprightFrame', () => {
  // Maps a point drawn in the frame through the frame transform and then the
  // canvas's own rotate(rot, w/2, h/2), returning where it lands on screen
  // relative to the node origin.
  const toScreen = (n, f, [px, py]) => {
    const rot = n.rot || 0
    const cx = n.w / 2
    const cy = n.h / 2
    // translate, then rotate(-rot) about centre, then rotate(+rot) about centre.
    const x = px + (n.w - f.w) / 2
    const y = py + (n.h - f.h) / 2
    return [x - cx, y - cy].map((v) => Math.round(v * 1000) / 1000)
  }

  it('is the node itself when upright or tilted off a quarter turn', () => {
    assert.deepEqual(uprightFrame(node()), { w: 176, h: 82 })
    assert.deepEqual(uprightFrame(node({ rot: 15 })), { w: 176, h: 82 })
  })

  it('keeps the frame the same size at 180 and swaps it at 90/270', () => {
    assert.deepEqual(
      [uprightFrame(node({ rot: 180 })).w, uprightFrame(node({ rot: 180 })).h], [176, 82])
    for (const rot of [90, 270, -90]) {
      const f = uprightFrame(node({ rot }))
      assert.deepEqual([f.w, f.h], [82, 176])
    }
  })

  it('puts the frame top-left at the visual top-left of the rotated box', () => {
    for (const rot of [90, 180, 270]) {
      const n = node({ rot })
      const f = uprightFrame(n)
      // Top-left corner of the frame, relative to centre, is (-fw/2, -fh/2):
      // upright on screen, so the caption drawn there is top-left as seen.
      assert.deepEqual(toScreen(n, f, [0, 0]), [-f.w / 2, -f.h / 2])
    }
  })
})
