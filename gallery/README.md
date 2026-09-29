# Mythic card gallery

A showcase of the finished Mythic deck: all 52 faces, the four glasses 8s and
the card back, one card at a time, each sliding over the last. It's live at
https://apismellow.github.io/cuttle-web/gallery/.

The gallery stands alone. It's plain HTML, CSS and JavaScript with no build
step and no game code; it links to the game but the game doesn't link back.

```
gallery/
  build.py        exports the images and cards.json from the source art
  site/           the page itself, deployed as-is
    index.html  gallery.css  gallery.js
    cards.json    one entry per card: name, effect, alt text, image sizes
    img/          gallery-size WebPs (600 x 900, glasses 900 x 600)
    img/thumb/    thumbnails (150 px long edge)
```

## Rebuild the images

Needs Python 3.10+ and Pillow with WebP support (`pip install Pillow`).

```
gallery/build.py SOURCE_DIR --back PATH/TO/back.png
```

`SOURCE_DIR` is the Mythic art folder: one folder per rank (`aces/A-spades.png`
through `kings/K-clubs.png`), with the 8s and the glasses art in `eights-v2/`
(`8-<suit>.png`, `glasses-<suit>.png`). The source is only read. The script
rewrites `site/img/` and `site/cards.json`, prints the total size, and fails if
it passes 6 MiB.

Each card's name and effect come from the game's `web/src/lib/cardText.ts`,
copied into `build.py`. `web/tests/unit/gallery-data.test.ts` fails if the two
drift apart, and `web/tests/e2e/gallery.spec.ts` checks the page loads all 57
cards and navigates.

## Preview locally

The page fetches `cards.json`, so serve the folder rather than opening the
file:

```
python3 -m http.server --directory gallery/site 8000
```

## Deploy

`.github/workflows/pages.yml` copies `gallery/site/` into the built site as
`gallery/`, next to the game.
