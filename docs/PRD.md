# Cuttle Web — Product Requirements Document

**Status:** Draft for David's review
**Date:** 2026-08-23
**Parent project:** [Cuttle engine](https://github.com/ApisMellow/cuttle) (`github.com/ApisMellow/cuttle`)
**This repo:** `ApisMellow/cuttle-web` — a graphical, mobile-first web version of Cuttle for two human players.

---

## 1. Vision

Two people share one phone and play a full game of Cuttle with a clean, touch-first graphical board — no rules knowledge enforced by the humans, because the engine only ever offers legal moves. Version 1 is pass-and-play on a single device. Version 2 (designed-ahead, not built in v1) lets two phones join the same game via a room code. No AI opponent, no accounts, no native app.

## 2. Context: what already exists

The Go engine in `cuttle` is a pure, well-tested state machine:

- `engine.LegalMoves(GameState) []Move` — every legal move in the current state
- `engine.Apply(GameState, Move) (GameState, error)` — immutable state transition
- `Move.Describe(GameState) string` — human-readable move label
- `engine.PointTotal`, `engine.Threshold`, `engine.HasWon` — scoring helpers
- Pending-state model: counters (2s), forced discards (4s), and seven-reveals are represented as engine states in which a specific player owns the next decision

`RULES.md` in that repo is the authoritative rules document. **The engine is canon.** The web UI implements zero game rules; every rule question is answered by the engine's output.

## 3. Goals

- **G1.** A complete, legal game of Cuttle is playable start-to-win by two humans on one phone.
- **G2.** Hidden information stays hidden: a full-curtain handoff model means a player's hand is only ever on screen when that player holds the phone.
- **G3.** The UI is mobile-first and finger-friendly: portrait phone layout is the primary design target, desktop browser is a functioning afterthought.
- **G4.** The architecture leaves v2 (two-device rooms) as a transport swap, not a rewrite.
- **G5.** The whole app works offline after first load (PWA), because v1 needs no server round-trips.

## 4. Non-goals (v1)

- No AI player.
- No accounts, auth, or server-side persistence.
- No matchmaking or public games.
- No native app (the stack must keep a Capacitor/TWA door open, nothing more).
- ~~No bitmap/generated card art — card faces are clean vector/CSS/SVG. (A generated-art theme layer — table background, card backs, cuttlefish mascot — is a v2+ candidate.)~~ *Superseded 2026-08-23 — see §10 Amendment A-1. Vector/SVG faces remain the functional baseline; generated art is now in scope as a theme layer built by its own loop phase.*
- No tutorial or guided hints — a rules reference screen only.
- No persistent match history — the win tally lives only for the browser session.

## 5. Architecture decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| A1 | **Engine compiled to WASM with standard Go** (not TinyGo, not a TS port). Runs fully client-side in v1. | Reuses the tested engine verbatim; zero rule drift; offline-capable. TinyGo's reflect/JSON gaps aren't worth ~1 MB of savings on a cached asset. |
| A2 | **JSON contract as the seam.** The WASM bridge exposes four functions — `newGame(seed?)`, `legalMoves()`, `apply(moveIndex)`, `describe()` — passing JSON strings. The UI consumes an envelope: `{state, legalMoves[], descriptions[]}`. | `GameState`/`Move` are exported fields; stdlib `encoding/json` marshals them cleanly. The identical envelope is what a v2 server sends over WebSocket. |
| A3 | **Move selection by index.** The client never constructs a `Move`; it submits an index into the engine-provided legal-move list. | Illegal moves are unrepresentable. In v2, stale/illegal submissions are rejected by construction (`{seq, moveIndex}`). |
| A4 | **Frontend: Svelte 5 + TypeScript + Vite + vite-plugin-pwa. DOM/CSS/SVG rendering — no canvas.** | ~25 board elements; CSS transforms give 60fps card animation free; SVG faces are crisp at any DPI; Playwright gets real selectors (the autonomous playtest judge depends on this). Pin the official Svelte 5 LLM docs file in the repo for dev-agent reliability. |
| A5 | **Packaging: single Go binary serving the built frontend via `embed.FS`.** Local dev and production are the same binary. | One deployment unit for the project's whole life; v2 adds WebSocket handlers to the same binary. |
| A6 | **Hosting: Fly.io**, shared-cpu-1x with auto-stop/auto-start machines (≪ $2/mo; ~300 ms–2 s wake). Deploy-on-push via GitHub Action. | Replit needs a $15/mo VM for WebSockets; Render free tier's 30–60 s cold start ruins the join flow. |
| A7 | **Engine imported as a published Go module dependency**, `github.com/ApisMellow/cuttle` (repo renamed to match the module path — §10 A-2), pinned at `v0.2.0` with no committed `replace` directive. Engine fixes land in the engine repo. | Clean separation; the terminal project stays the single home of the rules. |

## 6. V1 functional requirements

Each requirement below becomes one or more entries in the implementation loop's `requirements.yaml` ledger with machine-checkable acceptance criteria (see `docs/loop-workflow.md`). IDs are stable — reference them everywhere.

### 6.1 Game lifecycle

- **R1 — New game.** From the home screen, start a new game: shuffled 52-card deck, dealer alternates between games (first game: random), non-dealer gets 5 cards and goes first, dealer gets 6. Player names entered once per session (default "Player 1"/"Player 2").
- **R2 — Win and stalemate.** Win detection, threshold display (21, lowered by Kings: 14/10/7/5), and three-consecutive-passes stalemate are all engine-driven. A win/stalemate screen names the result.
- **R3 — Rematch + session tally.** The end screen offers Rematch (dealer alternates) and shows a session win tally (e.g., "Alice 2 – Blake 1"). The tally does not survive a page reload.
- **R4 — Resume in-progress game.** Reloading the page mid-game restores the current game (state snapshot in `localStorage`). A "New game" action from the menu abandons it after a confirm.

### 6.2 Board and information display

- **R5 — Board layout (portrait phone).** One screen shows: opponent's hand (card backs + count), opponent's permanents and point cards, the deck (count) and scrap pile between the fields, the active player's permanents and point cards, and the active player's hand (face up). Both players' current point totals and win thresholds are always visible.
- **R6 — Scrap pile is public.** Tapping the scrap pile opens a browsable list of every card in it, at any time, for whoever holds the phone.
- **R7 — Glasses-8 visibility.** If the active player has a glasses-8 in play, the opponent's hand renders face-up for them. (Redacted-view rules: a player's screen may show their own hand, opponent hand only under glasses-8, opponent hand *count* always, scrap always, deck count but never deck order, and both fields always.)
- **R8 — Frozen-card marker.** A card returned to hand by a 9 shows a visible "frozen" marker while it is unplayable, on its owner's screen.

