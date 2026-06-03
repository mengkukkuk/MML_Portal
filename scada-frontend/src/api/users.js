import { apiClient } from './client'

// Admin-only user management. All calls require an admin access token;
// the backend enforces this via the require_admin dependency.

export async function fetchUsers() {
  const { data } = await apiClient.get('/users')
  return data // [{ id, username, role, display_name, email, created_at }, ...]
}

export async function createUser(payload) {
  // payload: { username, password, role, display_name, email? }
  const { data } = await apiClient.post('/users', payload)
  return data
}

export async function updateUser(id, payload) {
  // payload: { role, display_name, email? }
  const { data } = await apiClient.put(`/users/${id}`, payload)
  return data
}

export async function deleteUser(id) {
  await apiClient.delete(`/users/${id}`)
}
