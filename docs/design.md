# Cuttle Web: design system

> **Status: binding (2026-09-28).** The three calls that were provisional as of 2026-09-27 are now confirmed by the product owner (ApisMellow, 2026-09-28): a single dark table (§2), the field card width at 60 px (§5), and recap cards shown as theme `mini` faces (§8). The recap and staging sentence text is runtime output from `lib/recap.ts` or engine `descriptions[i]`, and it may carry suit glyphs. §5.6 rule 1 governs glyphs written into component source. Build to these tokens; any change will be a token edit. ApisMellow will give placement feedback after he has played a build, so expect layout adjustments then. The judge-scored visual items (R5.1, R19.4) can now proceed against a confirmed board.

Binding for every presentational component from round 3 on. Tokens live in `web/src/lib/styles/tokens.css` (imported once by `App.svelte`); card geometry stays in `web/src/lib/styles/card-geometry.css`. Section numbers in the form §x.y refer to `docs/SPEC.md`.

## 1. Direction

**Ink and cuttlebone.** A cuttlefish escapes by clouding the water with ink; this game hides each player's hand the same way. The table is deep ink, the cards are cuttlebone-white stock, and the curtain is a denser ink with a fixed chromatophore dot field. The two interaction accents come from the animal's skin: iridophore teal means "you can play here", chromatophore ochre means "you chose this". Everything else stays quiet. The one memorable element is the curtain; the board is disciplined and dense.

## 2. Single theme, dark table

**Confirmed 2026-09-28 (ApisMellow).** There is no light mode and no `prefers-color-scheme` branch. Reasons:

- The table is a place, like felt. Card faces are light in either case, so a light table would only lower card-edge contrast.
- The phone is passed across a table, often in dim rooms; a dark field reduces glare at the moment of handoff.
- Every suit-contrast and state-visibility check runs against one table colour. Two tables double the judge surface and the contrast audit.
- `manifest.theme_color` / `background_color` become `#241c2b` (currently `#0f1115`, §5.8).

**Card styles are separate from the table (added 2026-09-28, round 8 themes).** The one dark table stays; what a player chooses is the deck. The home screen carries a **Card style** group under the two name fields: one pill per style (Classic, then Mythic), side by side, each at least `--cu-tap-min` tall, on `--cu-ink-raised` with a 1 px `--cu-ink-line` edge. The chosen pill takes a 1 px `--cu-ochre` edge plus a 1 px inset ochre ring, and its radio is ochre (`accent-color`); keyboard focus shows a 2 px `--cu-iris` outline. The legend reads "Card style" in `--cu-text-sm` muted. The group only appears once there is more than one style to pick. There is no in-game menu yet, so changing style mid-game means Home, pick, Resume (SPEC §5.6 rule 5 ruling). The vector deck is called **Classic** on screen.

A bitmap style paints only inside the boxes the app already sizes (§5, SPEC §5.6 rule 2), so switching never moves anything. Any card it has no art for, or whose image fails, draws as Classic in the same box. Mythic has faces and glasses art but no back or playmat, so its backs are Classic and the table stays ink. A theme playmat, when one ships, is painted behind the board only, never behind a curtain. At `mini`, a bitmap face zooms to its own painted corner index (§7). **Known item to check on a real phone:** Mythic's painted index is smaller than Classic's, about a 10 px rank on a 60–66 px hand card.

