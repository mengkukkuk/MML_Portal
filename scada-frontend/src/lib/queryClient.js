import { QueryClient } from '@tanstack/react-query'

// client.js (src/api/client.js) already retries transient 502/503/504 failures
// once after 1500ms. Query's default retry:3 would compound that into ~8
// requests for a single backend blip, so Query itself never retries.
// refetchOnWindowFocus is also disabled — the Live dashboard polls on its own
// cadence via refetchInterval and a focus-triggered refetch would just be a
// redundant, uncoordinated extra request.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 0,
      refetchOnWindowFocus: false,
    },
  },
})
