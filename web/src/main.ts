import '@fontsource/atkinson-hyperlegible-next/latin-400.css';
import '@fontsource/atkinson-hyperlegible-next/latin-700.css';
import { mount } from 'svelte';

import App from './App.svelte';
import { registerServiceWorker } from './lib/pwa/register';

// SPEC §5.2 — App.svelte is now the routed app shell (HomeScreen /
// GameScreen / ResultScreen), not the P1b walking-skeleton status page.
const target = document.getElementById('app');
if (!target) {
  throw new Error('missing #app mount point');
}

// R18 (SPEC §5.8): offline play and background updates. A no-op outside a
// production build.
void registerServiceWorker();

export default mount(App, { target });
