import api from './api'
import type { User } from '../types'

interface CreateUserData {
  username?: string
  email?: string
  password: string
  role: string
  auth_source?: string
  must_change_password?: boolean
  token_allocation?: number
}

interface UpdateUserData {
  username?: string
  role?: string
  is_active?: boolean
  allowed_time_start?: string | null
  allowed_time_end?: string | null
}

const userService = {
  list: async (): Promise<User[]> => {
    try {
      const resp = await api.get('/user/list')
      const users = Array.isArray(resp.data) ? resp.data : resp.data.users || []
      return users
    } catch (error) {
      console.error('Failed to fetch users:', error)
      throw error
    }
  },

  // Create: include both email and username; try /users then fallback /users/create
  create: async (userData: CreateUserData): Promise<{ user: User; message: string }> => {
    // Format payload according to API requirements
    const payload = {
      username: userData.username || '',  // ensure username is string
      email: userData.email || '',        // ensure email is string
      password: userData.password,
      role: userData.role || 'user',       // default to 'user' if not specified
      must_change_password: userData.must_change_password ?? true,
      is_active: true,
      token_allocation: userData.token_allocation || 10000, // default token allocation
      auth_source: userData.auth_source || 'ldap'      // default auth source to 'ldap'
    }

    try {
      console.log('Creating user with payload:', JSON.stringify(payload, null, 2))
      const resp = await api.post('/user/create', payload)
      console.log('payload sent to create user:', payload)
      console.log('Create user API response status:', resp.status)
      console.log('Create user response:', resp.data);
      const createdUser: User = resp.data?.user ?? resp.data
      return { user: createdUser, message: 'User created successfully!' }
    } catch (err: any) {
      // Log the error details for debugging
      console.error('Create user error:', {
        status: err?.response?.status,
        data: err?.response?.data
      })
      throw err
    }
  },

  update: async (username: string, userData: UpdateUserData): Promise<{ user: User; message: string }> => {
    try {
      console.debug('Updating user:', username, userData)
      const resp = await api.put(`/user/update/${encodeURIComponent(username)}`, userData)
      const updatedUser: User = resp.data?.user ?? resp.data
      return { user: updatedUser, message: 'User updated successfully!' }
    } catch (error) {
      console.error(`Failed to update user ${username}:`, error)
      throw error
    }
  },
  // yet to implement delete user
  deactivate: async (username: string): Promise<void> => {
    try {
      await api.delete(`/user/delete/${encodeURIComponent(username)}`)
    } catch (error) {
      console.error(`Failed to deactivate user ${username}:`, error)
      throw error
    }
  },

  get: async (username: string): Promise<User> => {
    try {
      const resp = await api.get(`/user/user/${encodeURIComponent(username)}`)
      return resp.data
    } catch (error) {
      console.error(`Failed to fetch user ${username}:`, error)
      throw error
    }
  }
}

export default userService