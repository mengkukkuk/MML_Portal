<script setup>
/**
 * DevicesPage — device inventory table (route: /devices).
 * Fetches the device list from useDevicesStore on mount and displays
 * ID, name, location, status (online/degraded/offline), CPU progress bar,
 * and uptime. Refresh button re-fetches from the backend.
 */
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useDevicesStore } from '@/stores/devices'

const store = useDevicesStore()
const { list, loading } = storeToRefs(store)

onMounted(() => store.load())

const tagType = (s) =>
  s === 'online' ? 'success' : s === 'degraded' ? 'warning' : 'danger'
</script>

<template>
  <div class="page">
    <header class="page__head">
      <h2 class="page__title">Devices</h2>
      <el-button type="primary" :icon="'Refresh'" @click="store.load()" :loading="loading">
        Refresh
      </el-button>
    </header>

    <el-table :data="list" v-loading="loading" stripe size="default" style="width: 100%">
      <el-table-column prop="id" label="ID" width="120" />
      <el-table-column prop="name" label="Name" min-width="180" />
      <el-table-column prop="location" label="Location" min-width="200" />
      <el-table-column label="Status" width="130">
        <template #default="{ row }">
          <el-tag :type="tagType(row.status)" disable-transitions>
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="CPU" width="160">
        <template #default="{ row }">
          <el-progress :percentage="row.cpu" :stroke-width="8" :show-text="false" />
          <span class="cpu-text">{{ row.cpu }}%</span>
        </template>
      </el-table-column>
      <el-table-column prop="uptime" label="Uptime" width="120" />
    </el-table>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.cpu-text {
  display: inline-block;
  margin-left: var(--space-2);
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
</style>
