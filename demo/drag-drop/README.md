# Drag a card onto a zone: demo movie

Proof movie for issue #26. On a phone, a player can drag a card from their hand
onto a zone (for example Points); the legal zones light up, and dropping stages
the move. Confirm still commits it, and tapping still works.

The movie films two builds through the real UI on a 393x852 touch viewport
(iPhone 15), using real touch input (CDP touch events):

- **Before:** an unfixed checkout. Dragging 2 of hearts toward Points does
  nothing: no highlight, nothing staged.
- **After:** this tree. An illegal drop (Permanents) snaps the card back; a
  drag to Points lights the zone, stages the move, and Confirm plays it; a
  plain tap, tap, Confirm still works.

`record.mjs` throws if any of those is not shown.

Rerun from the repo root:

```sh
(cd web && npm run build:wasm)                    # in this tree and in the unfixed checkout
BEFORE_WEB=<web/ of an unfixed checkout> node demo/drag-drop/record.mjs
MOVIE=<path to proving-it-works-with-a-movie skill>/bin/movie
$MOVIE build demo/drag-drop/scenes.yaml demo/drag-drop/out/drag-drop.mp4
```

- `record.mjs` starts and stops its own vite dev servers (ports 4184 and 4185,
  override with `PORT_AFTER` / `PORT_BEFORE`) and uses Playwright from
  `web/node_modules`. The only test hook used seeds the deal (seed 42, dealer
  Blake, so Alice acts first); every move is real touch.
- Narration is Piper, voice `en_US-lessac-medium`, in `~/.cache/piper-voices`.
- Subtitles are burned into the picture by `movie build` (needs ffmpeg with libass).
- `out/` is gitignored.
