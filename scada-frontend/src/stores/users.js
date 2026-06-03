import { defineStore } from 'pinia'
import { fetchUsers, createUser, updateUser, deleteUser } from '@/api/users'

export const useUsersStore = defineStore('users', {
  state: () => ({
    list: [],
    loading: false,
    error: null,
  }),
  actions: {
    async load() {
      this.loading = true
      this.error = null
      try {
        this.list = await fetchUsers()
      } catch (e) {
        this.error = e?.response?.data?.detail || e?.message || String(e)
      } finally {
        this.loading = false
      }
    },

    async create(payload) {
      await createUser(payload)
      await this.load()
    },

    async update(id, payload) {
      await updateUser(id, payload)
      await this.load()
    },

    async remove(id) {
      await deleteUser(id)
      await this.load()
    },
  },
})
