/**
 * Simple streaming fetch helper with optional token extraction
 * Works with the existing fetchTracker interceptor
 * No complex logging - just get the response and extract tokens
 */

export interface StreamingFetchResponse {
  fullText: string;
  status: number;
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
 * Simple streaming fetch that accumulates response text
 * Works with existing fetchTracker interceptor
 * 
 * Usage:
 * const { fullText, status } = await streamingFetch(url, formData);
 * const tokens = extractTokenCounts(fullText);
 */
export async function streamingFetch(
  url: string,
  body: FormData | BodyInit | null,
  options?: { method?: string }
): Promise<StreamingFetchResponse> {
  const response = await fetch(url, {
    method: options?.method || 'POST',
    body: body
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  let fullText = '';

  // Stream and accumulate response
  if (response.body) {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      fullText += chunk.replace(/^data: /, '');
    }
  } else {
    fullText = await response.text();
  }

  return {
    fullText,
    status: response.status
  };
}
