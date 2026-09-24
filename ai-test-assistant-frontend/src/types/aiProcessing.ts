export type AIProcessingStatus = 'idle' | 'processing' | 'success' | 'error';

export interface AIProcessingRequest {
  actionName: string;
  title?: string;
  actionLabel: string;
  artifactType?: string;
  stages: string[];
  successMessage?: string;
  errorMessage?: string;
  requestId?: string;
  jobId?: string;
  retryAction?: () => void | Promise<void>;
}

export interface AIProcessingState extends AIProcessingRequest {
  isOpen: boolean;
  status: AIProcessingStatus;
  /**
   * The generated text as it streams in, shown in place of the timed stage
   * line. Undefined until a caller pushes some: an action that does not stream
   * keeps the stage narration it always had.
   */
  streamPreview?: string;
  startedAt?: number;
  completedAt?: number;
  errorReason?: string;
}

export interface RunAIActionOptions<T> extends AIProcessingRequest {
  execute: () => Promise<T>;
  onSuccess?: (result: T) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  /** False runs the action without the processing modal, for callers that show progress on the page. Defaults to true. */
  showModal?: boolean;
}
