/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        app: {
          DEFAULT: '#E8EAEE',
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
          // Status foregrounds are darkened to clear WCAG AA (4.5:1) against
          // their own tinted background at badge size. The previous warning
          // pair measured 2.93:1 -- on the one badge that blocks approval.
          success: '#136B34',
          'success-bg': '#EAF7EF',
          'success-border': '#BBDFC8',
          warning: '#8A5000',
          'warning-bg': '#FFF4E5',
          'warning-border': '#EBCFA4',
          danger: '#A3231C',
          'danger-bg': '#FEEBEC',
          'danger-border': '#F0C2C0',
          info: '#1D4ED8',
          'info-bg': '#EFF6FF',
          'info-border': '#C2D5F5'
        }
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
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: 'none',
            color: '#1f2937',
            code: {
              backgroundColor: '#FFF5F5',
              padding: '0.2em 0.4em',
              borderRadius: '6px',
              fontWeight: '400',
              color: '#7A0B0D'
            },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            'pre code': {
              backgroundColor: 'transparent',
              borderWidth: '0',
              borderRadius: '0',
              padding: '0',
              fontWeight: '400',
              color: 'inherit',
              fontSize: 'inherit',
              fontFamily: 'inherit',
              lineHeight: 'inherit'
            },
            pre: {
              backgroundColor: '#FFF5F5',
              border: '1px solid #F6D4D5',
              borderRadius: '6px',
              padding: '16px'
            }
          }
        }
      }
    }
  },
  plugins: [require('@tailwindcss/typography')]
}
