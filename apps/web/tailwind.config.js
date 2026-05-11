/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{html,ts,js}',
  ],
  theme: {
    extend: {
      colors: {
        'kinetic-purple':   '#7F77DD',
        'kinetic-teal':     '#00C2A0',
        'kinetic-coral':    '#FF6B6B',
        'kinetic-gold':     '#FFD166',
        // Couleurs thématiques pilotées par variables CSS (cf. styles.css)
        'kinetic-neon':     'rgb(var(--kinetic-neon) / <alpha-value>)',
        'kinetic-electric': 'rgb(var(--kinetic-electric) / <alpha-value>)',
        // Palette de fond (Redesign v2)
        'kinetic-ink':      '#050508',   // body — void
        'kinetic-surface':  '#0E0E13',   // cards
        'kinetic-elevated': '#151519',   // panneaux internes
        'kinetic-raised':   '#1B1B21',   // niveaux supérieurs
      },
      fontFamily: {
        sans:    ['DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        'k': '20px',
      },
      boxShadow: {
        'glow-p': '0 0 20px rgb(var(--kinetic-neon) / 0.38)',
        'glow-e': '0 0 20px rgb(var(--kinetic-electric) / 0.42)',
      },
      scale: { '98': '0.98' },
      keyframes: {
        'slide-done': {
          '0%':   { transform: 'translateX(0)',  opacity: '1'   },
          '60%':  { transform: 'translateX(6px)', opacity: '0.8' },
          '100%': { transform: 'translateX(0)',  opacity: '0.6' },
        },
        'slide-up': {
          '0%':   { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)'    },
        },
        'scale-in': {
          '0%':   { opacity: '0', transform: 'scale(0.88)' },
          '100%': { opacity: '1', transform: 'scale(1)'    },
        },
      },
      animation: {
        'slide-done': 'slide-done 0.35s cubic-bezier(0.4, 0, 1, 1) forwards',
        'slide-up':   'slide-up 0.45s cubic-bezier(0.22, 0.68, 0, 1.2) both',
        'scale-in':   'scale-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both',
      },
    },
  },
  plugins: [],
};
