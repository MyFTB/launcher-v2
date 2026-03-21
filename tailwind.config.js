/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/src/**/*.{ts,tsx}', './src/renderer/index.html'],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#83da38',
          dim: '#6ab82c',
          muted: '#4a8020'
        },
        bg: {
          base: '#1a1a1a',
          surface: '#242424',
          elevated: '#2e2e2e',
          overlay: '#383838'
        },
        text: {
          primary: '#e8e8e8',
          secondary: '#9a9a9a',
          muted: '#606060'
        },
        border: {
          DEFAULT: '#3a3a3a',
          focus: '#83da38'
        }
      },
      fontFamily: {
        sans: ['Lato', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif']
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'progress-bar': 'progressBar 1.5s ease-in-out infinite'
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        progressBar: {
          '0%':   { marginLeft: '0%',   width: '40%' },
          '50%':  { marginLeft: '60%',  width: '40%' },
          '100%': { marginLeft: '0%',   width: '40%' },
        }
      }
    }
  },
  plugins: []
}
