import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { StoreProvider } from './store'
import '../../design/tokens.css'
import './styles.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Navigation updates render at once, as with React Router 6 (7 defaults to transitions). */}
      <BrowserRouter useTransitions={false}>
        <StoreProvider>
          <App />
        </StoreProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
