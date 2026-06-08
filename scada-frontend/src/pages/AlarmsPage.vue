<script setup>
/**
 * AlarmsPage — active alarms list (route: /alarms).
 * Displays all active alarms from useAlarmsStore with severity colour-coding
 * (critical → danger, warning → warning, info → info) and inline Acknowledge
 * buttons. Polls on mount; user can also manually refresh.
 */
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useAlarmsStore } from '@/stores/alarms'

const store = useAlarmsStore()
const { active, loading } = storeToRefs(store)

onMounted(() => store.load())

const sevType = (s) =>
  s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'info'
</script>

<template>
  <div class="page">
    <header class="page__head">
      <h2 class="page__title">Active alarms</h2>
      <el-button :icon="'Refresh'" @click="store.load()" :loading="loading">Refresh</el-button>
    </header>

    <el-table :data="active" v-loading="loading" stripe size="default" style="width: 100%">
      <el-table-column prop="time" label="Time" width="180" />
      <el-table-column label="Severity" width="120">
        <template #default="{ row }">
          <el-tag :type="sevType(row.severity)" disable-transitions>
            {{ row.severity }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="source" label="Source" width="120" />
      <el-table-column prop="message" label="Message" min-width="280" />
      <el-table-column label="Acknowledged" width="160">
        <template #default="{ row }">
          <el-tag v-if="row.ack" type="success" disable-transitions>Ack</el-tag>
          <el-button v-else size="small" type="primary" @click="store.acknowledge(row.id)">
            Acknowledge
          </el-button>
        </template>
      </el-table-column>
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
</style>
