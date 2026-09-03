/**
 * Fetch wrapper that automatically logs requests and extracts token details
 * This wrapper logs the request, accumulates the response, extracts tokens,
 * and updates the log with token information
 * 
 * IMPORTANT: This is ONLY for the 6 Test Assistant tabs (visual, testcases, data, changes, unit, kb)
 * All other API calls should use the standard axios API with interceptor
 */

import RequestTrackerAPI from './requestTrackerAPI';
import { TabName } from './requestTracker';

interface TrackedFetchOptions {
  tab: TabName;
  method?: string;
  user?: string;
  sessionId?: string;
  headers?: Record<string, string>;
  body?: FormData;
  /**
   * When true, do NOT consume the response body here.
   * Return the raw Response so callers can handle streaming themselves.
   * Default: false (legacy behavior returns accumulated fullText)
   */
  externalStream?: boolean;
}

// Resolve the auth token: runtime session token first, then the .env-configured key
export function getAiAuthToken(): string {
  // try {
  //   const runtimeToken =
  //     localStorage.getItem('api_token') ||
  //     localStorage.getItem('authToken') ||
  //     localStorage.getItem('auth_token') ||
  //     sessionStorage.getItem('authToken') ||
  //     '';
  //   if (runtimeToken) return runtimeToken;
  // } catch {
  //   // storage unavailable — fall through to env token
  // }
  return (import.meta as any).env?.VITE_AI_API_TOKEN || '';
}

// Capture the native fetch before any interceptor modifies it
const nativeFetch = (() => {
  if (typeof window !== 'undefined' && (window as any).fetch) {
    return (window as any).fetch.bind(window);
  }
  return fetch;
})();

/**
 * Origin AND base path of our own admin backend, with any trailing slash gone.
 * Null when VITE_API_URL is unset or unparseable, which means "trust nothing".
 */
