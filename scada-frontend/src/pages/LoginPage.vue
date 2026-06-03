<script setup>
import { reactive, ref } from 'vue'
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

const registerVisible = ref(false)
const registerForm = reactive({
  username: '',
  password: '',
  display_name: '',
  email: '',
})
const registerError = ref('')

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

function openRegister() {
  registerError.value = ''
  registerForm.username = ''
  registerForm.password = ''
  registerForm.display_name = ''
  registerForm.email = ''
  registerVisible.value = true
}

async function handleRegister() {
  registerError.value = ''
  if (!registerForm.username.trim() || !registerForm.display_name.trim()) {
    registerError.value = 'Username and display name are required'
    return
  }
  if (registerForm.password.length < 8) {
    registerError.value = 'Password must be at least 8 characters'
    return
  }
  try {
    await auth.signUp({
      username: registerForm.username.trim(),
      password: registerForm.password,
      display_name: registerForm.display_name.trim(),
      email: registerForm.email.trim() || null,
    })
    ElMessage.success('Account created')
    registerVisible.value = false
    router.push('/')
  } catch {
    registerError.value = auth.error || 'Registration failed'
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

        <el-button
          size="large"
          class="login-box__register"
          style="width: 100%"
          @click="openRegister"
        >
          Create an account
        </el-button>

        <el-button text type="primary" class="login-box__forgot" @click="forgotVisible = true">
          Forgot password?
        </el-button>
      </el-form>
    </div>

    <el-dialog v-model="registerVisible" title="Create an account" width="400px">
      <el-form @submit.prevent="handleRegister" label-position="top">
        <el-form-item label="Username">
          <el-input v-model="registerForm.username" placeholder="Choose a username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="Display name">
          <el-input v-model="registerForm.display_name" placeholder="Your full name" />
        </el-form-item>
        <el-form-item label="Password">
          <el-input
            v-model="registerForm.password"
            type="password"
            show-password
            placeholder="At least 8 characters"
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="Email (optional)">
          <el-input
            v-model="registerForm.email"
            placeholder="name@example.com"
            autocomplete="email"
            @keyup.enter="handleRegister"
          />
        </el-form-item>
        <el-alert
          v-if="registerError"
          :title="registerError"
          type="error"
          show-icon
          :closable="false"
        />
      </el-form>
      <template #footer>
        <el-button @click="registerVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="auth.loading" @click="handleRegister">
          Create account
        </el-button>
      </template>
    </el-dialog>

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

.login-box__register {
  margin-top: var(--space-3);
  margin-left: 0;
}

.login-box__forgot {
  width: 100%;
  margin-top: var(--space-2);
}

.forgot-hint {
  margin: 0 0 var(--space-3);
  color: var(--fg-muted);
  font-size: 13px;
}
</style>
