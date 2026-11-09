import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Path routing: /app is the Plus app (the user's home), /helper the helper page, / the overview.
const PlusApp = lazy(() => import('./plus/PlusApp.tsx'))
const HelperPage = lazy(() => import('./helper/HelperPage.tsx'))

const path = window.location.pathname
const Page = path.startsWith('/app') ? PlusApp : path.startsWith('/helper') ? HelperPage : App

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
)
