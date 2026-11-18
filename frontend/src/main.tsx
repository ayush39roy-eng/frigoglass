import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/App';
import { installChunkErrorReload } from '@/lib/app-version';
import { bootstrapSession } from '@/lib/auth/session-bootstrap';
import '@/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found in index.html');
}

// P49 (ADR 0060 R1): a chunk deleted by a deploy reloads the page once.
installChunkErrorReload();

// P49 (ADR 0060 L1): purge the old remembered login and adopt an open tab's
// session (≤ 300 ms) before the session gate decides whether to show the login page.
void bootstrapSession().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
