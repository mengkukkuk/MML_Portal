import PanToolOutlined from '@mui/icons-material/PanToolOutlined'
import NearMeOutlined from '@mui/icons-material/NearMeOutlined'
import GridOnOutlined from '@mui/icons-material/GridOnOutlined'
import GridOffOutlined from '@mui/icons-material/GridOffOutlined'
import ZoomInOutlined from '@mui/icons-material/ZoomInOutlined'
import ZoomOutOutlined from '@mui/icons-material/ZoomOutOutlined'
import CenterFocusStrongOutlined from '@mui/icons-material/CenterFocusStrongOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import FullscreenOutlined from '@mui/icons-material/FullscreenOutlined'
import FullscreenExitOutlined from '@mui/icons-material/FullscreenExitOutlined'
import PhotoCameraOutlined from '@mui/icons-material/PhotoCameraOutlined'
import ViewSidebarOutlined from '@mui/icons-material/ViewSidebarOutlined'
import BarChartOutlined from '@mui/icons-material/BarChartOutlined'
import { WIRE_GROUPED, WIRE_TYPES } from '@/components/mimic/wireTypes'
import styles from './EditorChrome.module.css'

function ToolButton({ active = false, label, children, ...props }) {
  return (
    <button
      type="button"
      className={`${styles.toolButton} ${active ? styles.toolButtonActive : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      {...props}
    >
      {children}
    </button>
  )
}

export default function MimicEditorToolbar({
  toolMode, onToolMode, wirePen, onWirePen, gridVisible, onGridVisible,
  snapEnabled, onSnapEnabled, zoomPercent, onZoomOut, onZoomIn, onResetView,
  onFit, fullscreen, onFullscreen, onSnapshot, onTogglePalette, onToggleInspector,
  onProductionLog, productionLogConfigured,
}) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Drafting tools">
      <div className={styles.toolGroup}>
        <ToolButton label="Select tool" active={toolMode === 'select'} onClick={() => onToolMode('select')}>
          <NearMeOutlined fontSize="small" />
        </ToolButton>
        <ToolButton label="Pan tool" active={toolMode === 'pan'} onClick={() => onToolMode('pan')}>
          <PanToolOutlined fontSize="small" />
        </ToolButton>
      </div>

      <label className={styles.wireSelect}>
        <span>Wire</span>
        <select value={wirePen} onChange={(event) => onWirePen(event.target.value)}>
          {WIRE_GROUPED.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {group.ids.map((id) => <option key={id} value={id}>{WIRE_TYPES[id].label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>

      <div className={styles.toolGroup}>
        <ToolButton label="Toggle grid" active={gridVisible} onClick={() => onGridVisible(!gridVisible)}>
          {gridVisible ? <GridOnOutlined fontSize="small" /> : <GridOffOutlined fontSize="small" />}
        </ToolButton>
        <button
          type="button"
          className={`${styles.snapButton} ${snapEnabled ? styles.toolButtonActive : ''}`}
          aria-pressed={snapEnabled}
          onClick={() => onSnapEnabled(!snapEnabled)}
          title="Toggle 8-unit snap"
        >
          SNAP 8
        </button>
      </div>

      <div className={`${styles.toolGroup} ${styles.zoomGroup}`}>
        <ToolButton label="Zoom out" disabled={zoomPercent <= 25} onClick={onZoomOut}><ZoomOutOutlined fontSize="small" /></ToolButton>
        <output className={styles.zoomValue} aria-label="Canvas zoom">{zoomPercent}%</output>
        <ToolButton label="Zoom in" disabled={zoomPercent >= 400} onClick={onZoomIn}><ZoomInOutlined fontSize="small" /></ToolButton>
        <ToolButton label="Reset view" onClick={onResetView}><RestartAltOutlined fontSize="small" /></ToolButton>
        <ToolButton label="Fit contents" onClick={onFit}><CenterFocusStrongOutlined fontSize="small" /></ToolButton>
        <ToolButton
          label={fullscreen ? 'Leave full screen (F)' : 'Full screen (F)'}
          active={fullscreen}
          onClick={onFullscreen}
        >
          {fullscreen ? <FullscreenExitOutlined fontSize="small" /> : <FullscreenOutlined fontSize="small" />}
        </ToolButton>
        <ToolButton label="Download PNG snapshot" onClick={onSnapshot}><PhotoCameraOutlined fontSize="small" /></ToolButton>
      </div>

      <div className={`${styles.toolGroup} ${styles.drawerTools}`}>
        <ToolButton
          label={productionLogConfigured ? 'Edit production log settings' : 'Configure production log'}
          active={productionLogConfigured}
          onClick={onProductionLog}
        >
          <BarChartOutlined fontSize="small" />
        </ToolButton>
        <ToolButton label="Open symbol palette" onClick={onTogglePalette}><ViewSidebarOutlined fontSize="small" /></ToolButton>
        <ToolButton label="Open inspector" onClick={onToggleInspector}><ViewSidebarOutlined fontSize="small" /></ToolButton>
      </div>
    </div>
  )
}
