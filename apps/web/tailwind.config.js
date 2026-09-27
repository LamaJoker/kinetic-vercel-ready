/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{html,ts,js}'],
  theme: {
    extend: {
      colors: {
        'kinetic-purple': '#3E6FD8',
        'kinetic-teal': '#1E9E5A',
        'kinetic-coral': '#D93A34',
        'kinetic-gold': '#F2C230',
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
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'sans-serif'],
        display: ['Barlow Condensed', 'Arial Narrow', 'sans-serif'],
      },
      // Barlow Condensed est chargée jusqu'à 700 : évite un faux-gras synthétisé.
      fontWeight: { black: '700', extrabold: '700' },
      borderRadius: {
        k: '20px',
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
