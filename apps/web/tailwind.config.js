/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{html,ts,js}'],
  theme: {
    extend: {
      colors: {
        // Couleurs système iOS (variante sombre) : bleu, vert, rouge, jaune.
        'kinetic-purple': '#0A84FF',
        'kinetic-teal': '#30D158',
        'kinetic-coral': '#FF453A',
        'kinetic-gold': '#FFD60A',
        gray: {
          50: '#f9f9fb',
          100: '#f2f2f7',
          200: '#e5e5ea',
          300: '#d1d1d6',
          400: '#aeaeb2',
          500: '#98989f',
          600: '#8e8e93',
          700: '#636366',
          800: '#3a3a3c',
          900: '#1c1c1e',
          950: '#0a0a0c',
        },
        // Couleurs thématiques pilotées par variables CSS (cf. styles.css)
        'kinetic-neon': 'rgb(var(--kinetic-neon) / <alpha-value>)',
        'kinetic-electric': 'rgb(var(--kinetic-electric) / <alpha-value>)',
        // Palette de fond pilotée par data-mode="light|dark" (cf. styles.css)
        'kinetic-ink': 'rgb(var(--ink) / <alpha-value>)',
        'kinetic-surface': 'rgb(var(--surface) / <alpha-value>)',
        'kinetic-elevated': 'rgb(var(--elevated) / <alpha-value>)',
        'kinetic-raised': 'rgb(var(--raised) / <alpha-value>)',
      },
      fontFamily: {
        // Appareils Apple : San Francisco. Ailleurs (Android, Windows) : Inter, très proche.
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter Variable',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        display: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter Variable',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      // Échelle typographique iOS (Dynamic Type, taille « Large ») :
      // footnote 13, subheadline 15, body 17, title3 20, title2 22, title1 28, large title 34.
      fontSize: {
        xs: ['0.8125rem', { lineHeight: '1.125rem' }],
        sm: ['0.9375rem', { lineHeight: '1.25rem' }],
        base: ['1.0625rem', { lineHeight: '1.375rem' }],
        lg: ['1.25rem', { lineHeight: '1.5625rem' }],
        xl: ['1.375rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.75rem', { lineHeight: '2.125rem' }],
        '3xl': ['2.125rem', { lineHeight: '2.5625rem' }],
        '4xl': ['2.5rem', { lineHeight: '2.875rem' }],
      },
      // Titres en « bold » (700), jamais plus gras : c'est le poids des grands titres iOS.
      fontWeight: { black: '700', extrabold: '700' },
      borderRadius: {
        lg: '10px',
        xl: '14px',
        '2xl': '22px',
        '3xl': '28px',
        k: '22px',
      },
      boxShadow: {
        'glow-p': 'none',
        'glow-e': 'none',
      },
      scale: { 98: '0.98' },
      keyframes: {
        'slide-done': {
          '0%': { transform: 'translateX(0)', opacity: '1' },
          '60%': { transform: 'translateX(6px)', opacity: '0.8' },
          '100%': { transform: 'translateX(0)', opacity: '0.6' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.88)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'slide-done': 'slide-done 0.35s cubic-bezier(0.4, 0, 1, 1) forwards',
        'slide-up': 'slide-up 0.45s cubic-bezier(0.22, 0.68, 0, 1.2) both',
        'scale-in': 'scale-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both',
      },
    },
  },
  plugins: [],
};
