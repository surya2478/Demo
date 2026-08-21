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

// Capture the native fetch before any interceptor modifies it
const nativeFetch = (() => {
  if (typeof window !== 'undefined' && (window as any).fetch) {
    return (window as any).fetch.bind(window);
  }
  return fetch;
})();

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
      // For FormData: Use ONLY method and body, no headers whatsoever
      // Browser will automatically set Content-Type: multipart/form-data with boundary
      fetchOptions = {
        method: options.method || 'POST',
        body: options.body
      };
      console.log("[TrackedFetch] FormData detected - using minimal fetch options (no headers)");
    } else {
      // For non-FormData: Can safely add headers
      fetchOptions = {
        method: options.method || 'POST',
        body: options.body,
        headers: { 'Accept': 'application/json' }
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