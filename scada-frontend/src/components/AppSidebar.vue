<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

defineProps({
  collapsed: { type: Boolean, default: false },
})

const route = useRoute()
const activeIndex = computed(() => '/' + (route.path.split('/')[1] || ''))

const items = [
  { path: '/', title: 'Overview', icon: 'Odometer' },
  { path: '/devices', title: 'Devices', icon: 'Cpu' },
  { path: '/alarms', title: 'Alarms', icon: 'WarningFilled' },
  { path: '/trends', title: 'Trends', icon: 'TrendCharts' },
  { path: '/settings', title: 'Settings', icon: 'Setting' },
]
</script>

<template>
  <div class="sidebar">
    <div class="sidebar__brand">
      <span class="sidebar__logo" aria-hidden="true">⚙</span>
      <span v-show="!collapsed" class="sidebar__title">SCADA</span>
    </div>
    <el-menu
      class="sidebar__menu"
      :default-active="activeIndex"
      :collapse="collapsed"
      router
      background-color="transparent"
      text-color="var(--fg-muted)"
      active-text-color="var(--accent)"
    >
      <el-menu-item v-for="item in items" :key="item.path" :index="item.path" :route="item.path">
        <el-icon><component :is="item.icon" /></el-icon>
        <template #title>{{ item.title }}</template>
      </el-menu-item>
    </el-menu>
  </div>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.sidebar__brand {
  height: var(--header-h);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--border-soft);
  color: var(--fg);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.sidebar__logo {
  font-size: 20px;
  color: var(--accent);
}

.sidebar__title {
  font-size: 14px;
}

.sidebar__menu {
  border-right: none;
  flex: 1;
  padding-top: var(--space-2);
}

.sidebar__menu :deep(.el-menu-item) {
  height: 44px;
  line-height: 44px;
  margin: 2px var(--space-2);
  border-radius: var(--radius-sm);
}

.sidebar__menu :deep(.el-menu-item.is-active) {
  background: var(--accent-soft);
}

.sidebar__menu :deep(.el-menu-item:hover) {
  background: rgba(255, 255, 255, 0.04);
}
</style>