### 6.3 Move interaction

- **R9 — Tap-to-play with legal-target highlighting.** Tapping a card in hand highlights every legal play for it (derived from the engine's legal-move list): play-as-points zone, scuttle targets, permanent zone, one-off action, Jack steal targets, 2-scrap targets. Tapping a highlighted target stages the move; a confirm control commits it. Cards with no legal play render dimmed but still inspectable.
- **R10 — Draw and pass.** Drawing (when legal) is a tap on the deck; when the only legal action is pass, a Pass control appears.
- **R11 — Every legal move reachable, only legal moves reachable.** The UI's reachable actions correspond 1:1 with `LegalMoves` output — verified by an invariant test that walks scripted games comparing UI-offered actions to engine output. Ambiguous taps (e.g., an 8 that could be points or glasses) resolve with an explicit chooser. *(Clarified 2026-09-28, David: when the candidates land on different zones or targets — the 8, the Ace — the zone or target the card is dropped or tapped on resolves the move, with no chooser. David prefers implicit actions to extra prompts; the chooser is only the backstop for residue geometry can't separate. See SPEC §6.4 and ledger R11.3.)*
- **R12 — Misclick protection.** Committing a move always requires the stage-then-confirm step of R9. No accidental single-tap ever applies a move.

### 6.4 Curtain handoff (privacy model)

