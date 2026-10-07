import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // upstream-ish accent, kept as tokens so a rebrand is a one-file change.
        brand: {
          50: '#f0f6ff',
          100: '#dbe8ff',
          500: '#2f6fed',
          600: '#1f5bd6',
          700: '#1a49ac',
        },
      },
    },
  },
  plugins: [],
};

export default config;