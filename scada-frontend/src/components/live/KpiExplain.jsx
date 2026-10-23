import { useState } from 'react'
import Popover from '@mui/material/Popover'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { explainBlock } from './kpiFormulas'
import panelStyles from './LivePanel.module.css'
import styles from './KpiExplain.module.css'

/**
 * KpiExplain — the ⓘ beside a management block's gear: how the block's figures
 * are calculated and why a manager reads them. Opens in Thai whatever the
 * interface language (the board is Thai-first); EN switches it in place.
 */
export default function KpiExplain({ chartType, kpi }) {
  const [anchor, setAnchor] = useState(null)
  const [lang, setLang] = useState('th')
  const content = explainBlock(chartType, kpi, lang)
  if (!content) return null
  const open = !!anchor

  return (
    <>
      <button
        type="button"
        className={`${panelStyles.panel__gear} ${open ? panelStyles['panel__gear--active'] : ''}`}
        title="คำนวณอย่างไร · How it is calculated"
        aria-label="คำนวณอย่างไร · How it is calculated"
        aria-expanded={open}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <InfoOutlinedIcon fontSize="small" />
      </button>
      <Popover
        open={open}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { className: panelStyles.gearpopPaper } }}
      >
        <div className={styles.explain} lang={lang}>
          <div className={styles.explain__head}>
            <h4 className={styles.explain__question}>{content.question}</h4>
            <div className={styles.explain__lang} role="group" aria-label="ภาษา · Language">
              {['th', 'en'].map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`${styles.explain__langbtn} ${lang === l ? styles['explain__langbtn--on'] : ''}`}
                  aria-pressed={lang === l}
                  onClick={() => setLang(l)}
                >
                  {l === 'th' ? 'ไทย' : 'EN'}
                </button>
              ))}
            </div>
          </div>
          {content.sections.map((sec) => (
            <section key={sec.heading} className={styles.explain__section}>
              <h5 className={styles.explain__heading}>{sec.heading}</h5>
              <ul className={`${styles.explain__list} ${sec.formula ? styles['explain__list--formula'] : ''}`}>
                {sec.lines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </section>
          ))}
          <section className={`${styles.explain__section} ${styles.explain__why}`}>
            <h5 className={styles.explain__heading}>{content.why.heading}</h5>
            <p>{content.why.text}</p>
          </section>
        </div>
      </Popover>
    </>
  )
}
