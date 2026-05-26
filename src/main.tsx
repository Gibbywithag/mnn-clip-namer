import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installBrowserPreviewApi } from './browserPreview';
import './styles.css';

installBrowserPreviewApi();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
