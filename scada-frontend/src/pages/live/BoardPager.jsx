import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import { useTranslation } from '@/i18n'
import { AUTOPLAY_SECONDS, MAX_PAGES, stepPage } from './boardPages'
import styles from './BoardPager.module.css'

/**
 * BoardPager — the dashboard's pages, beside the dashboard switcher.
 *
 * Arrows and numbered pages move the whole board to another area; ▶ slides
 * through them by itself. The thin bar along the bottom is the slideshow's
 * clock as well as its picture: it fills over the chosen interval and the
 * board turns when it is full (`onAutoplayTurn`), so pausing it — the pointer
 * resting on the board, an editor open — pauses the slideshow exactly where
 * it was, with nothing to drift out of step.
 */
// "Remove page 3", and where its panels go, so the button never hides a move.
function removeLabel(tr, count, filled) {
  if (!filled) return tr('Remove page {n}', { n: count })
  return filled === 1
    ? tr('Remove page {n} — its panel moves to page {p}', { n: count, p: count - 1 })
    : tr('Remove page {n} — its {k} panels move to page {p}', { n: count, k: filled, p: count - 1 })
}

export default function BoardPager({
  page, count, onGo, canManage = false, onAddPage, onRemovePage, adding = false, lastPageFilled = 0,
  autoplay = false, onAutoplay, seconds, onSeconds, paused = false, onAutoplayTurn,
}) {
  const tr = useTranslation()
  if (count <= 1 && !canManage) return null
  const many = count > 1
  const go = (next, dir) => { if (next !== page) onGo(next, dir) }

  function onKey(e) {
    const keys = {
      ArrowLeft: () => go(stepPage(page, -1, count), -1),
      ArrowRight: () => go(stepPage(page, 1, count), 1),
      Home: () => go(0, -1),
      End: () => go(count - 1, 1),
    }
    if (!keys[e.key] || e.target.tagName === 'SELECT') return
    e.preventDefault()
    keys[e.key]()
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className={styles.pager} role="group" aria-label={tr('Dashboard pages')} onKeyDown={onKey}>
      {/* Controls first, pages after: adding or removing a page only changes
          the numbers at the end, so −, + and the slideshow never move under
          the pointer. They stay in place (disabled) on a one-page board too. */}
      <span className={`${styles.tools} ${many ? styles['tools--split'] : ''}`}>
        {canManage && (
          <>
            <button type="button" className={`${styles.arrow} ${styles.add}`} disabled={adding || !many}
              title={many ? removeLabel(tr, count, lastPageFilled) : tr('Only one page')}
              aria-label={many ? removeLabel(tr, count, lastPageFilled) : tr('Only one page')}
              onClick={onRemovePage}>
              <RemoveIcon fontSize="inherit" />
            </button>
            <button type="button" className={`${styles.arrow} ${styles.add}`} disabled={adding || count >= MAX_PAGES}
              title={count >= MAX_PAGES ? tr('{n} pages is the most a dashboard can have', { n: MAX_PAGES }) : tr('Add a page to this dashboard')}
              aria-label={tr('Add a page to this dashboard')}
              onClick={onAddPage}>
              <AddIcon fontSize="inherit" />
            </button>
          </>
        )}
        <span className={`${styles.play} ${canManage ? '' : styles['play--first']}`}>
          <button type="button" className={`${styles.arrow} ${autoplay && many ? styles['arrow--on'] : ''}`}
            disabled={!many}
            aria-pressed={autoplay && many}
            title={autoplay ? tr('Stop the slideshow') : tr('Play the pages as a slideshow')}
            aria-label={autoplay ? tr('Stop the slideshow') : tr('Play the pages as a slideshow')}
            onClick={() => onAutoplay(!autoplay)}>
            {autoplay && many ? <PauseIcon fontSize="inherit" /> : <PlayArrowIcon fontSize="inherit" />}
          </button>
          <select className={styles.secs} value={seconds} aria-label={tr('Seconds per page')} disabled={!many}
            onChange={(e) => onSeconds(Number(e.target.value))}>
            {AUTOPLAY_SECONDS.map((s) => <option key={s} value={s}>{s < 60 ? `${s}s` : `${s / 60}m`}</option>)}
          </select>
        </span>
      </span>

      {many && (
        <>
          <button type="button" className={styles.arrow} aria-label={tr('Previous page')}
            onClick={() => go(stepPage(page, -1, count), -1)}>
            <ChevronLeftIcon fontSize="inherit" />
          </button>
          <ol className={styles.pages}>
            {Array.from({ length: count }, (_, i) => (
              <li key={i}>
                <button type="button" className={`${styles.num} ${i === page ? styles['num--on'] : ''}`}
                  aria-current={i === page ? 'page' : undefined}
                  aria-label={tr('Page {n} of {c}', { n: i + 1, c: count })}
                  onClick={() => go(i, i > page ? 1 : -1)}>
                  {i + 1}
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className={styles.arrow} aria-label={tr('Next page')}
            onClick={() => go(stepPage(page, 1, count), 1)}>
            <ChevronRightIcon fontSize="inherit" />
          </button>
        </>
      )}

      {many && autoplay && (
        <span
          key={`${page}-${seconds}`}
          className={styles.clock}
          style={{ animationDuration: `${seconds}s`, animationPlayState: paused ? 'paused' : 'running' }}
          onAnimationEnd={onAutoplayTurn}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
