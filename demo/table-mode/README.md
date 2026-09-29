# Table mode: demo movie

Proof movie for issue #37. With the Home toggle "Table mode: phone lies flat
between you" on, the phone lies flat between two players. Alice (player 1) sits
at the bottom edge and Blake (player 2) at the top edge. The board never flips.
Blake's screens are turned 180 degrees so they read correctly from across the
table, and the handoff says "Blake's turn" instead of "Pass the phone to Blake".

The movie films one build through the real UI on a 393x852 touch viewport
(iPhone 15) with real touch input (CDP touch events):

- **Before:** the toggle off (normal mode). Blake's turn flips the board, his
  hand is at the bottom, and the handoff says "Pass the phone to Blake".
- **After:** the toggle turned on at Home. Alice upright with her hand at the
  bottom; Blake's handoff turned 180 degrees; Blake's hand at the physical top;
  Blake drags a card onto his Points zone in the turned view, then Confirm;
  back to Alice, upright.

`record.mjs` throws if any of those is not shown (hand positions, handoff
copy, drag highlight, move counts).

Rerun from the repo root:

```sh
(cd web && npm run build:wasm)
node demo/table-mode/record.mjs
MOVIE=<path to proving-it-works-with-a-movie skill>/bin/movie
$MOVIE build demo/table-mode/scenes.yaml demo/table-mode/out/table-mode.mp4
```

- `record.mjs` starts and stops its own vite dev server (port 4186, override
  with `PORT`) and uses Playwright from `web/node_modules`. The only test hooks
  used seed the deal (seed 42, dealer Blake, so Alice acts first) and read the
  legal moves to pick a point card for Blake; every move is real touch.
- Narration is Piper, voice `en_US-lessac-medium`, in `~/.cache/piper-voices`.
- Subtitles are burned into the picture by `movie build` (needs ffmpeg with libass).
- `out/` is gitignored.
