import { mount } from 'svelte';

import App from './App.svelte';

// Batch 3 walking-skeleton mount (SPEC §1.2). App.svelte is the status page
// proving the bridge boundary; the routed app shell of SPEC §5.2 is a later
// batch's work.
const target = document.getElementById('app');
if (!target) {
  throw new Error('missing #app mount point');
}

export default mount(App, { target });
