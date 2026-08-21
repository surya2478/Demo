import React, { useEffect, useState, useRef } from 'react';
import settingsService from '../services/settingsService';
import type { AiConfig } from '../config/ai-api';
import type { EnvironmentConfig } from '../services/settingsService';

const Settings: React.FC = () => {
  const [activeTab, setActiveTab] = useState<number>(0);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [envConfig, setEnvConfig] = useState<EnvironmentConfig>({ SOLUTIONS_API_AUTH_TOKEN: '' });
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const didLoadRef = useRef(false)
  
  useEffect(() => {
    if (didLoadRef.current) return // prevent duplicate load (React StrictMode double mount)
    didLoadRef.current = true
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    console.log('Loading AI configuration...');
    try {
      setLoading(true);
      const [cfg, envCfg] = await Promise.all([
        settingsService.loadConfig(),
        settingsService.loadEnvironmentConfig()
      ]);
      setConfig(cfg);
      setEnvConfig(envCfg);
      setError(null);
    } catch (e: any) {
      console.error('Failed to load AI config', e);
      setError('Failed to load configuration');
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (activeTab === 0 && !config) return;
    if (activeTab === 2 && !envConfig) return;
    try {
      setSaving(true);
      if (activeTab === 2) {
        const savedEnv = await settingsService.saveEnvironmentConfig(envConfig);
        setEnvConfig(savedEnv);
      } else {
        const saved = await settingsService.saveConfig(config as AiConfig);
        setConfig(saved);
      }
      setSavedMsg('Settings saved');
      setTimeout(() => setSavedMsg(null), 2500);
      setError(null);
    } catch (e: any) {
      console.error('Failed to save config', e);
      setError('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleParamChange = (key: keyof AiConfig['PARAMETERS'], v: string | number) =>
    setConfig((prev) => (prev ? { ...prev, PARAMETERS: { ...prev.PARAMETERS, [key]: v } } : prev));

  const handleBaseUrlChange = (v: string) => setConfig((prev) => (prev ? { ...prev, BASE_URL: v } : prev));

  if (loading) {
    return <div className="p-6">Loading AI configuration...</div>;
  }

  return (
    <div className="space-y-5">
      {/* Hero card */}
      <section className="relative overflow-hidden rounded-[24px] border border-app bg-app-surface shadow-app-card">
        <div className="relative flex flex-col gap-4 px-5 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative z-10 max-w-xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-app-brand-700">Configuration</p>
            <h1 className="mt-1 text-[28px] font-bold tracking-[-0.02em] text-app-primary">Settings</h1>
            <p className="mt-1 text-sm text-app-secondary">Manage AI, API docs and environment configuration.</p>
          </div>

          {/* Decorative gear illustration */}
          <div className="pointer-events-none absolute right-[200px] top-1/2 hidden h-full w-[420px] -translate-y-1/2 lg:block">
            <div className="absolute inset-0">
              <div className="absolute left-1/2 top-1/2 h-[160px] w-[160px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_40%_30%,rgba(255,255,255,0.85),rgba(253,235,236,0.7)_60%,rgba(253,200,202,0.3)_100%)]" />
              {/* Gear */}
              <svg viewBox="0 0 120 120" className="absolute left-1/2 top-1/2 h-[110px] w-[110px] -translate-x-1/2 -translate-y-1/2 drop-shadow-[0_18px_30px_rgba(183,25,32,0.18)]">
                <defs>
                  <linearGradient id="gearGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#fbbcc0" />
                    <stop offset="55%" stopColor="#ec5b62" />
                    <stop offset="100%" stopColor="#a40e15" />
                  </linearGradient>
                </defs>
                <g fill="url(#gearGrad)">
                  <path d="M60 12c2 0 4 1 5 3l2 5c3 1 6 2 9 4l5-2c2-1 4 0 6 1l5 5c2 2 2 4 1 6l-2 5c2 3 3 6 4 9l5 2c2 1 3 3 3 5v7c0 2-1 4-3 5l-5 2c-1 3-2 6-4 9l2 5c1 2 1 4-1 6l-5 5c-2 2-4 2-6 1l-5-2c-3 2-6 3-9 4l-2 5c-1 2-3 3-5 3h-7c-2 0-4-1-5-3l-2-5c-3-1-6-2-9-4l-5 2c-2 1-4 0-6-1l-5-5c-2-2-2-4-1-6l2-5c-2-3-3-6-4-9l-5-2c-2-1-3-3-3-5v-7c0-2 1-4 3-5l5-2c1-3 2-6 4-9l-2-5c-1-2-1-4 1-6l5-5c2-2 4-2 6-1l5 2c3-2 6-3 9-4l2-5c1-2 3-3 5-3z" />
                </g>
                <circle cx="60" cy="60" r="18" fill="#fff" opacity="0.95" />
                <circle cx="60" cy="60" r="10" fill="#fbbcc0" />
              </svg>
              {/* Floating cubes */}
              <div className="absolute left-[6%] top-[24%] h-5 w-5 rotate-12 rounded-[6px] bg-app-brand-200 shadow-[0_8px_18px_rgba(183,25,32,0.18)]" />
              <div className="absolute right-[8%] top-[18%] h-4 w-4 -rotate-6 rounded-[5px] bg-app-brand-300 shadow-[0_6px_12px_rgba(183,25,32,0.15)]" />
              <div className="absolute right-[12%] bottom-[16%] h-6 w-6 rotate-12 rounded-[7px] bg-[#f8a4a8] shadow-[0_10px_24px_rgba(183,25,32,0.18)]" />
              <div className="absolute left-[14%] bottom-[20%] h-4 w-4 -rotate-12 rounded-[5px] bg-app-brand-300 shadow-[0_6px_14px_rgba(183,25,32,0.14)]" />
            </div>
          </div>

          <div className="relative z-10 flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading || saving}
              className="inline-flex items-center gap-2 rounded-[12px] border border-app bg-white px-4 py-2.5 text-sm font-semibold text-app-primary transition hover:border-app-brand-200 hover:bg-app-brand-50/40 disabled:opacity-60"
              title="Reload"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M5.5 9a8 8 0 0114.4 1M18.5 15a8 8 0 01-14.4-1" />
              </svg>
              Reload
            </button>

            <button
              onClick={save}
              disabled={(activeTab === 0 ? !config : activeTab === 2 ? !envConfig : true) || saving}
              className="inline-flex items-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:opacity-90 disabled:opacity-60"
              title="Save"
            >
              {saving ? (
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25" />
                  <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </section>

      {error && <div className="rounded-[14px] border border-red-100 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {savedMsg && <div className="rounded-[14px] border border-green-100 bg-green-50 p-3 text-sm text-green-700">{savedMsg}</div>}

      {/* Underline-style tabs */}
      <div>
        <nav className="flex flex-wrap items-center gap-6 border-b border-app">
          {([
            {
              label: 'AI Configuration',
              icon: (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                  <rect x="4" y="7" width="16" height="12" rx="2" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 7V4M9 4h6M9 13h.01M15 13h.01M9 17h6" />
                </svg>
              )
            },
            {
              label: 'API Docs',
              icon: (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5h8.25A1.5 1.5 0 0118.75 6v13.5L15 17.25 11.25 19.5 7.5 17.25 5.25 19.5V6A1.5 1.5 0 016.75 4.5h.25" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 8h6M9 11h6M9 14h4" />
                </svg>
              )
            },
            {
              label: 'Environment',
              icon: (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C9 6 7 9 7 13a5 5 0 0010 0c0-4-2-7-5-11z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 13v8" />
                </svg>
              )
            }
          ] as { label: string; icon: React.ReactNode }[]).map(({ label, icon }, idx) => (
            <button
              key={label}
              onClick={() => setActiveTab(idx)}
              className={`relative inline-flex items-center gap-2 pb-3 text-[14px] font-semibold transition-colors ${
                activeTab === idx
                  ? 'text-app-brand-700'
                  : 'text-app-secondary hover:text-app-primary'
              }`}
            >
              <span className={activeTab === idx ? 'text-app-brand-700' : 'text-app-muted'}>{icon}</span>
              {label}
              {activeTab === idx && (
                <span className="absolute inset-x-0 -bottom-[1px] h-[2px] rounded-full bg-app-brand-700" />
              )}
            </button>
          ))}
        </nav>

        <div className="mt-5">
          {activeTab === 0 && config && (
            <section className="space-y-5">
              {/* Backend URL card */}
              <div className="relative overflow-hidden rounded-[20px] border border-app bg-app-surface p-5 shadow-app-card sm:p-6">
                <div className="flex items-start gap-4">
                  <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-app-brand-50 text-app-brand-700">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                      <circle cx="12" cy="12" r="9" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
                    </svg>
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[16px] font-semibold text-app-primary">Backend URL</h3>
                    <p className="mt-0.5 text-[13px] text-app-secondary">Base endpoint for all API requests.</p>
                  </div>
                </div>
                <div className="relative mt-4">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-app-brand-700">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </span>
                  <input
                    type="text"
                    value={config.BASE_URL}
                    onChange={(e) => handleBaseUrlChange(e.target.value)}
                    className="w-full rounded-[12px] border border-app bg-white py-2.5 pl-10 pr-4 text-sm text-app-primary outline-none transition placeholder:text-app-muted focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                  />
                </div>

                {/* Decorative API illustration */}
                <div className="pointer-events-none absolute right-6 top-1/2 hidden h-[100px] w-[110px] -translate-y-1/2 lg:block">
                  <svg viewBox="0 0 110 100" className="h-full w-full">
                    <defs>
                      <linearGradient id="apiCard" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#fff" />
                        <stop offset="100%" stopColor="#fce5e7" />
                      </linearGradient>
                    </defs>
                    <rect x="14" y="14" width="74" height="56" rx="10" fill="url(#apiCard)" stroke="#f1a4a8" strokeWidth="1.2" />
                    <circle cx="24" cy="24" r="2" fill="#ec5b62" />
                    <circle cx="32" cy="24" r="2" fill="#f8a4a8" />
                    <circle cx="40" cy="24" r="2" fill="#fdcfd2" />
                    <text x="51" y="50" fontSize="14" fontWeight="700" fill="#b71920" textAnchor="middle">API</text>
                    <path d="M88 42 L100 30 M88 42 L100 54 M88 42 L100 42" stroke="#f1a4a8" strokeWidth="1.5" fill="none" />
                    <circle cx="100" cy="30" r="3" fill="#ec5b62" />
                    <circle cx="100" cy="42" r="3" fill="#f8a4a8" />
                    <circle cx="100" cy="54" r="3" fill="#fdcfd2" />
                  </svg>
                </div>
              </div>

              {/* Parameters card */}
              <div className="rounded-[20px] border border-app bg-app-surface p-5 shadow-app-card sm:p-6">
                <div className="mb-5 flex items-start gap-4">
                  <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-app-brand-50 text-app-brand-700">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h12M16 6a2 2 0 104 0 2 2 0 00-4 0zM4 12h6M10 12a2 2 0 104 0 2 2 0 00-4 0zM10 12h10M4 18h12M16 18a2 2 0 104 0 2 2 0 00-4 0z" />
                    </svg>
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[16px] font-semibold text-app-primary">Parameters</h3>
                    <p className="mt-0.5 text-[13px] text-app-secondary">Configure the AI model and request parameters.</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {Object.entries(config.PARAMETERS).map(([k]) => {
                    const key = k as keyof AiConfig['PARAMETERS'];

                    const paramMeta: Record<string, { label: string; desc: string; icon: React.ReactNode }> = {
                      provider: {
                        label: 'Provider',
                        desc: 'Select the AI provider to use.',
                        icon: (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                            <rect x="3" y="4" width="18" height="6" rx="1.5" />
                            <rect x="3" y="14" width="18" height="6" rx="1.5" />
                            <circle cx="7" cy="7" r="0.8" fill="currentColor" />
                            <circle cx="7" cy="17" r="0.8" fill="currentColor" />
                          </svg>
                        )
                      },
                      model: {
                        label: 'Model',
                        desc: 'Select the model to use.',
                        icon: (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l8.5 4.5v9L12 21l-8.5-4.5v-9L12 3z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M3.5 7.5L12 12l8.5-4.5" />
                          </svg>
                        )
                      },
                      temperature: {
                        label: 'Temperature',
                        desc: 'Controls randomness in the output.',
                        icon: (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14 14.5V5a2 2 0 10-4 0v9.5a3.5 3.5 0 104 0z" />
                          </svg>
                        )
                      },
                      maxTokens: {
                        label: 'Max Tokens',
                        desc: 'Maximum number of tokens to generate.',
                        icon: (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                            <ellipse cx="12" cy="6" rx="8" ry="2.5" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V6M4 12v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" />
                          </svg>
                        )
                      },
                      responseFormat: {
                        label: 'Response Format',
                        desc: 'Output format for the response.',
                        icon: (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5h8.25A1.5 1.5 0 0118.75 6v13.5L15 17.25 11.25 19.5 7.5 17.25 5.25 19.5V6A1.5 1.5 0 016.75 4.5h.25" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 8h6M9 11h6M9 14h4" />
                          </svg>
                        )
                      }
                    };

                    const meta = paramMeta[key] ?? {
                      label: String(k),
                      desc: 'AI parameter.',
                      icon: (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                          <circle cx="12" cy="12" r="9" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 3" />
                        </svg>
                      )
                    };

                    let inputEl: React.ReactNode;
                    if (key === 'temperature') {
                      inputEl = (
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="1"
                          value={(config.PARAMETERS as any)[key]}
                          onChange={(e) => {
                            const val = e.target.value === '' ? 0 : parseFloat(e.target.value);
                            handleParamChange(key, isNaN(val) ? 0 : val);
                          }}
                          className="w-full rounded-[10px] border border-app bg-white px-3.5 py-2 text-sm text-app-primary outline-none transition focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                        />
                      );
                    } else if (key === 'maxTokens') {
                      inputEl = (
                        <input
                          type="number"
                          step="1"
                          min="1"
                          value={(config.PARAMETERS as any)[key]}
                          onChange={(e) => {
                            const val = e.target.value === '' ? 0 : parseInt(e.target.value, 10);
                            handleParamChange(key, isNaN(val) ? 0 : val);
                          }}
                          className="w-full rounded-[10px] border border-app bg-white px-3.5 py-2 text-sm text-app-primary outline-none transition focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                        />
                      );
                    } else {
                      inputEl = (
                        <input
                          type="text"
                          value={(config.PARAMETERS as any)[k]}
                          onChange={(e) => handleParamChange(key, e.target.value)}
                          className="w-full rounded-[10px] border border-app bg-white px-3.5 py-2 text-sm text-app-primary outline-none transition focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                        />
                      );
                    }

                    return (
                      <div key={k} className="rounded-[16px] border border-app bg-app-surface-muted/30 p-4">
                        <div className="flex items-start gap-3">
                          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] bg-app-brand-50 text-app-brand-700">
                            {meta.icon}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="text-[14px] font-semibold text-app-primary">{meta.label}</div>
                            <div className="mt-0.5 text-[12px] text-app-secondary">{meta.desc}</div>
                          </div>
                        </div>
                        <div className="mt-3">{inputEl}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {activeTab === 1 && config && (
            <section>
              <div className="rounded-3xl border border-app bg-app-surface p-6 shadow-app-card">
                <div className="mb-6">
                  <h3 className="text-lg font-semibold text-app-brand-700 mb-2">API Documentation</h3>
                  <p className="text-sm text-gray-600">Complete API endpoints reference for the AI Testing Assistant backend</p>
                </div>

                {/* API Endpoints Grid */}
                <div className="space-y-4">
                  {Object.entries(config.ENDPOINTS).map(([key, endpoint]) => {
                    // Map endpoint keys to their HTTP methods and descriptions
                    const endpointMetadata: Record<string, { method: string; description: string; params?: string }> = {
                      generateTestCases: {
                        method: 'POST',
                        description: 'Generate test cases from BRD text or uploaded files',
                        params: 'provider, model_name, temperature, max_tokens, response_format, text/files'
                      },
                      exportExcel: {
                        method: 'POST',
                        description: 'Export generated test cases to Excel format',
                        params: 'test_cases_text'
                      },
                      chatInit: {
                        method: 'POST',
                        description: 'Initialize a new chat session with BRD content',
                        params: 'brd_content, session_id, provider, model_name, temperature, max_tokens'
                      },
                      chatStream: {
                        method: 'POST',
                        description: 'Send message to chat session with streaming response',
                        params: 'session_id, user_input, system_prompt'
                      },
                      chatHistory: {
                        method: 'GET',
                        description: 'Retrieve chat history for a session',
                        params: 'session_id'
                      },
                      loadConfig: {
                        method: 'GET',
                        description: 'Load AI configuration settings',
                        params: 'None'
                      },
                      saveConfig: {
                        method: 'PUT',
                        description: 'Save/update AI configuration settings',
                        params: 'AiConfig object'
                      }
                    };

                    const meta = endpointMetadata[key] || { 
                      method: 'GET', 
                      description: 'API endpoint', 
                      params: 'See endpoint documentation' 
                    };

                    return (
                      <div key={key} className="overflow-hidden rounded-3xl border border-app transition-shadow hover:shadow-app-card">
                        {/* Header */}
                        <div className="border-b border-app bg-gradient-to-r from-app-brand-50 to-app-brand-75 px-6 py-4">
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center space-x-3">
                              {/* Method Badge */}
                              <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold text-white ${
                                meta.method === 'GET' ? 'bg-app-brand-700' :
                                meta.method === 'POST' ? 'bg-green-500' :
                                meta.method === 'PUT' ? 'bg-orange-500' :
                                meta.method === 'DELETE' ? 'bg-red-500' :
                                'bg-gray-500'
                              }`}>
                                {meta.method}
                              </span>
                              {/* Endpoint Key */}
                              <h4 className="text-sm font-semibold text-gray-900">{key}</h4>
                            </div>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(endpoint);
                                alert(`Copied: ${endpoint}`);
                              }}
                              className="text-gray-400 hover:text-gray-700 p-1 transition"
                              title="Copy endpoint"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16h8M8 12h8M8 8h8M3 5a2 2 0 012-2h10a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V5z" />
                              </svg>
                            </button>
                          </div>
                          <p className="text-sm font-medium text-app-secondary">{meta.description}</p>
                        </div>

                        {/* Body */}
                        <div className="px-6 py-4 space-y-3">
                          {/* Endpoint Path */}
                          <div>
                            <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Endpoint</div>
                            <code className="block bg-gray-900 text-green-400 p-3 rounded text-xs font-mono overflow-auto">
                              {meta.method} {config.BASE_URL}{endpoint}
                            </code>
                          </div>

                          {/* Parameters */}
                          {meta.params && (
                            <div>
                              <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Parameters</div>
                              <div className="rounded-2xl border border-app-brand-100 bg-app-brand-75 p-3">
                                <p className="font-mono text-sm text-app-brand-900">{meta.params}</p>
                              </div>
                            </div>
                          )}

                          {/* Quick Info */}
                          <div className="grid grid-cols-2 gap-3 pt-2">
                            <div className="rounded-xl border border-app bg-app-brand-50/60 p-2">
                              <div className="text-xs text-gray-600 font-semibold">Content-Type</div>
                              <div className="text-sm text-gray-900 font-mono">FormData / JSON</div>
                            </div>
                            <div className="rounded-xl border border-app bg-app-brand-50/60 p-2">
                              <div className="text-xs text-gray-600 font-semibold">Auth Required</div>
                              <div className="text-sm text-gray-900 font-mono">Bearer Token</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Footer Info */}
                <div className="mt-8 rounded-2xl border border-app-brand-100 bg-app-brand-50/80 p-4">
                  <div className="flex items-start space-x-2">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-app-brand-700 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M18 5v8a2 2 0 01-2 2h-5l-5 4v-4H4a2 2 0 01-2-2V5a2 2 0 012-2h12a2 2 0 012 2zm-11-1a1 1 0 11-2 0 1 1 0 012 0z" clipRule="evenodd" />
                    </svg>
                    <div>
                      <p className="mb-1 text-sm font-semibold text-app-brand-900">API Base URL</p>
                      <code className="block rounded-xl border border-app-brand-100 bg-white p-2 text-xs font-mono text-app-brand-800">
                        {config.BASE_URL}
                      </code>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeTab === 2 && (
            <section>
              <div className="rounded-3xl border border-app bg-app-surface p-6 shadow-app-card">
                <h3 className="text-lg font-semibold text-app-brand-700 mb-4">Environment Configuration</h3>
                <div className="space-y-4 text-sm text-gray-700">
                  <p>Configure values that should be used by backend proxy integrations.</p>

                  <div>
                    <label className="block text-sm font-semibold text-app-brand-700 mb-1">Solutions API Bearer Token</label>
                    <input
                      type="text"
                      value={envConfig.SOLUTIONS_API_AUTH_TOKEN}
                      onChange={(e) => setEnvConfig((prev) => ({ ...prev, SOLUTIONS_API_AUTH_TOKEN: e.target.value }))}
                      placeholder="Paste bearer token value (without Bearer prefix)"
                      className="w-full p-2 border rounded hover:border-app-brand-600 focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100 outline-none transition"
                    />
                    <p className="mt-1 text-xs text-gray-500">This token is used by Solutions proxy endpoints for outbound Authorization header.</p>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default Settings;
