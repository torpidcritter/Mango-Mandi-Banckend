import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { cspPlugin } from '../scripts/csp'
import { supportBuildProblem } from './src/support'
import { shopServer } from './dev-server'

// The customer app shares the repo root's node_modules, so it needs no install of its own.
export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, __dirname, 'VITE_'), ...process.env }
  // UX-1: a production shop always shows a way to reach us.
  const noSupport = supportBuildProblem({ command, mode, value: env.VITE_SUPPORT_WHATSAPP })
  if (noSupport) throw new Error(noSupport)
  return {
    root: __dirname,
    // Own cache, apart from the panel's: both dev servers use the repo root's node_modules.
    cacheDir: path.resolve(__dirname, '../node_modules/.vite/shop'),
    plugins: [react(), cspPlugin('shop', env.VITE_API_URL)],
    // SEC-01: own files only, own host names only, and never /v1/dev through the proxy (dev-server.ts).
    server: shopServer(__dirname, env),
    // Pages load lazily, so let Vite find every page's imports at start-up. Otherwise the first
    // visit to a page can re-bundle dependencies mid-session (a 504 "Outdated Optimize Dep").
    optimizeDeps: { entries: ['index.html', 'src/**/*.{ts,tsx}'] },
    preview: { port: 5174 },
    build: { outDir: 'dist', emptyOutDir: true },
  }
})
