const { colors } = require('./src/theme/colors');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: { relative: true, files: ['./src/**/*.{ts,tsx}'] },
  presets: [require('nativewind/preset')],
  theme: { extend: { colors } },
  plugins: [],
};
