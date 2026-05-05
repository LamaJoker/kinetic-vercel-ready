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
        // ─── Palette legacy (rétrocompat — pages non encore migrées) ───
        'kinetic-purple':   '#7F77DD',
        'kinetic-teal':     '#00C2A0',
        'kinetic-coral':    '#FF6B6B',
        'kinetic-gold':     '#FFD166',
        // Couleurs thématiques pilotées par variables CSS (récompense Lv7)
        'kinetic-neon':     'rgb(var(--kinetic-neon) / <alpha-value>)',
        'kinetic-electric': 'rgb(var(--kinetic-electric) / <alpha-value>)',
        'kinetic-ink':      '#070708',   // body — noir profond bleuté
        'kinetic-surface':  '#121214',   // cards
        'kinetic-elevated': '#1A1A1D',   // panneaux internes (formulaires)

        // ─── Design v2 — alias vers les CSS vars OKLCH (pages migrées) ───
        'k-p':         'var(--k-p)',
        'k-e':         'var(--k-e)',
        'k-v':         'var(--k-v)',
        'k-void':      'var(--k-void)',
        'k-surface':   'var(--k-surface)',
        'k-elevated':  'var(--k-elevated)',
        'k-raised':    'var(--k-raised)',
        'k-line':      'var(--k-line)',
        'k-line-hi':   'var(--k-line-hi)',
        'k-tx':        'var(--k-tx)',
        'k-tx2':       'var(--k-tx2)',
        'k-tx3':       'var(--k-tx3)',
      },
      fontFamily: {
        // Legacy — Outfit (gardé pour pages non migrées)
        display: ['Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Design v2
        'display-v2': ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'sans-v2':    ['"DM Sans"',       'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      scale: { '98': '0.98' },
      keyframes: {
        // Legacy
        'slide-done': {
          '0%':   { transform: 'translateX(0)',  opacity: '1'   },
          '60%':  { transform: 'translateX(6px)', opacity: '0.8' },
          '100%': { transform: 'translateX(0)',  opacity: '0.6' },
        },
        // Design v2 (les @keyframes sont définis dans styles.css ;
        // on les expose ici pour utilisation via animate-{nom})
        'slide-up':    { from: { opacity: '0', transform: 'translateY(16px)' },
                         to:   { opacity: '1', transform: 'translateY(0)' } },
        'fade-in':     { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in':    { from: { opacity: '0', transform: 'scale(0.88)' },
                         to:   { opacity: '1', transform: 'scale(1)' } },
        'float':       { '0%, 100%': { transform: 'translateY(0)' },
                         '50%':      { transform: 'translateY(-5px)' } },
        'ring-pulse':  { '0%, 100%': { opacity: '0.5', transform: 'scale(1)' },
                         '50%':      { opacity: '0.9', transform: 'scale(1.06)' } },
        'pr-bounce':   { '0%':   { transform: 'scale(0) rotate(-12deg)' },
                         '60%':  { transform: 'scale(1.12) rotate(3deg)' },
                         '100%': { transform: 'scale(1) rotate(0deg)' } },
      },
      animation: {
        'slide-done': 'slide-done 0.35s cubic-bezier(0.4, 0, 1, 1) forwards',
        'slide-up':   'slide-up 0.45s cubic-bezier(.22,.68,0,1.2) both',
        'fade-in':    'fade-in 0.3s ease-out both',
        'scale-in':   'scale-in 0.35s cubic-bezier(.34,1.56,.64,1) both',
        'float':      'float 3s ease-in-out infinite',
        'ring-pulse': 'ring-pulse 2.4s ease-in-out infinite',
        'pr-bounce':  'pr-bounce 0.5s cubic-bezier(.34,1.56,.64,1) both',
      },
      boxShadow: {
        'glow-p':    '0 0 20px var(--k-p-glow)',
        'glow-p-lg': '0 0 40px var(--k-p-glow)',
        'glow-e':    '0 0 20px var(--k-e-glow)',
        'glow-v':    '0 0 20px var(--k-v-glow)',
      },
      borderRadius: {
        'k': '20px',
      },
    },
  },
  plugins: [],
};