## 3. Palette

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `--cu-ink` | `#241c2b` | board background | reference |
| `--cu-ink-raised` | `#30263a` | zone wells, score bar, action bar, sheets | |
| `--cu-ink-line` | `#4a3d57` | hairlines, empty-slot outlines | 1.64:1, decorative only |
| `--cu-curtain` | `#1a1420` | curtain screens only | |
| `--cu-pearl` | `#eee8f1` | primary text | 13.67 ink, 11.92 raised, 14.98 curtain |
| `--cu-muted` | `#b4a8be` | secondary text | 7.28 ink, 6.34 raised, 7.97 curtain |
| `--cu-paper` | `#faf8f4` | card face | 15.52 against ink |
| `--cu-suit-black` | `#1f1824` | ♣ ♠ | 16.30 on paper |
| `--cu-suit-red` | `#b0172e` | ♦ ♥ | 6.58 on paper |
| `--cu-suit-red-on-ink` | `#ff8a96` | red glyph on the table, if ever | 7.31 ink |
| `--cu-iris` | `#5ccfc4` | highlighted / legal target | 8.76 ink, 7.63 raised |
| `--cu-ochre` | `#f0b54a` | staged, Confirm | 8.94 ink, 7.80 raised |
| `--cu-frost` | `#a9d2f5` | frozen chip | 10.36 ink |
| `--cu-on-accent` | `#241c2b` | text on iris/ochre fills | 8.76 / 8.94 |

Dimmed faces sit under `--cu-dim-scrim` (ink at 42%): the red rank on a dimmed face measures 4.01:1 and black 6.25:1, both above the 3:1 large-text floor at every rank size used.

Rule: red suit glyphs appear on `--cu-paper` only. Any red glyph placed directly on ink uses `--cu-suit-red-on-ink`.

## 4. Type

- `--cu-font-ui` / `--cu-font-index`: **Atkinson Hyperlegible Next**, self-hosted woff2 (OFL), Latin subset, weights 400 and 700, precached with the app shell. Chosen for rank legibility at `mini`: open 1/l/I, a distinct `10`, wide counters. Budget about 40 KB for both weights.
- `--cu-font-display`: `ui-serif` (New York on Apple platforms, Georgia elsewhere). Zero bytes. Used only for the player name on curtain and result screens.
- No runtime font requests. `font-display: swap`; the system fallback stack is legible if the woff2 fails.

| Token | px | Use |
|---|---|---|
| `--cu-text-xs` | 12 | row tallies, badges |
| `--cu-text-sm` | 14 | secondary labels |
| `--cu-text-md` | 16 | body, buttons, recap lines |
| `--cu-text-lg` | 20 | score numerals, "Pass the phone to" |
| `--cu-text-xl` | 25 | result headline, sheet titles |
| `--cu-text-name` | 44 (short-viewport value tuned in the iPhone design pass) | curtain player name |

Sentence case everywhere. No all-caps labels. Numerals in the score bar use `font-variant-numeric: tabular-nums`.

**Rank/suit glyph sizes (read by the vector theme only), amended 2026-09-28 (W22, iPhone design pass) — sized for arm's length on an iPhone 15:** hand 24/19 px, field 20/16 px (field a touch smaller than hand so a Jack's downward offset stays clear of it, §6), mini 14/11 px. At the 430-wide roomy tier: hand 26/20 px, field 22/17 px; mini is unchanged across tiers. Every size renders its index as an upper-left corner index, rank above suit, bold rank — including `mini` *(amended 2026-09-28, ApisMellow, after a build screenshot; supersedes the earlier "centred… no corner indices at mini" rule — see §7)*.

## 5. Space, radius, geometry

Space: 4, 8, 12, 16, 24, 32, 48 (`--cu-space-1..7`). Board gutter 12 (`--cu-gutter-board`), sheet gutter 16.

Radius has three levels, by hierarchy: cards `6%`, zone wells `10px`, controls are pills, bottom sheets `18px` on the top corners only.

**Geometry, confirmed 2026-09-28 (ApisMellow):** field cards are 60 px wide on phone. Currently in `tokens.css`; move into `card-geometry.css` now that it's accepted.

**Target devices (ApisMellow, PRD §10 A-5).** Every player's phone is an iPhone 15 or larger: primary 393×852, also 430×932, with a Mobile Safari toolbar-shortened visible area down to about 393×660. **The compact tier (≤780 tall or <375 wide, sized for 360×740) is dropped**; 360×740 is no longer a target.

