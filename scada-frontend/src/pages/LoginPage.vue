<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { forgotPassword } from '@/api/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')

const forgotVisible = ref(false)
const forgotEmail = ref('')
const forgotLoading = ref(false)

async function handleLogin() {
  try {
    await auth.signIn(username.value, password.value)
    // Guard: must be a string starting with '/' (no open redirect, no array)
    const raw = route.query.redirect
    const redirect = typeof raw === 'string' && raw.startsWith('/') ? raw : '/'
    router.push(redirect)
  } catch {
    // error is in auth.error
  }
}

async function handleForgot() {
  if (!forgotEmail.value.trim()) {
    ElMessage.warning('Enter your email address')
    return
  }
  forgotLoading.value = true
  try {
    const { message } = await forgotPassword(forgotEmail.value.trim())
    ElMessage.success(message || 'If that email is registered, a reset link has been sent.')
    forgotVisible.value = false
    forgotEmail.value = ''
  } catch {
    // Endpoint is generic by design; show a neutral message on transport error
    ElMessage.info('If that email is registered, a reset link has been sent.')
    forgotVisible.value = false
  } finally {
    forgotLoading.value = false
  }
}
</script>

<template>
  <div class="login-bg">
    <div class="login-box">
      <div class="login-box__brand">
        <span class="login-box__logo">⚙</span>
        <h1 class="login-box__title">SCADA Dashboard</h1>
      </div>

      <el-form @submit.prevent="handleLogin" label-position="top">
        <el-form-item label="Username">
          <el-input
            v-model="username"
            placeholder="Enter username"
            autocomplete="username"
            size="large"
          />
        </el-form-item>

        <el-form-item label="Password">
          <el-input
            v-model="password"
            type="password"
            placeholder="Enter password"
            show-password
            autocomplete="current-password"
            size="large"
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-alert
          v-if="auth.error"
          :title="auth.error"
          type="error"
          show-icon
          :closable="false"
          style="margin-bottom: 16px"
        />

        <el-button
          type="primary"
          size="large"
          :loading="auth.loading"
          style="width: 100%"
          @click="handleLogin"
        >
          Sign in
        </el-button>

        <el-button text type="primary" class="login-box__forgot" @click="forgotVisible = true">
          Forgot password?
        </el-button>
      </el-form>
    </div>

    <el-dialog v-model="forgotVisible" title="Reset password" width="400px">
      <p class="forgot-hint">
        Enter your account email. If it matches a user, a reset link will be sent.
      </p>
      <el-form @submit.prevent="handleForgot" label-position="top">
        <el-form-item label="Email">
          <el-input
            v-model="forgotEmail"
            placeholder="name@example.com"
            autocomplete="email"
            @keyup.enter="handleForgot"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="forgotVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="forgotLoading" @click="handleForgot">
          Send reset link
        </el-button>
      </template>
    </el-dialog>
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

.login-box__forgot {
  width: 100%;
  margin-top: var(--space-3);
}

.forgot-hint {
  margin: 0 0 var(--space-3);
  color: var(--fg-muted);
  font-size: 13px;
}
</style>
