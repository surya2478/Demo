import axios from 'axios';
import { setupRequestTrackerInterceptor } from '../utils/requestTrackerInterceptor';


const API_BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:8002'; //'https://ai-studio.example.com/admin/';
console.log("API_BASE",API_BASE)
/**
 * --- Timeouts ------------------------------------------------------------
 *
 * There was no timeout at all here, which is not "no limit" so much as
 * "whatever the browser feels like": a request to a wedged endpoint sat
 * spinning until Chrome gave up minutes later, and what came back then was a
 * bare "Network Error" with nothing to say which call had died or why.
 *
 * Two tiers, because this API has two populations of endpoint and one number
 * cannot serve both. Ordinary reads and writes answer in well under a second,
 * so 30s on those is generous and still fails fast when something is wrong.
 * The other population runs a language model or drives a real browser and is
 * measured in minutes -- a single test case review is ~20s of model time, and
 * the backend's own run cap (AUTOMATION_RUN_TIMEOUT_SECONDS) is 600s. Those
 * calls opt in to LONG_REQUEST_MS per call, which sits above that cap so the
 * server's own deadline is what a caller hits, not ours.
 *
 * Anything long enough to want LONG_REQUEST_MS is really asking to be a
 * polled background job; the two that already are -- generation and intake
 * extraction -- return a job id and are on the default.
 */
export const DEFAULT_REQUEST_MS = 30_000;
export const LONG_REQUEST_MS = 900_000;

const api = axios.create({
  baseURL: API_BASE,
  timeout: DEFAULT_REQUEST_MS,
  headers: {
    'Content-Type': 'application/json'
  }
});

// --- Every request carries the saved session token ---------------------------
// The token was only copied onto api.defaults by authService (on login, or when
// AuthProvider calls /auth/me after a reload). React runs a child's effects
// before its parent's, so after a page refresh ProjectProvider -- nested inside
// AuthProvider -- restored the saved project with GET /projects/{id} BEFORE the
// header existed. That request went out without a token, got 401, and the 401
// handler below broadcast app:logout: every refresh signed the user out once a
// project had been chosen. Reading the saved token here makes the order of
// start-up calls irrelevant. A header set explicitly on a request still wins.
api.interceptors.request.use((config) => {
  const headers = config.headers as Record<string, any> | undefined
  const already = headers?.Authorization || headers?.authorization || api.defaults.headers.common['Authorization']
  if (!already) {
    try {
      const token = localStorage.getItem('api_token')
      if (token && config.headers) (config.headers as any).Authorization = `Bearer ${token}`
    } catch {
      // storage unavailable: the request goes as before
    }
  }
  return config
})

// Detect auth/session expiration responses and broadcast a global event
api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Axios reports a timeout as ECONNABORTED with "timeout of 30000ms
    // exceeded", which is true and useless -- it names neither the call nor
    // anything the reader can do. Rewriting the message here rather than in
    // each feature's error mapper means every screen benefits, since they all
    // fall back to err.message when the response carries no `detail`.
    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
      const ms = err?.config?.timeout ?? DEFAULT_REQUEST_MS
      const url = err?.config?.url ?? 'the server'
      err.message =
        `The request to ${url} did not finish within ${Math.round(ms / 1000)}s and was given up on. ` +
        `The work may still be running on the server.`
    }
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