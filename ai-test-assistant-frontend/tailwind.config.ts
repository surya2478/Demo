import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        app: {
          brand: {
            950: '#4D0507',
            900: '#65080A',
            800: '#7A0B0D',
            700: '#941216',
            600: '#B71920',
            500: '#D52B31',
            300: '#F1A4A6',
            200: '#F6D4D5',
            100: '#FDEBEC',
            75: '#FFF5F5',
            50: '#FFF8F8'
          },
          // Sidebar palette (dark red command-center)
          sidebar: {
            DEFAULT: '#65080A',
            top: '#7A0B0D',
            bottom: '#4D0507',
            hover: 'rgba(255,255,255,0.08)',
            active: '#B71920',
            text: '#FFFFFF',
            muted: 'rgba(255,255,255,0.62)',
            border: 'rgba(255,255,255,0.08)'
          },
          canvas: '#F8F9FB',
          surface: '#FFFFFF',
          'surface-subtle': '#FCFCFD',
          'surface-muted': '#F4F5F7',
          border: '#E8EAEE',
          'border-soft': '#F1D4D4',
          strong: '#E6B4B4',
          primary: '#1F2937',
          secondary: '#6B7280',
          muted: '#9CA3AF',
          // Status semantic
          success: '#15803D',
          'success-bg': '#EAF7EF',
          warning: '#D97706',
          'warning-bg': '#FFF4E5',
          danger: '#DC2626',
          'danger-bg': '#FEEBEC',
          info: '#2563EB',
          'info-bg': '#EFF6FF'
        }
      },
      borderColor: {
        app: '#E8EAEE'
      },
      boxShadow: {
        'app-card': '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)',
        'app-card-lg': '0 8px 24px -12px rgba(16,24,40,0.12), 0 4px 12px -6px rgba(16,24,40,0.08)',
        'app-sidebar': '2px 0 16px -8px rgba(77, 5, 7, 0.35)'
      },
      borderRadius: {
        'app-sm': '8px',
        app: '12px',
        'app-lg': '16px',
        'app-xl': '20px'
      }
    }
  },
  plugins: []
}

export default config
