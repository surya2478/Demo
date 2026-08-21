import api from './api'
import type { User } from '../types'

type LoginResponse = { 
  access_token?: string
  token_type?: string
  user?: User
}

function getToken() {
  return localStorage.getItem('authToken') ?? ''
}
async function handleResponse(res: Response) {
  if (!res.ok) {
    const text = await res.text()
    let err = text
    try {
      const json = JSON.parse(text)
      err = json?.message ?? JSON.stringify(json)
    } catch {}
    throw new Error(err || res.statusText)
  }
  return res.json().catch(() => ({}))
}


const authService = {
  login: async (username: string, password: string): Promise<LoginResponse> => {
    try {
      const resp = await api.post('/auth/login', { username, password })
      const data = resp.data as LoginResponse
      // console.log('authService.login response data:', data) ;
      // If backend returns token, set header for subsequent requests and persist
      if (data?.access_token) {
        api.defaults.headers.common['Authorization'] = `Bearer ${data.access_token}`
        localStorage.setItem('api_token', data.access_token)
      }
      // console.log('authService.login successful for user:', data);
        
      return data
    } catch (err: any) {
      console.error('authService.login error:', {
        status: err?.response?.status,
        data: err?.response?.data,
        message: err?.message
      })
      const serverMsg =
        err?.response?.data?.detail ??
        err?.response?.data?.message ??
        err?.response?.data ??
        err?.message ??
        'Login failed'
      throw new Error(typeof serverMsg === 'string' ? serverMsg : JSON.stringify(serverMsg))
    }
  },

  getCurrentUser: async (): Promise<User> => {
    try {
      // restore persisted token if header not present
      if (!api.defaults.headers.common['Authorization']) {
        const token = localStorage.getItem('api_token')
        if (token) api.defaults.headers.common['Authorization'] = `Bearer ${token}`
      }

      const resp = await api.get('/auth/me')
      // console.log('authService.getCurrentUser response data:', resp.data) ;
      return resp.data as User
    } catch (err: any) {
      console.error('authService.getCurrentUser error:', {
        status: err?.response?.status,
        data: err?.response?.data,
        message: err?.message
      })
      // clear token on 401 so app can trigger logout flow
      if (err?.response?.status === 401) {
        delete api.defaults.headers.common['Authorization']
        localStorage.removeItem('api_token')
      }
      throw new Error('Failed to fetch current user')
    }
  },

  //  async changePassword(newPassword: string, currentPassword?: string): Promise<void> {
  //   const body: any = { new_password: newPassword }
  //   if (currentPassword) body.current_password = currentPassword
  //   const res = await api.post('/change-password', {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       Authorization: `Bearer ${getToken()}`,
  //     },
  //     body: JSON.stringify(body),
  //   })
  //   await handleResponse(res)
  // },

  changePassword: async (newPassword: string, username?: string): Promise<void> => {
    try {
      // restore persisted token if header not present
      if (!api.defaults.headers.common['Authorization']) {
        const token = localStorage.getItem('api_token')
        if (token) api.defaults.headers.common['Authorization'] = `Bearer ${token}`
      }

      const body = {
        username: username || '',
        password: newPassword,
        must_change_password: false,
      }

      const resp = await api.put('/user/must_change_password', body)
      console.log('changePassword successful:', resp.data)
      return resp.data as any
    } catch (err: any) {
      console.error('changePassword error:', {
        status: err?.response?.status,
        data: err?.response?.data,
        message: err?.message
      })
      const serverMsg =
        err?.response?.data?.detail ??
        err?.response?.data?.message ??
        err?.response?.data ??
        err?.message ??
        'Failed to change password'
      throw new Error(typeof serverMsg === 'string' ? serverMsg : JSON.stringify(serverMsg))
    }
  },
}

export default authService