**Card widths, amended 2026-09-28 (W22, iPhone design pass, merged `16d2507`).** The compact tier's width column is gone; two phone tiers remain — base (393 wide) and roomy (the 430×932 Plus / Pro Max class) — plus the unchanged tablet threshold. The field size now comes in two widths: `--cuttle-card-width-field` sizes the viewer's own rows and the scrap browser; `--cuttle-card-width-field-far` sizes the opponent's rows, a step smaller, like the far side of a real table (`OpponentZone` sets the shared `--cu-row-card-width` custom property to it). The theme still receives `size="field"` for both — it never reads these tokens (§5.6 rule 2) — so the three-size rendering model is unchanged; only the container's box differs. The far step is also what lets the worst-case board (a Jack on two point cards per side) fit 393×852 with no scroll (§10.6).

| Token | Base phone (393 wide) | Roomy phone (430×932) | Tablet (≥600 wide and ≥900 tall) |
|---|---|---|---|
| `--cuttle-card-width-hand` | 60 | 66 | 72 |
| `--cuttle-card-width-field` | 60 | 66 | 72 |
| `--cuttle-card-width-field-far` | 52 | 56 | 64 |
| `--cuttle-card-width-mini` | 32 | 34 | 36 |

**Card ratio, amended 2026-09-28 (ApisMellow, after a build screenshot).** Cards read as slightly shorter than the prior height-to-width ratio. The ratio is one token, `--cuttle-card-aspect` in `web/src/lib/styles/card-geometry.css`, about 1.3, tunable via the token — the developer is choosing the exact value now.

## 6. Board layout

Portrait, one column, mirrored like two people across a table: each side's points row faces the center, where scuttles happen.

**Zone heights, amended 2026-09-28 (W22, iPhone design pass, merged `16d2507`).** `ScoreBar`, `OpponentHand`, `CenterZone`, `PlayerHand` and the action bar keep fixed budget tokens (`--cu-zone-*`, `tokens.css`), one set at the 393-wide base tier and a larger set at the 430×932 roomy tier. `PointRow` and `PermanentRow` no longer read a fixed `--cu-zone-*` height: each row is sized from its own card width — `--cu-row-pad` (3 px, both tiers) above and below one card, using whichever width that row's `--cu-row-card-width` resolves to — and grows by `--cu-jack-offset` (37 px base / 40 px roomy) only on a side that actually holds a stolen Jack (§6, "Field rows" below).

| Zone | Component | Base (393 wide) | Roomy (430×932) |
|---|---|---|---|
| Score bar | `ScoreBar` | 44 | 48 |
| Opponent hand | `OpponentHand` | 40 | 44 |
| Opponent permanents | `PermanentRow` | ≈74 (one field-far card + row-pad) | ≈79 |
| Opponent points | `PointRow` | ≈74, or ≈111 on a side holding a Jack | ≈79, or ≈119 with a Jack |
| Center strip | `CenterZone` | 84 | 92 |
| Your points | `PointRow` | ≈84, or ≈121 with a Jack | ≈92, or ≈132 with a Jack |
| Your permanents | `PermanentRow` | ≈84 (one field card + row-pad) | ≈92 |
| Your hand | `PlayerHand` | 96 | 104 |
| Action bar | `StagingBar` / Pass | 60 | 64 |

There is no fixed total: the board is the one scrolling region (below), so the page height is whatever these zones and the safe-area padding add up to, not a budget the layout must hit.

