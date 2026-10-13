/**
 * Which drawing an IP camera symbol uses, and where its identity plate goes — pure, so the
 * defaults are unit-tested (cameraStyle.test.js) and the drawing and the inspector agree on them.
 *
 * Both choices live in `node.options`, which the server stores untouched, and neither is written
 * for its default: a camera drawn before there was a choice, and one nobody has touched, keep the
 * JSON they always had. The first drawing is not retired for the second. A sheet that was laid out
 * around it, or an engineer who simply prefers it, can still pick it.
 */

export const CAMERA_STYLES = [
  {
    id: 'smart',
    label: 'Smart camera',
    hint: 'A box camera on a profile bracket, with a C-mount lens, status LEDs, the field of view and an ID plate showing the camera code.',
  },
  {
    id: 'classic',
    label: 'Classic',
    hint: 'The original barrel-and-lens drawing. It stretches to fill its box and has no ID plate.',
  },
]

export const DEFAULT_CAMERA_STYLE = 'smart'

/**
 * Where the smart camera's ID plate sits. The two only differ for a camera turned on its side:
 * lying down (0° or 180°) the plate is flat either way.
 */
export const PLATE_PLACEMENTS = [
  {
    id: 'follow',
    label: 'Follows the camera',
    hint: 'The plate turns with a camera that stands up and reads upward, close against its body, so a neighbouring camera is never behind it.',
  },
  {
    id: 'upright',
    label: 'Always upright',
    hint: 'The plate stays flat on the sheet at any angle. Beside a camera that stands up it sits a plate-width out to the side.',
  },
]

export const DEFAULT_PLATE_PLACEMENT = 'follow'

/** The stored style, or the default when it is missing or not one we know. */
export function cameraStyle(options) {
  const id = options?.cameraStyle
  return CAMERA_STYLES.some((s) => s.id === id) ? id : DEFAULT_CAMERA_STYLE
}

/** The stored plate placement, or the default when it is missing or not one we know. */
export function platePlacement(options) {
  const id = options?.platePlacement
  return PLATE_PLACEMENTS.some((p) => p.id === id) ? id : DEFAULT_PLATE_PLACEMENT
}
