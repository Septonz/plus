import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read VITE_* variables from the repo-root .env.local (gitignored), next to the backend's.
  // Only VITE_-prefixed values reach the browser bundle.
  envDir: '../..',
})
