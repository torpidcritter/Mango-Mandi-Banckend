import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { cspPlugin } from './scripts/csp'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, __dirname, 'VITE_'), ...process.env }
  return {
    plugins: [react(), cspPlugin('panel', env.VITE_API_URL)],
    server: { port: 5173 },
    // The shop's dev server shares this node_modules; separate caches stop one server's
    // pre-bundle from overwriting the other's (which loads React twice and blanks the page).
    cacheDir: 'node_modules/.vite/panel',
    // Pages load lazily, so let Vite find every page's imports at start-up (no mid-session re-bundle).
    optimizeDeps: { entries: ['index.html', 'src/**/*.{ts,tsx}'] },
  }
})
