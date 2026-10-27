import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Prerendered pages arrive with their content already in #root for crawlers and
// no-JS visitors. The app renders fresh over it (rather than hydrating), because the
// player's own saved games and language live in localStorage and differ from the
// static HTML; the markup and styles are the same, so the swap is not visible.
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
