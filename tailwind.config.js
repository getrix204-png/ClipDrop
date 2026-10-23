/** @type {import('tailwindcss').Config} */
module.exports = {
  // Clases del HTML y las generadas desde JS (template strings)
  content: ['./index.html', './app.js'],
  theme: {
    extend: {
      colors: {
        brand: { dark: '#0B0F17', card: '#161C28', accent: '#10B981', cyan: '#06B6D4', border: '#232D3F', text: '#F3F4F6' }
      },
      fontFamily: { sans: ['Inter', 'sans-serif'] }
    }
  },
  plugins: []
};
