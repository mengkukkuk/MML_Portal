import { apiClient } from './client'

/**
 * GET /api/health — service liveness plus coarse database state.
 *
 * Answers 200 even when the database is unreachable (the body carries that),
 * so a rejection here means the API itself could not be reached.
 */
export async function getHealth() {
  const { data } = await apiClient.get('/health')
  return data
}
