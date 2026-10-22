'use strict';

tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: { 950: '#04060b', 900: '#070b13', 800: '#0b1220', 700: '#111a2b' },
        neon: { cyan: '#0f8f83', green: '#2f9e6b', amber: '#c2871f', red: '#d94a5c', violet: '#7c6cf0' },
      },
    },
  },
};
