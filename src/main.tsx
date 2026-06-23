import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root element missing from document')
createRoot(rootEl).render(<App />)