**Safe areas and the new scroll model (amended 2026-09-28, ApisMellow, A-5; W22, merged `16d2507`).** The page sets `viewport-fit=cover` in its viewport meta, and `GameScreen` is exactly `100dvh` — never taller — padded by `env(safe-area-inset-top)` (the Dynamic Island, about 59 pt) and `env(safe-area-inset-bottom)` (the home indicator, about 34 pt); no control, card or corner index sits in either inset, and the page itself never scrolls, in either direction. `Board` is the *only* scrolling region: it fills whatever height `GameScreen` leaves above the action bar, with `overflow-y: auto` and `overscroll-behavior: contain`. Inside it, `ScoreBar` sticks to `Board`'s top edge and the hand (`PlayerZone`'s hand slot) sticks to its bottom edge, so between them only the opponent's zones, the center strip and your points/permanents rows scroll. The action bar sits below `Board` entirely — a fixed sibling, not part of the scroll region — so staging never disappears with a scroll. Any slack beyond the safe-area insets, on a tall viewport, is split evenly into the gaps either side of the center strip (`margin-block: auto`, `CenterZone`). When Mobile Safari's toolbars shorten the visible area (down to about 393×660), **the hand and the action bar stay fully visible, pinned; only `Board` (score bar through your permanents) scrolls.** The hand zone's 12 px top padding is headroom for the staged/selected lift (`--cu-lift-staged` −12 px, `--cu-lift-selected` −8 px) rising above the fanned row; the frozen and staged markers themselves sit inside each card's own clipped box (§7) and need no extra room.

**Score bar.** Viewer on the left (their name, points, "of 21"), opponent on the right, menu button (44×44) at the far right. **Turn header, amended 2026-09-28 (W25 playtest fixes, merged `b8238db`):** the side whose turn it is names it, in bold `--cu-ochre`, widened to 12 em: "Alice, your turn" on the viewer's side, "Blake’s turn" on the opponent's. The viewer's label used to read "You". A tap on the score bar clears a selected card (SPEC §6.1). Each side has a 4 px meter filling points/threshold in `--cu-pearl` on `--cu-ink-line`. When a King lowers a threshold, the "of N" value changes and a small K pip per King appears; nothing turns red.

**Opponent hand.** Mini backs overlapped at a 14 px offset, count as a numeral beside them ("5 cards", "1 card"). Under glasses-8 (R7) the backs become mini faces, same slot, same offsets.

**Field rows, amended 2026-09-28 (W22, merged `16d2507`).** Your own rows (`PlayerZone`) sit in a `--cu-ink-raised` well at `--cu-radius-well`, sized at `--cuttle-card-width-field`. The opponent's rows (`OpponentZone`) are a step quieter and smaller: a `--cu-ink-far` well at `--cuttle-card-width-field-far`, one visual step back from your own half. Cards left-aligned with 6 px gaps; each row's height is one card of its own width plus `--cu-row-pad` (3 px) top and bottom — see the zone-heights table above. Cards beyond what fits cascade; the visible slice of any card that is a legal target never drops below 44 px, and if a row still overflows, the row (not the page) scrolls horizontally. A tally chip at the row's right end shows the row's point sum (points rows only). An empty row shows its name ("Points", "Permanents") in `--cu-muted`. **Jack display, confirmed 2026-09-28 (ApisMellow); redone twice the same day after build screenshots.** Only the top (newest) Jack is drawn: full card size, offset downward by `--cu-jack-offset` (37 px base / 40 px roomy — the distance that clears the field corner index below it), so the point card's upper-left corner index stays visible above it. Extra Jacks stack exactly underneath it and are not drawn separately; at 2 or more, a thin "deck thickness" edge — two card-back slivers past the Jack's bottom-right corner — shows there's more than one. No count number and no player colour render on the stack; the count lives only in the aria-label ("stolen, N Jacks"). Only the top Jack is a legal tap target, whether for its own selection or as the target of a 2 or a 9; buried Jacks are never targetable and never answer a tap (the engine offers only the top Jack, and the UI draws nothing else to tap). The points row grows by `--cu-jack-offset` only when that side holds a Jack (`--cu-zone-*` heights above). A small ownership mark shows when the controller differs from the owner. This supersedes the earlier fan-above treatment (§5.2) and the multi-Jack cascade previously described here.

