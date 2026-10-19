import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HiOutlineEye, HiOutlineEyeOff, HiOutlineLockClosed, HiOutlineUser } from 'react-icons/hi'
import { useAuth } from '../hooks/useAuth'
import { AFTER_LOGIN_KEY } from '../components/auth/ProtectedRoute'

const BrandLogo: React.FC = () => (
  <div className="relative h-[86px] w-[165px] shrink-0 overflow-hidden" aria-label="Etisalat">
    <img src="/etisalat-white.png" alt="Etisalat" className="absolute left-1/2 top-1/2 w-[285px] max-w-none -translate-x-1/2 -translate-y-1/2 mix-blend-screen" />
    <span className="brand-logo-glint brand-logo-glint-login" aria-hidden="true" />
  </div>
)

const Login: React.FC = () => {
  const [credentials, setCredentials] = useState({ username: '', password: '' })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (loading) return
    setError(null)
    setLoading(true)
    try {
      await login(credentials.username.trim(), credentials.password)
      let next = '/dashboard'
      try {
        const saved = sessionStorage.getItem(AFTER_LOGIN_KEY)
        sessionStorage.removeItem(AFTER_LOGIN_KEY)
        if (saved && saved.startsWith('/')) next = saved
      } catch { /* private mode */ }
      navigate(next, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in. Check your details and try again.')
      setLoading(false)
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#F5F6F8] px-4 py-6 sm:px-8 lg:py-10">
      <div className="pointer-events-none absolute -left-48 -top-48 h-[520px] w-[520px] rounded-full bg-[#FCE7E8] blur-[90px]" />
      <div className="pointer-events-none absolute -bottom-56 -right-40 h-[560px] w-[560px] rounded-full bg-[#F4DDE0] blur-[100px]" />
      <div className="relative grid w-full max-w-[1080px] overflow-hidden rounded-[28px] border border-[#E9E5E7] bg-white shadow-[0_30px_90px_rgba(42,21,25,0.12)] lg:min-h-[630px] lg:grid-cols-[1fr_0.94fr]">
        <section className="relative flex min-h-[175px] flex-col justify-between overflow-hidden bg-[linear-gradient(145deg,#50080D_0%,#8D1019_48%,#B71920_100%)] px-7 py-5 text-white sm:px-10 lg:min-h-full lg:px-12 lg:py-10">
          <div className="pointer-events-none absolute -right-28 top-20 h-[400px] w-[400px] rounded-full border border-white/10" />
          <div className="pointer-events-none absolute -right-10 top-36 h-[280px] w-[280px] rounded-full border border-white/10" />
          <div className="relative z-10 flex items-center justify-between gap-4">
            <BrandLogo />
            <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/80">Enterprise QA</span>
          </div>
          <div className="relative z-10 hidden lg:block">
            <span className="mb-5 inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-semibold tracking-wide">AI testing workspace</span>
            <h1 className="max-w-[380px] text-[42px] font-bold leading-[1.08] tracking-[-0.045em]">From requirements to confident releases.</h1>
            <p className="mt-5 max-w-[340px] text-[14px] leading-7 text-white/75">Generate, refine, approve and automate test cases in one connected workspace.</p>
          </div>
          <div className="relative z-10 hidden border-t border-white/20 pt-5 text-[11px] font-medium tracking-wide text-white/65 lg:block">Test Case Intelligence · AI Testing Platform</div>
        </section>
        <section className="flex items-center px-7 py-10 sm:px-12 lg:px-[68px]">
          <div className="w-full">
            <div className="mb-9">
              <div className="mb-3 h-1 w-10 rounded-full bg-[#B71920]" />
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#A3231C]">Welcome back</p>
              <h2 className="text-[31px] font-bold tracking-[-0.035em] text-[#1F2937]">Sign in to your workspace</h2>
              <p className="mt-2 text-[13px] leading-6 text-[#667085]">Enter your account details to continue your testing work.</p>
            </div>
            {error && <div role="alert" className="mb-5 rounded-[12px] border border-[#F0C2C0] bg-[#FFF4F4] px-4 py-3 text-[13px] text-[#9A1B20]">{error}</div>}
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="login-username" className="mb-2 block text-[12px] font-bold text-[#344054]">Username</label>
                <div className="relative">
                  <HiOutlineUser className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#98A2B3]" size={18} />
                  <input id="login-username" type="text" autoComplete="username" autoFocus required value={credentials.username} onChange={event => setCredentials(previous => ({ ...previous, username: event.target.value }))} placeholder="Enter your username" className="h-12 w-full rounded-[12px] border border-[#DDE1E7] bg-white pl-11 pr-4 text-[14px] text-[#1F2937] outline-none transition placeholder:text-[#98A2B3] focus:border-[#B71920] focus:ring-4 focus:ring-[#FCE7E8]" />
                </div>
              </div>
              <div>
                <label htmlFor="login-password" className="mb-2 block text-[12px] font-bold text-[#344054]">Password</label>
                <div className="relative">
                  <HiOutlineLockClosed className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#98A2B3]" size={18} />
                  <input id="login-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={credentials.password} onChange={event => setCredentials(previous => ({ ...previous, password: event.target.value }))} placeholder="Enter your password" className="h-12 w-full rounded-[12px] border border-[#DDE1E7] bg-white pl-11 pr-12 text-[14px] text-[#1F2937] outline-none transition placeholder:text-[#98A2B3] focus:border-[#B71920] focus:ring-4 focus:ring-[#FCE7E8]" />
                  <button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-[#667085] hover:bg-[#F5F6F8] hover:text-[#1F2937]">{showPassword ? <HiOutlineEyeOff size={18} /> : <HiOutlineEye size={18} />}</button>
                </div>
              </div>
              <button type="submit" disabled={loading} className="flex h-12 w-full items-center justify-center rounded-[12px] bg-[#B71920] text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:bg-[#96131A] focus:outline-none focus:ring-4 focus:ring-[#F6D4D5] disabled:cursor-wait disabled:opacity-65">{loading ? 'Signing in…' : 'Sign in'}</button>
            </form>
            <p className="mt-8 text-center text-[11px] leading-5 text-[#98A2B3]">Access is managed by your organization’s administrator.</p>
          </div>
        </section>
      </div>
    </main>
  )
}

export default Login
