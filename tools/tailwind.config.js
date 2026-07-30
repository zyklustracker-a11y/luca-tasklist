/** @type {import('tailwindcss').Config}
 *  Spiegelt die frühere Inline-Config aus index.html. Wird nur gebraucht, um
 *  tailwind.css neu zu erzeugen, falls neue Utility-Klassen dazukommen:
 *    npx tailwindcss@3 -c tools/tailwind.config.js -i tools/input.css -o tailwind.css --minify
 */
module.exports = {
  content: ['./index.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        surface: { 900: '#0a0f0d', 800: '#0f1612', 700: '#151f19', 600: '#1c2a22' },
        accent: { DEFAULT: '#22c55e', dim: '#16a34a', glow: '#4ade80', muted: '#14532d' },
      },
      boxShadow: {
        glow: '0 0 40px -8px rgba(34, 197, 94, 0.35)',
        card: '0 4px 24px -4px rgba(0, 0, 0, 0.5)',
      },
      animation: {
        'fade-up': 'fadeUp 0.5s ease-out forwards',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
      },
      keyframes: {
        fadeUp: { '0%': { opacity: '0', transform: 'translateY(12px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.7' } },
      },
    },
  },
};
