/**
 * Axios Interceptor for Request Tracker
 * Automatically captures all API requests made through axios
 */

import { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import requestTracker, { TabName } from './requestTracker';
import { getConfig } from '../config/ai-api';
import useAuth from '../hooks/useAuth';

interface RequestMetadata {
  startTime: number;
  logId: string;
  tab: TabName;
}

// Map to track request metadata
const requestMetadataMap = new WeakMap<InternalAxiosRequestConfig, RequestMetadata>();

/**
 * Determine which tab initiated the request based on URL or custom header
 */
function determineTab(config: InternalAxiosRequestConfig): TabName | null {
  // Check for custom header
  if (config.headers && config.headers['X-Tab-Source']) {
    return config.headers['X-Tab-Source'] as TabName;
  }

  // Infer from URL
  const url = config.url || '';
  
  if (url.includes('/testcases') || url.includes('/test-cases') || url.includes('test_cases')) {
    return 'testcases';
  } else if (url.includes('/visual')) {
    return 'visual';
  } else if (url.includes('/data') || url.includes('/test-data') || url.includes('test_data')) {
    return 'data';
  } else if (url.includes('/changes')) {
    return 'changes';
  } else if (url.includes('/unit')) {
    return 'unit';
  } else if (url.includes('/kb') || url.includes('/knowledge')) {
    return 'kb';
  }

  // Unknown / not a Test Assistant tab
  return null;
}

/**
 * Extract token usage information from API response
 * Supports multiple token response formats (OpenAI, Ollama, custom)
 */
function extractTokenInfo(responseData: any): { promptTokens?: number; responseTokens?: number; totalTokens?: number } {
  if (!responseData || typeof responseData !== 'object') {
    return {};
  }

  // OpenAI format
  if (responseData.usage) {
    return {
      promptTokens: responseData.usage.prompt_tokens,
      responseTokens: responseData.usage.completion_tokens,
      totalTokens: responseData.usage.total_tokens
    };
  }

  // Ollama format
  if (responseData.prompt_eval_count !== undefined || responseData.eval_count !== undefined) {
    return {
      promptTokens: responseData.prompt_eval_count,
      responseTokens: responseData.eval_count,
      totalTokens: (responseData.prompt_eval_count || 0) + (responseData.eval_count || 0)
    };
  }

  // Direct token fields
  if (responseData.prompt_tokens !== undefined || responseData.response_tokens !== undefined) {
    return {
      promptTokens: responseData.prompt_tokens,
      responseTokens: responseData.response_tokens,
      totalTokens: responseData.total_tokens || (responseData.prompt_tokens || 0) + (responseData.response_tokens || 0)
    };
  }

  // Nested in result or data
  if (responseData.result && typeof responseData.result === 'object') {
    return extractTokenInfo(responseData.result);
  }
  if (responseData.data && typeof responseData.data === 'object') {
    return extractTokenInfo(responseData.data);
  }

  return {};
}


/**
 * Get user information from storage or auth context
 */
function getCurrentUser(): string | undefined {
  try {
    const { user } = useAuth()
    console.log('[RequestTracker] Current user from auth context:', user);
    const userStr = user?.username || user?.email || user?.id;
    if (userStr) {
      return userStr.toString();
    }
    // const userStr = localStorage.getItem('user') || sessionStorage.getItem('user');
    // if (userStr) {
    //   const user = JSON.parse(userStr);
    //   return user.username || user.email || user.id;
    // }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Get session ID from storage
 */
function getSessionId(): string | undefined {
  try {
    return sessionStorage.getItem('client_session_id') || sessionStorage.getItem('session_id') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a given URL belongs to Test Assistant AI endpoints
 */
function isTestAssistantUrl(fullUrl: string): boolean {
  try {
    const cfg = getConfig();
    const urlPath = (() => {
      try {
        const u = new URL(fullUrl);
        return u.pathname;
      } catch {
        return fullUrl;
      }
    })();

    const endpoints = cfg?.ENDPOINTS || {} as any;
    const endpointValues: string[] = Object.values(endpoints).filter(Boolean) as string[];
    // If any configured endpoint string is contained in the URL, treat as Test Assistant
    if (endpointValues.some(ep => ep && (fullUrl.includes(ep) || urlPath.endsWith(ep) || urlPath.includes(ep)))) {
      return true;
    }

    // Additional heuristics: common TA paths
    const hints = ['testcases', 'visual', 'test-data', 'testdata', 'changes', 'unit', 'kb', 'knowledge'];
    if (hints.some(h => urlPath.toLowerCase().includes(h))) {
      console.log(`[RequestTracker] Matched KB URL: ${urlPath}`);
      return true;
    }

    // Explicit exclusions (non-TA)
    const exclude = ['/session/status', '/dashboard/', '/settings/ai-config', '/session/cleanup'];
    if (exclude.some(ex => urlPath.includes(ex))) return false;

    return false;
  } catch {
    return false;
  }
}

/**
 * Setup request tracker interceptor for an axios instance
 */
export function setupRequestTrackerInterceptor(axiosInstance: AxiosInstance) {
    console.log('Setting up request tracker interceptor...');
    // Request interceptor
  axiosInstance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      if (!requestTracker.isEnabled()) {
        return config;
      }

      const startTime = Date.now();
      const tab = determineTab(config);
      const user = getCurrentUser();
      const sessionId = getSessionId();

      const fullUrl = config.baseURL 
        ? `${config.baseURL}${config.url}` 
        : config.url || '';

        
      // Only track Test Assistant requests: require explicit tab header or TA endpoint
      const shouldTrack = !!(tab) || isTestAssistantUrl(fullUrl);
      if (!shouldTrack) {
        return config; // skip tracking
      }

      // Fallback tab if inferred by URL
      const finalTab = tab ?? 'testcases';

      const logId = requestTracker.logRequest({
        tab: finalTab,
        method: (config.method || 'GET').toUpperCase(),
        url: fullUrl,
        requestPayload: config.data,
        user : "user",
        sessionId: "sessionId",
      });

      // Store metadata for later use in response interceptor
      const metadata: RequestMetadata = {
        startTime,
        logId,
        tab: finalTab
      };
      requestMetadataMap.set(config, metadata);

      return config;
    },
    (error: AxiosError) => {
      console.error('Request interceptor error:', error);
      return Promise.reject(error);
    }
  );

  // Response interceptor
  axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => {
      if (!requestTracker.isEnabled()) {
        return response;
      }

      const metadata = requestMetadataMap.get(response.config);
      if (metadata) {
        const duration = Date.now() - metadata.startTime;
        const tokenInfo = extractTokenInfo(response.data);
        
        requestTracker.updateRequest(metadata.logId, {
          responseStatus: response.status,
          responseData: response.data,
          duration,
          ...tokenInfo
        });
      }

      return response;
    },
    (error: AxiosError) => {
      if (!requestTracker.isEnabled()) {
        return Promise.reject(error);
      }

      const metadata = error.config ? requestMetadataMap.get(error.config) : undefined;
      if (metadata) {
        const duration = Date.now() - metadata.startTime;
        
        requestTracker.updateRequest(metadata.logId, {
          responseStatus: error.response?.status,
          responseData: error.response?.data,
          duration,
          error: error.message
        });
      }

      return Promise.reject(error);
    }
  );

  console.log('Request tracker interceptor setup completed');
}

/**
 * Add tab source header to axios config
 * Use this helper when making requests to explicitly set the tab source
 */
export function withTabSource(tab: TabName) {
  return {
    headers: {
      'X-Tab-Source': tab
    }
  };
}

export default setupRequestTrackerInterceptor;
