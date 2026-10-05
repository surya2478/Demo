// import api from './api'
// import type { Session } from '../types/session'

// interface RawSession {
//   session_id: string
//   username: string
//   ip_address?: string
//   user_agent?: string
//   created_at?: string
//   last_active?: string
//   expires_at?: string
//   status?: string
// }

// const mapSession = (raw: RawSession): Session => ({
//   sessionId: raw.session_id,
//   username: raw.username,
//   ipAddress: raw.ip_address,
//   userAgent: raw.user_agent,
//   startedAt: raw.created_at,
//   lastActiveAt: raw.last_active,
//   expiresAt: raw.expires_at,
//   status: raw.status as 'active' | 'expired' | 'revoked'
// })

// // Helper to get auth token from storage
// const getAuthToken = (): string | null => {
//   return (
//     localStorage.getItem('authToken') ||
//     sessionStorage.getItem('authToken') ||
//     localStorage.getItem('token') ||
//     sessionStorage.getItem('token') ||
//     null
//   )
// }

// const sessionService = {
//   list: async (opts?: { q?: string }): Promise<Session[]> => {
//     try {
//       const params = new URLSearchParams()
//       if (opts?.q) params.append('q', opts.q)
//       const query = params.toString() ? `?${params.toString()}` : ''
      
//       const resp = await api.get(`/session/list${query}`)
//       const sessions = resp.data.sessions || resp.data || []
//       return sessions.map(mapSession)
//     } catch (error) {
//       console.error('Failed to fetch sessions:', error)
//       throw error
//     }
//   },

//   getStatus: async (sessionId?: string) => {
//     try {
//       const token = getAuthToken()
//       if (!token) {
//         throw new Error('No authentication token found')
//       }

//       const config: any = {
//         headers: {
//           Authorization: `Bearer ${token}`
//         }
//       }

//       if (sessionId) {
//         config.params = { session_id: sessionId }
//       }

//       const resp = await api.get('/session/status', config)
//       return resp.data
//     } catch (error) {
//       console.error('Failed to get session status:', error)
//       throw error
//     }
//   },

//   terminate: async (sessionId: string): Promise<void> => {
//     await api.delete(`/session/delete/${encodeURIComponent(sessionId)}`)
//   },

//   terminateAllForUser: async (username: string): Promise<void> => {
//     await api.delete(`/session/user/${encodeURIComponent(username)}`)
//   },

//   get: async (sessionId: string): Promise<Session> => {
//     const resp = await api.get(`/session/${encodeURIComponent(sessionId)}`)
//     return resp.data
//   },

//   keepAlive: async (sessionId?: string, ttlSeconds?: number): Promise<any> => {
//     try {
//       const token = getAuthToken()
//       if (!token) {
//         console.warn('[sessionService] keepAlive: No auth token found')
//         throw new Error('No authentication token found')
//       }

//       const params: Record<string, any> = {}
//       if (sessionId) params.session_id = sessionId
//       if (ttlSeconds && ttlSeconds > 0) params.ttl_seconds = Math.floor(ttlSeconds)

//       const resp = await api.post('/session/keepAlive', {}, { 
//         params,
//         headers: {
//           Authorization: `Bearer ${token}`
//         }
//       })
//       return resp.data
//     } catch (error: any) {
//       if (error?.response?.status === 401) {
//         console.warn('[sessionService] keepAlive unauthorized (401). Token may be expired.')
//       } else {
//         console.error('[sessionService] keepAlive error:', error)
//       }
//       throw error
//     }
//   },

//   stayExtend: async (sessionId?: string, ttlSeconds?: number): Promise<boolean> => {
//     try {
//       await sessionService.keepAlive(sessionId, ttlSeconds)
//       return true
//     } catch (err) {
//       return false
//     }
//   }
// }

// export default sessionService

import api from './api'
import type { Session } from '../types/session'
import { getAuthToken } from '../utils/auth'

interface RawSession {
  session_id: string
  username: string
  ip_address?: string
  user_agent?: string
  created_at?: string
  last_active?: string
  expires_at?: string
  status?: string
}

