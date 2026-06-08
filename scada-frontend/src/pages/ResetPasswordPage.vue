<script setup>
/**
 * ResetPasswordPage — password reset form (route: /reset-password).
 * Reads the one-time JWT from the ?token= query parameter (set by the email
 * link generated in mailer.py). Validates token presence before showing the
 * form; on success redirects to /login.
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { resetPassword } from '@/api/auth'

const route = useRoute()
const router = useRouter()

const token = computed(() => {
  const t = route.query.token
  return typeof t === 'string' ? t : ''
})

const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')

async function handleReset() {
  error.value = ''
  if (newPassword.value.length < 8) {
    error.value = 'Password must be at least 8 characters'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Passwords do not match'
    return
  }
  loading.value = true
  try {
    await resetPassword(token.value, newPassword.value)
    ElMessage.success('Password reset. Please sign in.')
    router.push('/login')
  } catch (e) {
    error.value = e?.response?.data?.detail || 'Reset failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-bg">
    <div class="login-box">
      <div class="login-box__brand">
        <span class="login-box__logo">⚙</span>
        <h1 class="login-box__title">Reset password</h1>
      </div>

      <el-alert
        v-if="!token"
        title="This reset link is missing its token. Request a new one from the login page."
        type="error"
        show-icon
        :closable="false"
      />

      <el-form v-else @submit.prevent="handleReset" label-position="top">
        <el-form-item label="New password">
          <el-input
            v-model="newPassword"
            type="password"
            placeholder="At least 8 characters"
            show-password
            size="large"
          />
        </el-form-item>
        <el-form-item label="Confirm password">
          <el-input
            v-model="confirmPassword"
            type="password"
            placeholder="Re-enter password"
            show-password
            size="large"
            @keyup.enter="handleReset"
          />
        </el-form-item>

        <el-alert
          v-if="error"
          :title="error"
          type="error"
          show-icon
          :closable="false"
          style="margin-bottom: 16px"
        />

        <el-button
          type="primary"
          size="large"
          :loading="loading"
          style="width: 100%"
          @click="handleReset"
        >
          Reset password
        </el-button>
      </el-form>

      <router-link class="login-box__link" to="/login">Back to sign in</router-link>
    </div>
  </div>
</template>

<style scoped>
.login-bg {
  min-height: 100vh;
  background: var(--bg-app);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}

.login-box {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: var(--space-8) var(--space-7);
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.login-box__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.login-box__logo {
  font-size: 28px;
}

.login-box__title {
  font-size: 20px;
  font-weight: 600;
  color: var(--fg);
  margin: 0;
}

.login-box__link {
  color: var(--accent);
  font-size: 13px;
  text-align: center;
  text-decoration: none;
}
</style>
