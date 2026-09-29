# Tap the deck twice to draw: demo movie

Proof movie for issue #24. On your turn, tapping the deck stages a draw and
shows the Confirm bar; tapping the deck a second time now commits the draw and
goes straight to the pass curtain. Confirm still works.

The movie films two builds through the real UI on a 393x852 touch viewport
(iPhone 15):

- **Before:** the live site (`https://apismellow.github.io/cuttle-web/`). The
  second deck tap does nothing; the draw stays staged behind Confirm.
- **After:** a local production build of this tree. The second deck tap lands
  on the pass curtain, and the next player's board shows the deck one card
  smaller.

`record.mjs` throws if either half is not shown (live site not staged or not
still waiting; local build not at the curtain; deck count not down by one).
Once the live site ships the fix, the "before" half will fail by design.

Rerun from the repo root:

```sh
(cd web && npm run build:wasm && npm run build)   # the wasm must match the JS
node demo/deck-double-tap/record.mjs              # frames -> demo/deck-double-tap/out/frames/
MOVIE=<path to proving-it-works-with-a-movie skill>/bin/movie
$MOVIE build demo/deck-double-tap/scenes.yaml demo/deck-double-tap/out/deck-double-tap.mp4
```

- `record.mjs` starts and stops its own `vite preview` (port 4181) and uses
  Playwright from `web/node_modules`. No test hooks are used.
- Narration is Piper, voice `en_US-lessac-medium`, which must be in
  `~/.cache/piper-voices`.
- Which player goes first is random, so the narration names neither.
- `out/` (frames, mp4, build and check dirs) is gitignored.
