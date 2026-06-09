<script setup>
/**
 * LoginPage — public full-screen login page (route: /login).
 * Left brand panel (decorative, hidden on mobile) + right form panel with:
 *   - Sign-in form (redirects to ?redirect= target after login)
 *   - "Create an Account" dialog (self-registration)
 *   - "Forgot password?" dialog (sends reset email via /api/auth/forgot-password)
 * Open-redirect is prevented: only paths starting with '/' are honoured.
 */
import { reactive, ref, onMounted, onUnmounted } from 'vue'
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

// ── Slide nav tabs (brand panel) ─────────────────────────
const activeTab = ref(0)
const tabs = [
  { id: 'status', label: 'STATUS' },
  { id: 'load',   label: 'LOAD'   },
  { id: 'comm',   label: 'COMM'   },
]
let autoAdvance = null

onMounted(() => {
  autoAdvance = setInterval(() => {
    activeTab.value = (activeTab.value + 1) % tabs.length
  }, 3500)
})

onUnmounted(() => {
  clearInterval(autoAdvance)
})

function setTab(i) {
  activeTab.value = i
  clearInterval(autoAdvance)
  autoAdvance = setInterval(() => {
    activeTab.value = (activeTab.value + 1) % tabs.length
  }, 3500)
}

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
    <!-- Background decoration layers -->
    <div class="bg-grid" aria-hidden="true" />
    <div class="bg-glow-1" aria-hidden="true" />
    <div class="bg-glow-2" aria-hidden="true" />
    <div class="bg-scan" aria-hidden="true" />

    <!-- Corner brackets -->
    <div class="bracket bracket--tl" aria-hidden="true" />
    <div class="bracket bracket--tr" aria-hidden="true" />
    <div class="bracket bracket--bl" aria-hidden="true" />
    <div class="bracket bracket--br" aria-hidden="true" />

    <!-- ── Main card ──────────────────────────────────── -->
    <div class="login-card">

      <!-- LEFT: Brand / status panel -->
      <aside class="brand-panel">
        <!-- Gear logo -->
        <div class="brand-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#3aa0ff" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83
                     0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0
                     01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2
                     0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2
                     2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2
                     2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2
                     2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2
                     2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51
                     1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </div>

        <h1 class="brand-title">MML Portal</h1>
        <p class="brand-subtitle">MML Unified Systems</p>

        <!-- ── Slide nav tab panel ──────────────────────── -->
        <div class="info-tabs">

          <!-- Tab bar -->
          <div class="tab-bar" role="tablist">
            <button
              v-for="(tab, i) in tabs"
              :key="tab.id"
              class="tab-btn"
              :class="{ 'tab-btn--active': activeTab === i }"
              role="tab"
              :aria-selected="activeTab === i"
              @click="setTab(i)"
            >{{ tab.label }}</button>
            <div
              class="tab-bar__indicator"
              :style="{ transform: `translateX(${activeTab * 100}%)` }"
              aria-hidden="true"
            />
          </div>

          <!-- Sliding panels -->
          <div class="tab-content-wrap">
            <div
              class="tab-slides"
              :style="{ transform: `translateX(calc(-${activeTab} * 100%))` }"
            >

              <!-- STATUS slide -->
              <div class="tab-slide" role="tabpanel" :aria-hidden="activeTab !== 0">
                <div class="slide-header">— SYSTEM STATUS —</div>
                <div class="slide-item">
                  <span class="led led--ok" />
                  <span>Core Systems Online</span>
                </div>
                <div class="slide-item">
                  <span class="led led--ok" />
                  <span>Database Connected</span>
                </div>
                <div class="slide-item">
                  <span class="led led--ok" />
                  <span>Monitoring Active</span>
                </div>
              </div>

              <!-- LOAD slide (gauge) -->
              <!--
                Gauge: 300° sweep, 7 o'clock (SVG 120°) → 5 o'clock (SVG 60°)
                65% → 195° arc → needle at 315°
              -->
              <div class="tab-slide tab-slide--gauge" role="tabpanel" :aria-hidden="activeTab !== 1">
                <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="100" cy="100" r="92" stroke="rgba(58,160,255,0.06)" stroke-width="0.75"/>
                  <circle cx="100" cy="100" r="86" stroke="rgba(58,160,255,0.04)" stroke-width="0.75"/>
                  <path d="M 60 169.3 A 80 80 0 1 1 140 169.3"
                        stroke="rgba(58,160,255,0.12)" stroke-width="10" stroke-linecap="round"/>
                  <path d="M 60 169.3 A 80 80 0 1 1 156.6 43.4"
                        stroke="rgba(58,160,255,0.18)" stroke-width="18" stroke-linecap="round"/>
                  <path d="M 60 169.3 A 80 80 0 1 1 156.6 43.4"
                        stroke="#3aa0ff" stroke-width="10" stroke-linecap="round"/>
                  <g transform="translate(100,100)">
                    <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.45)" stroke-width="1.5" transform="rotate(120)"/>
                    <line x1="73" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.25)" stroke-width="1"   transform="rotate(157.5)"/>
                    <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.45)" stroke-width="1.5" transform="rotate(195)"/>
                    <line x1="73" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.25)" stroke-width="1"   transform="rotate(232.5)"/>
                    <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.55)" stroke-width="2"   transform="rotate(270)"/>
                    <line x1="73" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.25)" stroke-width="1"   transform="rotate(307.5)"/>
                    <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.45)" stroke-width="1.5" transform="rotate(345)"/>
                    <line x1="73" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.25)" stroke-width="1"   transform="rotate(22.5)"/>
                    <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.45)" stroke-width="1.5" transform="rotate(60)"/>
                  </g>
                  <g transform="translate(100,100) rotate(315)">
                    <line x1="-10" y1="0" x2="62" y2="0"
                          stroke="#3aa0ff" stroke-width="2.5" stroke-linecap="round"/>
                    <circle cx="0" cy="0" r="6"  fill="rgba(11,22,44,0.9)" stroke="#3aa0ff" stroke-width="2"/>
                    <circle cx="0" cy="0" r="2.5" fill="#3aa0ff"/>
                  </g>
                  <text x="100" y="108" text-anchor="middle"
                        fill="#e6edf7" font-size="26" font-weight="700"
                        font-family="ui-monospace,Menlo,monospace">65%</text>
                  <text x="100" y="126" text-anchor="middle"
                        fill="rgba(138,153,179,0.65)" font-size="9.5"
                        font-family="ui-monospace,Menlo,monospace" letter-spacing="2">SYSTEM LOAD</text>
                  <text x="54"  y="186" text-anchor="middle"
                        fill="rgba(91,106,134,0.6)" font-size="9"
                        font-family="ui-monospace,Menlo,monospace">0</text>
                  <text x="146" y="186" text-anchor="middle"
                        fill="rgba(91,106,134,0.6)" font-size="9"
                        font-family="ui-monospace,Menlo,monospace">100</text>
                </svg>
              </div>

              <!-- COMM slide -->
              <div class="tab-slide" role="tabpanel" :aria-hidden="activeTab !== 2">
                <div class="slide-header">— COMMUNICATIONS —</div>
                <div class="comm-metric">
                  <span class="comm-metric__label">UPTIME</span>
                  <div class="comm-metric__track">
                    <div class="comm-metric__fill" style="width:99.8%"></div>
                  </div>
                  <span class="comm-metric__val">99.8%</span>
                </div>
                <div class="comm-metric">
                  <span class="comm-metric__label">DATA RT</span>
                  <div class="comm-metric__track">
                    <div class="comm-metric__fill comm-metric__fill--cyan" style="width:48%"></div>
                  </div>
                  <span class="comm-metric__val">2.4K/s</span>
                </div>
                <div class="comm-metric">
                  <span class="comm-metric__label">LATENCY</span>
                  <div class="comm-metric__track">
                    <div class="comm-metric__fill comm-metric__fill--green" style="width:12%"></div>
                  </div>
                  <span class="comm-metric__val">12 ms</span>
                </div>
              </div>

            </div>
          </div>

        </div>

        <!-- Footer -->
        <div class="brand-footer">
          <span class="brand-version">v2.4.1</span>
          <span>MML Industrial Automation</span>
        </div>
      </aside>

      <!-- RIGHT: Login form -->
      <main class="form-panel">
        <!-- Header -->
        <div class="form-header">
          <div class="form-header__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#3aa0ff" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round" width="26" height="26">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
          </div>
          <h2 class="form-header__title">System Access</h2>
          <p class="form-header__sub">Authorized Personnel Only</p>
        </div>

        <!-- Credentials form -->
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
            Sign In
          </el-button>

          <el-button
            size="large"
            class="form-btn-register"
            style="width: 100%"
            @click="openRegister"
          >
            Create an Account
          </el-button>

          <el-button text type="primary" class="form-btn-forgot" @click="forgotVisible = true">
            Forgot password?
          </el-button>
        </el-form>
      </main>
    </div>

    <!-- ── Dialogs ────────────────────────────────────────── -->

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
/* ── Background ──────────────────────────────────────────── */
.login-bg {
  min-height: 100vh;
  background:
    radial-gradient(ellipse 110% 80% at 62% 38%, rgba(14, 48, 96, 0.38) 0%, transparent 65%),
    linear-gradient(150deg, #05091a 0%, #09152a 55%, #05091e 100%);
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/* Blueprint-style grid overlay */
.bg-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(58, 160, 255, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(58, 160, 255, 0.045) 1px, transparent 1px);
  background-size: 48px 48px;
  pointer-events: none;
}

/* Accent radial glows */
.bg-glow-1 {
  position: absolute;
  width: 720px;
  height: 720px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(58, 160, 255, 0.07) 0%, transparent 68%);
  top: -200px;
  right: -180px;
  pointer-events: none;
}

