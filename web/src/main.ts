import { mount } from 'svelte';

import App from './App.svelte';

// Batch 0 (scaffold) placeholder mount. There is no real UI yet — this
// exists so `check`, `lint`, and `build` have an app to run against.
// Batch 3 owns the real bridge/store wiring behind App.svelte.
const target = document.getElementById('app');
if (!target) {
  throw new Error('missing #app mount point');
}

export default mount(App, { target });
