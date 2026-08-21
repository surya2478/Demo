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
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/35 px-4 py-6 backdrop-blur-[1px]"
      aria-labelledby="ai-processing-title"
      aria-describedby="ai-processing-description"
      role="presentation"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="w-full max-w-[520px] rounded-[22px] border border-app bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.22)] outline-none"
      >
        <div className="flex flex-col items-center text-center">
          {isProcessing && (
            <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-[20px] bg-app-brand-50 text-app-brand-700">
              <div className="absolute h-16 w-16 rounded-full border-2 border-app-brand-100 border-t-app-brand-700 motion-safe:animate-spin" />
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-7 w-7">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v3M12 18v3M3 12h3M18 12h3M7.8 7.8l2.1 2.1M14.1 14.1l2.1 2.1M16.2 7.8l-2.1 2.1M9.9 14.1l-2.1 2.1" />
              </svg>
            </div>
          )}

          {isSuccess && (
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-green-50 text-green-600">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-8 w-8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
              </svg>
            </div>
          )}

          {isError && (
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-app-brand-50 text-app-brand-700">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-8 w-8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
          )}

          <div id="ai-processing-title" className="text-xl font-bold text-app-primary" aria-live="polite">
            {isSuccess ? 'Done' : isError ? 'Unable to Complete AI Processing' : state.title || 'AI is Working'}
          </div>

          {isProcessing && (
            <div className="mt-2 text-base font-semibold text-app-brand-800">{state.actionLabel}</div>
          )}

          <p id="ai-processing-description" className="mt-3 max-w-[420px] text-sm leading-6 text-app-secondary">
            {isSuccess
              ? state.successMessage
              : isError
                ? state.errorMessage || 'The AI service could not complete this request. Please retry or review your input.'
                : 'AI is analyzing your input and preparing the requested artifacts. Please do not refresh or close this page.'}
          </p>

          {isError && state.errorReason && (
            <div className="mt-3 rounded-[12px] bg-app-brand-50 px-3 py-2 text-sm font-medium text-app-brand-800">
              Reason: {state.errorReason}
            </div>
          )}

          {isProcessing && (
            <div className="mt-6 w-full rounded-[18px] border border-app bg-app-surface-muted/40 p-4 text-left">
              <div className="text-xs font-semibold uppercase text-app-secondary">Current Stage</div>
              <div className="mt-1 text-sm font-semibold text-app-primary" aria-live="polite">{currentStage}</div>
              <div className="mt-4 flex items-center justify-between text-xs font-semibold uppercase text-app-secondary">
                <span>Elapsed Time</span>
                <span>{formatElapsed(elapsed)}</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-app-brand-50">
                <div className="h-full w-1/3 rounded-full bg-[linear-gradient(90deg,#ff191f,#b91017)] motion-safe:animate-[pulse_1.4s_ease-in-out_infinite]" />
              </div>
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
