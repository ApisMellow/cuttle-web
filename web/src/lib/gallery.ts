// The card gallery is a standalone page beside the game (`gallery/`, copied
// into the site after the build). The game links to it at the app's base, so
// the same build works on Pages (`/cuttle-web/`) and self-hosted (`/`).
// Pages and the service worker leave it alone (SPEC §5.8), so a plain
// same-tab link is all it needs.

/** The one label every entry point uses. */
export const GALLERY_LABEL = 'Card gallery';

export function galleryHref(): string {
  return `${import.meta.env.BASE_URL}gallery/`;
}
