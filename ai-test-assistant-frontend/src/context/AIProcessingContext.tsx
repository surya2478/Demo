import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import AIProcessingModal from '../components/ai/AIProcessingModal';
import { AIProcessingRequest, AIProcessingState, RunAIActionOptions } from '../types/aiProcessing';

interface AIProcessingContextValue {
  state: AIProcessingState;
  runAIAction: <T>(options: RunAIActionOptions<T>) => Promise<T | undefined>;
  close: () => void;
  retry: () => void;
  /** Push the streamed text the modal should show instead of a stage line. */
  setStreamPreview: (text: string) => void;
}

const DEFAULT_STAGES = [
  'Reading inputs',
  'Understanding request context',
  'Processing AI response',
  'Preparing generated artifacts'
];

const initialState: AIProcessingState = {
  isOpen: false,
  status: 'idle',
  actionName: '',
  title: 'AI is Working',
  actionLabel: 'Processing AI Request',
  artifactType: 'AI Output',
  stages: DEFAULT_STAGES
};

const AIProcessingContext = createContext<AIProcessingContextValue | null>(null);

const getUserFriendlyReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || '');
  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'Request timed out';
  if (lower.includes('network') || lower.includes('failed to fetch') || lower.includes('connection')) return 'Connection issue';
  if (lower.includes('parse') || lower.includes('json') || lower.includes('invalid')) return 'Invalid AI response';
  if (lower.includes('file') || lower.includes('upload')) return 'File processing failed';
  if (lower.includes('unsupported')) return 'Unsupported input';
  if (lower.includes('503') || lower.includes('502') || lower.includes('500')) return 'Service temporarily unavailable';
  return undefined;
};

export const AIProcessingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AIProcessingState>(initialState);
  const activeRef = useRef(false);
  const lastOptionsRef = useRef<RunAIActionOptions<any> | null>(null);

  const close = useCallback(() => {
    setState(prev => ({ ...prev, isOpen: false, status: 'idle' }));
  }, []);

  /*
   * Only the tail is kept. A generation streams tens of kilobytes, and this
   * lands in React state on every chunk -- holding all of it would re-render
   * the modal against an ever-growing string for the whole call, and the line
   * it feeds is one row of truncated text either way.
   */
  const setStreamPreview = useCallback((text: string) => {
    const tail = (text || '').replace(/\s+/g, ' ').trim().slice(-160);
    setState(prev => (prev.streamPreview === tail ? prev : { ...prev, streamPreview: tail }));
  }, []);

  const runAIAction = useCallback(async <T,>(options: RunAIActionOptions<T>): Promise<T | undefined> => {
    if (activeRef.current) return undefined;

    activeRef.current = true;
    lastOptionsRef.current = options;
    const startedAt = Date.now();
    const retryAction = options.retryAction || (() => {
      void runAIAction(options);
    });

    setState({
      ...options,
      title: options.title || 'AI is Working',
      artifactType: options.artifactType || 'AI Output',
      stages: options.stages?.length ? options.stages : DEFAULT_STAGES,
      successMessage: options.successMessage || `${options.artifactType || 'AI output'} is ready.`,
      errorMessage: options.errorMessage || 'The AI service could not complete this request. Please retry or review your input.',
      retryAction,
      isOpen: options.showModal !== false,
      status: 'processing',
      streamPreview: undefined,
      startedAt
    });

    try {
      const result = await options.execute();
      await options.onSuccess?.(result);
      setState(prev => ({
        ...prev,
        status: 'success',
        completedAt: Date.now(),
        successMessage: options.successMessage || `${options.artifactType || 'AI output'} is ready.`
      }));
      window.setTimeout(() => {
        activeRef.current = false;
        close();
      }, 1800);
      return result;
    } catch (error) {
      console.error('[AIProcessing] Action failed:', options.actionName, error);
      await options.onError?.(error);
      activeRef.current = false;
      setState(prev => ({
        ...prev,
        status: 'error',
        completedAt: Date.now(),
        errorReason: getUserFriendlyReason(error),
        errorMessage: options.errorMessage || 'The AI service could not complete this request. Please retry or review your input.'
      }));
      return undefined;
    }
  }, [close]);

  const retry = useCallback(() => {
    const retryAction = state.retryAction || lastOptionsRef.current?.retryAction;
    close();
    window.setTimeout(() => {
      void retryAction?.();
    }, 0);
  }, [close, state.retryAction]);

  const value = useMemo(
    () => ({ state, runAIAction, close, retry, setStreamPreview }),
    [state, runAIAction, close, retry, setStreamPreview]
  );

  return (
    <AIProcessingContext.Provider value={value}>
      {children}
      <AIProcessingModal state={state} onClose={close} onRetry={retry} />
    </AIProcessingContext.Provider>
  );
};

export const useAIProcessing = () => {
  const context = useContext(AIProcessingContext);
  if (!context) {
    throw new Error('useAIProcessing must be used within AIProcessingProvider');
  }
  return context;
};
