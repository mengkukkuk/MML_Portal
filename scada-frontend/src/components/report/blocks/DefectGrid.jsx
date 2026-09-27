import { useMemo } from 'react'
import { useTranslation } from '@/i18n'
import ReportBlock from './ReportBlock'
import {
  cameraKey,
  cameraLabel,
  defectPalette,
  fmtNumber,
  heatBackground,
  isMultiSource,
} from '../reportFormat'
import styles from './blocks.module.css'

/**
 * DefectGrid — camera x defect slot, over the whole window.
 *
 * Columns are slots, not label names: each camera names its own slots
 * (`cameras.defect_labels`), so "slot 2" is "Filter NG" on one camera and
 * "Foil ยับ" on the next. A column per distinct name would scatter one
 * camera's five slots across twenty mostly-empty columns. Each cell therefore
 * carries its own label above its count — the mapping the engineer needs to
 * trace a count back to a camera's configuration.
 */

export default function DefectGrid({ block, result }) {
  const tr = useTranslation()
  const cameras = useMemo(() => result?.cameras ?? [], [result])
  const multi = isMultiSource(cameras)

  const { slotCount, max, palette } = useMemo(() => {
    let slotsSeen = 0
    let peak = 0
    const labels = []
    for (const c of cameras) {
      for (const s of c.slots ?? []) {
        slotsSeen = Math.max(slotsSeen, s.slot)
        peak = Math.max(peak, s.count)
        labels.push(s.defect)
      }
    }
    return { slotCount: slotsSeen, max: peak, palette: defectPalette(labels) }
  }, [cameras])

  const title = tr(block?.title ?? 'Camera x Defect Type')
  if (!cameras.length || !slotCount) {
    return (
      <ReportBlock title={title}>
        <p className={styles['block__empty']}>{tr('No defects recorded in this window.')}</p>
      </ReportBlock>
    )
  }

  const slots = Array.from({ length: slotCount }, (_, i) => i + 1)

  return (
    <ReportBlock title={title} note={tr('Each cell is named from that camera\'s own defect labels')}>
      <div className={styles['table__scroll']}>
        <table className={`${styles.table} ${styles.grid}`}>
          <thead>
            <tr>
              <th>{tr('Camera')}</th>
              {slots.map((n) => (
                <th key={n} className={styles['table__num']}>{tr('Slot {slot}', { slot: n })}</th>
              ))}
              <th className={styles['table__num']}>{tr('Total')}</th>
            </tr>
          </thead>
          <tbody>
            {cameras.map((c) => {
              const bySlot = new Map((c.slots ?? []).map((s) => [s.slot, s]))
              return (
                <tr key={cameraKey(c)}>
                  <td>{cameraLabel(c, multi)}</td>
                  {slots.map((n) => {
                    const s = bySlot.get(n)
                    return (
                      <td
                        key={n}
                        className={styles['grid__cell']}
                        style={{ background: heatBackground(s?.count, max) }}
                        title={s ? tr('{defect}: {count} in {batches} batches', {
                          defect: s.defect, count: s.count, batches: s.batches,
                        }) : undefined}
                      >
                        {s ? (
                          <>
                            <span className={styles['grid__label']}>
                              <i className={styles['chip__dot']} style={{ background: palette.get(s.defect) }} />
                              {s.defect}
                            </span>
                            <span className={styles['grid__count']}>{fmtNumber(s.count)}</span>
                          </>
                        ) : (
                          <span className={styles['grid__empty']}>·</span>
                        )}
                      </td>
                    )
                  })}
                  <td className={`${styles['table__num']} ${styles['matrix__total']}`}>
                    {fmtNumber(c.defects)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </ReportBlock>
  )
}
