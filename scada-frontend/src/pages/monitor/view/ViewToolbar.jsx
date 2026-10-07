import PanToolOutlined from '@mui/icons-material/PanToolOutlined'
import ZoomInOutlined from '@mui/icons-material/ZoomInOutlined'
import ZoomOutOutlined from '@mui/icons-material/ZoomOutOutlined'
import CenterFocusStrongOutlined from '@mui/icons-material/CenterFocusStrongOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import FullscreenOutlined from '@mui/icons-material/FullscreenOutlined'
import FullscreenExitOutlined from '@mui/icons-material/FullscreenExitOutlined'
import BarChartOutlined from '@mui/icons-material/BarChartOutlined'
import styles from '../MonitorPage.module.css'

/**
 * The view-mode control cluster: log, hand, zoom, fit, full screen.
 *
 * Rendered in one of two places — floating over the sheet when windowed,
 * inside the banner when full screen. One component because two copies would
 * be two sets of controls to keep in step, and because only one may exist in
 * the tree at a time: they carry `aria-controls` and keyboard hints that must
 * not be duplicated. The caller decides where the one instance goes.
 */
export default function ViewToolbar({
  fullscreen, onToggleFullscreen,
  productionLogOpen, onToggleLog,
  viewPan, onTogglePan,
  viewZoom, canvasRef,
}) {
  return (
    <div
      className={`${styles.viewTools} ${fullscreen ? styles.viewToolsInBanner : ''}`}
      role="group"
      aria-label="View controls"
    >
      <button
        type="button"
        className={`${styles.viewTool} ${productionLogOpen ? styles.viewToolOn : ''}`}
        aria-expanded={productionLogOpen}
        aria-controls="mimic-production-log"
        title="Production log / บันทึกผลผลิต"
        onClick={onToggleLog}
      >
        <BarChartOutlined fontSize="small" />
        <span className={styles.viewLogLabel}>LOG</span>
      </button>

      <span className={styles.viewDivider} />

      <button
        type="button"
        className={`${styles.viewTool} ${viewPan ? styles.viewToolOn : ''}`}
        aria-pressed={viewPan}
        aria-keyshortcuts="h"
        title="Hand tool — drag to move the drawing inside the panel (H)"
        onClick={onTogglePan}
      >
        <PanToolOutlined fontSize="small" />
        <kbd className={styles.viewKey}>H</kbd>
      </button>

      <span className={styles.viewDivider} />

      <button
        type="button"
        className={styles.viewTool}
        title="Zoom out"
        aria-label="Zoom out"
        disabled={viewZoom <= 25}
        onClick={() => canvasRef.current?.zoomOut()}
      >
        <ZoomOutOutlined fontSize="small" />
      </button>
      <output className={styles.viewZoom} aria-label="Drawing zoom">{viewZoom}%</output>
      <button
        type="button"
        className={styles.viewTool}
        title="Zoom in"
        aria-label="Zoom in"
        disabled={viewZoom >= 400}
        onClick={() => canvasRef.current?.zoomIn()}
      >
        <ZoomInOutlined fontSize="small" />
      </button>

      <span className={styles.viewDivider} />

      <button
        type="button"
        className={styles.viewTool}
        title="Fit the drawn area to the panel"
        aria-label="Fit contents"
        onClick={() => canvasRef.current?.fitContents()}
      >
        <CenterFocusStrongOutlined fontSize="small" />
      </button>
      <button
        type="button"
        className={styles.viewTool}
        title="Reset view"
        aria-label="Reset view"
        onClick={() => canvasRef.current?.resetView()}
      >
        <RestartAltOutlined fontSize="small" />
      </button>

      <span className={styles.viewDivider} />

      <button
        type="button"
        className={`${styles.viewTool} ${fullscreen ? styles.viewToolOn : ''}`}
        aria-pressed={fullscreen}
        aria-keyshortcuts="f"
        title={fullscreen ? 'Leave full screen (F or Esc)' : 'Show this mimic full screen (F)'}
        onClick={onToggleFullscreen}
      >
        {fullscreen ? <FullscreenExitOutlined fontSize="small" /> : <FullscreenOutlined fontSize="small" />}
        <kbd className={styles.viewKey}>F</kbd>
      </button>
    </div>
  )
}
