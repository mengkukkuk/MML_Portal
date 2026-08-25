import Alert from '@mui/material/Alert'

/**
 * SourceStatus — "some of your plants did not answer".
 *
 * Every fanned-out endpoint returns a `sources` array alongside its rows, one
 * entry per selected data source with `ok` and `error`. This renders the failed
 * ones and nothing else.
 *
 * It exists because a partial result is otherwise indistinguishable from a
 * complete one: with two plants selected and one powered off, the page shows the
 * healthy plant's rows and looks entirely normal. An operator would read "no
 * alarms on Line 2" when the truth is "Line 2 is unreachable" — the opposite
 * conclusion. Severity is `warning`, not `error`, because the data that did
 * arrive is real and usable.
 */
export default function SourceStatus({ sources = [] }) {
  const failed = sources.filter((s) => !s.ok)
  if (!failed.length) return null

  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      {failed.length === 1
        ? `${failed[0].datasource_name ?? 'A data source'} did not answer: ${failed[0].error}`
        : `${failed.length} data sources did not answer: ` +
          failed.map((s) => s.datasource_name ?? 'unnamed').join(', ')}
    </Alert>
  )
}
