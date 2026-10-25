import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/space-grotesk';
import './styles/tokens.css';
import './styles/base.css';
import './styles/panels.css';
import './styles/workspaces.css';
import './styles/llm.css';
import './styles/projects.css';
import './styles/workbench.css';
import './styles/measurement.css';
import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';

const CoreWorkspace = lazy(() => import('./features/workspace/CoreWorkspace'));
// Keep saved links usable while exposing a single canonical application entry.
const entry = new URL(window.location.href);
if (entry.searchParams.has('workspace') || entry.pathname === '/docs/conversation-workspace-prototype.html') {
  entry.searchParams.delete('workspace');
  entry.pathname = '/';
  window.history.replaceState(window.history.state, '', entry.pathname + entry.search + entry.hash);
}

createRoot(document.getElementById('root')!).render(<Suspense fallback={<p>正在打开工程工作区…</p>}>
  <CoreWorkspace />
</Suspense>);