function ownBackendPrefix(): string | null {
  const raw = String((import.meta as any).env?.VITE_API_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.href);
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Bearer header for calls that land on our own admin backend, and nothing else.
 *
 * ai_config.BASE_URL can point anywhere, and attaching the session token
 * unconditionally would hand our JWT to whatever host that happens to be.
 *
 * Comparing origins is NOT enough, and the deployed setup is exactly the case
 * that proves it: the admin backend is served at
 * https://<host>/admin/ while the external AI service sits at https://<host>/
 * on the SAME host. An origin check matches both, which would leak the token to
 * the AI service. So the full base prefix is compared, and the boundary is
 * checked so that a backend at "/admin" does not match a path like
 * "/administration".
 */
function isOwnBackend(targetUrl: string): boolean {
  const base = ownBackendPrefix();
  if (!base) return false;
  try {
    const url = new URL(targetUrl, window.location.href);
    const target = url.origin + url.pathname;
    return target === base || target.startsWith(base + '/');
  } catch {
    return false;
  }
}

export function authHeaderForOwnBackend(targetUrl: string): Record<string, string> {
  if (!isOwnBackend(targetUrl)) return {};

  // AuthContext writes 'authToken'; authService writes 'api_token'. Both are
  // the same access token, and which one is present depends on the login path
  // taken, so try each rather than picking a winner.
  const token =
    localStorage.getItem('authToken') ||
    localStorage.getItem('api_token') ||
    sessionStorage.getItem('authToken') ||
    '';

  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * The Authorization header a destination is allowed to see, and no other.
 *
 * Two credentials exist and they are not interchangeable. The session JWT
 * belongs to our own admin backend; the AI API key belongs to the external AI
 * service. Sending either to the other's host is the leak this function exists
 * to prevent, which is why the choice is made here once rather than at each
 * call site.
 *
 * The DESTINATION decides, never which credential happens to be available.
 * This first branched on whether authHeaderForOwnBackend returned anything,
 * which conflated its two empty results: "not our backend" and "our backend
 * but nobody is signed in". The second case then fell through and sent the AI
 * service's API key to our own backend, which is not a JWT -- so the backend
 * rejected it as "Invalid or expired token", and the key was handed to a host
 * with no business seeing it. Asking isOwnBackend() separates the two, and an
 * unauthenticated call to our own backend now correctly sends no header at all
 * and gets an honest 401.
 */
export function authHeaderFor(targetUrl: string): Record<string, string> {
  if (isOwnBackend(targetUrl)) return authHeaderForOwnBackend(targetUrl);
  const aiToken = getAiAuthToken();
  return aiToken ? { Authorization: `Bearer ${aiToken}` } : {};
}

/**
 * Extract token counts from response text
 * Expected format: "[TOKEN_COUNTS:Prompt=435,Response=1401,Total=1836]"
 */
export function extractTokenCounts(responseText: string): {
  promptTokens?: number;
  responseTokens?: number;
  totalTokens?: number;
} | null {
  if (!responseText) return null;
  
  try {
    const pattern = /\[TOKEN_COUNTS:Prompt=(\d+),Response=(\d+),Total=(\d+)\]/;
    const match = responseText.match(pattern);
    
    if (match) {
      return {
        promptTokens: parseInt(match[1], 10),
        responseTokens: parseInt(match[2], 10),
        totalTokens: parseInt(match[3], 10)
      };
    }
  } catch (error) {
    console.error('Error extracting token counts:', error);
  }
  
  return null;
}

/**
 * Fetch with automatic request tracking and token extraction
 * 
 * Usage:
 * const result = await trackedFetchWithTokens(url, {
 *   tab: 'visual',
 *   method: 'POST',
 *   body: formData,
 *   user: 'john',
 *   sessionId: 'sess-123'
 * });
 * 
 * Returns: { fullText, status, logId }
 */
// Overloads to support external streaming
export async function trackedFetchWithTokens(
  fullUrl: string,
  options: TrackedFetchOptions & { externalStream: true }
): Promise<{
  response: Response;
  status: number;
  logId: string;
}>;

export async function trackedFetchWithTokens(
  fullUrl: string,
  options: TrackedFetchOptions
): Promise<{
  fullText: string;
  status: number;
  logId: string;
}>;

export async function trackedFetchWithTokens(
  fullUrl: string,
  options: TrackedFetchOptions
): Promise<any> {
  const startTime = Date.now();
  let logId = '';
  let fullText = '';
  let responseStatus = 200;

  try {
    // Step 1: Create initial request log
    const endpoint = (() => {
      try {
        return new URL(fullUrl).pathname;
      } catch {
        return fullUrl.split('?')[0];
      }
    })();

    logId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();

    const logPayload = {
      id: logId,
      timestamp,
      tab: options.tab,
      method: options.method || 'POST',
      url: fullUrl,
      endpoint,
      requestPayload: options.body instanceof FormData ? '[FormData]' : options.body,
      user: options.user,
      sessionId: options.sessionId
    };

    console.log(`[TrackedFetch] Creating log for ${options.tab}:`, logId);
    
    // Create log via API (non-blocking - don't let logging failure prevent the actual request)
    RequestTrackerAPI.logRequest(logPayload as any).catch(err => {
      console.error(`[TrackedFetch] Failed to create log ${logId}, but continuing with request:`, err);
    });

    console.log("logPayload.requestPayload :::::: #### ",logPayload.requestPayload);
    console.log("[TrackedFetch] options.body type:", options.body?.constructor.name, "is FormData?", options.body instanceof FormData);
    
    // DEBUG: Log FormData contents
    // if (options.body instanceof FormData) {
    //   console.log("[TrackedFetch] FormData entries:");
    //   for (const [key, value] of options.body.entries()) {
    //     console.log(`  - ${key}:`, value instanceof File ? `File: ${value.name}` : value);
    //   }
    // }
    
    // Step 2: Make the fetch request with streaming
    // CRITICAL: Match the exact pattern that works in direct fetch calls
    // For FormData: ONLY {method: 'POST', body: formData} - NO HEADERS!
    let fetchOptions: RequestInit;
    
    if (options.body instanceof FormData) {
      // For FormData: never set Content-Type -- the browser has to generate it
      // so it can attach the multipart boundary. Authorization is a different
      // matter: it does not touch the body encoding, and generation endpoints
      // served by our own backend require it (they spend our OpenRouter key,
      // unlike the external AI service that used to serve those paths).
      fetchOptions = {
        method: options.method || 'POST',
        body: options.body,
        headers: authHeaderFor(fullUrl)
      };
      console.log("[TrackedFetch] FormData detected - no Content-Type set (browser supplies the boundary)");
    } else {
      // For non-FormData: Can safely add headers
      fetchOptions = {
        method: options.method || 'POST',
        body: options.body,
        headers: { 'Accept': 'application/json', ...authHeaderFor(fullUrl) }
      };
      // Merge custom headers for non-FormData
      if (options.headers) {
        fetchOptions.headers = { ...fetchOptions.headers, ...options.headers };
      }
    }
    
    console.log("[TrackedFetch] Fetch options:", { method: fetchOptions.method, hasHeaders: !!fetchOptions.headers, bodyType: fetchOptions.body?.constructor.name });
    console.log("[TrackedFetch] About to call nativeFetch with URL:", fullUrl);
    console.log("[TrackedFetch] nativeFetch function:", typeof nativeFetch);
    const response = await nativeFetch(fullUrl, fetchOptions);
    responseStatus = response.status;
    console.log("[TrackedFetch] Response status:", responseStatus);

    // If caller wants to handle streaming externally, return the raw response now
    if (options.externalStream) {
      // Do NOT update the log here with response body; caller will do it after streaming.
      return { response, status: responseStatus, logId };
    }

    // Always read the response body first, regardless of status
    let responseText = '';
    if (response.body) {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        responseText += chunk.replace(/^data: /, '');
      }
    } else {
      responseText = await response.text();
    }

    fullText = responseText;

    // If response is not ok, throw error AFTER capturing response text and status
    if (!response.ok) {
      console.error(`[TrackedFetch] HTTP Error: ${responseStatus} - ${responseText}`);
      // Create error object with status code so catch block can access it
      const error = new Error(`HTTP ${responseStatus}: ${responseText}`);
      (error as any).status = responseStatus;
      (error as any).responseText = responseText;
      throw error;
    }

    // Step 4: Extract token counts and update log (only for successful responses)
    const duration = Date.now() - startTime;
    const tokenCounts = extractTokenCounts(fullText);

    const updatePayload: any = {
      response_status: responseStatus,
      response_data: fullText,
      duration
    };

    if (tokenCounts) {
      updatePayload.promptTokens = tokenCounts.promptTokens;
      updatePayload.responseTokens = tokenCounts.responseTokens;
      updatePayload.totalTokens = tokenCounts.totalTokens;
      console.log(`[TrackedFetch] Extracted tokens for ${logId}:`, tokenCounts);
    }

    console.log(`[TrackedFetch] Updating log ${logId} with response and tokens`);
    RequestTrackerAPI.updateRequest(logId, updatePayload).catch(err => {
      console.error(`[TrackedFetch] Failed to update log ${logId}:`, err);
    });

    return { fullText, status: responseStatus, logId };

  } catch (error: any) {
    // Update log with error - CRITICAL: use actual HTTP status from error object
    // NEVER use responseStatus as fallback because it starts at 200 (success)
    const duration = Date.now() - startTime;
    
    // Extract status code from error object if available
    // For HTTP errors: error.status will be set from response.status
    // For network/fetch errors: error.status will be undefined, so use 500
    // IMPORTANT: Never fallback to responseStatus because it's initialized to 200
    let errorStatus = 500; // Default to 500 for any error
    if (error.status && error.status >= 400) {
      errorStatus = error.status; // Use actual HTTP status if we have one (400, 401, 403, 404, 500, etc.)
    }
    
    const errorMessage = error.responseText || error.message || 'Unknown error';
    
    console.error(`[TrackedFetch] Error caught - status: ${errorStatus}, message: ${errorMessage}`);
    console.error(`[TrackedFetch] Debug info - error.status: ${error.status}, responseStatus was: ${responseStatus}`);
    
    if (logId) {
      try {
        await RequestTrackerAPI.updateRequest(logId, {
          response_status: errorStatus,
          response_data: errorMessage,
          duration,
          error: errorMessage
        });
        console.error(`[TrackedFetch] Updated log ${logId} with error status ${errorStatus}:`, errorMessage);
      } catch (updateErr) {
        console.error(`[TrackedFetch] Failed to update log with error:`, updateErr);
      }
    }

    throw error;
  }
}