**Glasses 8, added 2026-09-28 (W24, merged `1fbe15f`).** An 8 in a permanents row is always glasses (SPEC §3.2), and it lies on its side, the traditional table cue. Its box is the card turned 90°: one card-height (width × `--cuttle-card-aspect-ratio`) wide and one card-width tall, so it fits inside the row's one-card height and takes a little more of the row's width. The box itself is landscape, with no transform, so the row lays out, clips and hit-tests the same rectangle it draws; the element, testid and tap key don't change. The face is the theme's `glasses` variant (SPEC §5.6): in the vector theme, a pair of smug brass goggles on a stained-glass ground tinted by suit (hearts red, diamonds amber, clubs green, spades blue-black), with no rank. The same treatment applies on both sides of the table. *(R10, 2026-09-28.)* A permanents row wraps rather than scrolling sideways, so no permanent can sit off the end of the row unseen: Q + K + two sideways glasses hold one line at 393 wide on both sides, and a sixth permanent (K K Q Q 8 8) drops to a second line that grows the row.

**Center strip, amended 2026-09-28 (W22, merged `16d2507`).** Three slots: Deck (hand-size box; the count is a small pill *tab overlapping the bottom edge* of the pile, not a numeral centred beneath it), the One-off target (flex, middle), Scrap (hand-size box, top card face up; same bottom-edge count tab). When idle, the middle slot shows the last move as one line of `--cu-text-sm` muted text (R20) — the last `isRecapVisible` entry in `history`, never raw `lastMove` *(amended 2026-09-28, W13 GameScreen review: `lastMove` can be a filtered-out kind like Decline, and reading it raw told the acting player whether the opponent held a 2)*. When a card that can be played as a one-off is selected, the middle slot becomes the One-off drop zone.

**Your hand, amended 2026-09-28 (W22, merged `16d2507`).** `--cuttle-card-width-hand`-wide faces (60 px base, 66 px roomy), 4 px gaps, centred. When the row can't fit, it fans with equal overlap; the visible slice stays ≥ 44 px — 8 cards hold one row at 393 (60 px cards, ~44.6 px slices in a ~373 px row) and at 430 (66 px cards, ~47.8 px slices). If the slice would ever fall below 44 px, the hand wraps into two rows and the action bar keeps its height. At the target widths (393 and 430) an 8-card hand fits in one fanned row; the old 360-wide wrap case is no longer a target *(2026-09-28, A-5)*.

**Being watched, added 2026-09-28 (W24, merged `1fbe15f`).** While the opponent has glasses in play, a marker sits on the hand's top edge: a 22 px pill, right-aligned at the board gutter, `--cu-ink-raised` fill with a 1 px `--cu-ochre` edge, an ochre goggles icon and "Blake can see your hand" in bold `--cu-text-xs` pearl. It rides the seam between your permanents row and the hand (half in the hand slot's 12 px lift headroom), so it costs no height, and it is painted before the hand so a lifted card passes over it. Not a tap target, no testid. *(Amended 2026-09-28, R10.)* It shows exactly when the bridge's `you.watched` flag is set (SPEC §3.2), never from the board's own reading of the permanents. It is plain text rather than a live region: the hand slot is a group labelled "Your hand" whose description is the marker's text, so a screen reader hears "Blake can see your hand" whenever focus enters the hand. **Decision (ApisMellow, 2026-09-28):** being watched must be obvious. Players find the opponent's goggles annoying, so the marker must be unmistakable at a glance, not a subtle cue.

**Hover lift, added 2026-09-28 (W25, merged `b8238db`).** With a mouse (`@media (hover: hover)` only), a hand card under the pointer lifts `--cu-lift-hover` (−4 px), half the selected lift. Dimmed, selected and staged cards don't hover-lift, and a touch tap never leaves a card raised.

**Action bar.** Always reserved, so staging never reflows the board. Idle: empty or the Pass pill when it is the only legal move. Staged: the move description on the left, Cancel (ghost pill) and Confirm (ochre pill, `--cu-on-accent` text) on the right, both ≥ 44 px tall.

**Tablet and desktop.** The column caps at `--cu-board-max` (560 px) and centres on `--cu-ink`. Card sizes step up only when both ≥ 600 wide and ≥ 900 tall. Short landscape viewports scroll vertically inside the column; nothing ever scrolls horizontally.