.bg-glow-2 {
  position: absolute;
  width: 480px;
  height: 480px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(58, 160, 255, 0.055) 0%, transparent 68%);
  bottom: -160px;
  left: -80px;
  pointer-events: none;
}

/* Animated scan line */
.bg-scan {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, rgba(58, 160, 255, 0.18) 40%, rgba(58, 160, 255, 0.18) 60%, transparent 100%);
  animation: scan-line 8s linear infinite;
  pointer-events: none;
}

@keyframes scan-line {
  0%   { top: -2px; opacity: 0; }
  4%   { opacity: 1; }
  96%  { opacity: 1; }
  100% { top: 100%; opacity: 0; }
}

/* Corner bracket decorations */
.bracket {
  position: absolute;
  width: 28px;
  height: 28px;
  border-color: rgba(58, 160, 255, 0.24);
  border-style: solid;
}
.bracket--tl { top: 18px; left: 18px; border-width: 2px 0 0 2px; }
.bracket--tr { top: 18px; right: 18px; border-width: 2px 2px 0 0; }
.bracket--bl { bottom: 18px; left: 18px; border-width: 0 0 2px 2px; }
.bracket--br { bottom: 18px; right: 18px; border-width: 0 2px 2px 0; }

/* ── Login Card ──────────────────────────────────────────── */
.login-card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 860px;
  display: flex;
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid rgba(58, 160, 255, 0.2);
  box-shadow:
    0 0 0 1px rgba(58, 160, 255, 0.06),
    0 36px 72px rgba(0, 0, 0, 0.58),
    0 0 120px rgba(58, 160, 255, 0.07);
}

