# English / Thai interface bindings

Scope: login and password reset, sidebar/header navigation, connection status,
and settings. Other pages and arbitrary server error details retain English.

`messages.js` is the editable EN → TH mapping. English text is the lookup key
and the fallback. Add a pair there, then bind the visible element at render time:

```jsx
import { useTranslation } from '@/i18n'

function Example() {
  const tr = useTranslation()
  return <button title={tr('Save changes')}>{tr('Save')}</button>
}
```

Use `tr('Connection {status}', { status: translatedStatus })` for parameters.
Translate labels, placeholders, titles, accessible labels, and validation text.
Do not translate form field names, API values, paths, CSS classes, usernames,
database names, or other user-provided content. Keep local notification/error
state in English and call `tr(message)` where it is displayed so changing
language also updates already-open dialogs and messages. Unknown messages
fall back to their source text; backend error codes can gain explicit mappings later.

`LanguageSelect` changes `useLanguageStore.language` without remounting forms.
The choice is persisted under `mml.language`, defaults to `en`, and updates
`html[lang]`. The Thai font is already bundled; no translation service is used.

Run `npm run test:i18n` to check mappings, interpolation, and persistence.
