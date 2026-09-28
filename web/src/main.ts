import { mount } from 'svelte';

import App from './App.svelte';

// SPEC §5.2 — App.svelte is now the routed app shell (HomeScreen /
// GameScreen / ResultScreen), not the P1b walking-skeleton status page.
const target = document.getElementById('app');
if (!target) {
  throw new Error('missing #app mount point');
}

export default mount(App, { target });
