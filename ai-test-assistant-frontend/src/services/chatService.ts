import { getConfig } from '../config/ai-api';

export interface ChatRequest {
  message: string;
  context?: {
    tab: string;
    userName: string;
    timestamp: string;
  };
}

export interface ChatResponse {
  reply: string;
  status: 'success' | 'error';
  context?: any;
  body?: ReadableStream<Uint8Array>;
}

export interface InitSessionRequest {
  brd_content: string;
  session_id: string | null;
  provider: string;
  model_name: string;
  temperature: number | string;
  max_tokens: number | string;
}

export interface InitSessionResponse {
  status?: 'success' | 'error';
  session_id?: string;
  message?: string;
}

const chatService = {
  sendMessage: async (formData: FormData): Promise<Response> => {
    const config = getConfig();
    const baseUrl = config.BASE_URL || '';
    if (!baseUrl) throw new Error('API base URL is not configured');

    const response = await fetch(`${baseUrl}${config.ENDPOINTS.chatStream}`, {
      method: 'POST',
      body: formData,
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || errorData.message || `Chat API error: ${response.status}`);
    }

    // Return the response object directly for streaming
    return response;
  },

  initSession: async (formData: FormData): Promise<InitSessionResponse> => {
    const config = getConfig();
    const baseUrl = config.BASE_URL || '';
    if (!baseUrl) throw new Error('API base URL is not configured');

    const res = await fetch(`${baseUrl}${config.ENDPOINTS.chatInitiate}`, {
      method: 'POST',
      body: formData,
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || err.message || `Chat init failed: ${res.status}`);
    }
    return res.json();
  },

  getChatHistory: async (tab: string): Promise<any[]> => {
    const config = getConfig();
    const baseUrl = config.BASE_URL || '';
    if (!baseUrl) throw new Error('API base URL is not configured');

    const response = await fetch(`${baseUrl}${config.ENDPOINTS.chatSessions}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('auth_token') || ''}`
      }
    });

    if (!response.ok) throw new Error(`Failed to fetch chat history: ${response.status}`);
    return response.json();
  }
};

export default chatService;