## 7. Card states

The theme receives `state` and renders it (§5.6 rule 3). The container applies lift. Each state has a non-colour cue.

| State | Treatment | Non-colour cue | Who applies |
|---|---|---|---|
| `normal` | paper face, 1 px `--cu-ink-line` edge | | theme |
| `highlighted` | 3 px `--cu-iris` ring outside a 2 px table gap | a ring appears; hand cards lift `--cu-lift-selected` | theme ring, container lift |
| `staged` | 3 px `--cu-ochre` ring plus a small ochre tab (16 px round) with a ✓, **bottom left** of the card | tab and ✓ glyph; lift `--cu-lift-staged` | theme, container |
| `dimmed` | `--cu-dim-scrim` over the face | luminance drop; no lift; still tappable to inspect | theme |
| `frozen` | dimmed scrim plus a frost chip (❄ on `--cu-frost`, 18 px round), **bottom left** of the card | the ❄ glyph, with "frozen" for screen readers | theme scrim, container chip (existing `hand-card__frozen-marker`) |

**Marker placement, amended 2026-09-28 (W22, iPhone design pass, merged `16d2507`) — supersedes "top centre" / "top right" above.** Both the frozen chip and the staged tab moved to the card's bottom-left corner, inside the clipped hand-card box. A fanned hand shows only each card's left ~44 px slice, and the top of that slice is the corner index (§4, §7 below); bottom-left is the one spot that stays visible and free on every card in the fan, whichever position it holds.

Precedence in the single `state` slot: `frozen` > `staged` > `highlighted` > `dimmed` > `normal`.

Drop zones (Points row, Permanents row, One-off slot) use the same `highlighted` recipe on their well (iris ring, 2 px inset) plus a label ("Play for points"), and the `staged` recipe once a move targets them.

Because the ring sits outside the card box and the container clips, containers reserve `--cu-ring-width + --cu-ring-gap` of padding around a card that can be highlighted, or draw the ring on a wrapper. The face never grows.

**Identity lives in the upper-left corner index, amended 2026-09-28 (ApisMellow, after a build screenshot) — rewrites the "top strip" rule above.** Every card shows its rank and suit as a corner index in the upper-left, at every size (hand, field, mini) — never centred, never as a full-width strip. Only the top Jack on a stolen point card is drawn, same size as the card and offset downward only (§6), so the point card's index stays visible above it and the Jack's own index stays visible too. Extra Jacks carry no index of their own — they're represented only by the deck-thickness edge, never by additional corner indices, and never by a count number or a player colour. This is a face-layout rule, binding on both the vector theme and any future theme, including the PRD §10 amendment A-3 mythic theme.

**The one exception: a glasses 8 (added 2026-09-28, W24, merged `1fbe15f`).** An 8 played as a permanent draws the theme's `glasses` face (SPEC §5.6) and carries no rank and no corner index. Its identity is the suit tint plus a small suit pip, in a paper-white circle in the top-left corner of the sideways card. It is the only card on the table drawn this way, and the rule still binds every other card, including an 8 in the hand, in a points row, or in the scrap.

**Hover and focus (added 2026-09-28, W25, merged `b8238db`).** Hover is a container lift only (`--cu-lift-hover`, §6 "Your hand"); it doesn't change `state`. Keyboard focus on a board target (deck, scrap, drop zones, point and permanent cards, the 7's revealed cards) shows a 3 px `--cu-pearl` outline drawn inset (`outline-offset: -3px`), so a clipping row or well can't hide it. Hand cards keep a 2 px pearl outline offset 2 px.

## 8. Curtain screens

All curtain screens are full-viewport `--cu-curtain` with a static chromatophore dot field (two layered `radial-gradient`s, fixed size, no animation). The board is unmounted behind them (§4.5).

**Invariance rule.** The handoff and reveal screens have exactly one layout. Their DOM, classes, attributes, colours and motion are the same for every `HandoffReason`. The only values that vary are the player name and the label, which is one of the two strings "Your turn" / "Your response" (§4.5) in a fixed-height, centred slot.

