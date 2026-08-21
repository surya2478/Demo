import React, { useEffect, useRef, useState } from 'react';
import Notification from '../components/Notification';
import sessionService from '../services/sessionService';
import { useAuth } from '../hooks/useAuth';

// read configured snooze seconds from Vite env or fallback to 300 (5 minutes)
const CONFIGURED_SNOOZE_SECONDS = (() => {
  try {
    const v = Number((import.meta as any).env?.VITE_SNOOZE_SECONDS);
    // console.log('[SessionWatcher] Using configured snooze seconds:', v);  
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 300;
  } catch {
    return 300;
  }
})();
console.log('Using configured snooze seconds >>>>> :', CONFIGURED_SNOOZE_SECONDS);  
const SNOOZE_DEFAULT_SECONDS = CONFIGURED_SNOOZE_SECONDS; // default postpone time when user clicks "Extend session time"

// helper: format seconds to user-friendly minutes/seconds string
const formatDuration = (seconds: number) => {
  if (seconds <= 0) return '0 seconds';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins > 0 ? `${mins} minute${mins !== 1 ? 's' : ''}` : ''} ${secs > 0 ? `${secs} second${secs !== 1 ? 's' : ''}` : ''}`.trim();
};

// helper for modal countdown display (e.g. "1m 30s" or "45s" or "2 minutes")
const formatCountdown = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins > 0 ? `${mins}m ` : ''}${secs}s`.trim();
};

