import { render } from 'solid-js/web'
import { App } from './app.tsx'
import { runtimeModeFrom } from './runtime/mode.ts'
import { BrowserRuntimePage } from './runtime/page.tsx'
import './style.css'

const root = document.getElementById('root')
if (root === null) throw new Error('the page has no #root to render into')

// The server-backed page is the default; the browser-only runtime is an
// explicit opt-in, so this branch never changes what `jzh web` already serves.
render(
  () => (runtimeModeFrom(window.location.search) === 'browser' ? <BrowserRuntimePage /> : <App />),
  root,
)
