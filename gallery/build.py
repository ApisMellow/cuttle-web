#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow"]  # WebP encode; the only third-party need
# ///
"""Export the Mythic deck gallery into gallery/site/ (images + cards.json).

Reads the finished art from a source directory (never modifies it) and
writes, for every card, a gallery-size WebP of the full uncropped painting
and a small thumbnail, plus cards.json, the page's only data file.

Source layout:

    <source>/aces/A-clubs.png ... <source>/kings/K-spades.png
    <source>/eights-v2/8-<suit>.png          the 8 faces
    <source>/eights-v2/glasses-<suit>.png    landscape glasses-8 art
    --back PATH                              the card back

Usage:
    gallery/build.py SOURCE_DIR --back PATH/back.png [--out gallery/site]

Requires Python 3.10+ and Pillow with WebP support (pip install Pillow).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent

# Engine order (web/src/lib/bridge/schema.ts: Clubs, Diamonds, Hearts, Spades).
SUITS = ["clubs", "diamonds", "hearts", "spades"]

# (file rank, source folder, rank in words)
RANKS = [
    ("A", "aces", "Ace"), ("2", "twos", "2"), ("3", "threes", "3"),
    ("4", "fours", "4"), ("5", "fives", "5"), ("6", "sixes", "6"),
    ("7", "sevens", "7"), ("8", "eights-v2", "8"), ("9", "nines", "9"),
    ("10", "tens", "10"), ("J", "jacks", "Jack"), ("Q", "queens", "Queen"),
    ("K", "kings", "King"),
]
GLASSES_DIR = "eights-v2"

# Copied from web/src/lib/cardText.ts (CLASSIC_NAMES and cardEffectLine).
# The gallery never imports game code; web/tests/unit/gallery-data.test.ts
# fails if this wording drifts from the game's.
TEXT = {
    "A": ("Board Wipe", "One-off: scrap every point card."),
    "2": ("Counter", "One-off: scrap one royal or glasses 8, or stop a one-off as it’s played."),
    "3": ("Recycle", "One-off: take a card from the scrap."),
    "4": ("Forced Discard", "One-off: they discard 2 cards."),
    "5": ("Draw Two", "One-off: draw 2 cards."),
    "6": ("Royal Wipe", "One-off: scrap every royal and glasses 8."),
    "7": ("Top Deck", "One-off: see the top 2 cards (or the last one), play one."),
    "8": ("Glasses", "Glasses: you see their hand."),
    "9": ("Send Back", "One-off: send a card back to its owner’s hand."),
    "10": ("Points", "No one-off: play it for points or to scuttle."),
    "J": ("Thief", "Permanent: steal one of their point cards."),
    "Q": ("Guard", "Permanent: their 2s, 9s and Jacks can’t target your other cards."),
    "K": ("Shortcut", "Permanent: you need fewer points to win."),
}

# Long edge of the gallery image and the thumbnail (px). Portrait art is
# 2:3, so a card is 600 x 900; glasses art is 3:2, so 900 x 600.
LARGE_EDGE = 900
THUMB_EDGE = 150
QUALITY = 75
THUMB_QUALITY = 72
BUDGET_BYTES = 6 * 1024 * 1024


def export(src: Path, out: Path, slug: str) -> dict:
    img = Image.open(src).convert("RGB")
    entry: dict = {}
    for kind, edge, quality, sub in (
        ("img", LARGE_EDGE, QUALITY, "img"),
        ("thumb", THUMB_EDGE, THUMB_QUALITY, "img/thumb"),
    ):
        scale = edge / max(img.size)
        size = (round(img.size[0] * scale), round(img.size[1] * scale))
        dst = out / sub / f"{slug}.webp"
        dst.parent.mkdir(parents=True, exist_ok=True)
        img.resize(size, Image.LANCZOS).save(dst, "WEBP", quality=quality, method=6)
        entry[kind] = f"{sub}/{slug}.webp"
        entry[f"{kind}W"], entry[f"{kind}H"] = size
    return entry


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source", type=Path, help="the Mythic art folder (aces/ ... kings/)")
    ap.add_argument("--back", type=Path, required=True, help="the card-back painting")
    ap.add_argument("--out", type=Path, default=HERE / "site")
    args = ap.parse_args()

    jobs: list[tuple[Path, dict]] = [(args.back, {
        "id": "back", "kind": "back", "title": "Card back",
        "subtitle": "The Mythic back",
        "effect": "Every card in the deck shares this back.",
        "alt": "The Mythic card back, a painted design.",
    })]
    for rank, folder, word in RANKS:
        name, effect = TEXT[rank]
        for suit in SUITS:
            jobs.append((args.source / folder / f"{rank}-{suit}.png", {
                "id": f"{rank}-{suit}", "kind": "face", "title": name,
                "subtitle": f"{word} of {suit}", "effect": effect,
                "alt": f"{word} of {suit}, painted Mythic card face.",
            }))
        if rank == "8":
            for suit in SUITS:
                jobs.append((args.source / GLASSES_DIR / f"glasses-{suit}.png", {
                    "id": f"glasses-{suit}", "kind": "glasses", "title": "Glasses",
                    "subtitle": f"8 of {suit}, played as glasses",
                    "effect": effect,
                    "alt": f"Glasses 8 of {suit}, painted landscape card face.",
                }))

    missing = [str(p) for p, _ in jobs if not p.is_file()]
    if missing:
        print("missing source art:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1

    cards = []
    for src, meta in jobs:
        cards.append({**meta, **export(src, args.out, meta["id"])})
    (args.out / "cards.json").write_text(
        json.dumps({"deck": "Mythic", "cards": cards}, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    big = sum((args.out / c["img"]).stat().st_size for c in cards)
    small = sum((args.out / c["thumb"]).stat().st_size for c in cards)
    print(f"{len(cards)} cards; gallery {big / 1e6:.2f} MB + thumbs {small / 1e6:.2f} MB "
          f"= {(big + small) / 1e6:.2f} MB")
    if big + small > BUDGET_BYTES:
        print(f"over the {BUDGET_BYTES / 2**20:.0f} MiB budget", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
