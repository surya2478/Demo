/**
 * Helper utility to manually track fetch-based API requests
 * for Test Assistant tabs that use streaming responses
 */

import RequestTrackerAPI from './requestTrackerAPI';
import { TabName } from './requestTracker';

interface FetchRequestLog {
  tab: TabName;
  method: string;
  url: string;
  endpoint: string;
  requestPayload?: any;
  user?: string;
  sessionId?: string;
}

interface FetchResponseUpdate {
  responseStatus: number;
  responseData: string;
  duration: number;
  error?: string;
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
 * Create a manual request log entry
 * Returns the log ID for later updates
 */
export async function createManualRequestLog(params: FetchRequestLog): Promise<string> {
  const logId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timestamp = new Date().toISOString();
  
  try {
    await RequestTrackerAPI.logRequest({
      id: logId,
      timestamp,
      tab: params.tab,
      method: params.method,
      url: params.url,
      endpoint: params.endpoint,
      requestPayload: params.requestPayload,
      user: params.user,
      sessionId: params.sessionId
    });
    
    console.log(`[ManualTracker] Created log ${logId} for ${params.tab}`);
    return logId;
  } catch (error) {
    console.error('[ManualTracker] Failed to create log:', error);
    return logId; // Return ID anyway for update attempts
  }
}

/**
 * Update a request log with response data and extracted token counts
 */
export async function updateManualRequestLog(
  logId: string,
  update: FetchResponseUpdate
): Promise<void> {
  try {
    // Extract token counts from response
    const tokenCounts = extractTokenCounts(update.responseData);
    
    // Build update payload
    const updatePayload: any = {
      responseStatus: update.responseStatus,
      responseData: update.responseData,
      duration: update.duration,
      error: update.error
    };
    console.log ('tokenCounts ======= ', tokenCounts);
    // Add token counts if extracted
    if (tokenCounts) {
      updatePayload.promptTokens = tokenCounts.promptTokens;
      updatePayload.responseTokens = tokenCounts.responseTokens;
      updatePayload.totalTokens = tokenCounts.totalTokens;
      console.log(`[ManualTracker] Extracted tokens for ${logId}:`, tokenCounts);
    }
    
    await RequestTrackerAPI.updateRequest(logId, updatePayload);
    console.log(`[ManualTracker] Updated log ${logId} with response`);
  } catch (error) {
    console.error('[ManualTracker] Failed to update log:', error);
  }
}

/**
 * Helper to get current user from session/storage
 */
export function getCurrentUser(): string | undefined {
  try {
    const userStr = localStorage.getItem('user') || sessionStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return user.username || user.email || user.id?.toString();
    }
  } catch (error) {
    console.error('Error getting current user:', error);
  }
  return undefined;
}

/**
 * Helper to get session ID
 */
export function getSessionId(): string | undefined {
  try {
    return sessionStorage.getItem('client_session_id') || sessionStorage.getItem('session_id') || undefined;
  } catch {
    return undefined;
  }
}