const mapSession = (raw: RawSession): Session => ({
  sessionId: raw.session_id,
  username: raw.username,
  ipAddress: raw.ip_address,
  userAgent: raw.user_agent,
  startedAt: raw.created_at,
  lastActiveAt: raw.last_active,
  expiresAt: raw.expires_at,
  status: raw.status as 'active' | 'expired' | 'revoked'
})

const sessionService = {
  list: async (opts?: { q?: string }): Promise<Session[]> => {
    try {
      const params = new URLSearchParams()
      if (opts?.q) params.append('q', opts.q)
      const query = params.toString() ? `?${params.toString()}` : ''
      
      const resp = await api.get(`/session/list${query}`)
      const sessions = resp.data.sessions || resp.data || []
      return sessions.map(mapSession)
    } catch (error) {
      console.error('Failed to fetch sessions:', error)
      throw error
    }
  },

  // Changed: use api.get instead of fetch so request goes through app API client (auth headers, interceptors)
  getStatus: async (sessionId?: string) => {
    try {
      const resp = await api.get('/session/status', {
        params: sessionId ? { session_id: sessionId } : {}
      })
      return resp.data
    } catch (error) {
      console.error('Failed to get session status:', error)
      throw error
    }
  },

  terminate: async (sessionId: string): Promise<void> => {
    await api.delete(`/session/delete/${encodeURIComponent(sessionId)}`)
  },

  terminateAllForUser: async (username: string): Promise<void> => {
    await api.delete(`/session/user/${encodeURIComponent(username)}`)
  },

  // optional: fetch single session
  get: async (sessionId: string): Promise<Session> => {
    const resp = await api.get(`/session/${encodeURIComponent(sessionId)}`)
    return resp.data
  },

  keepAlive: async (sessionId?: string, ttlSeconds?: number): Promise<any> => {
    try {
      const token = getAuthToken()      
      console.log(' keepAlive called with sessionId:', sessionId, ' ttlSeconds:', ttlSeconds)
      if (!token) {
        console.warn('[sessionService] keepAlive: No auth token found')
        throw new Error('No authentication token found')
      }

      const params: Record<string, any> = {}
      if (sessionId) params.session_id = sessionId
      if (ttlSeconds && ttlSeconds > 0) params.ttl_seconds = Math.floor(ttlSeconds)
      
      console.log(' keepAlive params:', params);

      const resp = await api.post('/session/keepAlive', {}, { 
        params,
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
      return resp.data
    } catch (error: any) {
      if (error?.response?.status === 401) {
        console.warn('[sessionService] keepAlive unauthorized (401). Token may be expired.')
      } else {
        console.error('[sessionService] keepAlive error:', error)
      }
      throw error
    }
  },

  stayExtend: async (sessionId?: string, ttlSeconds?: number): Promise<boolean> => {
    try {
      await sessionService.keepAlive(sessionId, ttlSeconds)
      return true
    } catch (err) {
      return false
    }
  }

  // keepAlive: async (ttlSeconds?: number): Promise<any> => {
  //   const API_BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:8002';
  //   const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken') || '';
  //   const headers: Record<string, string> = {};
  //   if (token) {
  //     headers['Authorization'] = `Bearer ${token}`;
  //   }
  //   console.log('headers for keepAlive:', headers);
  //   console.log(' 111 extend session keepAlive called with ttlSeconds:', ttlSeconds);  
  //   let url = `${API_BASE}/session/keepAlive`;
  //   console.log(' 222 extend session keepAlive URL:', url); 
  //   if (ttlSeconds && ttlSeconds > 0) {
  //     url += `?ttl_seconds=${Math.floor(ttlSeconds)}`;
  //   }
  //   console.log(' 333 extend session keepAlive final URL:', url);   
  //   console.debug('[sessionService] calling keepAlive:', url);
  //   const res = await fetch(url, {
  //     method: 'POST',
  //     headers,
  //   });

  //   if (!res.ok) {
  //     const error = await res.json().catch(() => ({}));
  //     throw {
  //       status: res.status,
  //       message: error?.detail || `HTTP ${res.status}`,
  //       response: { status: res.status, data: error },
  //     };
  //   }

  //   const data = await res.json();
  //   console.debug('[sessionService] keepAlive success:', data);
  //   return data;
  // }
}

export default sessionService
