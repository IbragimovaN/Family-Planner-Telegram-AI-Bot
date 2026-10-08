import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import AuthGate from './AuthGate.tsx'
import TelegramShell from './TelegramShell'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TelegramShell><AuthGate /></TelegramShell>
  </StrictMode>,
)
