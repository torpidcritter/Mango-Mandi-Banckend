import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The customer app shares the repo root's node_modules, so it needs no install of its own.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5174 },
  preview: { port: 5174 },
  build: { outDir: 'dist', emptyOutDir: true },
})
