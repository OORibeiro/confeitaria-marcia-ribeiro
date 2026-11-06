/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // A família amber existente é a cor de marca da loja, agora em marsala.
      colors: {
        amber: {
          50: '#fcf6f7', 100: '#f6e7eb', 200: '#eccdd5', 300: '#dca7b5',
          400: '#c7778e', 500: '#ab516c', 600: '#903c56', 700: '#783047',
          800: '#652a3e', 900: '#552536', 950: '#30111c',
        },
      },
      fontFamily: {
        serif: ['Georgia', 'Cambria', '"Times New Roman"', 'Times', 'serif'],
      },
    },
  },
  plugins: [],
}

