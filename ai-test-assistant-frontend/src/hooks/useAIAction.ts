import { useAIProcessing } from '../context/AIProcessingContext';

export const useAIAction = () => {
  const { runAIAction } = useAIProcessing();
  return { runAIAction };
};
