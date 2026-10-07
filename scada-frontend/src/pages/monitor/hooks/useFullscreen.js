import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Full screen — the drawing on its own, for a control-room wall, and in edit
 * mode the whole workspace: palette, sheet and inspector.
 *
 * Both modes used to send only the canvas, which put a viewer on a wall
 * display with a drawing and no way to see what a symbol they clicked was
 * reporting — same problem the editor had with no way to add or bind a
 * symbol. `stageRef` therefore lands on the whole workspace in both modes:
 * the editor's palette/sheet/inspector grid while editing, and the
 * sheet/rail grid (`.body`) while viewing — one ref, because the two modes
 * never mount at the same time.
 *
 * The browser owns this state: Esc, F11 and the window manager can all leave
 * it without asking us. So this mirrors `document.fullscreenElement` from the
 * event rather than keeping a second opinion that could go stale. Switching
 * modes unmounts the fullscreen element, which the browser answers by exiting
 * and firing the same event, so that case needs no cleanup of its own.
 */
export default function useFullscreen() {
  // The element that goes full screen: the sheet *and* its controls, not the
  // bare <svg>. A wall display that loses the pan tool and the zoom readout the
  // moment it fills the screen is a picture, not a mimic.
  const stageRef = useRef(null)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    // The null guard is load-bearing: the drawing has not mounted on the first
    // render, so an unguarded identity test compares null to null and reports
    // full screen before there is anything to show full screen.
    const sync = () => setFullscreen(
      !!stageRef.current && document.fullscreenElement === stageRef.current,
    )
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {})
      return
    }
    stageRef.current?.requestFullscreen?.().catch(() => {})
  }, [])

  /**
   * Where overlays open.
   *
   * A full-screen element is the only subtree the browser paints, and every
   * dialog here portals to `<body>` by default — which is outside it. Left
   * alone, "Connect data source" on a wall display opens a dialog nobody can
   * see and traps focus in it. Re-homing them into whichever element is
   * currently full screen is what makes the editor genuinely usable there.
   */
  const overlayHost = fullscreen ? stageRef.current : undefined

  return { stageRef, fullscreen, toggleFullscreen, overlayHost }
}
