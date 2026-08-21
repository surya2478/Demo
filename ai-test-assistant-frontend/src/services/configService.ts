import axios from 'axios';
import type { AIConfig } from '../types/config';

const configService = {
  async saveConfig(config: AIConfig): Promise<void> {
    try {
      await axios.post('/api/config/save', config);
    } catch (error) {
      console.error('Failed to save config:', error);
      throw new Error('Failed to save configuration');
    }
  },

  async loadConfig(): Promise<AIConfig> {
    try {
      const response = await axios.get('/api/config/load');
      return response.data;
    } catch (error) {
      console.error('Failed to load config:', error);
      throw new Error('Failed to load configuration');
    }
  }
};

export default configService;