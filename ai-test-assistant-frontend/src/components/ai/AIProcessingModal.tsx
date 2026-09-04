import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AIProcessingState } from '../../types/aiProcessing';

interface AIProcessingModalProps {
  state: AIProcessingState;
  onClose: () => void;
  onRetry: () => void;
}

const formatElapsed = (seconds: number) => {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
};

const AIProcessingModal: React.FC<AIProcessingModalProps> = ({ state, onClose, onRetry }) => {
  const [elapsed, setElapsed] = useState(0);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const stages = state.stages?.length ? state.stages : ['Processing AI request'];

  useEffect(() => {
    if (!state.isOpen || !state.startedAt) {
      setElapsed(0);
      return;
    }

    const tick = () => setElapsed(Math.floor((Date.now() - state.startedAt!) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [state.isOpen, state.startedAt]);

  useEffect(() => {
    if (!state.isOpen) return;
    if (state.status === 'error') retryButtonRef.current?.focus();
    else if (state.status === 'success') closeButtonRef.current?.focus();
    else modalRef.current?.focus();
  }, [state.isOpen, state.status]);

  useEffect(() => {
    if (!state.isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (state.status === 'processing') {
        event.preventDefault();
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, state.isOpen, state.status]);

  const currentStage = useMemo(() => {
    if (state.status !== 'processing') return stages[Math.min(stages.length - 1, 0)];
    const index = Math.min(stages.length - 1, Math.floor(elapsed / 5));
    return stages[index];
  }, [elapsed, stages, state.status]);

  if (!state.isOpen) return null;

  const isProcessing = state.status === 'processing';
  const isSuccess = state.status === 'success';
  const isError = state.status === 'error';

  return (
    <div
      className={`fixed inset-0 z-[1000] flex items-center justify-center px-4 py-6 ${isSuccess ? 'bg-transparent pointer-events-none' : 'bg-black/35 backdrop-blur-[1px]'}`}
      aria-labelledby="ai-processing-title"
      aria-describedby="ai-processing-description"
      role="presentation"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`w-full border border-app bg-white outline-none ${isSuccess ? 'max-w-[360px] rounded-[20px] px-4 py-3 shadow-[0_16px_40px_rgba(15,23,42,0.16)]' : 'max-w-[390px] rounded-[16px] p-4 shadow-[0_20px_55px_rgba(15,23,42,0.2)]'}`}
      >
        <div className="flex flex-col">
          {isProcessing && (
            <div className="flex items-center gap-3">
              <div className="relative flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-[16px] bg-app-brand-50 text-app-brand-700">
                <div className="absolute h-10 w-10 rounded-full border-[3px] border-app-brand-100 border-t-app-brand-700 motion-safe:animate-spin" />
                <img src="/etisalat-logo.svg" alt="" aria-hidden="true" className="h-6 w-6" />
              </div>
              <div className="min-w-0 text-left">
                <div id="ai-processing-title" className="text-sm font-bold text-app-primary" aria-live="polite">
                  {state.actionLabel || state.title || 'Processing'}
                </div>
                <div id="ai-processing-description" className="mt-0.5 truncate text-xs text-app-secondary" aria-live="polite">
                  {state.streamPreview || currentStage}
                </div>
              </div>
            </div>
          )}

          {isSuccess && (
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[14px] bg-green-50 text-green-600 shadow-sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-5 w-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <div className="min-w-0">
                <div id="ai-processing-title" className="text-sm font-bold text-app-primary" aria-live="polite">Complete</div>
                <p id="ai-processing-description" className="mt-0.5 truncate text-xs text-app-secondary">{state.successMessage}</p>
              </div>
            </div>
          )}

          {isError && (
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-app-brand-50 text-app-brand-700">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-8 w-8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
          )}

          {!isProcessing && !isSuccess && (
            <>
              <div id="ai-processing-title" className="text-base font-bold text-app-primary" aria-live="polite">
                Unable to Complete AI Processing
              </div>
              <p id="ai-processing-description" className="mt-2 text-sm leading-5 text-app-secondary">
                {state.errorMessage || 'The AI service could not complete this request. Please retry or review your input.'}
              </p>
            </>
          )}

          {isError && state.errorReason && (
            <div className="mt-3 rounded-[12px] bg-app-brand-50 px-3 py-2 text-sm font-medium text-app-brand-800">
              Reason: {state.errorReason}
            </div>
          )}

          {isError && (
            <div className="mt-6 flex w-full justify-end gap-3">
              <button
                type="button"
                ref={closeButtonRef}
                onClick={onClose}
                className="rounded-[12px] border border-app bg-white px-4 py-2 text-sm font-semibold text-app-primary hover:bg-app-surface-muted"
              >
                Close
              </button>
              <button
                type="button"
                ref={retryButtonRef}
                onClick={onRetry}
                className="rounded-[12px] bg-app-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-app-brand-800"
              >
                Retry
              </button>
            </div>
          )}

          {isSuccess && (
            <button ref={closeButtonRef} type="button" onClick={onClose} className="sr-only">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AIProcessingModal;
