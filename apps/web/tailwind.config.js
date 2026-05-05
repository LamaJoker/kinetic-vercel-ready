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
        // Les deux couleurs thématiques sont pilotées par des variables CSS
        // pour permettre le changement de thème au runtime (récompense Lv7).
        // Format "R G B" (sans #) pour que les modificateurs d'opacité Tailwind fonctionnent.
        'kinetic-neon':     'rgb(var(--kinetic-neon) / <alpha-value>)',
        'kinetic-electric': 'rgb(var(--kinetic-electric) / <alpha-value>)',
        'kinetic-ink':      '#070708',   // body — noir profond bleuté
        'kinetic-surface':  '#121214',   // cards
        'kinetic-elevated': '#1A1A1D',   // panneaux internes (formulaires)
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans:    ['"DM Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'glow-neon':     '0 0 20px rgb(var(--kinetic-neon) / 0.42)',
        'glow-electric': '0 0 18px rgb(var(--kinetic-electric) / 0.42)',
      },
      scale: { '98': '0.98' },
      keyframes: {
        'slide-done': {
          '0%':   { transform: 'translateX(0)',  opacity: '1'   },
          '60%':  { transform: 'translateX(6px)', opacity: '0.8' },
          '100%': { transform: 'translateX(0)',  opacity: '0.6' },
        },
      },
      animation: {
        'slide-done': 'slide-done 0.35s cubic-bezier(0.4, 0, 1, 1) forwards',
      },
    },
  },
  plugins: [],
};
