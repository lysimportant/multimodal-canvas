import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { UiProvider } from '@multimodal-canvas/ui';
import '@multimodal-canvas/ui/styles.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>,
);
