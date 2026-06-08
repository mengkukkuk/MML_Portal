<script setup>
/**
 * SettingsPage — application settings form (route: /settings).
 * Currently a placeholder UI for API base URL, polling interval, theme, and
 * critical alarm notifications. The save() function is not yet wired to the
 * backend or localStorage — implement persistence before shipping.
 */
import { reactive } from 'vue'

const form = reactive({
  apiBase: import.meta.env.VITE_API_BASE || '/api',
  pollSeconds: 5,
  theme: 'dark',
  notifyOnCritical: true,
})

function save() {
  // placeholder — persist to backend or localStorage later
  ElMessage?.success?.('Settings saved (placeholder)')
}
</script>

<template>
  <div class="page">
    <h2 class="page__title">Settings</h2>

    <el-card class="page__card" shadow="never">
      <el-form :model="form" label-position="top" style="max-width: 480px">
        <el-form-item label="API base URL">
          <el-input v-model="form.apiBase" placeholder="/api" />
        </el-form-item>
        <el-form-item label="Polling interval (seconds)">
          <el-input-number v-model="form.pollSeconds" :min="1" :max="60" />
        </el-form-item>
        <el-form-item label="Theme">
          <el-radio-group v-model="form.theme">
            <el-radio-button label="dark" />
            <el-radio-button label="light" disabled />
          </el-radio-group>
        </el-form-item>
        <el-form-item>
          <el-switch v-model="form.notifyOnCritical" />
          <span class="hint">Notify on critical alarms</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="save">Save</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.page__card {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
}

.hint {
  margin-left: var(--space-3);
  color: var(--fg-muted);
  font-size: 13px;
}
</style>
