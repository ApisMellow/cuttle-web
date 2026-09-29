#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow"]  # WebP encode/decode; the only third-party need
# ///
"""Export a card-art theme into web/static/themes/<theme-id>/ (PRD §10 A-6).

Reads finished card art from a source directory (never modifies it) and
writes game-size WebP faces, a manifest, and the theme's entry in
web/static/themes/index.json.

Source layout (one folder per rank; override any folder with --rank-dir):

    <source>/aces/A-spades.png  ...  <source>/kings/K-clubs.png
    <source>/<eights folder>/glasses-<suit>.png   landscape glasses-8 art (optional)
    <source>/back.png                              card back (optional; or --back PATH)
    <source>/table.png                             playmat (optional)

Every slot is optional; a missing file is left out of the manifest and the
game draws the vector baseline for it.

Faces are portrait art (for example 1024x1536, 2:3) with the rank-and-suit
corner index already stamped in the upper-left (see the art's
stamp_index.py). The game's card is about 1:1.3, so each face is cropped to
that ratio. The crop window slides as close to centred as it can while
keeping the whole stamped index, plus a margin, inside it, so the index is
never cut and never needs re-stamping. The index geometry is read from
the X, Y, W, H constants in the source directory's stamp_index.py when
present (parsed, never executed), else the defaults below, and the index
box is recorded in the manifest so the game can zoom to it at its smallest
card size. Every face must share one pixel size, since the manifest holds
one index box for the whole theme.

Requires Python 3.10+ and Pillow with WebP support (pip install Pillow).

Usage:
    scripts/export_theme.py SOURCE_DIR --theme-id mythic --label Mythic \\
        [--rank-dir 8=eights-v2] [--glasses-dir eights-v2] [--back PATH]
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
THEMES = REPO / "web" / "static" / "themes"

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
SUITS = ["clubs", "diamonds", "hearts", "spades"]
RANK_DIRS = {
    "A": "aces", "2": "twos", "3": "threes", "4": "fours", "5": "fives",
    "6": "sixes", "7": "sevens", "8": "eights", "9": "nines", "10": "tens",
    "J": "jacks", "Q": "queens", "K": "kings",
}

# Game card: about 1.3 tall per 1 wide (web/src/lib/styles/card-geometry.css).
# Small = 2x a 66 px roomy-phone hand card; large = 2x that, for the detail
# view and 3x screens. Glasses faces are the same boxes turned landscape.
SMALL = (132, 172)
LARGE = (264, 344)
BUDGET_BYTES = 4 * 1024 * 1024

# Corner-index plaque at a 1024-px-wide face: x, y, w, h (stamp_index.py).
DEFAULT_PLAQUE = (16, 16, 252, 486)
INDEX_MARGIN = 12  # px at 1024 wide kept clear above the plaque
NO_PLAQUE = (0, 0, 0, 0)  # art with no stamped index (the back): crop centred

# Same rule as parseCatalog() in web/src/lib/theme/catalog.ts.
THEME_ID = re.compile(r"^[a-z0-9-]+$")


def load_plaque(source: Path) -> tuple[int, int, int, int]:
    """Plaque geometry from the art's own stamp_index.py, if it has one.

    Reads the module-level X, Y, W, H assignments (plain or tuple-unpacked)
    with ast and literal_eval only; the file is never imported or run.
    """
    path = source / "stamp_index.py"
    if not path.exists():
        return DEFAULT_PLAQUE
    try:
        tree = ast.parse(path.read_text(), filename=str(path))
    except (OSError, SyntaxError, ValueError):
        return DEFAULT_PLAQUE
    found: dict[str, object] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            try:
                if isinstance(target, ast.Name):
                    found[target.id] = ast.literal_eval(node.value)
                elif isinstance(target, ast.Tuple) and isinstance(node.value, ast.Tuple):
                    if len(target.elts) != len(node.value.elts):
                        continue
                    for name, value in zip(target.elts, node.value.elts):
                        if isinstance(name, ast.Name):
                            found[name.id] = ast.literal_eval(value)
            except ValueError:
                continue  # not a literal; irrelevant unless it is X/Y/W/H
    values = [found.get(k) for k in ("X", "Y", "W", "H")]
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in values):
        return DEFAULT_PLAQUE
    return tuple(values)  # type: ignore[return-value]


def crop_portrait(im: Image.Image, ratio: float, plaque: tuple[int, int, int, int]):
    """Crop to height = ratio * width, keeping the stamped index inside.

    Returns (cropped image, index box as fractions of the crop).
    """
    w, h = im.size
    k = w / 1024
    px, py, pw, ph = (v * k for v in plaque)
    has_plaque = plaque != NO_PLAQUE
    if h / w > ratio:
        ch = round(w * ratio)
        centred = (h - ch) / 2
        if has_plaque:
            # The window's top may not pass the plaque's top minus the
            # margin, and its bottom must stay below the plaque's bottom.
            top_max = max(0.0, py - INDEX_MARGIN * k)
            top_min = max(0.0, py + ph - ch)
            top = round(min(max(centred, top_min), top_max))
        else:
            top = round(centred)
        box = (0, top, w, top + ch)
    else:
        cw = round(h / ratio)
        centred = (w - cw) / 2
        left = round(min(centred, max(0.0, px - INDEX_MARGIN * k)) if has_plaque else centred)
        box = (left, 0, left + cw, h)
    out = im.crop(box)
    cw, ch = out.size
    index = {
        "x": round((px - box[0]) / cw, 4),
        "y": round((py - box[1]) / ch, 4),
        "w": round(pw / cw, 4),
        "h": round(ph / ch, 4),
    }
    return out, index


def crop_landscape(im: Image.Image, ratio: float) -> Image.Image:
    """Crop landscape art to width = ratio * height, keeping the upper-left
    suit pip (the glasses face's only identity mark) in view."""
    w, h = im.size
    if w / h > ratio:
        cw = round(h * ratio)
        return im.crop((0, 0, cw, h))
    ch = round(w / ratio)
    return im.crop((0, 0, w, ch))


def save_webp(im: Image.Image, size: tuple[int, int], path: Path, quality: int) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.resize(size, Image.LANCZOS).save(path, "WEBP", quality=quality, method=6)
    return path.stat().st_size


def sources(stem: str, sizes: list[tuple[str, int]]) -> list[dict]:
    return [{"src": f"{folder}/{stem}.webp", "w": w} for folder, w in sizes]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="art source directory (read only)")
    ap.add_argument("--theme-id", required=True, help="lower-case id, e.g. mythic")
    ap.add_argument("--label", required=True, help="player-facing name, e.g. Mythic")
    ap.add_argument("--rank-dir", action="append", default=[], metavar="RANK=DIR",
                    help="override a rank's source folder, e.g. 8=eights-v2")
    ap.add_argument("--glasses-dir", default=None, help="folder holding glasses-<suit>.png (default: the 8s folder)")
    ap.add_argument("--back", type=Path, default=None, help="card back image (default: SOURCE/back.png)")
    ap.add_argument("--quality", type=int, default=80, help="WebP quality (default 80)")
    args = ap.parse_args()

    source: Path = args.source.expanduser().resolve()
    if not source.is_dir():
        print(f"source directory not found: {source}", file=sys.stderr)
        return 2
    theme_id = args.theme_id
    if not THEME_ID.fullmatch(theme_id) or theme_id == "vector":
        print("theme id must be lower-case letters, digits and dashes, and not 'vector'", file=sys.stderr)
        return 2

    rank_dirs = dict(RANK_DIRS)
    for item in args.rank_dir:
        rank, _, folder = item.partition("=")
        if rank not in rank_dirs or not folder:
            print(f"bad --rank-dir {item!r}", file=sys.stderr)
            return 2
        rank_dirs[rank] = folder
    glasses_dir = args.glasses_dir or rank_dirs["8"]

    out = THEMES / theme_id
    for sub in ("faces", "faces-2x", "glasses", "glasses-2x"):
        d = out / sub
        if d.exists():
            for f in d.glob("*.webp"):
                f.unlink()
    for f in ("back.webp", "back-2x.webp", "table.webp"):
        (out / f).unlink(missing_ok=True)

    ratio = SMALL[1] / SMALL[0]
    plaque = load_plaque(source)
    total = 0
    faces: dict[str, list[dict]] = {}
    index_box = None
    face_size: tuple[int, int] | None = None
    missing: list[str] = []

    for rank in RANKS:
        for suit in SUITS:
            key = f"{rank}-{suit}"
            src = source / rank_dirs[rank] / f"{key}.png"
            if not src.exists():
                missing.append(key)
                continue
            with Image.open(src) as im:
                if face_size is None:
                    face_size = im.size
                elif im.size != face_size:
                    # One index box serves the whole theme (manifest "index").
                    print(f"{src.name} is {im.size[0]}x{im.size[1]}, but faces are "
                          f"{face_size[0]}x{face_size[1]}; every face must share one size",
                          file=sys.stderr)
                    return 2
                cropped, index = crop_portrait(im.convert("RGB"), ratio, plaque)
            index_box = index_box or index
            total += save_webp(cropped, SMALL, out / "faces" / f"{key}.webp", args.quality)
            total += save_webp(cropped, LARGE, out / "faces-2x" / f"{key}.webp", args.quality - 4)
            faces[key] = sources(key, [("faces", SMALL[0]), ("faces-2x", LARGE[0])])

    glasses: dict[str, list[dict]] = {}
    for suit in SUITS:
        src = source / glasses_dir / f"glasses-{suit}.png"
        if not src.exists():
            continue
        with Image.open(src) as im:
            cropped = crop_landscape(im.convert("RGB"), ratio)
        total += save_webp(cropped, (SMALL[1], SMALL[0]), out / "glasses" / f"{suit}.webp", args.quality)
        total += save_webp(cropped, (LARGE[1], LARGE[0]), out / "glasses-2x" / f"{suit}.webp", args.quality - 4)
        glasses[suit] = [{"src": f"glasses/{suit}.webp", "w": SMALL[1]}, {"src": f"glasses-2x/{suit}.webp", "w": LARGE[1]}]

    back = None
    back_src = args.back.expanduser().resolve() if args.back else source / "back.png"
    if back_src.exists():
        with Image.open(back_src) as im:
            cropped, _ = crop_portrait(im.convert("RGB"), ratio, NO_PLAQUE)
        total += save_webp(cropped, SMALL, out / "back.webp", args.quality)
        total += save_webp(cropped, LARGE, out / "back-2x.webp", args.quality - 4)
        back = [{"src": "back.webp", "w": SMALL[0]}, {"src": "back-2x.webp", "w": LARGE[0]}]

    table = None
    if (source / "table.png").exists():
        with Image.open(source / "table.png") as im:
            im = im.convert("RGB")
            im.thumbnail((1024, 1024), Image.LANCZOS)
            path = out / "table.webp"
            im.save(path, "WEBP", quality=args.quality - 10, method=6)
            total += path.stat().st_size
            table = [{"src": "table.webp", "w": im.size[0]}]

    manifest = {
        "id": theme_id,
        "label": args.label,
        "assetBytes": total,
        "index": index_box,
        "faces": faces,
        "glasses": glasses,
        "back": back,
        "table": table,
    }
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    index_path = THEMES / "index.json"
    catalog = {"themes": []}
    if index_path.exists():
        catalog = json.loads(index_path.read_text())
    entries = [t for t in catalog.get("themes", []) if t.get("id") != theme_id]
    entries.append({"id": theme_id, "label": args.label, "manifest": f"{theme_id}/manifest.json"})
    catalog["themes"] = entries
    index_path.write_text(json.dumps(catalog, indent=2) + "\n")

    print(f"{theme_id}: {len(faces)} faces, {len(glasses)} glasses, back={'yes' if back else 'no'}, "
          f"table={'yes' if table else 'no'}")
    if missing:
        print(f"missing (vector fallback): {', '.join(missing)}")
    print(f"total {total} bytes ({total / 1024 / 1024:.2f} MiB); budget {BUDGET_BYTES} bytes")
    if total > BUDGET_BYTES:
        print("OVER BUDGET", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
