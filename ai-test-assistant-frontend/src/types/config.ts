export interface AIConfig {
  BASE_URL: string;
  ENDPOINTS: {
    generateTestCases: string;
    generateTestData: string;
    exportExcel: string;
  };
  PARAMETERS: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
}