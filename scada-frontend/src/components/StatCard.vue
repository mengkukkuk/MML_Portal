<script setup>
/**
 * StatCard — KPI summary card used in the OverviewPage grid.
 * Props:
 *   label   — metric name displayed in small caps
 *   value   — numeric or string reading
 *   unit    — optional suffix (e.g. '°C', '%')
 *   trend   — optional delta string (e.g. '+2.1%')
 *   tone    — left-border colour: 'default' | 'ok' | 'warn' | 'crit'
 *   icon    — optional Element Plus icon name shown in the card header
 */
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], required: true },
  unit: { type: String, default: '' },
  trend: { type: String, default: '' },       // e.g. '+2.1%' or '-3'
  tone: { type: String, default: 'default' }, // default | ok | warn | crit
  icon: { type: String, default: '' },
})
</script>

<template>
  <div class="card" :data-tone="tone">
    <div class="card__head">
      <span class="card__label">{{ label }}</span>
      <el-icon v-if="icon" class="card__icon"><component :is="icon" /></el-icon>
    </div>
    <div class="card__value-row">
      <span class="card__value">{{ value }}</span>
      <span v-if="unit" class="card__unit">{{ unit }}</span>
    </div>
    <div v-if="trend" class="card__trend">{{ trend }}</div>
  </div>
</template>

<style scoped>
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 110px;
  position: relative;
  overflow: hidden;
}

.card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--border);
}

.card[data-tone='ok']::before   { background: var(--ok); }
.card[data-tone='warn']::before { background: var(--warn); }
.card[data-tone='crit']::before { background: var(--crit); }

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--fg-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.card__icon {
  font-size: 16px;
  color: var(--fg-dim);
}

.card__value-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.card__value {
  font-size: clamp(22px, 2.4vw, 30px);
  font-weight: 600;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.card__unit {
  color: var(--fg-muted);
  font-size: 13px;
}

.card__trend {
  font-size: 12px;
  color: var(--fg-muted);
}
</style>
