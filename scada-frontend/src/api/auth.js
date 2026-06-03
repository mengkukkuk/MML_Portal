import { apiClient } from './client'

export async function login(username, password) {
  const { data } = await apiClient.post('/auth/login', { username, password })
  return data // { access_token, refresh_token, expires_in, user }
}

export async function refreshToken(token) {
  const { data } = await apiClient.post('/auth/refresh', { refresh_token: token })
  return data // { access_token, expires_in }
}

export async function logout(token) {
  await apiClient.post('/auth/logout', { refresh_token: token })
}

export async function getProfile() {
  const { data } = await apiClient.get('/auth/me')
  return data // { id, username, role, display_name }
}