const SessionWatcher: React.FC = () => {
  const { user, logout } = useAuth();
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalMessage, setModalMessage] = useState('');
  const [modalCountdown, setModalCountdown] = useState<number | null>(null);
  const logoutTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);

  // NEW: snooze timer + interval to ensure trigger
  const snoozeTimerRef = useRef<number | null>(null); // primary setTimeout
  const snoozeIntervalRef = useRef<number | null>(null); // safety interval check
  const warnedRef = useRef<string | null>(null);
  const snoozeUntilRef = useRef<number | null>(null);
  const isLoggingOutRef = useRef(false);
  
  // NEW: Track modal shown key and just-extended flag
  const modalShownKeyRef = useRef<string | null>(null);
  const justExtendedRef = useRef<boolean>(false);

  const showNotification = (msg: string, type: 'success' | 'error') => {
    setNotification({ message: msg, type });
    setTimeout(() => setNotification(null), 3500);
  };

  function parseJwt(token: string): Record<string, any> | null {
    try {
      if (!token || typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length < 2) return null;
      // handle base64url -> base64
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      // pad base64 string if necessary
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
      const decoded = atob(padded);
      // decode UTF-8
      const json = decodeURIComponent(
        Array.prototype.map
          .call(decoded, (c: string) => {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join('')
      );
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  const clearModalAndTimers = () => {
    setModalVisible(false);
    setModalMessage('');
    setModalCountdown(null);
    if (logoutTimerRef.current) {
      clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    // clear snooze timers/intervals
    if (snoozeTimerRef.current) {
      clearTimeout(snoozeTimerRef.current);
      snoozeTimerRef.current = null;
    }
    if (snoozeIntervalRef.current) {
      clearInterval(snoozeIntervalRef.current);
      snoozeIntervalRef.current = null;
    }
    snoozeUntilRef.current = null;
    // Do NOT reset modalShownKeyRef here to prevent re-showing same modal
  };

  const triggerLogoutWithModal = (message: string, autoSeconds = 5, forceShow = false) => {
    console.log('*** triggerLogoutWithModal called, message:', message);
    console.log('*** justExtendedRef.current:', justExtendedRef.current);
    console.log('*** forceShow:', forceShow);


    // If user just extended and this is not a forced show, skip
    if (!forceShow && justExtendedRef.current) {
      console.log('*** User just extended, skipping modal show');
      return;
    }

    // If already actively logging out (timer running), don't trigger again
    if (isLoggingOutRef.current && logoutTimerRef.current !== null) {
      console.log('*** Already logging out, ignoring duplicate call');
      return;
    }

    // Clear any previous modal/timers
    clearModalAndTimers();

    // Set flag only after clearing previous logout state
    isLoggingOutRef.current = true;

    setModalMessage(message);
    setModalCountdown(autoSeconds);
    setModalVisible(true);
    console.log('SessionWatcher: triggering logout in', autoSeconds, 'seconds');

    countdownIntervalRef.current = window.setInterval(() => {
      setModalCountdown((prev) => {
        if (prev === null) return prev;
        const next = prev - 1;
        if (next <= 0) return 0;
        return next;
      });
    }, 1000);

    logoutTimerRef.current = window.setTimeout(() => {
      try {
        console.log('SessionWatcher: executing logout NOW');
        setModalVisible(false); // Hide modal before logout
        logout();
      } finally {
        clearModalAndTimers();
        isLoggingOutRef.current = false;
        justExtendedRef.current = false;
      }
    }, autoSeconds * 1000);
  };

  const stayAndExtend = (seconds = SNOOZE_DEFAULT_SECONDS) => {
    console.log('*** stayAndExtend called with seconds=', seconds);
    const secs = Math.max(0, Math.floor(Number(seconds) || SNOOZE_DEFAULT_SECONDS));
    console.debug('[SessionWatcher] stayAndExtend called, seconds=', secs);

    // Clear previous modal/timers but keep snooze scheduling fresh
    clearModalAndTimers();
    
    // IMPORTANT: Reset the logging out flag so snooze can trigger logout later
    isLoggingOutRef.current = false;
    // Mark that user just extended - prevent immediate re-showing of modal
    justExtendedRef.current = true;

    const ms = secs * 1000;
    snoozeUntilRef.current = Date.now() + ms;
    console.log('[SessionWatcher] snoozeUntilRef.current set to', new Date(snoozeUntilRef.current).toLocaleTimeString());

    // primary timeout
    snoozeTimerRef.current = window.setTimeout(() => {
      console.log('[SessionWatcher] snoozeTimerRef FIRED after', secs, 'seconds');
      if (isLoggingOutRef.current) {
        console.log('[SessionWatcher] Already logging out, skipping snooze timeout trigger');
        return;
      }
      // After snooze ends, allow modal to show again
      justExtendedRef.current = false;
      modalShownKeyRef.current = null;
      console.log('[SessionWatcher] Triggering logout modal from snooze timeout');
      triggerLogoutWithModal('Extended session time ended. Redirecting to login...', SNOOZE_DEFAULT_SECONDS, true);
      // cleanup
      if (snoozeTimerRef.current) {
        clearTimeout(snoozeTimerRef.current);
        snoozeTimerRef.current = null;
      }
      if (snoozeIntervalRef.current) {
        clearInterval(snoozeIntervalRef.current);
        snoozeIntervalRef.current = null;
      }
      snoozeUntilRef.current = null;
    }, ms) as unknown as number;

    console.log('[SessionWatcher] snoozeTimerRef scheduled for', ms, 'ms from now');

    // safety interval
    snoozeIntervalRef.current = window.setInterval(() => {
      try {
        if (!snoozeUntilRef.current) return;
        if (Date.now() >= snoozeUntilRef.current) {
          console.log('[SessionWatcher] snooze interval DETECTED EXPIRY');
          if (snoozeTimerRef.current) {
            clearTimeout(snoozeTimerRef.current);
            snoozeTimerRef.current = null;
          }
          if (snoozeIntervalRef.current) {
            clearInterval(snoozeIntervalRef.current);
            snoozeIntervalRef.current = null;
          }
          snoozeUntilRef.current = null;
          justExtendedRef.current = false;
          modalShownKeyRef.current = null;
          if (!isLoggingOutRef.current) {
            console.log('[SessionWatcher] Triggering logout modal from snooze interval');
            triggerLogoutWithModal('Extended session time ended. Redirecting to login...', SNOOZE_DEFAULT_SECONDS, true);
          }
        }
      } catch (e) {
        console.error('[SessionWatcher] snooze interval error:', e);
      }
    }, 1000) as unknown as number;

    // Call backend to extend the session
    (async () => {
      try {
        console.log('[SessionWatcher] Calling keepAlive with ttl_seconds:', secs);
        const result = await sessionService.keepAlive(undefined, secs);
        console.debug('[SessionWatcher] keepAlive success:', result);
        if (result && result.expires_at) {
          console.log('if condition');
          showNotification(`Session extended until ${new Date(result.expires_at).toLocaleTimeString()}`, 'success');
          // Clear any previous modal tracking
          modalShownKeyRef.current = null;
          warnedRef.current = null;
        } else {
          console.log('else condition');
          showNotification(`Session extended by ${formatDuration(secs)}.`, 'success');
        }
        // Keep justExtended true until a short delay passes
        setTimeout(() => {
          justExtendedRef.current = false;
        }, SNOOZE_DEFAULT_SECONDS * 1000); // keep for default snooze duration 2000
      } catch (err: any) {
        console.error('[SessionWatcher] keepAlive failed:', err);
        const statusCode = err?.response?.status ?? err?.status ?? null;
        if (statusCode === 401 || statusCode === 403) {
          // Auth failed - show error but keep local snooze active
          showNotification('Unable to extend session on server. Local snooze active - please re-login to refresh.', 'error');
        } else {
          // Other error - show best-effort message
          showNotification(`Auto-logout postponed by ${formatDuration(secs)} (local only).`, 'success');
        }
        // Keep justExtended true for a bit
        setTimeout(() => {
          justExtendedRef.current = false;
        }, 2000);
      }
    })();
  };

  // const getCurrentSessionId = (currentUsername?: string) => {
  //   // check user object claims first
  //   const fromUser = (user as any)?.sessionId ?? (user as any)?.currentSessionId ?? (user as any)?.sid;
  //   if (fromUser) return String(fromUser);

  //   // check storage tokens / sessionId keys
  //   const storageCandidates = [
  //     localStorage.getItem('sessionId'),
  //     sessionStorage.getItem('sessionId'),
  //     localStorage.getItem('currentSessionId'),
  //     sessionStorage.getItem('currentSessionId'),
  //     localStorage.getItem('authToken'),
  //     sessionStorage.getItem('token'),
  //     sessionStorage.getItem('authToken'),
  //     localStorage.getItem('token'),
  //   ];
  //   for (const c of storageCandidates) {
  //     if (!c) continue;
  //     if (!c.includes('.') && c.length > 5 && c.length < 200) return c;
  //     const payload = parseJwt(c);
  //     if (payload) {
  //       const claim = payload.sid ?? payload.sessionId ?? payload.session_id ?? payload.jti ?? payload.sess ?? payload.sub;
  //       if (claim) return String(claim);
  //     }
  //   }

  //   // cookies
  //   const cookieNames = ['sessionId', 'currentSessionId', 'connect.sid', 'sid', 'authToken', 'token'];
  //   for (const n of cookieNames) {
  //     const v = getCookie(n);
  //     if (v) return v;
  //   }

  //   return null;
  // };

  useEffect(() => {
    // Reset logout flag when user changes (logs in/out)
    isLoggingOutRef.current = false;
    justExtendedRef.current = false;
    modalShownKeyRef.current = null;
    return () => {
      // cleanup timers when component unmounts
      clearModalAndTimers();
    };
  }, [user]);

  useEffect(() => {
    let intervalHandle: number | null = null;

    const performCheck = async () => {
      if (isLoggingOutRef.current) return;

      const currentUsername = (user as any)?.username ?? (user as any)?.email;
      if (!currentUsername) return;

      // If snoozed and still within snooze window, skip modal/notification actions
      if (snoozeUntilRef.current && Date.now() < snoozeUntilRef.current) {
        try {
          // Still enforce immediate token expiry even while snoozed
          const token =
            localStorage.getItem('authToken') ??
            sessionStorage.getItem('authToken') ??
            localStorage.getItem('token') ??
            sessionStorage.getItem('token') ??
            null;
            console.log('token:', token);
          if (token) {
            const payload = parseJwt(token);
            if (payload?.exp && payload.exp * 1000 <= Date.now()) {
              triggerLogoutWithModal('Your session token has expired. Redirecting to login...', SNOOZE_DEFAULT_SECONDS, false);
            }
          }
        } catch {}
        return;
      }

      try {
        const statusResp: any = await sessionService.getStatus();
        if (!statusResp) return;

        const { session_id: sid, status, is_active, expires_at } = statusResp;

        // server signals revoked -> immediate modal+logout (security override)
        if (status === 'revoked' || (is_active === false && status === 'revoked')) {
          triggerLogoutWithModal('Your session was revoked. Redirecting to login...', 5, true);
          return;
        }

        // expired by server
        if (status === 'expired' || (expires_at && new Date(expires_at).getTime() <= Date.now())) {
          triggerLogoutWithModal('Your session has expired. Redirecting to login...', 5, true);
          return;
        }

        // warn 10s before server expiration and show modal only once
        if (expires_at) {
          const msLeft = new Date(expires_at).getTime() - Date.now();
          const modalKey = `${sid ?? ''}:${expires_at ?? ''}`;

          if (msLeft <= 10_000) {
            // show notification once per session
            if (warnedRef.current !== sid) {
              warnedRef.current = sid;
              showNotification('Your session will expire in 10 seconds. Saving your work is recommended.', 'error');
            }
            // Only show modal if user hasn't just extended and not shown for this expiry
            if (!justExtendedRef.current && modalShownKeyRef.current !== modalKey) {
              modalShownKeyRef.current = modalKey;
              const seconds = Math.max(1, Math.ceil(msLeft / 1000));
              console.log('Your session will expire soon. Extend session to stay logged in.:', seconds);
              triggerLogoutWithModal('Your session will expire soon. Extend session to stay logged in.', seconds);
            }
          } else {
            // Reset modal shown key if expiry moved further out
            if (modalShownKeyRef.current === modalKey) {
              modalShownKeyRef.current = null;
            }
          }
        }
      } catch (err: any) {
        const statusCode = err?.response?.status ?? err?.status ?? null;
        if (statusCode === 401 || statusCode === 403) {
          // If user just extended, don't immediately force logout
          if (justExtendedRef.current) {
            showNotification('Session check failed (unauthorized). Your local extension is active.', 'error');
            return;
          }
          triggerLogoutWithModal('Your session is no longer valid. Redirecting to login...', 3, true);
          return;
        }
        console.debug('SessionWatcher: getStatus failed (non-auth error)', err);
      }
    };

    // initial check + polling every 5s
    performCheck();
    intervalHandle = window.setInterval(performCheck, 5000);

    return () => {
      if (intervalHandle) clearInterval(intervalHandle);
      clearModalAndTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, logout]);

  return (
    <>
      {modalVisible && (
        <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm mx-auto shadow-lg">
            <div className="text-center">
              <h2 className="text-xl font-bold mb-4 text-red-600">Session Expiration Warning</h2>
              <p className="text-sm text-gray-700 mb-4">{modalMessage}</p>
              {modalCountdown !== null && (
                <p className="text-xs text-gray-500 mb-4">
                  Redirecting in {formatCountdown(modalCountdown)}
                </p>
              )}
              <div className="flex justify-center gap-2">
                <button
                  onClick={() => stayAndExtend()}
                  className="px-2 py-1 border border-gray-300 rounded-md text-gray-700 bg-gray-100 hover:bg-gray-200 transition-all duration-200 text-sm"
                  title={`Postpone auto-logout by ${formatDuration(SNOOZE_DEFAULT_SECONDS)}`}
                >
                  Extend session time
                </button>
                <button
                  onClick={() => {
                    clearModalAndTimers();
                    isLoggingOutRef.current = true;
                    logout();
                  }}
                  className="px-2 py-1 bg-red-600 text-white rounded-md hover:bg-red-500 transition-all duration-200 text-sm"
                >
                  Logout now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {notification && (
        <Notification
          message={notification.message}
          type={notification.type}
          onClose={() => setNotification(null)}
          duration={3500}
        />
      )}
    </>
  );
};

export default SessionWatcher;

