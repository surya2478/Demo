import React, { useState, useRef, useEffect } from 'react';
import chatService from '../services/chatService';
import { getConfig } from '../config/ai-api';
import { logApiEvent } from '../utils/auditApiHelper'
import useAuth from '../hooks/useAuth'
import { useAIAction } from '../hooks/useAIAction'

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ChatWindowProps {
  isOpen: boolean;
  onToggle: () => void;
  messages: ChatMessage[];
  onAddMessage: (role: 'user' | 'assistant', content: string) => void;
  onUpdateLastMessage?: (content: string) => void;  // Update last message in real-time
  onChatResponse?: (content: string) => void;       // Called when stream completes
  currentTab: string;
  userName: string;
  seedContent?: string; // concatenated BRD content to init session with
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  isOpen,
  onToggle,
  messages,
  onAddMessage,
  onUpdateLastMessage,
  onChatResponse,
  currentTab,
  userName,
  seedContent
}) => {
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isInitLoading, setIsInitLoading] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const authUser = useAuth()
  const { runAIAction } = useAIAction()
    

  useEffect(() => {
    if (messagesEndRef.current && isOpen) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const handleNewSession = async () => {


    const requestPayload = {
      brd_content: String(seedContent || '').trim(),
      session_id: '',
      provider: getConfig().PARAMETERS.provider,
      model_name: String(getConfig().PARAMETERS.model),
      temperature: String(getConfig().PARAMETERS.temperature),
      max_tokens: String(getConfig().PARAMETERS.maxTokens),
    };
    let responsePayload: any = null;
    let auditStatus: 'success' | 'failure' = 'success'
    
    await runAIAction({
      actionName: 'initialize_ai_chat_session',
      actionLabel: 'Analyzing Requirements',
      artifactType: 'AI Chat Session',
      stages: [
        'Reading requirements and inputs',
        'Understanding business and testing scope',
        'Preparing assistant context',
        'Initializing chat session'
      ],
      successMessage: 'AI Assistant session is ready.',
      retryAction: handleNewSession,
      execute: async () => {
        setInitError(null);
        onAddMessage('assistant', 'Chat session initializing.....');
        setIsInitLoading(true);
        try {
          const cfg = getConfig();
          const content = String(seedContent || '').trim();
          if (!content) throw new Error('No content available to initialize chat session');

          const fd = new FormData();
          fd.append('brd_content', content);
          fd.append('session_id', '');
          fd.append('provider', cfg.PARAMETERS.provider);
          fd.append('model_name', String(cfg.PARAMETERS.model));
          fd.append('temperature', String(cfg.PARAMETERS.temperature));
          fd.append('max_tokens', String(cfg.PARAMETERS.maxTokens));

          const res = await chatService.initSession(fd);
          console.log('Init session full response:', res);

          if (res?.message) onAddMessage('assistant', res.message);
          console.log('Init session response:', res);

          sessionIdRef.current = res.session_id || null;
          
          onAddMessage('assistant', 'Now you can continue your chat...');
          responsePayload = res;
          return res;

        } catch (err: any) {
          const msg = err?.message || 'Failed to start a new session';
          setInitError(msg);
          onAddMessage('assistant', `New session error: ${msg}`);
          auditStatus = 'failure';
          responsePayload = { error: msg };
          throw err;
        } finally {
          setIsInitLoading(false);
          try {
              await logApiEvent({
                user: authUser.user,
                module: 'AI Chat',
                action: 'Init Session',
                resourceType: 'API',
                resourceId: 'AI Chat Init',
                resourceName: 'Init Session',
                request: requestPayload,
                response: responsePayload,
                status: auditStatus
              })
            } catch (auditErr) {
              console.error('Failed to log audit event:', auditErr)
            }
        }
      }
    });
  };

  const sendCapturedMessage = async (userMessage: string, appendUserMessage: boolean) => {
    if (appendUserMessage) onAddMessage('user', userMessage);

    await runAIAction({
      actionName: 'ai_assistant_prompt_submission',
      actionLabel: 'Creating AI Recommendation',
      artifactType: 'AI Assistant Response',
      stages: [
        'Reading prompt and session context',
        'Understanding business and testing scope',
        'Generating assistant response',
        'Validating response structure',
        'Preparing AI recommendation'
      ],
      successMessage: 'AI Assistant response is ready.',
      retryAction: () => sendCapturedMessage(userMessage, false),
      execute: async () => {
        setIsLoading(true);
        
        console.log('Sending user message:', userMessage, 'with session_id:', sessionIdRef.current);  
        
        const fd = new FormData();
        fd.append('session_id', sessionIdRef.current || '');
        fd.append('user_input', userMessage);
        fd.append('system_prompt','');

        const requestPayload = {
          session_id: sessionIdRef.current,
          user_input: userMessage,
          system_prompt: ''
        };
        let responsePayload: any = null;
        let auditStatus: 'success' | 'failure' = 'success'
        
        try {
          const response = await chatService.sendMessage(fd);
          
          if (!response.body) {
            throw new Error('No response body available');
          }
          console.log('Chat streaming response received', response.body);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let accumulatedText = '';

          // Add an initial empty assistant message
          onAddMessage('assistant', '');

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            accumulatedText += chunk;

            // Update last message in real-time
            if (onUpdateLastMessage) {
              onUpdateLastMessage(accumulatedText);
            }
          }

          console.log('Final accumulated text:', accumulatedText);  

          // Extract session_id if in response
          try {
            const jsonMatch = accumulatedText.match(/\{.*\}/);
            if (jsonMatch) {
              const data = JSON.parse(jsonMatch[0]);
              if (data.session_id) {
                sessionIdRef.current = data.session_id;
              }
            }
          } catch (e) {
            // Not JSON, just text
          }

          // Notify parent component of completed response
          if (onChatResponse) {
            onChatResponse(accumulatedText);
          }

          responsePayload = { message: accumulatedText, session_id: sessionIdRef.current };
          return accumulatedText;
          
        } catch (error) {
          console.error('Chat error:', error);
          onAddMessage('assistant', 'An error occurred while processing your request. Please try again.');
          auditStatus = 'failure';
          responsePayload = { error: (error as Error).message };
          throw error;
        } finally {
          setIsLoading(false);

          try {
              await logApiEvent({
                user: authUser.user,
                module: 'AI Chat',
                action: 'Send Message',
                resourceType: 'API',
                resourceId: 'AI Chat Message',
                resourceName: 'Send Message',
                request: requestPayload,
                response: responsePayload,
                status: auditStatus
              })
            } catch (auditErr) {
              console.error('Failed to log audit event:', auditErr)
            }        
        }
      }
    });
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const userMessage = inputValue.trim();
    setInputValue('');
    await sendCapturedMessage(userMessage, true);
  };

  return (
    <>
      {/* Chat Button - Fixed bottom-right corner */}
      {!isOpen && (
        <button
          onClick={onToggle}
          className="fixed bottom-6 right-6 w-14 h-14 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all duration-200 hover:scale-110 z-40"
          title="Open chat"
          aria-label="Open chat assistant"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </button>
      )}

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 w-96 h-[520px] max-h-[80vh] bg-white rounded-lg shadow-2xl flex flex-col border border-gray-200 z-50 animate-fadeInUp overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-red-600 to-red-700 text-white p-4 rounded-t-lg flex items-center justify-between">
            {/* <div>
              <h3 className="font-semibold text-lg">AI Assistant</h3>
              <p className="text-xs text-red-100">{currentTab}</p>
            </div> */}

            <div>
              <div className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-white"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <rect x="7" y="7" width="10" height="10" rx="2" strokeWidth="2"></rect>
                  <path d="M12 3v3M12 21v-3M3 12h3M21 12h-3" strokeWidth="2" strokeLinecap="round"></path>
                </svg>
                <h3 className="font-semibold text-lg">AI Assistant</h3>
              </div>
              <p className="text-xs text-red-100">{currentTab}</p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleNewSession}
                disabled={isInitLoading}
                className="text-white bg-red-500 hover:bg-red-800 px-3 py-1 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Start a new chat session"
              >
                {isInitLoading ? 'Initializing chat session...' : 'New Session'}
              </button>
              <button
                onClick={onToggle}
                className="text-white hover:bg-red-800 rounded-full p-1 transition-colors"
                aria-label="Close chat"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>

          {initError && (
            <div className="px-4 py-2 text-xs text-red-700 bg-red-100 border-b border-red-200">
              {initError}
            </div>
          )}

          {/* Messages Container */}
          {/* <div className="fixed bottom-6 right-6 w-96 h-[520px] max-h-[80vh] bg-white rounded-lg shadow-2xl flex flex-col border border-gray-200 z-50 animate-fadeInUp overflow-hidden"> */}
            <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
              {messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm text-center px-4">
                  <div>
                    <svg className="w-12 h-12 mx-auto mb-2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                      />
                    </svg>
                    <p>Start a conversation</p>
                    <p className="text-xs mt-1">Ask me anything about {currentTab.toLowerCase()}</p>
                  </div>
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-xs px-4 py-2 rounded-lg ${
                      msg.role === 'user'
                        ? 'bg-red-600 text-white rounded-br-none'
                        : 'bg-gray-200 text-gray-900 rounded-bl-none'
                    } shadow-sm text-sm`}>
                      <p className="break-words whitespace-pre-wrap">{msg.content}</p>
                      <p className={`text-xs mt-1 ${msg.role === 'user' ? 'text-red-100' : 'text-gray-500'}`}>
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))
              )}

              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-200 text-gray-900 rounded-lg rounded-bl-none px-4 py-2">
                    <div className="flex space-x-2">
                      <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"></div>
                      <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                      <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          {/* </div> */}
          {/* Input Area */}
          <div className="border-t border-gray-200 p-4 bg-white rounded-b-lg">
            <form onSubmit={handleSendMessage} className="flex gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Type your message..."
                disabled={isLoading}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-none text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
              <button
                type="submit"
                disabled={isLoading || !inputValue.trim()}
                className="bg-red-600 hover:bg-red-700 disabled:bg-gray-300 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium"
                aria-label="Send message"
              >
                {isLoading ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                )}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default ChatWindow;
