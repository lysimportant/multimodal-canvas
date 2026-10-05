import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { SiteMetadata } from './seo/SiteMetadata';
import { UiProvider } from '@multimodal-canvas/ui';
import '@multimodal-canvas/ui/styles.css';
import './index.css';
import './native-scrollbars.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiProvider>
      <SiteMetadata />
      <App />
    </UiProvider>
  </StrictMode>,
);
