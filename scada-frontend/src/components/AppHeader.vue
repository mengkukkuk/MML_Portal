<script setup>
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import ConnectionPill from '@/components/ConnectionPill.vue'
import { useAuthStore } from '@/stores/auth'
import { changePassword } from '@/api/auth'

defineProps({
  collapsed: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle'])

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const pageTitle = computed(() => route.meta?.title || 'MML Portal')
const displayName = computed(() => auth.user?.display_name || auth.user?.username || 'Operator')

async function handleSignOut() {
  await auth.signOut()
  router.push('/login')
}

// --- Change password dialog ---
const pwVisible = ref(false)
const pwLoading = ref(false)
const pwError = ref('')
const pwForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })

function openChangePassword() {
  pwError.value = ''
  pwForm.oldPassword = ''
  pwForm.newPassword = ''
  pwForm.confirmPassword = ''
  pwVisible.value = true
}

async function submitChangePassword() {
  pwError.value = ''
  if (pwForm.newPassword.length < 8) {
    pwError.value = 'New password must be at least 8 characters'
    return
  }
  if (pwForm.newPassword !== pwForm.confirmPassword) {
    pwError.value = 'Passwords do not match'
    return
  }
  pwLoading.value = true
  try {
    await changePassword(pwForm.oldPassword, pwForm.newPassword)
    ElMessage.success('Password changed')
    pwVisible.value = false
  } catch (e) {
    pwError.value = e?.response?.data?.detail || 'Password change failed'
  } finally {
    pwLoading.value = false
  }
}
</script>

<template>
  <div class="header">
    <div class="header__left">
      <el-button
        text
        :icon="collapsed ? 'Expand' : 'Fold'"
        class="header__toggle"
        :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="emit('toggle')"
      />
      <h1 class="header__title">{{ pageTitle }}</h1>
    </div>
    <div class="header__right">
      <ConnectionPill />
      <el-dropdown trigger="click">
        <el-button text class="header__user">
          <el-icon><User /></el-icon>
          <span class="header__user-name">{{ displayName }}</span>
          <el-icon><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item @click="openChangePassword">Change password</el-dropdown-item>
            <el-dropdown-item divided @click="handleSignOut">Sign out</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <el-dialog v-model="pwVisible" title="Change password" width="400px">
      <el-form @submit.prevent="submitChangePassword" label-position="top">
        <el-form-item label="Current password">
          <el-input
            v-model="pwForm.oldPassword"
            type="password"
            show-password
            autocomplete="current-password"
          />
        </el-form-item>
        <el-form-item label="New password">
          <el-input
            v-model="pwForm.newPassword"
            type="password"
            show-password
            placeholder="At least 8 characters"
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="Confirm new password">
          <el-input
            v-model="pwForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            @keyup.enter="submitChangePassword"
          />
        </el-form-item>
        <el-alert
          v-if="pwError"
          :title="pwError"
          type="error"
          show-icon
          :closable="false"
        />
      </el-form>
      <template #footer>
        <el-button @click="pwVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="pwLoading" @click="submitChangePassword">
          Change password
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header__left,
.header__right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.header__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--fg);
}

.header__toggle {
  font-size: 18px;
  color: var(--fg-muted);
}

.header__user {
  color: var(--fg);
  display: flex;
  align-items: center;
  gap: 6px;
}

.header__user-name {
  font-size: 13px;
}

@media (max-width: 640px) {
  .header__user-name {
    display: none;
  }
}
</style>
