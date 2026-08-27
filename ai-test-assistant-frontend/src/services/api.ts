import axios from 'axios';
import { setupRequestTrackerInterceptor } from '../utils/requestTrackerInterceptor';


const API_BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:8002'; //'https://ai-studio.example.com/admin/';
console.log("API_BASE",API_BASE)
const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Detect auth/session expiration responses and broadcast a global event
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err?.response?.status
    if (status === 401 || status === 440 || status === 419) {
      try {
        window.dispatchEvent(new CustomEvent('app:logout', { detail: { status } }))
      } catch (e) {
        // ignore
      }
    }
    return Promise.reject(err)
  }
);

// Setup the interceptor
setupRequestTrackerInterceptor(api);

export default api;