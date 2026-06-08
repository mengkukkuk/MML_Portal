<script setup>
/**
 * AppShell — authenticated application layout (used by all protected routes).
 * Renders a collapsible AppSidebar on the left, a fixed AppHeader on top,
 * and a scrollable main content area with a fade-transition router-view.
 * Sidebar collapse state is local to this layout component.
 */
import { ref } from 'vue'
import AppSidebar from '@/components/AppSidebar.vue'
import AppHeader from '@/components/AppHeader.vue'

const collapsed = ref(false)
function toggleSidebar() {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <el-container class="shell" :class="{ collapsed }">
    <el-aside class="shell__aside" :width="collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)'">
      <AppSidebar :collapsed="collapsed" />
    </el-aside>
    <el-container class="shell__main">
      <el-header class="shell__header" height="var(--header-h)">
        <AppHeader :collapsed="collapsed" @toggle="toggleSidebar" />
      </el-header>
      <el-main class="shell__content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.shell {
  height: 100vh;
  background: var(--bg-app);
}

.shell__aside {
  background: var(--bg-panel);
  border-right: 1px solid var(--border-soft);
  transition: width 0.18s ease;
  overflow: hidden;
}

.shell__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.shell__header {
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-soft);
  padding: 0 var(--space-5);
  display: flex;
  align-items: center;
}

.shell__content {
  padding: var(--space-6);
  background: var(--bg-app);
  overflow: auto;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.12s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 960px) {
  .shell__content {
    padding: var(--space-4);
  }
}
</style>
