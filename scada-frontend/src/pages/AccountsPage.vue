<script setup>
/**
 * AccountsPage — admin-only user management page (route: /accounts).
 * Lists all users in a table and provides Create / Edit / Delete actions via
 * dialogs backed by useUsersStore. Accessible only to users with role 'admin'
 * (enforced by requiresRole in the router).
 */
import { onMounted, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUsersStore } from '@/stores/users'

const store = useUsersStore()
const { list, loading } = storeToRefs(store)

const dialogVisible = ref(false)
const dialogMode = ref('create') // 'create' | 'edit'
const submitting = ref(false)
const editingId = ref(null)

const blankForm = () => ({
  username: '',
  password: '',
  role: 'operator',
  display_name: '',
  email: '',
})
const form = reactive(blankForm())

function resetForm() {
  Object.assign(form, blankForm())
}

function openCreate() {
  dialogMode.value = 'create'
  editingId.value = null
  resetForm()
  dialogVisible.value = true
}

function openEdit(row) {
  dialogMode.value = 'edit'
  editingId.value = row.id
  resetForm()
  form.username = row.username
  form.role = row.role
  form.display_name = row.display_name
  form.email = row.email || ''
  dialogVisible.value = true
}

async function submit() {
  if (!form.display_name.trim()) {
    ElMessage.warning('Display name is required')
    return
  }
  if (dialogMode.value === 'create' && !form.username.trim()) {
    ElMessage.warning('Username is required')
    return
  }
  submitting.value = true
  try {
    if (dialogMode.value === 'create') {
      await store.create({
        username: form.username.trim(),
        password: form.password,
        role: form.role,
        display_name: form.display_name.trim(),
        email: form.email.trim() || null,
      })
      ElMessage.success('User created')
    } else {
      await store.update(editingId.value, {
        role: form.role,
        display_name: form.display_name.trim(),
        email: form.email.trim() || null,
      })
      ElMessage.success('User updated')
    }
    dialogVisible.value = false
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Save failed')
  } finally {
    submitting.value = false
  }
}

async function confirmDelete(row) {
  try {
    await ElMessageBox.confirm(
      `Delete user "${row.username}"? This cannot be undone.`,
      'Delete user',
      { type: 'warning', confirmButtonText: 'Delete', cancelButtonText: 'Cancel' },
    )
  } catch {
    return // cancelled
  }
  try {
    await store.remove(row.id)
    ElMessage.success('User deleted')
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Delete failed')
  }
}

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

onMounted(() => store.load())
</script>

<template>
  <div class="page">
    <header class="page__head">
      <h2 class="page__title">Accounts</h2>
      <div class="page__actions">
        <el-button :icon="'Refresh'" @click="store.load()" :loading="loading">
          Refresh
        </el-button>
        <el-button type="primary" :icon="'Plus'" @click="openCreate">
          Add user
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="false"
    />

    <el-table :data="list" v-loading="loading" stripe size="default" style="width: 100%">
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="username" label="Username" min-width="140" />
      <el-table-column prop="display_name" label="Display name" min-width="160" />
      <el-table-column label="Role" width="120">
        <template #default="{ row }">
          <el-tag :type="row.role === 'admin' ? 'danger' : 'info'" disable-transitions>
            {{ row.role }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="email" label="Email" min-width="200">
        <template #default="{ row }">{{ row.email || '—' }}</template>
      </el-table-column>
      <el-table-column label="Created" min-width="180">
        <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="Actions" width="160" fixed="right">
        <template #default="{ row }">
          <el-button size="small" :icon="'Edit'" @click="openEdit(row)" />
          <el-button
            size="small"
            type="danger"
            :icon="'Delete'"
            @click="confirmDelete(row)"
          />
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogMode === 'create' ? 'Add user' : 'Edit user'"
      width="440px"
    >
      <el-form label-position="top">
        <el-form-item label="Username">
          <el-input
            v-model="form.username"
            :disabled="dialogMode === 'edit'"
            placeholder="Login username"
          />
        </el-form-item>
        <el-form-item v-if="dialogMode === 'create'" label="Password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="At least 8 characters"
          />
        </el-form-item>
        <el-form-item label="Display name">
          <el-input v-model="form.display_name" placeholder="Full name" />
        </el-form-item>
        <el-form-item label="Role">
          <el-select v-model="form.role" style="width: 100%">
            <el-option label="operator" value="operator" />
            <el-option label="admin" value="admin" />
          </el-select>
        </el-form-item>
        <el-form-item label="Email (optional)">
          <el-input v-model="form.email" placeholder="name@example.com" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          {{ dialogMode === 'create' ? 'Create' : 'Save' }}
        </el-button>
      </template>
    </el-dialog>
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

.page__actions {
  display: flex;
  gap: var(--space-2);
}

.page__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
</style>
