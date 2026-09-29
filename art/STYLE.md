# Mythic style lock

Status: draft, 2026-09-28. Built from the first 16 cards (Aces, 2s, 3s, 4s).

## Direction

- **Colour comes from what the card does, not its suit.** Every Ace is
  Wrath white and pale gold. Every 2 is Counterspell azure and black. The
  suit shows only in the corner index. Blue is simply the colour of the 2s.
- **Each rank gets four different pictures, one per suit.** Style can vary
  inside a rank. Stained glass, woodcut and painterly are all allowed, as
  long as the shared rules below hold.

## Shared rules (every card)

- **Shape:** portrait, about 1:1.3. Render at 1024x1536 (or smaller).
  Full-bleed art, no border.
- **Corner index:** drawn in code, not by the image model. White rounded
  plaque, thick black outline, top-left, about a quarter of the card wide
  and a third tall (252x486 px on a 1024-wide card). Large rank glyph on
  top, a large pip below. Black pip for spades and clubs, red for hearts
  and diamonds. The same on every card, so it always reads, even in the
  top strip under a Jack.
- **In the prompt**, still ask the model for "a large solid pure-white
  rounded plaque with a thick black outline" in the corner, so it keeps
  that area clear for the stamped index to cover.
- **Line weight:** heavy, dark and even. Leaded lines for stained glass,
  carved black lines for woodcut. Painterly cards replace line with hard
  value edges.
- **Contrast:** the focal shape must be the brightest or darkest thing on
  the card, against a plain opposite value. Test at 80 px wide. If it goes
  to mush, re-render with bolder values rather than trying to rescue it by
  editing.
- **One focal shape per card.** A beam, a face, a burst, a tree, a head.
  Everything else stays secondary.
- **Model:** `openai:gpt-image-2`, quality medium, size 1024x1536.

## Palette by rank

| Rank | Spell | Palette |
|---|---|---|
| A | Wrath of God | white, pearl grey, pale lemon/gold; dark slate for contrast |
| 2 | Counterspell | azure, pale sky blue, deep black |
| 3 | Regrowth / Raise Dead | leaf and moss green, lime glow, earth brown, black |
| 4 | Mind Rot | violet, plum, magenta-purple, pale lilac, black |
| 5 | Divination | deep indigo, ultramarine blue-violet, silver, white, black (no magenta, so it stays apart from the 4s) |
| 6 | Tranquility | soft sage, seafoam, pale mint, white, deep pine-green shadow (no brown or lime, so it stays apart from the 3s) |
| 7 | Future Sight | deep teal, dark sea-green, bright gold, pale golden-white, black (gold is always the light source; no violet or magenta) |
| 8 | Telepathy | hot magenta, rose-pink, dark wine-magenta ground, pale silver-white, black (no violet, plum or lilac, so it stays apart from the 4s) |
| 9 | Boomerang / Unsummon | bright turquoise, cyan, white on deep navy, black (brighter and greener than the 2s; no azure sky-blue) |
| 10 | Apex creature (pure points) | fiery orange-red, blazing orange, pale yellow-orange, deep bronze, black (creature as one flat dark silhouette against open bright fire; no blue, green or purple) |
| J | Control Magic (steal a creature) | deep crimson, scarlet, black, bright gold threads/chains (gold is the brightest line; no orange, so it stays apart from the 10s). The creature reads as a bright shape on black or a black shape on bright crimson, never crimson on dark crimson. Focal image sits mid-and-lower card: a Jack on top of a stolen point card, offset downward |
| Q | Ward (protects your other cards) | pearl white, silver, soft lavender, deep charcoal-grey ground, black (no gold, no saturated purple, so it stays apart from the Aces, 4s and Kings) |
| K | Crown and throne (lowers the goal: 21, 14, 10, 5, 0) | royal gold, pale golden-white, deep royal purple, black (gold is the light; no red, blue or green) |

## Never

- Never let the model draw the final index; always stamp it.
- No text on the art: no titles, no rules text, no logos.
- No gore, no skeletons. Destruction reads as light, ash, shards or
  crumbling stone.
- No wrapped or detailed hands as the focus. Keep hands simple, partly lost
  in light or shadow, or leave them out.
- No close copies of the original Magic: The Gathering art. Echo the mood
  and composition only.
- Don't mix another rank's palette into a card. The suit never changes the
  colour.
- No low-contrast, all-mid-tone images.

## Open questions

- Does suit colour still show anywhere beyond the red/black pip, or is the
  pip enough?
- Creature point cards (Ace through 10, played for points rather than as a
  spell) haven't been styled yet. Is their palette also rank-based, or do
  creatures get a separate rule?
