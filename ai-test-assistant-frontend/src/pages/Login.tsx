import React, { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useNavigate } from 'react-router-dom';

const Login: React.FC = () => {
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await login(credentials.username, credentials.password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials or server error');
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_60%_40%,rgba(183,25,32,0.07),transparent_62%),radial-gradient(ellipse_at_10%_80%,rgba(253,235,236,0.6),transparent_50%)] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-[920px] overflow-hidden rounded-[28px] bg-white shadow-[0_24px_72px_rgba(120,30,30,0.13)] lg:flex">

        {/* Left — brand panel */}
        <div className="relative hidden lg:flex lg:w-[42%] flex-col justify-between bg-[linear-gradient(160deg,#4D0507_0%,#B71920_55%,#E8292E_100%)] p-10 text-white">
          <div>
            <img src="/etisalat-logo.svg" alt="Etisalat" className="h-10 object-contain brightness-0 invert" />
          </div>
          <div className="relative z-10">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/60 mb-3">AI Testing Platform</p>
            <h1 className="text-[32px] font-bold leading-tight tracking-[-0.03em]">
              AI Testing<br />Assistant
            </h1>
            <p className="mt-4 text-[14px] leading-7 text-white/70">
              Enterprise-grade test generation and management for your QA workflows.
            </p>
          </div>
          {/* decorative rings */}
          <div className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2">
            <div className="h-[340px] w-[340px] rounded-full border border-white/8" />
            <div className="absolute inset-[44px] rounded-full border border-white/10" />
            <div className="absolute inset-[88px] rounded-full border border-white/14" />
          </div>
        </div>

        {/* Right — form panel */}
        <div className="flex flex-1 flex-col justify-center px-8 py-12 sm:px-12">
          {/* Logo for mobile */}
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <img src="/etisalat-logo.svg" alt="Etisalat" className="h-8 object-contain" />
          </div>

          <div className="mb-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-app-brand-700 mb-1">Welcome back</p>
            <h2 className="text-[26px] font-bold tracking-[-0.03em] text-app-primary">Sign in to continue</h2>
          </div>

          {error && (
            <div className="mb-5 rounded-[14px] border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-app-primary">
                Username
              </label>
              <input
                type="text"
                value={credentials.username}
                onChange={(e) => setCredentials(prev => ({ ...prev, username: e.target.value }))}
                className="h-11 w-full rounded-[12px] border border-app bg-white px-4 text-sm text-app-primary outline-none transition placeholder:text-app-muted focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                required
                placeholder="Enter your username"
                autoComplete="username"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-app-primary">
                Password
              </label>
              <input
                type="password"
                value={credentials.password}
                onChange={(e) => setCredentials(prev => ({ ...prev, password: e.target.value }))}
                className="h-11 w-full rounded-[12px] border border-app bg-white px-4 text-sm text-app-primary outline-none transition placeholder:text-app-muted focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                required
                placeholder="Enter your password"
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              className="mt-1 flex h-11 w-full items-center justify-center rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] text-[14px] font-semibold text-white shadow-[0_8px_24px_rgba(183,25,32,0.22)] transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-app-brand-200"
            >
              Sign In
            </button>
          </form>
        </div>

      </div>
    </div>
  );
};

export default Login;
