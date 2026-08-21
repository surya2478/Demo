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
  startedAt?: number;
  completedAt?: number;
  errorReason?: string;
}

export interface RunAIActionOptions<T> extends AIProcessingRequest {
  execute: () => Promise<T>;
  onSuccess?: (result: T) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}
