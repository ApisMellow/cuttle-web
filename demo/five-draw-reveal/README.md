# A 5 shows you what you drew: demo movie

Proof movie for issue #27. When a player plays a 5 and draws cards, their next
own screen now shows the draw: the cards travel face down from the deck, flip
face up, and are marked "You drew N cards". A tap, Continue, or 3 seconds moves
on. The pass screens and the other player's screens never show the cards.

The movie films two builds through the real UI on a 393x852 touch viewport
(iPhone 15), both reaching the same moment on the golden seed-42 deal: Alice
plays a 2 for points, Blake plays the 5 as a one-off, Alice lets it resolve and
draws, and the phone goes back to Blake.

- **Before:** the base commit without the fix, which is what the live site
  (`https://apismellow.github.io/cuttle-web/`) runs. Blake's hand just grows by
  two cards, with no reveal.
- **After:** this tree. Blake sees the face-up reveal and taps Continue. Then
  Blake draws and passes, and Alice's curtain, recap and board show none of it.

The only test hook used is `newGame(seed, dealer)`, to seed the golden deal;
every move is a tap. That hook is compiled out of production builds, so both
sides run under `vite` dev rather than the deployed bundle.

`record.mjs` throws if the unfixed build shows a reveal, if the fixed build does
not say "You drew 2 cards" with two face-up cards, or if either drawn card's text
appears on any of Alice's screens.

Rerun from the repo root, with `BEFORE_WEB` pointing at the `web/` directory of a
checkout of the base commit (its wasm built):

```sh
npm --prefix web run build:wasm
BEFORE_WEB=<base checkout>/web node demo/five-draw-reveal/record.mjs   # frames -> demo/five-draw-reveal/out/frames/
MOVIE=<path to proving-it-works-with-a-movie skill>/bin/movie
$MOVIE build demo/five-draw-reveal/scenes.yaml demo/five-draw-reveal/out/five-draw-reveal.mp4
```

- `record.mjs` starts and stops its own dev servers (ports 4182 and 4183, bound
  to 127.0.0.1) and uses Playwright from `web/node_modules`.
- Narration is Piper, voice `en_US-lessac-medium`, which must be in
  `~/.cache/piper-voices`.
- The reveal continues by itself after 3 seconds, so the recording taps
  Continue about a second in.
- `out/` (frames, mp4, build and check dirs) is gitignored.