/* ── Brand Panel (left column) ───────────────────────────── */
.brand-panel {
  width: 310px;
  flex-shrink: 0;
  background: linear-gradient(168deg, rgba(10, 24, 54, 0.97) 0%, rgba(6, 13, 32, 0.98) 100%);
  border-right: 1px solid rgba(58, 160, 255, 0.14);
  padding: 40px 30px 32px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: relative;
  overflow: hidden;
}

/* Inner grid texture */
.brand-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(58, 160, 255, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(58, 160, 255, 0.025) 1px, transparent 1px);
  background-size: 22px 22px;
  pointer-events: none;
}

/* Top accent line */
.brand-panel::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgba(58, 160, 255, 0.55), transparent);
}

/* Gear icon box */
.brand-icon {
  position: relative;
  width: 52px;
  height: 52px;
  background: rgba(58, 160, 255, 0.07);
  border: 1px solid rgba(58, 160, 255, 0.2);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 11px;
}

.brand-icon svg {
  width: 100%;
  height: 100%;
}

.brand-title {
  position: relative;
  font-size: 20px;
  font-weight: 700;
  color: #e6edf7;
  letter-spacing: 4px;
  text-transform: uppercase;
  margin: 2px 0 0;
}

.brand-subtitle {
  position: relative;
  font-size: 10px;
  color: rgba(138, 153, 179, 0.65);
  margin: 0;
  letter-spacing: 1px;
  text-transform: uppercase;
  line-height: 1.6;
}

/* ── Slide Nav Tabs ──────────────────────────────────────── */
.info-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-top: 4px;
}

/* Tab bar */
.tab-bar {
  position: relative;
  display: flex;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(58, 160, 255, 0.12);
  border-bottom: none;
  border-radius: 7px 7px 0 0;
  overflow: hidden;
  flex-shrink: 0;
}

.tab-btn {
  flex: 1;
  background: none;
  border: none;
  padding: 8px 0 7px;
  font-size: 8px;
  letter-spacing: 2.5px;
  color: rgba(138, 153, 179, 0.4);
  font-family: var(--font-mono);
  text-transform: uppercase;
  cursor: pointer;
  position: relative;
  z-index: 1;
  transition: color 0.25s;
}

.tab-btn--active {
  color: rgba(230, 237, 247, 0.9);
}

.tab-btn:hover:not(.tab-btn--active) {
  color: rgba(138, 153, 179, 0.7);
}

/* Glowing sliding underline indicator */
.tab-bar__indicator {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 33.333%;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, #3aa0ff 40%, #3aa0ff 60%, transparent 100%);
  box-shadow: 0 0 8px rgba(58, 160, 255, 0.6), 0 0 2px rgba(58, 160, 255, 0.9);
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

/* Content viewport */
.tab-content-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(58, 160, 255, 0.09);
  border-radius: 0 0 8px 8px;
  background: rgba(0, 0, 0, 0.22);
  container-type: inline-size;
}

