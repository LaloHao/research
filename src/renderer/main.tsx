import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './i18n'
import { reportUncaughtErrors } from './lib/errorReport'
import './styles.css'

reportUncaughtErrors(window, (report) => window.research.log.rendererError(report))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
