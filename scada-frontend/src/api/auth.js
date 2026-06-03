import { apiClient } from './client'

export async function login(username, password) {
  const { data } = await apiClient.post('/auth/login', { username, password })
  // Server now sets refresh_token as HttpOnly cookie automatically
  // Response body: { access_token, expires_in, user }
  return data
}

export async function refreshToken() {
  // No body needed — browser sends the HttpOnly refresh_token cookie automatically
  const { data } = await apiClient.post('/auth/refresh')
  return data // { access_token, expires_in, user }
}

export async function logout() {
  // No body needed — server reads cookie and clears it
  await apiClient.post('/auth/logout')
}

export async function getProfile() {
  const { data } = await apiClient.get('/auth/me')
  return data // { id, username, role, display_name }
}

export async function changePassword(oldPassword, newPassword) {
  const { data } = await apiClient.post('/auth/change-password', {
    old_password: oldPassword,
    new_password: newPassword,
  })
  return data // { message }
}

export async function forgotPassword(email) {
  // Always resolves with a generic message (server never reveals if email exists)
  const { data } = await apiClient.post('/auth/forgot-password', { email })
  return data // { message }
}

export async function resetPassword(token, newPassword) {
  const { data } = await apiClient.post('/auth/reset-password', {
    token,
    new_password: newPassword,
  })
  return data // { message }
}
