// // sessionWebSocketService.ts
// // Lightweight WebSocket helper used by Sessions.tsx
// // Provides connect(username, onMessage, onError, onClose) and disconnect()

// type SessionUpdatePayload = {
//   type?: string;
//   sessions: any[];
//   stats: { total: number; active: number; expired: number };
// };

// let ws: WebSocket | null = null;
// let heartbeatTimer: number | null = null;
// let reconnectTimer: number | null = null;
// let reconnectAttempts = 0;
// const MAX_RECONNECT = 10;
// const RECONNECT_BASE_DELAY_MS = 2000;

// const getToken = () => {
//   return (
//     localStorage.getItem('authToken') ||
//     sessionStorage.getItem('authToken') ||
//     localStorage.getItem('token') ||
//     sessionStorage.getItem('token') ||
//     ''
//   );
// };

// // Best-effort decode to check exp and username (no signature verification)
// const safeDecodeJwt = (token: string) => {
//   try {
//     const parts = token.split('.');
//     if (parts.length < 2) return null;
//     const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
//     const json = decodeURIComponent(
//       Array.prototype.map
//         .call(atob(payload), (ch: string) => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2))
//         .join('')
//     );
//     return JSON.parse(json);
//   } catch {
//     return null;
//   }
// };

// const isTokenExpired = (token: string) => {
//   const decoded = safeDecodeJwt(token);
//   if (!decoded) return false; // can't tell -> assume not expired
//   if (!decoded.exp) return false;
//   const nowSec = Math.floor(Date.now() / 1000);
//   return decoded.exp <= nowSec;
// };

// const buildUrl = (username: string) => {
//   // normalize admin -> all_users for backend endpoint expectation
//   const userForPath = (username === 'admin' ? 'admin' : username) || 'anonymous';

//   const RAW_API = (import.meta as any).env?.VITE_API_URL ?? '';
//   const API_BASE = RAW_API.replace(/\/+$/, '') || window.location.origin;
//   const WS_BASE = API_BASE.replace(/^https?:/, (m: string) => (m === 'https:' ? 'wss:' : 'ws:'));
//   const token = getToken();
//   const safeUsername = encodeURIComponent(userForPath);
//   // encode token to avoid URL issues
//   return `${WS_BASE}/session/ws/sessions/${safeUsername}?token=${encodeURIComponent(token)}`;
// };

// const clearHeartbeat = () => {
//   if (heartbeatTimer) {
//     clearInterval(heartbeatTimer);
//     heartbeatTimer = null;
//   }
// };

// const startHeartbeat = () => {
//   clearHeartbeat();
//   heartbeatTimer = window.setInterval(() => {
//     try {
//       if (ws && ws.readyState === WebSocket.OPEN) {
//         ws.send(JSON.stringify({ type: 'ping' }));
//       }
//     } catch (e) {
//       // noop
//     }
//   }, 25000);
// };

// const cleanup = () => {
//   clearHeartbeat();
//   if (ws) {
//     try { ws.close(); } catch {}
//     ws = null;
//   }
//   if (reconnectTimer) {
//     clearTimeout(reconnectTimer);
//     reconnectTimer = null;
//   }
// };

// const connect = (
//   username: string,
//   onMessage: (data: SessionUpdatePayload) => void,
//   onOpen?: () => void,
//   onClose?: () => void,
//   onPermanentError?: (reason: string) => void
// ) => {
//   try {
//     const token = getToken();
//     if (!token) {
//       const msg = 'Missing auth token for WebSocket connection';
//       console.error('[sessionWebSocketService] ' + msg);
//       if (onPermanentError) onPermanentError(msg);
//       return;
//     }

//     // If token clearly expired, avoid handshake; surface permanent error
//     if (isTokenExpired(token)) {
//       const msg = 'Auth token expired - refresh required';
//       console.error('[sessionWebSocketService] ' + msg, safeDecodeJwt(token));
//       if (onPermanentError) onPermanentError(msg);
//       return;
//     }

//     const decoded = safeDecodeJwt(token);
//     if (decoded) {
//       console.debug('[sessionWebSocketService] token claims (best-effort):', {
//         sub: decoded.sub ?? decoded.username ?? decoded.user,
//         exp: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : undefined,
//       });
//     }

//     const url = buildUrl(username);
//     // cleanup previous socket
//     cleanup();
//     console.log('[sessionWebSocketService] connecting to', url);

//     ws = new WebSocket(url);

//     ws.onopen = () => {
//       reconnectAttempts = 0;
//       startHeartbeat();
//       if (onOpen) onOpen();
//       console.debug('[sessionWebSocketService] websocket open');
//     };

//     ws.onmessage = (ev: MessageEvent) => {
//       try {
//         const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
//         onMessage(data);
//       } catch (err) {
//         console.error('[sessionWebSocketService] parse error', err);
//       }
//     };

//     ws.onerror = (ev) => {
//       console.debug('[sessionWebSocketService] socket error', ev);
//     };

//     ws.onclose = (ev: CloseEvent) => {
//       cleanup();
//       // server rejected handshake (403) shows as connection failure — treat 1008 as permanent auth/policy rejection
//       const permanentAuth = ev.code === 1008;
//       if (permanentAuth) {
//         const reason = ev.reason || 'Authentication failed or connection rejected';
//         console.error('[sessionWebSocketService] permanent close', ev.code, reason);
//         if (onPermanentError) onPermanentError(reason);
//         return;
//       }

//       // attempt reconnect for other closes
//       if (reconnectAttempts < MAX_RECONNECT) {
//         reconnectAttempts++;
//         const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(1.5, reconnectAttempts - 1), 30000);
//         console.warn(`[sessionWebSocketService] socket closed (code=${ev.code}) - reconnecting in ${Math.round(delay/1000)}s`);
//         reconnectTimer = window.setTimeout(() => {
//           connect(username, onMessage, onOpen, onClose, onPermanentError);
//         }, delay);
//       } else {
//         const msg = 'Max reconnect attempts reached';
//         console.error('[sessionWebSocketService] ' + msg);
//         if (onPermanentError) onPermanentError(msg);
//       }

//       if (onClose) onClose();
//     };
//   } catch (err) {
//     console.error('[sessionWebSocketService] connect exception', err);
//     if (onPermanentError) onPermanentError(String(err));
//   }
// };

// const disconnect = () => {
//   cleanup();
//   reconnectAttempts = 0;
// };

// const isConnected = () => ws !== null && ws.readyState === WebSocket.OPEN;

// export default {
//   connect,
//   disconnect,
//   isConnected,
// };