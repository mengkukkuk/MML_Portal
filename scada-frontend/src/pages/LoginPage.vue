<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')

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
      </el-form>
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
</style>
