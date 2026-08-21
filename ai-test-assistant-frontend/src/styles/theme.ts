export const theme = {
  page: {
    shell: 'min-h-screen bg-app-canvas text-app-primary',
    content: 'mx-auto w-full max-w-[1600px] space-y-6'
  },
  input:
    'w-full rounded-app border border-app bg-app-surface px-3.5 py-2.5 text-sm text-app-primary outline-none transition placeholder:text-app-muted focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100',
  select:
    'w-full rounded-app border border-app bg-app-surface px-3.5 py-2.5 text-sm text-app-primary outline-none transition focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100',
  textarea:
    'w-full rounded-app border border-app bg-app-surface px-3.5 py-3 text-sm text-app-primary outline-none transition placeholder:text-app-muted focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100',
  button: {
    base: 'inline-flex items-center justify-center gap-2 rounded-app px-3.5 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-brand-600 disabled:cursor-not-allowed disabled:opacity-60',
    primary:
      'inline-flex items-center justify-center gap-2 rounded-[12px] bg-[linear-gradient(180deg,#ff191f_0%,#d7141c_48%,#b91017_100%)] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(183,25,32,0.22)] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-brand-600 disabled:cursor-not-allowed disabled:opacity-60',
    secondary:
      'inline-flex items-center justify-center gap-2 rounded-app border border-app bg-app-surface px-3.5 py-2 text-sm font-semibold text-app-primary transition hover:bg-app-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-brand-600 disabled:cursor-not-allowed disabled:opacity-60',
    tertiary:
      'inline-flex items-center justify-center gap-2 rounded-app px-3.5 py-2 text-sm font-semibold text-app-brand-700 transition hover:bg-app-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-brand-600 disabled:cursor-not-allowed disabled:opacity-60',
    danger:
      'inline-flex items-center justify-center gap-2 rounded-app bg-app-danger px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-danger disabled:cursor-not-allowed disabled:opacity-60'
  },
  tab: {
    active:
      'rounded-app border border-app-brand-200 bg-app-brand-50 px-3.5 py-2 text-sm font-semibold text-app-brand-800 shadow-sm',
    inactive:
      'rounded-app border border-transparent px-3.5 py-2 text-sm font-medium text-app-secondary transition hover:bg-app-surface-muted hover:text-app-primary'
  },
  nav: {
    link:
      'flex items-center gap-3 rounded-app px-3 py-2.5 text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
    active:
      'bg-app-brand-600 text-white shadow-sm hover:bg-app-brand-600 hover:text-white'
  },
  card: 'rounded-app-lg border border-app bg-app-surface shadow-app-card',
  badge: {
    brand: 'border border-app-brand-200 bg-app-brand-50 text-app-brand-800',
    success: 'border border-green-200 bg-app-success-bg text-app-success',
    warning: 'border border-orange-200 bg-app-warning-bg text-app-warning',
    danger: 'border border-red-200 bg-app-danger-bg text-app-danger',
    neutral: 'border border-app bg-app-surface-muted text-app-secondary'
  }
}