- **R13 — Curtain on actor change.** Whenever the player who owns the next decision changes (turn end, counter window, 4-discard, or any engine pending state that hands the decision across), the screen drops to a curtain: "Pass the phone to ⟨name⟩," revealing nothing. The next player taps and holds (or taps through a two-step reveal) to see their view.
- **R14 — Counter window without information leak.** Every counterable one-off triggers an acknowledgment curtain to the opponent — even when they hold no 2. Their private screen shows the played one-off and either "Counter with ⟨2♦⟩ / Let it resolve" or only "Let it resolve." The acting player therefore cannot distinguish "couldn't counter" from "chose not to." Counter chains (2s countering 2s) repeat the curtain per decision. *(Spec note: if the engine auto-resolves when no counter exists, the acknowledgment screen is pure presentation — verify engine behavior during spec-writing.)*
- **R15 — Four-discard handoff.** Resolving a 4 curtains to the opponent, who picks their discards on their own screen; then curtains back.
- **R16 — Seven-reveal privacy.** A 7's two revealed cards appear only on the acting player's screen; the returned card's identity is not shown again to either player.

### 6.5 App shell

- **R17 — Rules screen.** A formatted, scrollable rules reference (content from the engine repo's `RULES.md`), reachable from the menu at any time without disturbing the game.
- **R18 — PWA / offline.** Installable (manifest + icons); after first load the app — including the WASM engine — works fully offline via service-worker precache. WASM asset budget: ≤ 1.5 MB compressed.
- **R19 — Mobile-first quality bar.** Primary target: portrait phones, ~~360–430 px CSS width~~ iPhone 15 or larger, 393×852 primary (§10 amendment A-5, 2026-09-28). All tap targets ≥ 44 px. No horizontal scroll. Card animations (draw, play, scuttle-to-scrap, Jack steal) run as CSS-transform transitions; the game remains fully playable if animations are disabled (`prefers-reduced-motion` respected).
- **R20 — Game event feedback.** The last move's description (`Move.Describe`) is displayed after each action (e.g., "Blake scuttled 7♥ with 9♠"), so the incoming player can see what happened while they were curtained — shown on their post-curtain screen as a short "while you were away" recap of moves since their last look.

## 7. V2 design-ahead (not built in v1, but v1 leaves the slots open)

- **Transport:** WebSocket per client to the same Go binary. Server runs `LegalMoves`/`Apply`; clients receive redacted views (per R7's redaction rules) plus the legal-move envelope; clients submit `{seq, moveIndex}`.
- **Rooms:** in-memory `code → {GameState, [2]playerToken, seq}`; 4-char Crockford-base32 codes; join by typed code or QR encoding `https://…/join/CODE`; rooms GC after ~1 h idle; no database.
- **Reconnect:** client persists `{roomCode, playerToken, seq}` in `localStorage`; reconnect re-sends the full redacted view (full-state resync always — never diff at this scale).
- **V1 obligations to v2:** the UI consumes only the envelope + redacted views (never reaches into full state for opponent info), and move submission is index-based. Both are already required by A2/A3/R7.

## 8. Success criteria (v1 done)

- Two humans who know Cuttle can play complete games on one phone comfortably — including counter chains, Jack steals under Queen protection, seven-reveals, and stalemates — with hidden information actually hidden.
- Every requirement R1–R20 is `verified` in the requirements ledger with attached evidence (test run or judged playtest screenshots).
- A full scripted game and a final agent-driven playtest (start → win, phone viewport) pass.
- The app deploys as one Fly.io binary and installs as a PWA on a real phone.

## 9. Risks and mitigations

- **WASM bridge friction** (Go↔JS lifecycle, `wasm_exec.js` glue): mitigate by building the bridge + envelope contract as the loop's first milestone, with a headless smoke test that plays a full random game through the WASM build in Node.
- **Art-style drift across a 53-asset fan-out** (P-ART): mitigate by the style-lock gate — nothing fans out until the reference set is human-approved, every generation is conditioned on the locked references, and a consistency judge scores each asset against the lock before it counts.
- **Svelte 5 agent drift** (runes vs legacy syntax): pin Svelte 5 LLM docs in-repo; judge gate includes `svelte-check`.
- **Curtain UX tedium:** the curtain flow is required for correctness but must not feel like a chore — R20's recap and a fast tap-through are the mitigation; the playtest judge explicitly scores handoff friction.
- **Engine pending-state assumptions:** R14's spec note; the spec session must enumerate the engine's actual pending states before requirements are finalized.

## 10. Amendments

Amendments record post-P0 decisions by David. Requirement IDs stay stable; amendments only add or supersede.

### A-1 — Generated card art in scope, as its own loop phase (2026-08-23, David)

The §4 non-goal "no bitmap/generated card art" is superseded. Generated art for the cards is part of the project, built by a **dedicated loop phase (P-ART, defined in `docs/loop-workflow.md` §11)** because the work is massively parallel once a reference style is locked: a small reference set is generated first, approved by the agent coordinator **and a supervisory human (David)**, and only then does the full-deck generation fan out.

Constraints preserved from the original decision:

- **Vector/SVG/CSS card faces remain the functional baseline** (A4, R19). The game is complete and playable with no bitmap art at all.
- **Generated art is a theme layer** — a swappable skin over the baseline renderer, never a dependency of game logic or of any R1–R20 acceptance criterion.

New requirements (decomposed into ledger entries like R1–R20):

- **R21 — Art direction & style lock.** An art-direction brief and reference set exist: card-face template (layout, rank/suit indices, legibility at in-game size), one court-card sample, card back, table background, and mascot candidate. The reference set is approved by the agent coordinator and by David (explicit human gate). The approved set plus a written style-lock document become the conditioning inputs for all subsequent generation.
- **R22 — Full-deck generation.** All 52 card faces plus card back (and approved auxiliary assets) are generated against the style lock in parallel batches; every asset passes a consistency judge scoring against the lock; regeneration on failure. The complete theme meets an asset budget of ≤ 4 MB compressed, loaded lazily so R18's first-load/offline budget is unaffected.
- **R23 — Theme-layer integration.** The art theme is wired behind the theme seam defined in `docs/SPEC.md`: user-facing toggle, automatic fallback to the SVG baseline if assets are missing or fail to load, and full playability with the theme off. Default theme state is David's call at ship time.

### A-2 — A7 module-path correction (2026-08-23, factual; resolved 2026-09-26)

A7 originally named the engine module as `github.com/ApisMellow/Cuttle-card-game` (the repo name). The actual module path per the engine's `go.mod` is **`github.com/ApisMellow/cuttle`**. **Resolved 2026-09-26 (SPEC §8 OQ-3):** the engine repo was renamed to `github.com/ApisMellow/cuttle` to match its module path and tagged `v0.1.0`/`v0.2.0`; `cuttle-web` requires `v0.2.0` directly with no committed `replace` directive. A temporary local `replace` is fine for engine development but must never be committed.

### A-3 — Mythic theme (2026-09-28, David)

A second, optional look for the cards: the **Mythic theme**, in the vein of Magic: The Gathering. Cuttle already plays a lot like Magic minus the card buying, so the art leans into that instead of inventing a new idiom.

- **Point cards (A–10 played for points) are creatures.** Together they make up the score (name still open — "life" or similar). Scuttling a smaller point card with a bigger one is creature combat.
- **Royals and face-up 8s are enchantments** (permanents that stay on the table).
- Every other one-off echoes a well-known Magic card, evoking its mood/color/composition without copying it:

| Card | Cuttle effect | Magic echo |
|---|---|---|
| A | Wipes every point card | Wrath of God |
| 2 | Cancels a spell / destroys an enchantment | Counterspell / Disenchant |
| 3 | Returns a card from the scrap pile | Regrowth / Raise Dead |
| 4 | Opponent discards 2 | Mind Rot |
| 5 | Draw cards | Divination |
| 6 | Destroys every enchantment | Tranquility |
| 7 | Plays the top card of the deck | Future Sight |
| 8 (face-up) | Opponent's hand shown | Telepathy |
| 9 | Returns an enchantment to its owner's hand | Boomerang / Unsummon |
| 10 | Points only — the biggest creature | — |
| Jack | Steals an opponent's creature | Control Magic |
| Queen | Protects other cards from targeting | a protective aura |
| King | Lowers the win threshold | a crown or throne |

**Suits become colors** — a first proposal, not final: Spades black, Hearts red, Clubs green, Diamonds white. Open question for David: Counterspell is iconically blue, and none of the four suit colors above is blue; resolving whether Diamonds becomes blue, a card's color follows what it does rather than its suit, or blue stays an accent only is still pending.

Rank and suit fade into the background of the art; the card reads by its evocative image rather than its printed corner indices.

**One layout rule binds both themes:** a Jack stacked on a stolen point card is the same size as the card, offset downward only, and never covers below the corner index's height, so a card's identity (rank and suit) lives in the upper-left corner index regardless of theme *(amended 2026-09-28, David, after a build screenshot)* — see `docs/design.md` §6–§7.

Delivered under **R21–R23** (amendment A-1) as a theme layer on top of the vector baseline. No R1–R20 acceptance criterion depends on it, and this amendment adds no new R numbers.

### A-4 — Family beta (2026-09-28, David)

Target: a playable browser build for a first family beta in about 2 days.

- **Pass-and-play on one shared phone** — the v1 design already in §6, unchanged.
- **Plain vector cards.** The Mythic theme (A-3) is included only if its style lock is approved in time; the vector baseline (§4, R19) remains the fallback either way.
- **Hosting is a static host**, since v1 has no server for the beta build. David decided on **GitHub Pages**, with both repos made public on 2026-09-28 (Pages on a private repo needs a paid plan). This amends §8's "deploys as one Fly.io binary" for the beta specifically — A5/A6 stand as the eventual v1 architecture.
- **Two-phone online play stays the v2 design in §7**, unbuilt for the beta. A DigitalOcean VM is the likely host for that later, superseding A6's Fly.io pick as the v2-era assumption.
- **The testing policy in `docs/loop-workflow.md` §4.5** (strict tier for game rules/privacy/save-resume, light tier for look-and-layout) applies to all beta work.
- **Sample player names are Alice and Blake** in every fixture, test, scenario and doc example (the repos are public).
- **The Mythic theme (A-3) is a separate art thread.** It doesn't block the beta; if its style lock isn't approved in time, the beta ships on vector cards.
- **Target devices are set by A-5** (iPhone 15 or larger).

This amendment adds no new R numbers; it sets the beta's scope and hosting path without changing R1–R23's acceptance criteria.

### A-5 — Target devices (2026-09-28, David)

Every player's phone is an **iPhone 15 or larger**. This replaces R19's "360–430 px CSS width" and drops the 360×740 compact target entirely.

- **Primary viewport: 393×852 CSS points** (iPhone 15 / 15 Pro / 16). Also supported: **430×932** (the Plus / Pro Max size).
- **Safe areas are respected.** The Dynamic Island takes about 59 pt at the top and the home indicator about 34 pt at the bottom. The page sets `viewport-fit=cover` and pads with `env(safe-area-inset-*)`, so no control or card index sits under either.
- **Mobile Safari with its toolbars showing leaves a shorter visible area, down to about 393×660.** There the hand and the action bar must stay fully visible; only the board region above them may scroll. The page itself never scrolls horizontally.
- **The 360×740 compact target is dropped.** Nothing is sized, tested or judged against it any more (`docs/design.md` §5, §6, §10; ledger R19.1, R19.5).
- A design pass for these screens is in progress. Token values for the new targets are **tuned in the iPhone design pass**; until it lands, the 390×844 Playwright viewport stays in use as a slightly smaller stand-in for 393×852.

This amendment adds no new R numbers; it retargets R19 (and the viewport named in R5/R19 judge criteria) and adds ledger item R19.5.
