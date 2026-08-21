/**
 * Fetch Tracker - monkey patches window.fetch to log Test Assistant requests only
 */

import requestTracker, { TabName } from './requestTracker';
import { getConfig } from '../config/ai-api';

function getCurrentUser(): string | undefined {
  try {
    const userStr = localStorage.getItem('username') || sessionStorage.getItem('username');
    console.log('userStr from storage:', userStr , (userStr));   
    
    if (userStr) {
      return userStr.toString();
    }
  } catch {}
  return undefined;
}

function getSessionId(): string | undefined {
  try {
    return sessionStorage.getItem('client_session_id') || sessionStorage.getItem('session_id') || undefined;
  } catch {
    return undefined;
  }
}

function extractEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}

function determineTabFromUrl(url: string): TabName | null {
  const path = extractEndpoint(url).toLowerCase();
  if (path.includes('testcases') || path.includes('test-cases') || path.includes('test_cases')) return 'testcases';
  if (path.includes('visual')) return 'visual';
  if (path.includes('test-data') || path.includes('testdata') || path.includes('test_data')) return 'data';
  if (path.includes('changes')) return 'changes';
  if (path.includes('unit')) return 'unit';
  if (path.includes('kb') || path.includes('knowledge')) return 'kb';
  return null;
}

function isTestAssistantUrl(fullUrl: string): boolean {
  try {
    const cfg = getConfig();
    const endpoints = cfg?.ENDPOINTS || ({} as any);
    const endpointValues: string[] = Object.values(endpoints).filter(Boolean) as string[];
    if (endpointValues.some(ep => ep && (fullUrl.includes(ep) || extractEndpoint(fullUrl).includes(ep)))) return true;

    const hints = ['testcases', 'visual', 'test-data', 'testdata', 'changes', 'unit', 'kb', 'knowledge'];
    if (hints.some(h => extractEndpoint(fullUrl).toLowerCase().includes(h))) return true;

    const exclude = ['/session/status', '/dashboard/', '/settings/ai-config', '/session/cleanup'];
    if (exclude.some(ex => extractEndpoint(fullUrl).includes(ex))) return false;

    return false;
  } catch {
    return false;
  }
}

export function withTabSourceHeaders(tab: TabName, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers || {});
  headers.set('X-Tab-Source', tab);
  return { ...init, headers };
}

export function setupFetchTracker() {
  if (typeof window === 'undefined' || !(window as any).fetch) return;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = (init?.method || (input as any)?.method || 'GET').toUpperCase();
      const user = getCurrentUser();
      const sessionId = getSessionId();

      // Tab source from header if present
      let tab: TabName | null = null;
      try {
        const hdrs = new Headers(init?.headers || (input as any)?.headers || {});
        const hdrTab = hdrs.get('X-Tab-Source') as TabName | null;
        if (hdrTab) tab = hdrTab;
      } catch {}

      // Only track if explicitly tagged or recognized as Test Assistant
      const shouldTrack = !!tab || isTestAssistantUrl(url);
      if (!requestTracker.isEnabled() || !shouldTrack) {
        return await originalFetch(input as any, init);
      }

      const finalTab = tab ?? determineTabFromUrl(url) ?? 'testcases';
      const logId = requestTracker.logRequest({
        tab: finalTab,
        method,
        url,
        requestPayload: init?.body,
        user,
        sessionId,
      });

      const start = Date.now();
      try {
        const res = await originalFetch(input as any, init);
        requestTracker.updateRequest(logId, {
          responseStatus: res.status,
          // Do not read body to avoid consuming streams
          duration: Date.now() - start,
        });
        return res;
      } catch (err: any) {
        requestTracker.updateRequest(logId, {
          error: err?.message || 'fetch_error',
          duration: Date.now() - start,
        });
        throw err;
      }
    } catch {
      return await originalFetch(input as any, init);
    }
  };

  console.log('Fetch tracker interceptor setup completed');
}

export default setupFetchTracker;
