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
        'kinetic-purple': '#7F77DD',
        'kinetic-teal':   '#00C2A0',
        'kinetic-coral':  '#FF6B6B',
        'kinetic-gold':   '#FFD166',
      },
      scale: { '98': '0.98' },
    },
  },
  plugins: [],
};
