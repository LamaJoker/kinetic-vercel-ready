/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{html,ts,js}'],
  // Composants de la direction (styles.css, @layer components) : toujours émis,
  // même avant qu'une page ne les utilise ou quand une classe est composée en TS.
  safelist: [
    'k-hero',
    'k-btn-primary',
    'k-ring-box',
    'k-ring',
    'k-ring-track',
    'k-ring-value',
    'k-stat',
    'k-unit',
    'k-chip',
    'k-chip-active',
    'k-card',
  ],
  theme: {
    extend: {
      // Palette « Nuit profonde & corail » : toutes les couleurs lisent les
      // variables de styles.css (sombre / clair / thème d'accent).
      colors: {
        // Rôles sémantiques (variante GRAPHIQUE : aplats, anneaux, barres)
        'kinetic-purple': 'rgb(var(--k-info) / <alpha-value>)', // violet : XP, info
        'kinetic-teal': 'rgb(var(--k-success) / <alpha-value>)', // turquoise : succès
        'kinetic-coral': 'rgb(var(--k-danger) / <alpha-value>)', // erreur, priorité haute
        'kinetic-gold': 'rgb(var(--k-warning) / <alpha-value>)', // ambre : attention, records
        'kinetic-on-accent': 'rgb(var(--k-on-accent) / <alpha-value>)', // texte sur aplat d'accent
        // Macros (protéines, glucides, lipides)
        'kinetic-protein': 'rgb(var(--k-macro-p) / <alpha-value>)',
        'kinetic-carbs': 'rgb(var(--k-macro-c) / <alpha-value>)',
        'kinetic-fat': 'rgb(var(--k-macro-f) / <alpha-value>)',
        // Gris bleutés (accordés au fond bleu nuit) ; en clair, les textes gris
        // sont retournés dans styles.css (« Texte : contraste WCAG AA »).
        gray: {
          50: '#f8f8fc',
          100: '#f1f1f8',
          200: '#e3e4ef',
          300: '#cdd1e0',
          400: '#b4b9cf',
          500: '#a3a9c2',
          600: '#8c92ad',
          700: '#4a5275',
          800: '#2b3250',
          900: '#151a2c',
          950: '#0b0e1a',
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
      // Accents EN TEXTE : variante -ink (identique en sombre, foncée en clair
      // pour un contraste AA ≥ 4,5:1 sur fond lavande et cartes blanches).
      textColor: {
        'kinetic-neon': 'rgb(var(--kinetic-neon-ink) / <alpha-value>)',
        'kinetic-electric': 'rgb(var(--kinetic-electric-ink) / <alpha-value>)',
        'kinetic-purple': 'rgb(var(--k-info-ink) / <alpha-value>)',
        'kinetic-teal': 'rgb(var(--k-success-ink) / <alpha-value>)',
        'kinetic-coral': 'rgb(var(--k-danger-ink) / <alpha-value>)',
        'kinetic-gold': 'rgb(var(--k-warning-ink) / <alpha-value>)',
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
