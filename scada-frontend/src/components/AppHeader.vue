<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConnectionPill from '@/components/ConnectionPill.vue'
import { useAuthStore } from '@/stores/auth'

defineProps({
  collapsed: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle'])

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const pageTitle = computed(() => route.meta?.title || 'SCADA')
const displayName = computed(() => auth.user?.display_name || auth.user?.username || 'Operator')

async function handleSignOut() {
  await auth.signOut()
  router.push('/login')
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
            <el-dropdown-item>Profile</el-dropdown-item>
            <el-dropdown-item divided @click="handleSignOut">Sign out</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
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
