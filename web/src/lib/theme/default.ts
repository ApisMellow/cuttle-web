// SPEC §5.6 rule 5 — the single constant naming the ship-time default theme.
// ApisMellow's call at ship time (R23); flipping it is this one line.
//
// Kept in its own component-free module so `lib/stores/settings.svelte.ts`
// can import the default without statically pulling in any `.svelte` theme
// component. `lib/theme/index.ts` re-exports it, so the app reads the
// default from the theme's public surface.
export const DEFAULT_THEME_ID: string = 'vector';