**Handoff** (vertical positions at 844):
- menu button top right (identical to the board's; rules stay reachable, §5.5);
- at 30–44%: "Pass the phone to" (`--cu-text-lg`, muted), the name (`--cu-font-display`, `--cu-text-name`, pearl), the label (`--cu-text-md`, muted);
- at 62%: the hold ring, 132 px, `--cu-ink-line` track, "Hold" inside;
- at 82%: the two-step pill, "I'm NAME", 48 px tall, 240 px wide.

**Reveal.** Same screen, armed. During a hold the ring's stroke fills in `--cu-iris` over `--cu-dur-hold`; release before 600 ms resets it with no animation. On the two-step path, "I'm NAME" becomes "Show my hand" in the same place, with an iris ring on the pill. Both controls are always in the DOM.

**Recap.** Post-reveal, so it may carry game state. Background switches to `--cu-ink`: this is the first screen that belongs to the viewer. Heading "While you were away" (`--cu-text-xl`), then up to 6 lines oldest first, each a `mini` CardFace (when a card is named; confirmed 2026-09-28, ApisMellow) plus the sentence from `lib/recap.ts` at `--cu-text-md`. "+N earlier" is a text button above the list. The dismiss pill "See the board" sits in the two-step pill's position, so the thumb doesn't travel between screens. The ack and counter prompts reuse this frame; "Let it resolve" occupies the same slot on both the real and synthetic paths (§6.3). Neither the board nor the `ScoreBar` renders at the ack or counter prompt, real or synthetic; the played one-off (and any counter chain) shows as `mini` faces read from `history`, never from `pending` *(amended 2026-09-28, W13 GameScreen review; SPEC §4.3)*.

## 9. Motion

| Motion | Duration | Property |
|---|---|---|
| select lift | `--cu-dur-fast` 120 ms | `transform` |
| stage lift, ring | 120 ms lift, ring instant | `transform` |
| draw, play to a row | `--cu-dur-med` 200 ms | `transform` |
| scuttle to scrap, Jack steal | `--cu-dur-slow` 320 ms | `transform`, `opacity` |
| hold ring | `--cu-dur-hold` 600 ms, linear | two rotating half-masks (`transform`) |
| curtain in and out | none | hard cut |

- The curtain never animates in or out, in either direction, for any reason. A fade would differ in nothing, but a hard cut removes the question.
- Under `prefers-reduced-motion: reduce` every card duration is 0; lift offsets still apply as static state. The hold still takes 600 ms and the ring fills in three discrete steps. The two-step pill is unchanged.
- No state transition awaits an animation (§5.9).

## 10. Testable rules

1. `document.documentElement.scrollWidth <= clientWidth` on every screen at 393, 430 and 768 wide, plus the 390-wide Playwright default (§5.9). *(360 dropped 2026-09-28, A-5.)*
2. Every interactive `[data-testid]` box is ≥ 44×44; a cascaded or fanned card's visible slice is ≥ 44 px wide when it is interactive.
3. The handoff screen's serialized DOM, with the name and label text replaced by placeholders, is byte-identical across all five `HandoffReason` values; computed `background-color` and the set of animated properties are identical too.
4. No element in `Curtain` before the reveal completes carries a `data-*`, class or attribute derived from `HandoffReason`.
5. Each non-`normal` card state is distinguishable in a greyscale screenshot (ring present, tab present, ❄ present, scrim present).
6. At 393×852 and 430×932 (59 pt top / 34 pt bottom safe-area insets) all nine zones — including the worst case of a Jack sitting on two point cards per side (§5, §6) — are inside the viewport, clear of the safe-area insets, with no vertical scroll needed to reach any of them. At 393×660 (Mobile Safari's toolbars showing) the hand and the action bar are fully inside the viewport and pinned; only `Board`, the score bar through your permanents, scrolls, and the document itself never does. *(Amended 2026-09-28, ApisMellow, A-5: replaces the 360×740 compact rule; W22, merged `16d2507`, is the layout that satisfies it.)*
7. No request leaves the origin at runtime (fonts included); the woff2 files appear in the precache manifest.
8. With `prefers-reduced-motion: reduce`, no computed `transition-duration` on a card exceeds 0.
9. Red suit glyphs render only on `--cu-paper`, or with `--cu-suit-red-on-ink`.
10. `--cu-dur-hold` equals `HOLD_MS` from `lib/curtain.ts` (set from TS at mount; unit test).
11. The viewport meta carries `viewport-fit=cover`, and the column's top and bottom padding resolve from `env(safe-area-inset-top)` / `env(safe-area-inset-bottom)`. *(Added 2026-09-28, ApisMellow, A-5.)*

## 11. Component to token map

| Component | Tokens |
|---|---|
| `ScoreBar` | `--cu-zone-score`, `--cu-ink-raised`, `--cu-pearl`, `--cu-muted`, `--cu-ochre` (turn header), `--cu-text-lg`, `--cu-text-xs` |
| `PlayerZone` watched marker | `--cu-ink-raised`, `--cu-ochre`, `--cu-pearl`, `--cu-text-xs`, `--cu-gutter-board` |
| `OpponentHand` | `--cu-zone-opp-hand`, `--cuttle-card-width-mini`, `--cu-muted` |
| `PointRow`, `PermanentRow` | `--cuttle-card-width-field` / `--cuttle-card-width-field-far` (via `--cu-row-card-width`, opponent side only), `--cuttle-card-aspect-ratio`, `--cu-row-pad`, `--cu-jack-offset` (`PointRow` only), `--cu-ink-raised` / `--cu-ink-far` (via `--cu-row-well`), `--cu-radius-well`, `--cu-iris` (drop zone) |
| `CenterZone`, `DeckPile`, `ScrapPile` | `--cu-zone-center`, `--cuttle-card-width-hand`, `--cu-text-sm` |
| `PlayerHand`, `HandCard` | `--cu-zone-hand`, `--cuttle-card-width-hand`, `--cu-lift-*`, `--cu-dur-fast`, `--cu-frost` |
| `StagingBar` | `--cu-zone-action`, `--cu-ochre`, `--cu-on-accent`, `--cu-radius-control` |
| `Curtain`, `HandoffPanel`, `RevealGate` | `--cu-curtain`, `--cu-font-display`, `--cu-text-name`, `--cu-iris`, `--cu-dur-hold`, `--cu-gutter-sheet` |
| `RecapPanel` | `--cu-ink`, `--cu-text-xl`, `--cu-text-md`, `--cuttle-card-width-mini` |
| `AmbiguityChooser`, `ScrapBrowser` | `--cu-ink-raised`, `--cu-radius-sheet`, `--cu-tap-min` |
| Vector theme `Face`/`Back` | `--cu-paper`, `--cu-suit-*`, `--cu-index-*`, `--cu-dim-scrim`, `--cu-iris`, `--cu-ochre`, `--cu-back-*` |
| `HomeScreen` card-style picker | `--cu-ink-raised`, `--cu-ink-line`, `--cu-ochre` (chosen), `--cu-iris` (focus), `--cu-pearl`, `--cu-muted`, `--cu-tap-min`, `--cu-radius-control`, `--cu-text-sm`, `--cu-text-md` |

The vector theme reads colour and index tokens but never the `--cuttle-card-*` geometry tokens (§5.6 rule 2).

## 12. Not decided here

- Bitmap art, the table skin (`CardTheme.Table`), the card-back illustration, the court-card treatment and any mascot: R21–R23. Nothing above depends on them; an art theme must honour §7's state recipes over its own pixels. (Mythic faces added 2026-09-28, round 8 themes, see §2; the back, the playmat and any mascot are still open.)
- App icon and splash.
- Result-screen celebration beyond a static layout. (The static layout gained a "Final score" line and a quiet Home button beside Rematch, W25, merged `b8238db`.)
