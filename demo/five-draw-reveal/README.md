# A 5 shows you what you drew: demo movie

Proof movie for issues #27 and #23. When a player plays a 5 and the opponent
holds no 2, the drawer's own screen shows the draw straight away: the two cards
travel face down from the deck, flip face up, and are marked "You drew 2 cards".
A tap, Continue, or 3 seconds moves on to the pass. The opponent is only asked
to counter when they actually hold a 2, and that prompt comes right after the
pass gate, with no recap screen first. The opponent's screens never show the
drawn cards.

The movie films real builds through the real UI on a 393x852 touch viewport
(iPhone 15), with the frames padded onto a 1400x2500 black canvas so the burned-in
subtitles sit in a band under the phone.

1. **Before** (current main, seed 42): Alice plays a 2, Blake plays a 5. Alice
   holds no 2, yet is asked to "Let it resolve", and no one sees the drawn cards.
2. **After** (this tree, seed 42): the same moves. No prompt for Alice. Blake sees
   only his two drawn cards, then the pass to Alice, whose screens show none of it.
3. **After, opponent with a 2** (this tree, seed 21, dealer Blake): Alice plays an
   8 and keeps a 2. Blake plays a 5. Alice gets the counter prompt straight after
   the pass gate, lets it resolve, takes her turn, and Blake then sees his draw.

The only test hook used is `newGame(seed, dealer)`; every move is a tap. That hook
is compiled out of production builds, so both sides run under `vite` dev.

`record.mjs` throws if the old build shows a reveal or lacks the prompt, if the
new build prompts a no-2 opponent, if the reveal is not exactly the two drawn
cards, if either drawn card's text appears on Alice's screens, or if a recap
comes before the counter prompt.

Rerun from the repo root, with `BEFORE_WEB` pointing at the `web/` directory of a
checkout of current main (its wasm built):

```sh
npm --prefix web run build:wasm
BEFORE_WEB=<main checkout>/web node demo/five-draw-reveal/record.mjs   # frames -> demo/five-draw-reveal/out/frames/
MOVIE=<path to proving-it-works-with-a-movie skill>/bin/movie
$MOVIE build demo/five-draw-reveal/scenes.yaml demo/five-draw-reveal/out/five-draw-reveal.mp4
```

- `record.mjs` warms and runs its own dev servers (ports 4182 and 4183, bound to
  127.0.0.1; override with `PORT_AFTER` / `PORT_BEFORE`) and uses Playwright from
  `web/node_modules`. Screenshots time out at 3 s to avoid blank frames.
- Narration is Piper, voice `en_US-lessac-medium`, which must be in
  `~/.cache/piper-voices`.
- The reveal continues by itself after 3 seconds, so the recording taps
  Continue about 1.4 seconds in.
- `out/` (frames, mp4, build and check dirs) is gitignored.
