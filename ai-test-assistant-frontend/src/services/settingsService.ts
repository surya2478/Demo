import api from './api';
import type { AiConfig } from '../config/ai-api';

const SETTINGS_PATH = '/settings/ai-config';
const ENV_SETTINGS_PATH = '/settings/environment';

export interface EnvironmentConfig {
  SOLUTIONS_API_AUTH_TOKEN: string;
}

const settingsService = {
  async loadConfig(): Promise<AiConfig> {
    const resp = await api.get<AiConfig>(SETTINGS_PATH);
    return resp.data;
  },

  async saveConfig(config: AiConfig): Promise<AiConfig> {
    const resp = await api.put<AiConfig>(SETTINGS_PATH, config);
    return resp.data;
  },

  async loadEnvironmentConfig(): Promise<EnvironmentConfig> {
    const resp = await api.get<EnvironmentConfig>(ENV_SETTINGS_PATH);
    return resp.data;
  },

  async saveEnvironmentConfig(config: EnvironmentConfig): Promise<EnvironmentConfig> {
    const resp = await api.put<EnvironmentConfig>(ENV_SETTINGS_PATH, config);
    return resp.data;
  }
};

export default settingsService;