/* Slides strip — 3 panels side by side */
.tab-slides {
  display: flex;
  height: 100%;
  transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
}

/* Each slide = exactly 100% of the viewport (container query unit) */
.tab-slide {
  width: 100cqi;
  flex-shrink: 0;
  overflow: hidden;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
}

.tab-slide--gauge {
  padding: 8px 10px;
  align-items: center;
}

.tab-slide--gauge svg {
  width: 100%;
  height: auto;
  max-height: 100%;
}

/* Shared slide section header */
.slide-header {
  font-size: 8px;
  letter-spacing: 3px;
  color: rgba(58, 160, 255, 0.45);
  text-transform: uppercase;
  text-align: center;
  margin-bottom: 2px;
  font-family: var(--font-mono);
}

/* Status items (STATUS slide) */
.slide-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: rgba(138, 153, 179, 0.8);
  font-family: var(--font-mono);
}

/* Comm metrics (COMM slide) */
.comm-metric {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
}

.comm-metric__label {
  font-size: 8px;
  letter-spacing: 1px;
  color: rgba(91, 106, 134, 0.75);
  text-transform: uppercase;
  width: 44px;
  flex-shrink: 0;
}

.comm-metric__track {
  flex: 1;
  height: 4px;
  background: rgba(58, 160, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.comm-metric__fill {
  height: 100%;
  background: #3aa0ff;
  border-radius: 2px;
  box-shadow: 0 0 6px rgba(58, 160, 255, 0.5);
}

.comm-metric__fill--cyan {
  background: #22d3ee;
  box-shadow: 0 0 6px rgba(34, 211, 238, 0.5);
}

.comm-metric__fill--green {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
}

.comm-metric__val {
  font-size: 9px;
  color: rgba(138, 153, 179, 0.7);
  width: 34px;
  text-align: right;
  flex-shrink: 0;
}

/* LED dots */
.led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.led--ok {
  background: #22c55e;
  box-shadow: 0 0 7px rgba(34, 197, 94, 0.55);
  animation: led-pulse 2.8s ease-in-out infinite;
}

.led--warn {
  background: #f59e0b;
  box-shadow: 0 0 7px rgba(245, 158, 11, 0.55);
}

@keyframes led-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 7px rgba(34, 197, 94, 0.55); }
  50%       { opacity: 0.6; box-shadow: 0 0 3px rgba(34, 197, 94, 0.25); }
}

/* Version/footer */
.brand-footer {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 9.5px;
  color: rgba(91, 106, 134, 0.55);
  font-family: var(--font-mono);
}

.brand-version {
  background: rgba(58, 160, 255, 0.1);
  border: 1px solid rgba(58, 160, 255, 0.18);
  border-radius: 4px;
  padding: 1px 6px;
  color: rgba(58, 160, 255, 0.7);
  font-size: 9px;
}

/* ── Form Panel (right column) ───────────────────────────── */
.form-panel {
  flex: 1;
  background: rgba(9, 18, 38, 0.95);
  padding: 48px 44px 44px;
  display: flex;
  flex-direction: column;
}

/* Top accent line matching brand panel */
.form-panel::before {
  content: '';
  position: absolute;
  top: 0;
  /* can't use absolute in flow context easily, handled via border-top on card */
}

/* Form header */
.form-header {
  margin-bottom: 32px;
}

.form-header__icon {
  width: 48px;
  height: 48px;
  background: rgba(58, 160, 255, 0.07);
  border: 1px solid rgba(58, 160, 255, 0.18);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 18px;
}

.form-header__title {
  font-size: 20px;
  font-weight: 600;
  color: #e6edf7;
  margin: 0 0 6px;
  letter-spacing: 0.3px;
}

.form-header__sub {
  font-size: 10.5px;
  color: rgba(91, 106, 134, 0.75);
  margin: 0;
  letter-spacing: 2px;
  text-transform: uppercase;
}

/* Button spacing */
.form-btn-register {
  margin-top: var(--space-3);
  margin-left: 0;
}

.form-btn-forgot {
  width: 100%;
  margin-top: var(--space-2);
}

/* ── Dialog hint text ────────────────────────────────────── */
.forgot-hint {
  margin: 0 0 var(--space-3);
  color: var(--fg-muted);
  font-size: 13px;
}

/* ── Responsive: hide brand panel on narrow screens ──────── */
@media (max-width: 680px) {
  .brand-panel {
    display: none;
  }

  .form-panel {
    padding: 36px 28px 32px;
  }

  .login-card {
    border-radius: 12px;
  }

  .bracket {
    width: 20px;
    height: 20px;
  }
}
</style>
