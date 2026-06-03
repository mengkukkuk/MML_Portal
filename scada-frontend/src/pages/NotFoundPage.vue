<script setup>
import { useRouter } from 'vue-router'
const router = useRouter()
</script>

<template>
  <div class="nf">
    <h1 class="nf__code">404</h1>
    <p class="nf__msg">That route doesn't exist.</p>
    <el-button type="primary" @click="router.replace('/')">Back to overview</el-button>
  </div>
</template>

<style scoped>
.nf {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  height: 100vh;
  background: var(--bg-app);
  color: var(--fg);
}
.nf__code {
  font-size: 64px;
  margin: 0;
  color: var(--fg-muted);
}
.nf__msg {
  color: var(--fg-muted);
}
</style>
