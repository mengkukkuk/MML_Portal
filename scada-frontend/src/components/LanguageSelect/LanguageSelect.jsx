import Button from '@mui/material/Button'
import { useLanguageStore, useTranslation } from '@/i18n'

/** Shared browser-local language preference, available before and after sign-in. */
export default function LanguageSelect() {
  const tr = useTranslation()
  const language = useLanguageStore((state) => state.language)
  const setLanguage = useLanguageStore((state) => state.setLanguage)

  return (
    <Button
      variant="outlined"
      size="small"
      aria-label={`${tr('Language')}: EN / ไทย`}
      aria-pressed={language === 'th'}
      title={tr('Interface language')}
      onClick={() => setLanguage(language === 'en' ? 'th' : 'en')}
      sx={{ minWidth: 96, gap: 0.75, textTransform: 'none', whiteSpace: 'nowrap' }}
    >
      <span lang="en" style={{ color: language === 'en' ? 'var(--accent)' : 'var(--fg-muted)', fontWeight: language === 'en' ? 700 : 400 }}>EN</span>
      <span aria-hidden="true" style={{ color: 'var(--fg-muted)' }}>/</span>
      <span lang="th" style={{ color: language === 'th' ? 'var(--accent)' : 'var(--fg-muted)', fontWeight: language === 'th' ? 700 : 400 }}>ไทย</span>
    </Button>
  )
}
