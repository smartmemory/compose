import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import './index.css';

const isMobile = window.location.pathname.startsWith('/m');
const Root = isMobile
  ? React.lazy(() => import('./mobile/MobileApp'))
  : React.lazy(() => import('./App'));

ReactDOM.createRoot(document.getElementById('root')).render(
  <WorkspaceProvider>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </WorkspaceProvider>
);
