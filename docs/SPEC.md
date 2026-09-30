# Cuttle Web — Technical Specification

**Status:** P1 output — binding for the loop
**Date:** 2026-08-23
**Companions:** `docs/PRD.md` (requirements R1–R20, architecture A1–A7), `docs/loop-workflow.md` (the loop that consumes this spec)
**Engine under test:** `github.com/ApisMellow/cuttle` v0.2.1, Go 1.25.2

---

## 1. Overview and scope

### 1.1 What this document is

This is the implementation contract for Cuttle Web v1. A developer agent with no conversation context implements from this file plus the PRD. Every behavioral claim below is cited to a PRD requirement ID (`R1`–`R20`, `A1`–`A7`) or to engine source as `file:line`.

The governing principle from PRD §2 is absolute and repeated here because every section depends on it:

> **The engine is canon. The web UI implements zero game rules.** Every rule question — what is legal, what a move does, who decides next, who won — is answered by engine output. The UI derives presentation from engine state and never computes a rule.

Where this spec says "the UI must not compute X," it means X is available from the engine and recomputing it in TypeScript is a contract violation that code review must reject.

### 1.2 Phase split

| Phase | Owner | Output |
|---|---|---|
| **P1a** | this document | `docs/SPEC.md` — the technical contract |
| **P1b** | Claude developer agents (Sonnet and Opus, dispatched by an Opus manager), own feature branch | Walking skeleton: repo scaffold (Vite + Svelte 5 + Go WASM build + Playwright + CI script), the WASM bridge, and the test harness described in §7. **Test authoring is P1b's job.** §7 defines *what* the tests are; P1b writes the code. |
| **P-ART** | separate loop phase (`loop-workflow.md` §11) | Generated bitmap card art (PRD R21–R23), consumed through the theme seam defined in §5.6. **Not a dependency of R1–R20**; the game is complete and shippable with no bitmap art at all (PRD §10 amendment A-1). |
| **P2** | loop orchestrator | Feature implementation against this spec, per `docs/loop-workflow.md` §5. |

P1a writes **no application code, no test code, no scaffolding.**

### 1.3 Repository layout (binding for P1b)

```
cuttle-web/
  go.mod                        # module github.com/ApisMellow/cuttle-web
  main.go                       # A5: single binary, embed.FS serving web/dist
  internal/game/                # importable bridge logic (two-phone W1, 2026-09-29)
    bridge.go                   # held session, the seven calls (§2.4)
    envelope.go                 # wire types, §2.8 normalization, §2.9 errors
    deal.go                     # bridge-side dealing (§2.6)
    view.go                     # bridge-side redaction (§3)
  internal/wasm/                # NOT built into the server binary
    main.go                     # //go:build js && wasm — the syscall/js shim over internal/game (§2)
  web/
    src/
      lib/bridge/               # TS side of the bridge boundary (§5.4)
      lib/stores/               # runes-based state (§5.3)
      lib/components/           # Svelte 5 components (§5.2)
      lib/theme/                # card-face theme seam (§5.6)
      routes/                   # Home / Game / Rules / Result
    static/
      cuttle.wasm               # build artifact
      wasm_exec.js              # copied from GOROOT at build time (§2.2)
    tests/
      unit/                     # vitest
      e2e/                      # Playwright
      scenarios/                # §7.3 scenario files — shared by all layers
    vite.config.ts
  scripts/build-wasm.sh
  docs/
```

### 1.4 Terminology

- **Actor** / **decider** — the player who owns the next decision. Formally `state.Active`; see §4.1 for why that identity is exact.
- **Viewer** — the player currently holding the phone, whose redacted view is on screen. Usually equals the actor, but diverges during the curtain and the reveal gate.
- **Envelope** — the JSON object returned by every bridge call (§2.7).
- **Curtain** — the full-screen privacy handoff of R13.
- **Affordance** — a tappable UI element that maps to one or more engine legal moves (§6).

---

## 2. WASM bridge contract

### 2.1 Correction to PRD A7 — the module path

PRD A7 originally named the engine dependency `github.com/ApisMellow/Cuttle-card-game`. **That was not the module path.** `go.mod:1` declares:

```
module github.com/ApisMellow/cuttle
```

All imports are therefore:

```go
import (
    "github.com/ApisMellow/cuttle/card"
    "github.com/ApisMellow/cuttle/engine"
)
```

**Resolved 2026-09-26 (OQ-3, §8): the engine repo was renamed to `github.com/ApisMellow/cuttle`**, matching its module declaration, and is tagged `v0.1.0` (787bbf5), `v0.2.0` (e4f91b8) and `v0.2.1` (latest, pinned). `cuttle-web/go.mod` requires the published module directly:

```
require github.com/ApisMellow/cuttle v0.2.1
```

No `replace` directive is committed. A temporary local `replace` is fine for engine development but must never land in a commit.

### 2.2 Toolchain, build, and measured budget

Build target and command (P1b implements `scripts/build-wasm.sh`):

```sh
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/static/cuttle.wasm ./internal/wasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" web/static/wasm_exec.js
```

**`wasm_exec.js` lives at `$(go env GOROOT)/lib/wasm/wasm_exec.js`** as of Go 1.24+. Pre-1.24 documentation says `misc/wasm/` — that path is gone (verified: `$(go env GOROOT)/misc/wasm/` contains only `wasm_exec.html`). Never vendor a copy from the internet; `wasm_exec.js` must match the Go version that compiled the `.wasm`, so it is copied from GOROOT at build time and gitignored.

Measured on this toolchain (Go 1.25.2, darwin/arm64 host, `js/wasm` target) with a minimal bridge importing `engine` + `encoding/json` + `syscall/js`:

| Build | Raw | gzip -9 |
|---|---|---|
| default | 2,996,481 B (2.86 MiB) | 842,720 B (823 KiB) |
| `-ldflags="-s -w"` | 2,935,851 B (2.80 MiB) | 825,004 B (806 KiB) |

**R18's ≤ 1.5 MB compressed budget is met with ~45% headroom** at 806 KiB gzipped. A1's premise (standard Go, not TinyGo) is confirmed viable. The real build will be somewhat larger than this probe; the acceptance criterion in §7 gates on the measured artifact, not on this number.

Two deployment consequences the developer must not miss:

1. **Serve the `.wasm` with `Content-Encoding: gzip` or `br`.** The 2.8 MiB raw figure is what crosses the wire otherwise. The Go server (A5) must negotiate encoding for `.wasm`, and `Content-Type` must be `application/wasm` or `WebAssembly.instantiateStreaming` falls back to a slower path with a console warning.
2. **Workbox's default `maximumFileSizeToCacheInBytes` is 2 MiB.** The raw 2.8 MiB `.wasm` is *silently skipped* by precache at that default, which breaks R18 offline with no build error. See §5.8.

### 2.3 Load and readiness lifecycle

The bridge is a Go program whose `main` registers JS globals and then blocks forever on `select {}`. If `main` returns, the Go runtime tears down and every registered function throws. This is the single most common Go/WASM bridge defect and the smoke test in §7.2 exists partly to catch it.

Required sequence, implemented once in `lib/bridge/wasm.ts`:

```ts
// lib/bridge/wasm.ts
let readyPromise: Promise<void> | null = null;

export function ensureEngine(): Promise<void> {
  if (readyPromise) return readyPromise;          // idempotent; never load twice
  readyPromise = (async () => {
    await import('/wasm_exec.js');                // defines globalThis.Go
    const go = new (globalThis as any).Go();
    const result = await WebAssembly.instantiateStreaming(
      fetch('/cuttle.wasm'), go.importObject,
    );
    // Do NOT await go.run — it resolves only when the Go program exits.
    void go.run(result.instance);
    await whenGlobalDefined('__cuttleReady');     // poll rAF for the readiness flag
  })();
  return readyPromise;
}
```

Go side, last statements of `main`:

```go
func main() {
    registerBridgeFunctions()          // sets js.Global() entries
    js.Global().Set("__cuttleReady", js.ValueOf(true))
    select {}                          // block forever — MUST be last
}
```

Rules:

- `ensureEngine()` is called exactly once, from the app-shell root, before any route renders game UI. It is memoized; concurrent callers share one promise.
- Until it resolves the UI shows a loading state. On rejection it shows a hard-fail screen with the error — never a blank board.
- No component calls a `__cuttle*` global directly. All calls go through `lib/bridge/engine.ts` (§5.4).
- `WebAssembly.instantiateStreaming` requires the correct MIME type. The dev server (Vite) and the production Go server must both set `application/wasm`.
- **Engine URLs carry a content token** *(added 2026-09-28, R10, deploy safety)*. `wasm_exec.js` and `cuttle.wasm` keep fixed names in publicDir, while the app JS is content-hashed. Both are fetched as `${BASE_URL}<name>?v=<token>` (`engineAssetUrl` in `lib/bridge/wasm.ts`), where the token is the first 16 hex digits of a SHA-256 over `wasm_exec.js` then `cuttle.wasm`, computed when `vite.config.ts` loads and injected as the `__CUTTLE_ENGINE_VERSION__` define (`'dev'` if the files don't exist yet). The wasm must therefore be built before `vite build` or the dev server starts, which `scripts/ci.sh` and the Pages workflow already do. A deploy that changes the engine changes both URLs, so a browser can't pair a cached old engine with new JS (which would fail §5.4 validation on every view, e.g. a new required field such as `you.watched`). The two files share one token because `wasm_exec.js` must match the Go version that built the `.wasm`.

### 2.4 Function surface

A2 locks four functions. Three additional read-only/persistence functions are required because R4 (resume) and R13 (curtain) cannot be satisfied by the four alone — the curtain must render the *incoming* player's view before that player becomes the viewer, and `localStorage` restore needs full state, which a redacted view by definition cannot provide. Flagged as **OQ-4**.

All functions take and return **JSON strings** (A2). None take or return objects; `syscall/js` object marshalling is avoided entirely.

| Global | Args | Returns | Mutates state |
|---|---|---|---|
| `__cuttleNewGame(optsJson)` | `NewGameOpts` | `Envelope` | yes — replaces held state |
| `__cuttleLegalMoves()` | — | `Envelope` | no |
| `__cuttleApply(moveIndex)` | `number` | `Envelope` | yes |
| `__cuttleDescribe()` | — | `Envelope` | no |
| `__cuttleView(viewerId)` | `0 \| 1` | `Envelope` | no |
| `__cuttleSnapshot()` | — | `SnapshotJson` (full, unredacted) | no |
| `__cuttleRestore(snapshotJson, viewerId)` | `SnapshotJson, 0 \| 1` | `Envelope` | yes |

**Bridge owns the state.** The Go side holds one package-level `engine.GameState` plus the move history. The TypeScript side never holds a `GameState` and never constructs a `Move` (A3). In two-phone play the same envelope arrives over a WebSocket from the server's copy of exactly this code (`internal/game`, §2.11). *(Amended 2026-09-29.)* That is not a pure transport swap: the online store is async and receives pushed states, so online play gets its own store behind the `TableSource` seam (W10, `web/src/lib/stores/tableSource.ts`), and the wire protocol around the envelope is §2.12.

`__cuttleApply` takes an **index into the legal-move list of the current state** (A3). The bridge recomputes `engine.LegalMoves(state)` and bounds-checks the index. An out-of-range index is an error, not a panic. Illegal moves are unrepresentable because the client can only name a position in a list the engine produced.

**Which viewer each call returns** *(amended 2026-09-26)*. `__cuttleApply` returns the envelope for the **pre-apply `Active`** (the mover). After the curtain reveal the UI fetches the incoming actor's envelope with `__cuttleView(newActor)` (§3.3 rule 4). `__cuttleNewGame` returns the envelope for the first actor (`state.Active` after the deal). *(Amended 2026-09-28, W25 playtest fixes, merged `b8238db`.)* The player who taps "New game" is not necessarily the first actor, so the game store drops that envelope unread, raises an opening curtain to the first actor (§4.2), and fetches their view with `__cuttleView(first)` once they pass the reveal gate. This replaces the earlier rule that whoever starts the game is the first player and gets no opening curtain. `__cuttleRestore(snapshotJson, viewerId)` returns the envelope for `viewerId`; TS passes its persisted `Snapshot.viewer` (§5.7) and puts the persisted curtain back up before rendering (R4.2); at a saved board or counter window it raises the resume gate instead and drops this envelope unread (§5.7, ruling 2026-09-29). A `viewerId` that isn't exactly 0 or 1 is `BAD_REQUEST`, and the held state is unchanged. `__cuttleLegalMoves` and `__cuttleDescribe` return the envelope for `state.Active`, and `__cuttleView(p)` returns `p`'s. No mutating call returns the view of a player who is not holding the phone.

### 2.5 Enum values, pinned from source

Every enum crosses the wire as a **plain JSON number** — the Go types are `uint8`-based with no `MarshalJSON` and no string tags. These tables are the authoritative TypeScript mirror. A developer who guesses these values will produce a subtly wrong UI that still compiles.

**`Phase`** — `engine/state.go:60-68`. Exhaustive; `LegalMoves` branches on `Phase` first (`engine/apply.go:15-31`).

| Value | Go constant | Decider | Meaning |
|---|---|---|---|
| `0` | `PhaseNormal` | `Active` | ordinary turn |
| `1` | `PhaseAwaitingCounter` | `Active` (the non-playing player) | a one-off is pending; counter or decline |
| `2` | `PhaseSevenChoosing` | `Active` (the player who played the 7) | pick one of the revealed cards and a play for it |
| `3` | `PhaseAwaitingDiscard` | `Active` (the opponent of the 4's player) | choose discards |
| `4` | `PhaseGameOver` | nobody | `LegalMoves` returns `nil` (`engine/apply.go:16-18`) |

**`MoveKind`** — `engine/moves.go:9-22`.

| Value | Constant | Value | Constant |
|---|---|---|---|
| `0` | `MoveDraw` | `5` | `MoveCounter` |
| `1` | `MovePlayPoint` | `6` | `MoveDecline` |
| `2` | `MovePlayPermanent` | `7` | `MoveSevenPick` |
| `3` | `MoveScuttle` | `8` | `MoveDiscardPair` |
| `4` | `MoveOneOff` | `9` | `MovePass` |

**`PlayerID`** — `engine/state.go:26-31`. `P1 = 0`, `P2 = 1`. `Other()` is `1 - p` (`state.go:33-35`).

**`TargetZone`** — `engine/state.go:70-75`. `ZonePoints = 0`, `ZonePermanents = 1`.

**`Suit`** — `card/card.go:5-12`. `Clubs = 0`, `Diamonds = 1`, `Hearts = 2`, `Spades = 3`. This ordering is also the **scuttle tiebreak order** (`card/card.go:51-56`, RULES.md §Legal Actions 3): equal rank, higher suit wins. The UI must render suits in this order wherever suits are ordered.

**`Rank`** — `card/card.go:18-34`. **Starts at 1, not 0.**

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | J | Q | K |

**Consequence: `Rank === 0` is the "no card" sentinel.** `Move.Card` is a value type, so a `MoveDraw` marshals as `"Card":{"Rank":0,"Suit":0}` — verified. The UI must treat `Rank === 0` as absent and must never render it as a card. The bridge normalizes this away (§2.8).

### 2.6 `newGame` — bridge-side dealing (R1, R3)

**The engine exports no `NewGame`, no deck constructor, no shuffle, and no seeding API.** Dealing exists only as unexported `newGame()` in `cmd/cuttle/main.go:47-67`, using the unseeded global `math/rand`. That code is not importable and is not deterministic.

**The bridge must implement dealing itself.** Engine modification is out of scope for this repo (`loop-workflow.md` §7); §8 **OQ-1** records it as an upstream contribution candidate.

```ts
interface NewGameOpts {
  seed?: string;        // decimal uint64 as a string; omitted => crypto-random
  dealer?: 0 | 1;       // omitted => random (R1: "first game: random")
  names?: [string, string];
}
```

`seed` is a **string**, not a number: uint64 seeds exceed `Number.MAX_SAFE_INTEGER` and JSON round-tripping through a JS number would silently corrupt scenarios. The Go side parses with `strconv.ParseUint(s, 10, 64)`.

Required algorithm — binding, because scenario reproducibility (§7.3) depends on every byte of it:

```go
// internal/game/deal.go
const dealStream = 0x9E3779B97F4A7C15 // fixed second PCG word; never vary it

func dealNewGame(seed uint64, dealer engine.PlayerID) engine.GameState {
    // 1. Build the deck in canonical order: suit-major (Clubs..Spades),
    //    rank-minor (Ace..King). Matches cmd/cuttle/main.go:48-53.
    deck := make([]card.Card, 0, 52)
    for s := card.Clubs; s <= card.Spades; s++ {
        for r := card.Ace; r <= card.King; r++ {
            deck = append(deck, card.Card{Rank: r, Suit: s})
        }
    }
    // 2. Seeded Fisher-Yates via math/rand/v2 PCG.
    rng := rand.New(rand.NewPCG(seed, dealStream))
    rng.Shuffle(len(deck), func(i, j int) { deck[i], deck[j] = deck[j], deck[i] })

    // 3. Deal: non-dealer 5 and goes first, dealer 6 (R1; RULES.md §Setup).
    nonDealer := dealer.Other()
    var st engine.GameState
    st.Players[nonDealer].Hand = append([]card.Card(nil), deck[0:5]...)
    st.Players[dealer].Hand    = append([]card.Card(nil), deck[5:11]...)
    st.Deck                    = append([]card.Card(nil), deck[11:]...)
    st.Active                  = nonDealer
    st.Phase                   = engine.PhaseNormal
    return st
}
```

Why `math/rand/v2`'s PCG rather than `math/rand`'s `NewSource`: PCG's output is a published, versioned specification, so a scenario seed produces the same deal on any Go version and any platform. The v1 `rand.NewSource` stream is a Go implementation detail. Scenarios are the backbone of the whole test strategy (§7.3); they must not drift under a Go upgrade.

**Golden scenario, verified against this exact algorithm:**

```
seed = "42", dealer = P2 (so P1 is non-dealer and goes first)
  P1 hand (5):  2♥ 3♣ A♥ K♦ Q♣
  P2 hand (6):  5♥ 9♥ 8♦ 4♦ 5♠ 4♥
  deck length:  41,  top 5: 2♣ 9♠ 9♦ J♥ 7♣
  Active:       0 (P1),  Phase: 0 (PhaseNormal)
  LegalMoves(): 7 moves —
    [0] draw a card
    [1] play 2♥ as point card
    [2] play 3♣ as point card
    [3] play A♥ as one-off
    [4] play A♥ as point card
    [5] play K♦ as permanent
    [6] play Q♣ as permanent
```

P1b must include this as the bridge smoke test's first assertion. Note what it already demonstrates for §6: the `A♥` at hand index 2 produces two moves in two different slots — the R11 case that zone geometry resolves with no chooser (§6.4; amended 2026-09-28, ApisMellow). The `2♥` produces only a point play, because 2-as-scrap requires a target and the board is empty.

**Dealer alternation (R1, R3)** is bridge-side but *driven by the client*: the bridge does not remember prior games. The session store (§5.3) holds `lastDealer` and passes `dealer: 1 - lastDealer` on rematch. First game of a session passes no `dealer`, getting a random one.

### 2.7 Envelope schema

Every bridge function returns one `Envelope`. A2 locks the shape `{state, legalMoves[], descriptions[]}`; the fields below add the metadata the UI provably needs, and `state` is a **redacted `PlayerView`**, not the raw `GameState` (§3, **OQ-5**).

```ts
// lib/bridge/types.ts — the complete wire contract.

export type PlayerId = 0 | 1;
export type Suit = 0 | 1 | 2 | 3;                       // ♣ ♦ ♥ ♠
export type Rank = 1|2|3|4|5|6|7|8|9|10|11|12|13;
export type Phase = 0 | 1 | 2 | 3 | 4;
export type MoveKind = 0|1|2|3|4|5|6|7|8|9;
export type TargetZone = 0 | 1;

export interface Card { Rank: Rank; Suit: Suit }

export interface Target { Owner: PlayerId; Zone: TargetZone; Index: number }

export interface PointEntry {
  Card: Card;
  Owner: PlayerId;          // ORIGINAL owner — see engine/state.go:3-22
  JackStack: Card[];        // bottom-up; [] when none
  JackOwners: PlayerId[];   // parallel to JackStack; [] when none
  Controller: PlayerId;     // DERIVED by the bridge from PointEntry.Controller()
}

export interface Move {
  Kind: MoveKind;
  Card: Card | null;        // NORMALIZED: null where the raw wire had Rank:0
  HandIndex: number;
  Target: Target | null;
  JackTarget: Target | null;
  ScrapIndex: number;
  DiscardA: number;
  DiscardB: number;         // -1 when the discarding hand holds exactly 1 card
  SubMove: Move | null;     // MoveSevenPick only; nesting is single-level
}

/** What one player's screen is allowed to consume. See §3. */
export interface PlayerView {
  viewer: PlayerId;
  active: PlayerId;                 // who owns the next decision
  phase: Phase;
  passesInARow: number;
  winner: PlayerId | null;
  stalemate: boolean;               // DERIVED: phase===4 && winner===null

  you: {
    hand: Card[];
    frozenHandIndices: number[];    // NORMALIZED from FrozenIDs (§2.8)
    points: PointEntry[];
    permanents: Card[];
    watched: boolean;               // DERIVED: the opponent has glasses, so their view carries this hand (§3.2; amended 2026-09-28, R10)
  };
  opponent: {
    handCount: number;              // always available (R7)
    hand: Card[] | null;            // NON-NULL ONLY under glasses-8 (R7); see §3.2
    points: PointEntry[];
    permanents: Card[];
  };

  deckCount: number;                // count only — order is NEVER transmitted (R7)
  scrap: Card[];                    // fully public (R6); index 0 = bottom

  /** Engine-computed. The UI must not recompute any of these. */
  scoreboard: {
    you:      { points: number; threshold: number; kings: number; hasWon: boolean };
    opponent: { points: number; threshold: number; kings: number; hasWon: boolean };
  };

  /** PhaseSevenChoosing only, and ONLY when viewer === active (R16). */
  sevenRevealed: Card[] | null;

  /** PhaseAwaitingCounter/PhaseSevenChoosing/PhaseAwaitingDiscard only. */
  pending: {
    playedBy: PlayerId;
    card: Card;                     // the one-off under consideration
    target: Target | null;
    counterChain: Card[];           // grows per counter link; [] at the first window
  } | null;
}

export interface AppliedMove {
  index?: number;                   // index into the PRE-state legal-move list; present only
                                     // when viewer === entry.by, else omitted (§3.2, amended 2026-09-26)
  by: PlayerId;                     // pre-state Active
  kind: MoveKind;
  card: Card | null;
  description: string;              // Move.Describe evaluated against the PRE-state
  seq: number;                      // 1-based, monotonic for the game
  subKind: MoveKind | null;         // SubMove.Kind for MoveSevenPick; null otherwise, and null for a dead-end SevenPick (engine scraps an unplayable reveal) (§2.8).
                                     // Public to both viewers. (amended 2026-09-26)
  targetCard: Card | null;          // the card the move targeted, read from the PRE-state: Scuttle's
                                     // Target, a Jack's JackTarget, a targeted OneOff's Target (2-as-scrap,
                                     // 9), and the same for a SevenPick's SubMove. null for every untargeted
                                     // move. Always a card on the board, so public to both viewers.
                                     // Needed by the §4.6 recap, because Describe omits the target for Jack
                                     // steals and one-offs. (amended 2026-09-27, ApisMellow)
  drawn: number | null;             // how many cards a 5 drew, on the entry whose apply RESOLVED the 5: the
                                     // 5's own entry when nobody could counter, else the Decline or Counter
                                     // that closed its chain with an even length (history is append-only, so
                                     // an earlier entry is never rewritten). The one who drew is the 5's
                                     // player (the chain origin's `by`). null on every other entry, including
                                     // a cancelled 5. A count only — never the drawn cards — and public to
                                     // both viewers (hand and deck counts are public, R7). Always present as
                                     // a key; restore rejects a missing key or a count on an entry that
                                     // resolved no 5. Read ONLY by the board's idle line (§4.6): the recap
                                     // and the counter prompt never read it (the prompt shows a 5 before it
                                     // resolves, §4.3). (amended 2026-09-28,
                                     // playtest friction)
}

export interface Envelope {
  ok: true;
  state: PlayerView;
  legalMoves: Move[];               // [] when viewer !== active, or at game over
  descriptions: string[];           // parallel to legalMoves; [] likewise
  lastMove: AppliedMove | null;     // the move that produced this state
  history: AppliedMove[];           // every applied move this game, oldest first
  seq: number;                      // === history.length
}

export interface EngineError {
  ok: false;
  code: 'ILLEGAL_MOVE' | 'INDEX_OUT_OF_RANGE' | 'BAD_REQUEST'
      | 'NO_GAME' | 'NO_LEGAL_MOVES' | 'INTERNAL';
  message: string;
  detail?: Record<string, unknown>;
}

export type BridgeResult = Envelope | EngineError;
```

**Which viewer each call returns** *(amended 2026-09-26)*: see §2.4. No mutating call returns the view of a player who is not holding the phone.

Invariants a reviewer checks:

- `legalMoves.length === descriptions.length`, always.
- `legalMoves` is non-empty whenever `state.phase !== 4` **and** `state.viewer === state.active` — **except** in the engine-defect case of §2.10, which is precisely why `NO_LEGAL_MOVES` exists as an error code.
- `descriptions[i]` is `legalMoves[i].Describe(currentState)` computed Go-side. The UI never builds a move description from a `Move` struct.
- `lastMove.description` is computed against the **pre**-state and frozen at apply time. Regenerating it later is wrong: `Move.Describe` for `MoveScuttle` dereferences `s.Players[Target.Owner].Points[Target.Index].Card` (`engine/moves.go:49-54`), and that index is stale the instant the move resolves. This is what makes the R20 recap correct.

### 2.8 Normalization rules — mandatory, Go-side

Raw `encoding/json` output of `engine.GameState` has four quirks. **All four are normalized in the Go bridge before the JSON leaves WASM**, so the TypeScript side gets a strict schema with no defensive parsing. Verified by marshalling real engine values.

**(a) `JackOwners` marshals as a base64 string, not an array.** This is the dangerous one.

`PlayerID` is `uint8` (`engine/state.go:26`), so `[]PlayerID` is `[]byte` as far as `encoding/json` is concerned, and the encoder base64-encodes it. Verified:

```json
{"Card":{"Rank":10,"Suit":2},"Owner":0,
 "JackStack":[{"Rank":11,"Suit":0}],
 "JackOwners":"AQA="}
```

`"AQA="` is base64 for the bytes `[0x01, 0x00]` — i.e. `[P2, P1]`. A TypeScript client that types this as `PlayerId[]` compiles cleanly and is wrong at runtime for every Jack chain-steal. The bridge must emit `"JackOwners":[1,0]`. This has a dedicated unit test in §7.1.

**(b) Nil slices marshal as `null`, not `[]`.** `Hand`, `Points`, `Permanents`, `Deck`, `Scrap`, `JackStack`, `Revealed`, `CounterChain` are all `null` when nil. Verified against a zero-value `GameState`:

```json
{"Players":[{"Hand":null,"Points":null,"Permanents":null,"FrozenIDs":null},…],
 "Deck":null,"Scrap":null,"Active":0,"Phase":0,"Pending":null,
 "PassesInARow":0,"Winner":null}
```

**Decision: the bridge normalizes every nil slice to `[]`.** No array-typed field in `PlayerView`, `Move`, or `Envelope` is ever `null`. The TS types above encode that guarantee (`Card[]`, not `Card[] | null`) — with the single deliberate exception of `opponent.hand`, where `null` carries the semantic meaning "not visible to you" and must be distinguishable from `[]` meaning "visible and empty" (§3.2).

**(c) `FrozenIDs map[int]bool` marshals with string keys and is `null` when nil.** Verified: `"FrozenIDs":{"0":true}`. The bridge converts to a sorted `number[]` named `frozenHandIndices`, dropping `false` values. `null` becomes `[]`.

**(d) Pointer fields are `null` when absent** — `Pending`, `Winner`, `Target`, `JackTarget`, `SubMove`. Preserved as `null` in the TS types; that is already the correct representation. `Winner` marshals as a bare number when present (`"Winner":1`), not an object.

Two further normalizations the bridge performs:

**(e) `Move.Card` with `Rank === 0` becomes `null`.** `Move` is a value struct, so `MoveDraw`, `MovePass`, `MoveDecline`, and `MoveDiscardPair` all carry a zero `Card`. Verified: `{"Kind":0,"Card":{"Rank":0,"Suit":0},…}`. Rank 0 is not a card (`card/card.go:20-22` starts at `Ace = 1`), and `Rank.String()` panics on 0. Emitting `null` makes the "no card" case unrepresentable as a renderable value.

**(f) `PointEntry.Controller` is added.** `Controller()` is a method (`engine/state.go:46-51`), so it does not marshal. The bridge calls it and emits the result, because the UI needs it to render a stolen point card on the correct side with the correct ownership badge, and per the canon rule may not reimplement it.

### 2.9 Error shape and handling

Every bridge function returns either an `Envelope` (`ok: true`) or an `EngineError` (`ok: false`). **The bridge never throws across the WASM boundary and never panics.** A Go panic in WASM kills the runtime and every later call fails opaquely, so the bridge wraps each exported function body in `defer recover()` and converts a recovered panic into `{ok:false, code:'INTERNAL', message:…}`.

| Code | Raised when | UI response |
|---|---|---|
| `ILLEGAL_MOVE` | `engine.Apply` returned `ErrIllegalMove` (`engine/apply.go:9`) for a move that came out of `LegalMoves` | **Not recoverable by retry.** Show the stuck-state screen (§2.10). |
| `INDEX_OUT_OF_RANGE` | `moveIndex` outside `[0, len(legalMoves))` | UI bug. Log, refuse, keep prior state. |
| `NO_LEGAL_MOVES` | `LegalMoves` returned empty in a non-`PhaseGameOver` phase | Stuck-state screen (§2.10). |
| `NO_GAME` | a call arrived before `newGame`/`restore` | Route to the home screen. |
| `BAD_REQUEST` | malformed opts/snapshot JSON, unparseable seed | Home screen with a message. |
| `INTERNAL` | recovered panic | Stuck-state screen; include the message. |

On any `ok: false`, **the bridge's held state is unchanged.** `Apply` is already immutable on error (`engine/apply.go:138-142` clones first and returns the original `s` on every rejection path), so the bridge simply does not assign the result.

### 2.10 Engine-contract hazards — both real, both found empirically

A 4,000-game random-playout survey through the real engine (uniform-random selection from `LegalMoves`, mixed dealers and seeds) produced 3,825 wins, 101 stalemates (2.5%), and **74 games that broke the `LegalMoves`/`Apply` contract**. Both defects live in `PhaseSevenChoosing`. Both are engine-repo problems, out of scope here per `loop-workflow.md` §7; §8 carries them as **OQ-1** and both must be written to `docs/loop-log/engine-issues.md` at loop start so a stalled requirement can cite them.

**E-1 — a stale `FrozenIDs` index makes every offered `MoveSevenPick` illegal. 63/4000 games (~1.6%).**

`FrozenIDs` is keyed by **hand index** (`engine/state.go:57`), and `removeAt` never remaps those keys when a card leaves the hand (`engine/apply.go:752-757`). Meanwhile `legalForCard` blanks `FrozenIDs` in its scratch state before enumerating (`engine/apply.go:518-527`), but the real `Apply` injects the chosen card at `injectIdx = len(p.Hand)` against the *real* map (`engine/apply.go:439-445`) and the inner handlers reject on `p.FrozenIDs[m.HandIndex]`. When a stale key equals `injectIdx`, **every** move `LegalMoves` offers is rejected. Minimal reproduction, verified:

```
Hand [3♣, 4♣] (len 2), FrozenIDs {2:true} (stale — set by an earlier 9,
    hand has since shrunk), Phase=PhaseSevenChoosing, Revealed [5♥]
  LegalMoves() -> 2 moves
    "7: play 5♥ as one-off"     -> Apply: illegal move
    "7: play 5♥ as point card"  -> Apply: illegal move
```

The player is hard-stuck in a phase that *looks* playable. This is worse than a visible lock, which is why the UI needs the explicit handling below.

**E-2 — empty `LegalMoves` in `PhaseSevenChoosing`. 11/4000 games (~0.3%).**

When every revealed card is a Jack and the opponent has no stealable point (none on the board, or a Queen protecting them), the enumeration yields nothing: a Jack is not in the `Ace..Ten` point range, is not `Q/K/8`, and `legalForCard` filters out `MoveDraw`/`MovePass` (`engine/apply.go:531-542`). Verified minimal case — `Revealed [J♦, J♠]`, opponent holds no points → `LegalMoves` returns 0 moves with `Phase === 2` and `Winner === nil`.

**Required UI behavior (binding for P2).** The UI must not hang, must not silently retry, and must not present a dead board:

1. `PhaseGameOver` is the **only** phase in which an empty legal-move list is normal. Detect `phase !== 4 && legalMoves.length === 0` and raise `NO_LEGAL_MOVES`.
2. On `NO_LEGAL_MOVES` or `ILLEGAL_MOVE`, render a **stuck-state screen**: a plain statement that the game cannot continue, the current `seq`, the game's seed and dealer, the full `history` of applied-move descriptions, and a copy-to-clipboard button producing a scenario stanza (§7.3) that reproduces the position. Offer "New game" as the only forward action.
3. Never auto-retry an `ILLEGAL_MOVE`. It is deterministic — retrying loops forever.
4. The bridge smoke test (§7.2) asserts a **zero** occurrence rate across its seed corpus, so if the engine is later fixed the test tightens automatically; until then the corpus is chosen to exclude known-bad seeds and the exclusion list cites this section.

**Resolution note (2026-09-26):** both E-1 and E-2 are now fixed upstream in the engine, verified against the exact repros above at `engine/seven_test.go:209` (E-1) and `:242` (E-2), plus a green 500-game random playout. The smoke exclusion list (`web/tests/smoke/exclusions.json`) is expected to go away in P1b Batch 2; the diagnostic UI behavior above remains required as defense-in-depth.

Two smaller contract notes for the same reason:

- `MovePass` is emitted only as a fallback when nothing else is legal (`engine/apply.go:131-133`) and `Apply` re-checks that gate (`engine/apply.go:160-166`). The UI therefore never shows Pass alongside other actions — this is engine-enforced, not a UI policy (R10).
- Three consecutive passes set `PhaseGameOver` with `Winner === nil` (`engine/apply.go:167-171`). There is no `IsStalemate` helper; stalemate is exactly `phase === 4 && winner === null`, and the bridge exposes it as the derived `state.stalemate` (R2).

### 2.11 Typed Go API for the two-phone server *(added 2026-09-29, two-phone W2)*

`internal/game` exports a typed API next to the JSON `Bridge`, for `cmd/cuttle-server` (`docs/two-phone-plan.md` §4). Both run one core: the deal, `applyMove` (index to history entry, `targetCard`, `drawn`), `decodeSnapshot` (v1 upgrade and every §2.9 restore check) and `buildEnvelope`. The golden transcript (`internal/game/golden_test.go`) pins the Bridge's bytes, and `TestW2_TypedAPIMatchesBridge` shows the typed API emits the same bytes.

| Call | Returns | Notes |
|---|---|---|
| `NewSession(seed uint64, dealer Seat)` | `*Session, error` | `ErrBadSeat` unless the dealer is 0 or 1. The dealer's opponent acts first. The server draws seed and dealer from `crypto/rand`. |
| `RestoreSession(persisted []byte)` | `*Session, error` | Accepts `ServerSnapshot.PersistBytes()` or any v1/v2 `SnapshotJson`. Any defect is `ErrInvalidSnapshot`, with the Bridge's message. |
| `(*Session).Status()` | `Status` | `Seq`, `Actor`, `Phase`, `Over`, `Winner` (`NoSeat` = none), `Stalemate`, `Stuck` (§2.10). Public to both seats. |
| `(*Session).View(seat)` | `Envelope, error` | §2.7 envelope for `seat`, redacted per §3. Never `NO_LEGAL_MOVES`. |
| `(*Session).LegalMoves(seat)` | `[]MoveView, []string, error` | Filled only for the actor; `[]`, `[]` for the other seat and at game over. |
| `(*Session).Apply(seat, seq, index)` | `Update, error` | `Update.For(seat)` is that seat's envelope after the move. |
| `(*Session).Snapshot()` | `ServerSnapshot, error` | The full game, for the store only. |

**Seat binding.** `Apply` accepts only `seat == state.Active`: the player on turn, the responder at a counter window, the 4's discarder, the 7's player while choosing (the engine's `LegalMoves` is always `Active`'s, `engine/apply.go:15-33`; `Active` flips for a counter window at `:337` and for a discard at `:653`). The checks run in this order and every failure leaves the session unchanged: bad seat (`ErrBadSeat`, code `BAD_REQUEST`), game over (`GAME_OVER`), `seq` not the history length (`STALE`), wrong seat (`NOT_YOUR_TURN`), no legal move (`NO_LEGAL_MOVES`), index out of range (`INDEX_OUT_OF_RANGE`), engine rejection (`ILLEGAL_MOVE`). Errors are `*game.Error{Code, Message, Detail}`; match a kind with `errors.Is(err, game.ErrNotYourTurn)` and so on.

**Commit atomicity (§2.9).** `Apply` renders both seats' envelopes for the candidate state and only then commits. A render failure (a recovered panic) is `INTERNAL` and nothing changes. Every `Session` method recovers panics into `INTERNAL`.

**Output safety.** `Envelope` is the only type that satisfies `game.ClientSafe`; a server's send path should take that interface. `ServerSnapshot` holds hands, deck order and seed. `json.Marshal` and `MarshalText` on it fail with `ErrSnapshotNotForClients`, every `fmt` verb and `slog` print a fixed redacted marker, and its bytes come out only through `PersistBytes()`. Returned envelopes and `Update`s are deep copies that share no memory with the session.

**Concurrency.** A `Session` is not safe for concurrent use; the server serializes calls per room. Distinct sessions share no mutable state: the envelope renderer that tests swap is a per-instance field on `Session` and `Bridge`, not a package variable (`TestW2_ParallelSessionsShareNoState`, run under `-race`).

### 2.12 Two-phone wire protocol (v1) *(added 2026-09-29; decisions by the product owner)*

This section is the binding contract between a phone running the Pages app and `cmd/cuttle-server`. It replaces `docs/two-phone-plan.md` §3 as the source of truth; where the plan and this section differ, this section wins. The server side is W5 (HTTP), W6 (WebSocket), W7 (hold); the client side is W11 (`web/src/lib/online/`) and W12 (`OnlineGameStore`).

The envelope inside a `state` frame is exactly the §2.7 `Envelope` for one seat, validated on the phone by the same `schema.ts` tripwire as the local bridge. Everything else in this section is room metadata around it.

#### 2.12.1 HTTP: create and join

Both calls are `POST` with a JSON body, sent to the configured server origin (`VITE_CUTTLE_SERVER`) with `credentials: 'omit'` and `cache: 'no-store'`.

| Call | Body | Success | Reply |
|---|---|---|---|
| `POST /api/rooms` | `{name}` | `201` | `{code, seat: 0, token}` |
| `POST /api/rooms/{code}/join` | `{name}` | `200` | `{code, seat: 1, token}` |
| `GET /healthz` | — | `200` (`503` if the database is down) | `{ok, status, rooms, version, commit}` |

- **`code`** is the canonical room code: 4 upper-case Crockford base32 characters (`0-9A-Z` without `I L O U`). Clients fold input before sending (upper-case, `O`→`0`, `I`/`L`→`1`, separators dropped) and the server folds again (`store.NormalizeCode`).
- **`token`** is base64url of 32 bytes from `crypto/rand` (43 characters). It is returned once, in this reply, and never again. The server stores only its SHA-256.
- **Request bodies are strict.** `Content-Type: application/json`, at most 1 KB, exactly one object, unknown fields rejected. Any violation is `400 BAD_REQUEST`.
- **Names:** control and bidi-override characters stripped, then trimmed, then 1–20 runes. Other format characters (the ZWJ inside an emoji) stay. Names are rendered as text only, never as HTML.
- **Headers.** Every response, success or error, carries `Cache-Control: no-store`. CORS echoes the exact allowed origin (`CUTTLE_ALLOWED_ORIGINS`, the Pages origin; `http://localhost:5173` only by a dev flag), never `*`, never `Access-Control-Allow-Credentials`.
- **Join deals.** A successful join deals game 1 under the room lock (seed and first dealer from `crypto/rand`) and saves it as `(game 1, seq 0)` before replying. If seat 0 is connected, it is told at once (§2.12.4, "Create, join, deal").

**HTTP errors.** Every error body is `{code, message}`. `message` is a fixed human string: never a token, never an `err` text, never card data. The client renders it as text only.

| `code` | Status | When | Client does |
|---|---|---|---|
| `BAD_REQUEST` | 400 | Malformed code, bad name, oversize body, wrong content type, unknown field | Show the message; stay on the form |
| `UNAUTHORIZED` | 401 | Reserved; no v1 HTTP call takes a token | — |
| `FORBIDDEN` | 403 | `Origin` not allowed | "This app can't reach the game server." (a deploy bug) |
| `ROOM_GONE` | 404 | Unknown, malformed or expired code (the store can't tell them apart, so `410` is not used) | "That game doesn't exist or has ended." |
| `ROOM_FULL` | 409 | Join when seat 1 is taken | "That game already has two players." |
| `UPGRADE_REQUIRED` | 426 | Reserved for a server that has dropped this client's version (§2.12.7) | "Refresh to update." |
| `RATE_LIMITED` | 429 + `Retry-After` | Per-client limit hit (§2.12.6) | "Too many tries, wait a minute." |
| `INTERNAL` | 500 | Anything else | Generic failure, retry allowed |
| `SERVER_FULL` | 503 + `Retry-After: 600` | Create at the live-room cap. The play-socket cap also answers the WebSocket upgrade with `503 SERVER_FULL`, `Retry-After: 30` (§2.12.6). | "The server is busy, try again later." |

A client that gets a non-JSON error body derives the code from the status (W11 `statusCode()`); `503` without a body reads as `INTERNAL`.

#### 2.12.2 WebSocket: `/api/play`

`wss://<server origin>/api/play`. JSON text frames, one object per frame, each with a type field `t`. The server checks `Origin` on the upgrade and refuses a disallowed one with a `403` before any frame (the browser sees a failed connection). **The token is never in the URL**, so it never reaches an access log; it travels only in `hello`.

**Client → server**

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `v: 1, code, token, lastSeq` | Authenticate. Must be the first frame, on every (re)connect. `lastSeq` is advisory (below). |
| `move` | `game, seq, index` | Apply legal move `index` of the envelope whose history length is `seq`, in game `game`. |
| `rematch` | `game` | Ask for a rematch of finished game `game`. |
| `ping` | — | Keepalive. The server answers every `ping` with `pong`. |

**Server → client**

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `seat, names: [string\|null, string\|null], status` | Hello accepted. `seat` is the seat bound to the token. `names[1]` is `null` until someone joins. `status` is `waiting` (no opponent yet), `playing` or `over` (game over, no rematch dealt yet). The mover under a hold is told `playing`, never `over` (§2.12.5). |
| `state` | `game, envelope, opponentOnline, tally: [n0, n1]` | This seat's full redacted envelope (§2.7). Never a diff. `envelope.state.viewer` equals the connection's seat. |
| `responding` | `by` | The mover's neutral hold after a counterable move (§2.12.5). `by` is the other seat. |
| `presence` | `opponentOnline` | The other seat connected or dropped. |
| `rematch` | `requestedBy` | A rematch request is pending from `requestedBy` (either seat, including the receiver's own). |
| `error` | `code, message, seq?` | §2.12.3. `seq` echoes the rejected `move`'s `seq`, when there was one (never on the held mover's `STALE`, §2.12.5). |
| `pong` | — | Reply to `ping`. |

Field rules:

- `game` is ≥ 1 and counts games in the room across rematches (the store's `Game`). `seq` is ≥ 0 and equals `envelope.seq`, the history length of that game. A deal or rematch bumps `game` and restarts `seq` at 0.
- `seat`, `by` and `requestedBy` are `0` or `1`. `tally[s]` is seat `s`'s wins in this room; a stalemate counts for neither. The tally changes in the same `state` that shows the game over.
- **No client frame names a seat.** The server takes the seat from the token authenticated in `hello` and never from a frame. It calls `Session.Apply(seat, seq, index)` with that seat (§2.11). A client frame's unknown fields are ignored; an unknown `t` is `BAD_REQUEST`.
- The client ignores a server frame whose `t` it doesn't know and extra fields on known frames (forward compatibility, §2.12.7). A known frame with a bad shape is a protocol error: reported, not delivered, connection kept (W11).
- `welcome` is sent after every accepted `hello`, and again, unprompted, when the names or status change under a live connection (the join; §2.12.4). A repeat `welcome` never changes the seat.

**What answers a `hello`.** `welcome`, then exactly one of:

1. `state`, the full current envelope for this seat (the normal case, including `status: over`);
2. `responding {by}`, if this seat is the mover under a hold (§2.12.5); its `state` follows when the hold ends;
3. nothing more, if `status` is `waiting` (no game has been dealt); `state` follows the join.

After that, if a rematch request is pending, the server sends `rematch {requestedBy}` (to the mover under a hold, only once the hold ends, after its `state`). The server never answers a `hello` with a diff or with anything that depends on `lastSeq`.

**`lastSeq`** is the `envelope.seq` of the last `state` this phone accepted, in whatever game that was (0 if none). It is advisory. `hello` carries no `game`, so the server can't tell whether `lastSeq` belongs to the current game; a v1 server therefore ignores it for every decision (it may log it). Across a rematch it refers to the game the phone last saw, and the server ignores it when that game is not the current one, which in v1 means always. The phone does the comparison itself: on a `state` whose `game` differs from the last one it saw, it starts that game fresh (no recap across games); on the same `game` with `seq` more than one past the last one, it shows the missed-moves recap (plan §7, §2.12.9).

**Seq rules.** A `move` must carry the current `game` and `seq`. The client never resends a move on its own and never queues one while not connected (W11 refuses `sendMove` unless `open`). After a reconnect, the fresh `state` shows whether an in-flight move landed; if it didn't, the player confirms again.

#### 2.12.3 Errors on the socket

**Terminal errors.** After these the phone stops reconnecting and forgets the saved seat (`cuttle.online.v1`), except as noted:

| `code` | Sent when | Client does |
|---|---|---|
| `ROOM_GONE` | `hello` for an unknown or expired code, or the room expires under a live socket | "This game has ended." Forget the seat, go Home. |
| `UNAUTHORIZED` | `hello` with a token that doesn't match a seat of that room | Forget the seat, go Home. |
| `UPGRADE_REQUIRED` | `hello.v` is not a version this server speaks | "Refresh to update." Keep the seat: the refreshed app can resume. |
| `SEAT_MISMATCH` | **Client-side only; never on the wire.** `welcome.seat`, or a `state`'s `envelope.state.viewer`, is not the saved seat | Close the socket, forget the seat, go Home ("This game couldn't be resumed."). |

**Framing rule.** A terminal condition is always sent as an `error` frame before the server closes the socket. A close with no preceding terminal `error` (network loss, server restart, idle timeout, oversize frame, handshake timeout, `BAD_REQUEST` on `hello`) is retryable, and the phone reconnects with backoff.

**Non-terminal errors.** The session is unchanged in every case.

| `code` | Sent when | Followed by | Client does |
|---|---|---|---|
| `NOT_YOUR_TURN` | `move` from a seat that isn't `Active` | fresh `state` | Resync from it |
| `STALE` | `move` (or `rematch`) whose `game` or `seq` isn't current; also every well-formed `move` or `rematch` from the mover under a hold, whatever its `game` and `seq`, and then with no `seq` field (§2.12.5) | fresh `state` (`responding` for the held mover) | Resync; the player confirms again if still legal |
| `GAME_OVER` | `move` after the game ended | fresh `state` | Resync (shows the result) |
| `ILLEGAL_MOVE` | engine rejected an offered move (§2.9) | nothing | Stuck-state screen (§2.10) |
| `NO_LEGAL_MOVES` | engine offered nothing outside game over (§2.10) | nothing | Stuck-state screen |
| `INDEX_OUT_OF_RANGE` | `index` outside the legal-move list | nothing | Client bug: keep the current state, clear `sending` |
| `BAD_REQUEST` | malformed frame, unknown `t`, `rematch` before the game is over; before `welcome`, the socket is then closed | nothing | Clear `sending`; show a generic failure |
| `RATE_LIMITED` | frame rate over the limit (§2.12.6), or a `hello` that would get `UNAUTHORIZED` or `ROOM_GONE`, once the failed-hello limit is spent | nothing (on `hello`: close) | On `hello`: wait at least 60 s before the next attempt. Otherwise continue. |
| `INTERNAL` | recovered panic, or a failed save (§2.12.5) | fresh `state` if the session could be reloaded | Clear `sending`; resync |

"Followed by a fresh `state`" means the server sends this seat's current envelope right after the error, **unless this seat is the mover under a hold**, in which case it sends `responding {by}` instead and the `state` waits for the hold to end (otherwise a stray stale move would open the hold early).

**Reconnect policy (client).** Backoff 0.5, 1, 2, 4, then every 8 s, ±20% jitter; no ordinary wait may exceed ~30 s; a `welcome` resets it; `online` resets it and retries at once; `visibilitychange` to visible retries at once without resetting. After a `RATE_LIMITED` on `hello` the next attempt waits at least 60 s. After about 10 consecutive failures without a `welcome`, the phone stops and shows "stalled: tap to reconnect"; a tap resets the backoff and tries once. The phone goes to `offline` (no retries) while `navigator.onLine` is false.

#### 2.12.4 Sequences

Arrows are frames or HTTP calls; `A` holds seat 0, `B` seat 1, `S` is the server.

**Create, join, deal.**

```
A → S  POST /api/rooms {name:"Alice"}
S → A  201 {code:"K7QX", seat:0, token:tA}
A → S  WS hello {v:1, code:"K7QX", token:tA, lastSeq:0}
S → A  welcome {seat:0, names:["Alice",null], status:"waiting"}
          (no state: nothing is dealt yet)
B → S  POST /api/rooms/K7QX/join {name:"Blake"}
          S, under the room lock: claim seat 1, NewSession(seed, dealer),
          store.Save(game 1, seq 0)
S → B  200 {code:"K7QX", seat:1, token:tB}
S → A  welcome {seat:0, names:["Alice","Blake"], status:"playing"}
S → A  state {game:1, envelope:<seat 0, seq 0>, opponentOnline:false, tally:[0,0]}
B → S  WS hello {v:1, code:"K7QX", token:tB, lastSeq:0}
S → B  welcome {seat:1, names:["Alice","Blake"], status:"playing"}
S → B  state {game:1, envelope:<seat 1, seq 0>, opponentOnline:true, tally:[0,0]}
S → A  presence {opponentOnline:true}
```

**A move** (not counterable).

```
A → S  move {game:1, seq:4, index:2}
          S, under the room lock: up := Session.Apply(0, 4, 2)
                                  store.Save(game 1, seq 4 → 5)
S → A  state {game:1, envelope:up.For(0) /* seq 5 */, ...}
S → B  state {game:1, envelope:up.For(1) /* seq 5 */, ...}
```

**A counter window with the hold.** A plays a one-off. Whether or not B holds a 2, A's frames are identical in type and order.

```
A → S  move {game:1, seq:9, index:0}          (a OneOff; t0 = apply time)
          S: Apply, Save(seq 10)
S → A  responding {by:1}                      (at once; A's state is withheld)
S → B  state {seq 10}                         (at once: counter prompt if B holds a 2,
                                               else the resolved board)
    ... case B holds a 2: B answers ...
B → S  move {game:1, seq:10, index:k}         (Decline or Counter)
          S: Apply, Save(seq 11)
S → B  state {seq 11}                         (if B countered: responding {by:0} instead,
                                               B is now the mover under a hold)
S → A  state {seq 11}                         at max(answer time, t0 + 1.5 s)
    ... case B has no 2: no window opened, the answer is "in" at t0 ...
S → A  state {current seq}                    at t0 + 1.5 s
```

**Reconnect.**

```
          (A's socket dies; S notices after 45 s of silence, or at once on close)
S → B  presence {opponentOnline:false}
A → S  WS hello {v:1, code, token:tA, lastSeq:12}
S → A  welcome {seat:0, names, status:"playing"}
S → A  state {game:1, envelope:<seat 0, current seq>, opponentOnline:true, tally}
          (or responding {by:1}, if A is the mover under a hold)
S → A  rematch {requestedBy:1}                (only if a request is pending)
S → B  presence {opponentOnline:true}
```

**Rematch.**

```
          (game 1 is over; the last state carried the updated tally)
A → S  rematch {game:1}
S → A  rematch {requestedBy:0}                ("Waiting for Blake")
S → B  rematch {requestedBy:0}                ("Alice wants a rematch")
B → S  rematch {game:1}
          S, under the room lock: NewSession(seed, other dealer), Save(game 2, seq 0)
S → A  state {game:2, envelope:<seat 0, seq 0>, ..., tally}
S → B  state {game:2, envelope:<seat 1, seq 0>, ..., tally}
```

A repeat `rematch` from the seat that already asked is a no-op (the server re-sends `rematch {requestedBy}`). `rematch` with a `game` other than the current one is `STALE` plus `state`; while the current game isn't over it's `BAD_REQUEST`. The server owns dealer alternation (R1, R3): game `n+1` is dealt by the player who didn't deal game `n` (§2.6's client-driven `dealer` doesn't apply online).

#### 2.12.5 Server obligations

**Privacy.** The only game data the server sends is `Update.For(seat)` or `Session.View(seat)`, both `game.Envelope`, the one type that satisfies `game.ClientSafe` (§2.11). The frame writer takes `game.ClientSafe`, so a `ServerSnapshot` or an `Update` can't be passed to it. No frame carries a seed, the deck, a snapshot, or any token (the socket never sends one at all). Logs carry code, seat and event, never cards, names or tokens.

**Seat binding.** The seat comes from the connection, fixed at `hello` by `store.Authenticate(code, token)`. `Session.Apply(seat, seq, index)` rejects any seat but engine `Active` with `NOT_YOUR_TURN`. The server first checks `move.game` against the current game (`STALE` if different), then lets `Apply` check the rest in its §2.11 order.

**Persistence ordering.** Every move is handled under the room lock, in this order:

1. `up, err := Session.Apply(seat, seq, index)`. On error: send the §2.12.3 error (and `state` where the table says so). Nothing else happens.
2. `store.Save` with the optimistic `(game, seq)` check, writing the snapshot (`ServerSnapshot.PersistBytes()`), the new `seq`, `updated_at`, and on a game over the status and tally.
3. Only after the save succeeds: send `up.For(s)` to each connected seat `s`, subject to the hold.

If the save fails, the server reloads the room with `RestoreSession` from the stored snapshot, discards the `Update`, and sends no envelope of the unsaved state. It tells the mover `error {code: INTERNAL, seq}` followed by the reloaded (unchanged) `state`, so the phone clears `sending`. If the reload fails too, it closes both sockets without an error frame (retryable) and drops the room from memory; the next `hello` loads it from the store.

**The counter hold (§4.3, plan §6).** A *counterable move* is a `MoveOneOff`, a `MoveSevenPick` whose `SubMove` is a one-off, or a `MoveCounter`. After one is applied and saved:

- The mover gets `responding {by: other}` at once and **no `state`** until both (a) the answer is in, meaning the engine no longer waits on the other seat's counter decision (not `phase == PhaseAwaitingCounter && active == other`; true immediately when no window opened), and (b) at least `CUTTLE_RESPOND_MIN_MS` (default 1500) has passed since the move was applied.
- When both hold, the mover gets the **current** `state`, which may already include later moves (a quick answer and a quick next move); the phone's recap covers the gap.
- The other seat gets its `state` at once, as for any move.
- A `hello` from the mover during the hold is answered with `welcome` and `responding` (§2.12.2), never with the withheld state. So is any error that would otherwise be followed by `state`.
- **The held mover learns nothing from its own frames.** Every well-formed `move` or `rematch` it sends during the hold gets the fixed `error {code: STALE}` (no `seq`) and `responding`, without reaching `Session.Apply` or the rematch requests, so the reply is the same whether or not the answer is in or the game has ended. Its `welcome` says `playing`, never `over`. A rematch request is neither sent nor replayed to it until the hold ends; then it gets the current `state`, then `rematch {requestedBy}`.
- The hold is enforced by the server, so raw frames reveal nothing early. It lives in memory; a server restart ends it, and the next `hello` gets the current `state` (accepted: a restart takes seconds and says nothing about the hand).

**Presence and liveness.** The client sends `ping` every 15 s and treats a socket as dead if no frame arrives within 10 s of a ping (5 s for the probe on becoming visible). The server answers every `ping` with `pong` and sends no app-level pings of its own. It treats a socket with no inbound frame for 45 s as dead, closes it (bare, retryable) and sends the other seat `presence {opponentOnline:false}`. It must receive `hello` within 10 s of the upgrade or close. **One socket per seat:** a new accepted `hello` for a seat replaces the old socket, which the server closes with `error {code: "REPLACED"}` first (open question 1).

#### 2.12.6 Limits

| Limit | Value | Breach |
|---|---|---|
| Create | 10/hour per client, burst 10 | `429 RATE_LIMITED` + `Retry-After` |
| Join | 30/hour per client, burst 30; every attempt counts, code guesses included | `429 RATE_LIMITED` + `Retry-After` |
| Failed `hello` | 30/hour per client. **Counted:** hellos answered `UNAUTHORIZED` or `ROOM_GONE` (token or code guessing). **Not counted:** accepted hellos, `UPGRADE_REQUIRED`, `BAD_REQUEST`, handshake timeouts, closes. A legitimate phone's reconnect storm never trips it. Each `hello` takes a token before its token is checked and gets it back unless the hello failed as a guess, so N parallel guesses spend N tokens. The token is always checked: a valid one is accepted even when the budget is spent. | A guess once the budget is spent gets `error RATE_LIMITED` (no `UNAUTHORIZED`/`ROOM_GONE` verdict), then close |
| Frames per socket | 10/s sustained, burst 20 (token bucket). Pings at 1 per 15 s and human-rate moves sit far below it. | Frame dropped with `error RATE_LIMITED` (at most one per second); over the limit for 5 s straight, bare close |
| Inbound frame size | 1 KB | Close (1009), retryable |
| HTTP body | 1 KB, JSON only, no unknown fields | `400 BAD_REQUEST` |
| Names | 1–20 runes after stripping and trimming | `400 BAD_REQUEST` |
| Live rooms | 500 | `503 SERVER_FULL` + `Retry-After: 600` |
| Play sockets | 500 open in total (`CUTTLE_MAX_SOCKETS`), 8 per client (`CUTTLE_MAX_SOCKETS_PER_CLIENT`) | Upgrade refused with `503 SERVER_FULL` + `Retry-After: 30`, before any frame (the browser sees a failed connection; retryable) |
| Room idle expiry | 24 h since `updated_at` (`CUTTLE_IDLE_TTL`), joined or not | `ROOM_GONE` |
| `hello` deadline | 10 s after upgrade | bare close |
| Idle socket | 45 s with no inbound frame | bare close |

"Per client" is the peer IP, with IPv6 grouped by /64. `X-Forwarded-For` is read only when the peer is a configured `-trusted-proxy` address (the local Caddy), and then only its rightmost entry. Outbound frames have no size cap; an envelope is a few KB.

**Nightly backup** *(added 2026-09-29, W8)*. Off unless `-backup-dir` (`CUTTLE_BACKUP_DIR`) is set. Config accepts only an absolute path with no `..`, and refuses the data directory or anything inside it, after resolving symlinks on both (the deepest existing ancestor of a not-yet-created backup directory is resolved too); the server serves no files, so the directory is never web-reachable. `-backup-keep` (`CUTTLE_BACKUP_KEEP`, default 3, at least 1) is the number of copies kept. `RunBackups` is its own loop next to the janitor and stops with the server's context. It runs one `VACUUM INTO` a day: at once on start unless the newest backup is under a day old (so restarts and deploys neither skip a day nor add copies), then every 24 h. The copy goes to `.tmp-cuttle-YYYYMMDDTHHMMSSZ.db` in the backup directory and is renamed to `cuttle-YYYYMMDDTHHMMSSZ.db` (UTC) only when complete, so the final name never holds a partial file. On any error the temp file is removed and nothing is pruned; a leftover temp from a crash is removed by the next run (only names of the form `.tmp-cuttle-<UTC>.db`, with an optional `-journal`; other files are never touched). The wait for the first run after a start is at most one interval, so a future-dated backup file cannot stall the schedule. Files are 0600 and the directory 0700 (a missing directory is created and set to 0700; an existing one the server did not create is never chmodded, and one that group or others can access is refused with an error). The directory check runs at startup (before the server listens): a loose existing directory, or one that cannot be created, exits with status 2 like any other configuration error. A dangling symlink in the backup path is not resolved by the data-directory check, so the operator must create the link target first. After a good copy only files matching the backup name beyond the newest N are deleted. A backup holds every hidden card and every token hash, so it is as sensitive as the live database. Logs carry the file name, size and prune count on success and the failing step on error: no path (OS errors are logged without the path, and SQLite errors as a fixed message plus the SQLite code), row or token.

#### 2.12.7 Versioning

- The protocol version is the integer `v` in `hello`. This document is `v: 1`.
- **A `v` bump means `UPGRADE_REQUIRED` for old clients.** A server speaks the versions it lists (v1: only `1`). A `hello` with any other `v` gets `error {code: UPGRADE_REQUIRED}` and a close. The phone shows "Refresh to update" and keeps its seat, so the refreshed app resumes the game if the room is still alive.
- **Bump `v` for** any change an existing client would misread: a removed or renamed frame or field, a changed meaning, a new required client field, or an envelope change that the shipped `schema.ts` rejects (a new required `Envelope` field is one, §2.3's engine-token note).
- **Don't bump for** additive changes: a new server frame type (old clients ignore it), a new optional field on a server frame, a new error code (old clients keep an unknown code as non-terminal), or a new optional client field.
- HTTP v1 bodies carry no version; `426 UPGRADE_REQUIRED` is reserved. A later version that changes the HTTP bodies adds an optional `v` to them, where absent means 1.
- Pages and the server deploy separately and the service worker keeps old app builds alive, so a bump is deployed server first, and the new app must ship in the same release.

#### 2.12.8 Open protocol questions

Each has the default the work proceeds on until the product owner decides otherwise.

1. **Two sockets for one seat** (two tabs, or a phone that reconnected before its old socket timed out). **Default:** newest `hello` wins; the old socket gets `error {code: "REPLACED"}` and a close. The phone treats `REPLACED` as "stalled" (no auto-reconnect, keep the seat, "This game is open somewhere else. Tap to play here."). Without this, two tabs would take the seat from each other forever. W11 today treats an unknown code as non-terminal and would reconnect, so W11/W12 need the case.
2. **Pending rematch requests across a server restart.** **Default:** memory only. A restart drops the request, and the player taps Rematch again. The room's `status` stays `over`, so nothing else is lost.
3. **`game` in `hello`.** v1 has none, so the server can't use `lastSeq`. **Default:** leave it out; the server always sends the full `state` anyway. Adding an optional `hello.game` later is additive and needs no bump.
4. **Deploy skew.** A bump needs the server and the Pages app to move together. **Default:** a server speaks one version; bumps are rare and ship server first, with the app build in the same release. Revisit (speak N and N−1) if a bump ever lands mid family game.
5. **The hold across a restart** (§2.12.5). **Default:** accept losing it. Persisting the hold's start time would need a schema change for a gap of a few seconds.
6. **`Decline` entries in raw history** (plan §14, question 1). **Default:** accept, as R14 already accepts it and the recap hides them.

#### 2.12.9 Phone screens during online play *(added 2026-09-29, two-phone W13b)*

What the phone shows around the board, all from `OnlineGameStore` (`web/src/lib/stores/onlineGame.svelte.ts`) through `TableSource.online` (`OnlineTableInfo`). Every string is fixed text or a room name; none carries a token, a server `message`, or a card the seat can't see.

- **Status and notice lines.** One banner per line below the board: the connection status ("Connecting…", "Reconnecting…", "You’re offline. Online games need a connection.", "Can’t reach the game server." with "Tap to reconnect", "This game is open somewhere else." with "Play here", "Blake is offline.") and the last move's notice. `data-tone` is `warn` for this phone's own connection, `info` for the opponent being away, `notice` for a notice (`online-status`, `online-notice`, `online-retry`).
- **Waiting panel** (`online-waiting`): a card back and "Waiting for the game…" until the first `state`.
- **Responding panel** (`online-responding`, the §2.12.5 hold): "Blake is responding…", with the card this seat played when this page sent the move (taken from its own legal-move list at the Confirm; none when the hold is met on a resume). It depends only on this seat's own move, so it looks the same whether or not a counter window opened.
- **Waiting line** (`online-waiting-on`, plan §7 `waitingOn`): in the action bar while the other seat acts in a phase that is more than "their turn": "Blake is choosing what to discard." (a 4), "Blake is choosing from the 7." From public `phase` and `active` only. The other seat's counter window, which a phone can see only without a hold (after a server restart), reads "Blake is responding…", the hold's own words, so it tells nothing the hold doesn't.
- **Missed-moves recap** (`online-recap`, `online-recap-toggle`, `online-recap-dismiss`, `online-recap-expand`). On a `state` in the same `game` whose `seq` is more than one past the last `state` this page saw (a reconnect in the same page; a reload or a resume starts from its first `state` and never recaps), the store lists the other seat's entries after that last `seq`, `isRecapVisible` only, from this `state`'s own redacted history and nothing else. This seat's own entries are seen (§4.6), so a jump over only the mover's own move and a Decline (the end of a hold after a declined window) shows nothing, the same as the no-window case. Lines are `formatRecapLines` sentences with `recapCards` mini faces, so §4.6's rules hold unchanged: an opponent's draw is "drew a card", a 5 says "to draw 2 cards" (never `drawn`, never the cards), a 3 never names the card it takes, a 9 names only itself and its board target, a 7 never names the card that went back, a discard names no position or card. The panel is a compact strip in the flow between the board and the action bar: it takes its height from the board (which scrolls), so it never lies over the hand or the deck, and the board stays live. Closed (the default) it shows a header row (heading, move count, Show, Got it) and the latest line; open, the last 6 lines ("+N earlier" for the rest) scroll inside a list about two lines tall on a 393×660 screen and up to 200 px on a tall one. While the strip is up, whenever the board or the strip changes size (opening it, a status banner arriving), GameScreen scrolls the board just far enough that the hand's bottom edge meets the board's, so a short screen with a full board never clips the hand. An entry the formatter can't read is skipped on its own, never shown raw. It closes on "Got it", on this seat's next move from the board, and on a new game. **An apply at this seat's own counter window counts as having seen what the prompt showed (§4.6):** the entries `counterPromptEntries` returned are dropped, earlier missed moves the prompt didn't show stay, and a later jump never brings the dropped ones back. A further jump while the strip is up extends it from the same start. A first `state` and a new `game` never recap.
- **Stuck screen** (`online-stuck`, `online-leave-game`, the online §2.10). `ILLEGAL_MOVE` or `NO_LEGAL_MOVES` from the server, or a `state` where this seat must act and `legalMoves` is empty outside game over (§2.10 rule 1), replaces the board, the counter prompt and the draw reveal. It says the game can't go on, shows the game and move number and the code (never the server's `message`, which can name a card), and lists this seat's history as §4.6 recap lines (never raw `Describe` text, never a Decline). There is no seed, dealer or scenario stanza online: the seed never leaves the server. The only way on is "Leave this game", which forgets the seat and goes Home. Nothing retries (§2.10 rule 3), and `apply` sends nothing while stuck. The state stays for that position (a resent identical `state` keeps it) and clears when a `state` for another position arrives.
- **Rematch line** (`online-rematch-status`, on the result screen under the buttons): "Blake wants a rematch." when the other seat asked; "Waiting for Blake…" once this seat asked, with Rematch disabled until the next game; "Starting the rematch…" when both have asked and the new `state` isn't in yet.
- **Home offline** (`online-offline`, R24.14): while `navigator.onLine` is false, Play on two phones stays on Home with "You’re offline. Online games need a connection."; Start a room and Join with a code are disabled (both would only fail) and Resume stays enabled (the game screen shows the offline line and reconnects on its own).

---

## 3. Redacted-view rules (R7)

### 3.1 Where redaction happens, and why it matters

**Redaction is performed in Go, inside the bridge, in `internal/game/view.go`** (moved from `internal/wasm` in two-phone W1, 2026-09-29, so the WASM shim and the future server share one copy). The `GameState` never crosses the WASM boundary. The only game data the TypeScript side can reach is a `PlayerView` already stripped for one named viewer.

This is not defense-in-depth for its own sake. PRD §7 makes it a v1 obligation to v2: *"the UI consumes only the envelope + redacted views (never reaches into full state for opponent info)."* If redaction lives in TypeScript, v2 has to write it a second time in Go and the two will drift. Writing it once, Go-side, means the v2 server calls the identical `viewFor(state, viewerId)` and ships its output over the WebSocket. *(Amended 2026-09-29.)* The redaction and the envelope carry over unchanged, which is the part of G4 that holds. The rest of the "transport swap" doesn't: the server only ever sends per-seat envelopes (`game.ClientSafe`, §2.12.5), and the phone reads them through `OnlineGameStore` behind the `TableSource` seam (W10), not through `lib/bridge/engine.ts`.

It also makes the privacy property structural rather than disciplinary. A developer agent cannot accidentally render the opponent's hand, because the bytes are not present in the browser's JS heap.

### 3.2 The per-field derivation

`viewFor(state, viewer)` produces `PlayerView`. `opp := viewer.Other()`.

| `PlayerView` field | Source | Rule |
|---|---|---|
| `viewer` | argument | — |
| `active`, `phase`, `passesInARow` | `state.Active`, `.Phase`, `.PassesInARow` | always public |
| `winner` | `state.Winner` | always public; `null` when absent |
| `stalemate` | derived | `Phase === PhaseGameOver && Winner == nil` |
| `you.hand` | `Players[viewer].Hand` | always |
| `you.frozenHandIndices` | `Players[viewer].FrozenIDs` | always; sorted `number[]` (R8) |
| `you.points` / `you.permanents` | `Players[viewer]` | always — fields are public (R5) |
| `you.watched` | derived: `viewerHasGlasses(Players[opp])` | always a boolean. True exactly when the opponent's own view carries this viewer's hand. *(added 2026-09-28, R10)* |
| `opponent.handCount` | `len(Players[opp].Hand)` | **always** (R7: count always) |
| `opponent.hand` | `Players[opp].Hand` | **only if `viewerHasGlasses`; otherwise `null`** |
| `opponent.points` / `.permanents` | `Players[opp]` | always — fields are public (R5) |
| `deckCount` | `len(state.Deck)` | **count only. `Deck` contents are never transmitted, to either player, in any phase.** |
| `scrap` | `state.Scrap` | always, in full, to both players (R6) |
| `scoreboard` | `engine.PointTotal`, `engine.Threshold`, `engine.KingCount`, `engine.HasWon` | both players, always (R5) |
| `sevenRevealed` | `state.Pending.Revealed` | **only if `phase === PhaseSevenChoosing && viewer === state.Active`; otherwise `null`** (R16) |
| `pending.card` / `.target` / `.playedBy` | `state.Pending` | present whenever `Pending != nil` — the played one-off is public the moment it is played (R14 requires the opponent to see it) |
| `pending.counterChain` | `state.Pending.CounterChain` | public; every 2 in the chain was played face-up |
| `pending.scrapIndex` | `state.Pending.ScrapIndex` | **omitted from the view entirely** — see below |
| `history[].index`, `lastMove.index` | `AppliedMove.index` | present only when `viewer === entry.by`; otherwise the key is **omitted**. The index into the mover's legal-move list reveals a pending 3's `ScrapIndex` and how many options the hidden hand produced. *(amended 2026-09-26)* |

**`viewerHasGlasses` (R7).** `Players[viewer].Permanents` contains any card with `Rank === card.Eight`. `Permanents` holds only Queens, Kings, and glasses-8s (`engine/state.go:56`), so no further filtering is needed. Suit is irrelevant (RULES.md §Notes: "Glasses 8: any 8"). Note the direction carefully: **the glasses' owner sees the other hand.** A viewer with glasses sees `opponent.hand`; a viewer whose *opponent* has glasses sees nothing extra in the view.

**The being-watched marker** *(added 2026-09-28, W24 glasses 8, merged `1fbe15f`; amended 2026-09-28, R10)*. While the opponent has glasses, the viewer's own hand carries a marker saying so: a goggles icon and "`NAME` can see your hand", on an ochre-edged pill sitting on the top edge of the hand slot, right-aligned (no testid, not a tap target). `Board` renders it from `view.you.watched` and nothing else. The bridge computes that flag in `viewFor` by calling `viewerHasGlasses` on the opponent, the same predicate that gates the opponent's `opponent.hand`, so the marker and the watcher's actual exposure can't disagree, and the UI does not re-derive it from permanents (§3.3 rule 2). It is a per-view derived field: it is not stored in engine state or the save, so the snapshot shape (§5.7) is unchanged. The marker is plain text, not a live region: the hand slot is a `role="group"` labelled "Your hand" whose `aria-describedby` points at the marker's text while the viewer is watched, so a screen reader hears it whenever focus enters the hand. (A `role="status"` region mounted together with its text, as the board is after every curtain, is not reliably announced.) **Design decision (ApisMellow, 2026-09-28):** being watched must be obvious. Players find the opponent's goggles annoying, so the marker has to be unmistakable at a glance, not a subtle cue.

**`opponent.hand` uses `null` vs `[]` meaningfully.** `null` = "you may not see this hand." `[]` = "you can see it and it is empty." This is the one deliberate exception to the normalize-nil-to-empty rule of §2.8(b), and it must be preserved through every layer; collapsing it would make an empty opponent hand indistinguishable from a hidden one and would render a face-up empty hand under glasses as though the glasses had stopped working.

**`pending.scrapIndex` is dropped.** For a pending 3, `ScrapIndex` names which scrap card the player will take if it resolves. Scrap contents are public (R6), so the *index* discloses the acting player's intent to the opponent while they are deciding whether to counter — information the physical game does not give them. The engine holds it (it must, to resolve), the view omits it, and the acting player's own UI already knows their staged choice locally. Removing it costs nothing and closes a small leak.

### 3.3 What the UI layer is forbidden to do

Enforced by code review; each is a hard reject.

1. **No component may import from `lib/bridge/types` anything other than the exported view/envelope types.** There is no `GameState` type in TypeScript. If one appears, redaction has been bypassed.
2. **No recomputation of engine-derived values.** Point totals, thresholds, King counts, win state, controller of a Jack stack, whether a scuttle is legal, whether a Queen protects — all arrive in the view. Re-deriving any of them in TS is rule logic in the UI, forbidden by PRD §2.
3. **No component may index `legalMoves` by anything but a value the engine produced.** Move submission is by index (A3); constructing or mutating a `Move` object is forbidden.
4. **No caching of a previous player's view across a curtain.** When the viewer changes, the store discards the old view and requests a fresh one via `__cuttleView(newViewer)`. A stale view retained in a component's closure is a hidden-information leak with a rendering bug attached.
5. **No reading `history` for card identities beyond what the recap formatter allows** (§4.6).

### 3.4 Threat model, stated plainly

v1 is two people sharing one phone. The adversary is **a person glancing at the screen**, not a person with devtools. Consequently:

- `__cuttleSnapshot()` returns the **full, unredacted** state, and R4's `localStorage` snapshot contains both hands. This is accepted: anyone who can open devtools or read `localStorage` is already holding the phone with the game paused, and could simply take the other player's turn. Encrypting it would be theatre.
- What is *not* accepted is unredacted state reaching the **DOM or the JS heap during play**, because that is reachable by a shoulder-glance, a screenshot, a mis-fired reactive statement, or an accidental render. Hence §3.1.

Recorded as **OQ-9** so ApisMellow can overrule if he wants the snapshot redacted-and-reconstructed instead.

---

## 4. Curtain state machine (R13–R16, R20)

### 4.1 The one identity everything rests on

Across all five phases, **the player who owns the next decision is exactly `state.Active`.**

- `PhaseNormal` — `Active` takes the turn.
- `PhaseAwaitingCounter` — `Apply` sets `out.Active = opp` when entering (`engine/apply.go:337`), and flips it per counter link (`engine/apply.go:359-362`). The decider is `Active`.
- `PhaseSevenChoosing` — `resolveOneOffWith` sets `s.Active = played` (`engine/apply.go:704`). The decider is `Active`, and it is the same player who played the 7.
- `PhaseAwaitingDiscard` — `resolveOneOffWith` sets `s.Active = opp` (`engine/apply.go:626`). The decider is `Active`.
- `PhaseGameOver` — nobody decides.

So the curtain rule of R13 reduces to one predicate, and the UI needs no phase-by-phase special-casing to know *whether* to curtain:

```
curtainRequired  ⟺  post.active !== pre.active  ∧  post.phase !== PhaseGameOver
```

Phase transitions determine *what the incoming player sees*, not *whether* they get a curtain. That separation is what keeps this tractable.

There is no addition to the predicate. A one-off the engine resolved at once, because the opponent held no legal 2, is followed exactly like any other resolved move (§4.3, ruling 2026-09-29). Until that ruling the client staged a "synthetic acknowledgment" on top of the predicate; it is gone.

### 4.2 States

```ts
type CurtainState =
  | { kind: 'none' }                                   // viewer === active, playing
  | { kind: 'handoff';  to: PlayerId; reason: HandoffReason }
  | { kind: 'reveal';   to: PlayerId }                 // tap-and-hold gate (R13)
  | { kind: 'recap';    to: PlayerId; entries: RecapEntry[] }  // R20
  | { kind: 'ack';      to: PlayerId }                 // R14: the counter window
  | { kind: 'result' };                                // PhaseGameOver

type HandoffReason = 'turn' | 'counter' | 'discard' | 'seven-return' | 'resume';
```

`resume` *(added 2026-09-29, resume gate, `loop/r14-resume`)* is the reason of the gate a restore raises in front of a saved board or counter window (§5.7). It lives in memory only and is never written to the save.

The sequence a receiving player walks through is always the same shape:

```
handoff  →  reveal  →  [recap]  →  [ack (the counter prompt)]  →  live view
```

`recap` is skipped when there is nothing new (`entries.length === 0`). `ack` is the counter prompt and comes only when the engine opened a counter window for the incoming player (`post.phase === PhaseAwaitingCounter`, `post.active === to`). Before it, the recap leaves out the one-off and the 2s the prompt shows, and is skipped when nothing else is new (§4.3, ruling 2026-09-29). Everything else is unconditional.

*`acknowledge` and `synthetic` retired 2026-09-29.* A save written before the ruling can still hold them; `decodeSnapshot` reads an `ack` with `synthetic: false` as `ack`, one with `synthetic: true` as `reveal` for the same player, and an `acknowledge` handoff as `turn`. Passing such a reveal goes on to `post.active`: a handoff when the saved addressee is not the decider (`afterRecap` in `curtain.svelte.ts`), so no one is shown the wrong board. No `v` bump: the written shape only loses a field (§5.7).

**The opening curtain** *(added 2026-09-28, W25 playtest fixes, merged `b8238db`)*. A new game starts behind the curtain, addressed to the first actor: `handoff` (`to: first`, `reason: 'turn'`, so the label is "Your turn") → `reveal` → live view. There is no move behind it, so the curtain machine runs it with a context whose `move` is `null` and whose `pre` and `post` are both the first actor's `CurtainView`; with no move there is no counter window, and the history holds nothing new, so no recap. The deal's envelope is not kept (§2.4), and `history` is stored with every `index` stripped, as for any curtain.

**Turn header.** On the live board the `ScoreBar` names whose turn it is: the viewer's side reads "`NAME`, your turn" (bold, ochre), and when it is the opponent's turn their side reads "`NAME`’s turn". Both come from public data only: the names and `view.active`. The viewer's side shows the viewer's name, not "You".

### 4.3 R14 — the counter window *(rewritten 2026-09-29, ruling by the product owner; closes GitHub issue #23)*

**A one-off happens at once, as at the table.** It takes effect, it is scrapped, and the player's turn ends. For a 5, the drawn cards go straight into the player's hand. The opponent gets a chance to answer **if and only if they hold a legal 2**, and that is exactly when the engine opens a window: `Apply` checks `hasLegalCounter(out.Players[opp])` (engine v0.2.0 `engine/apply.go`, `case MoveOneOff`) and otherwise calls `resolveOneOffWith` in the same call, with no pending state and no phase change. A counter link works the same way: if the next player holds no 2, `MoveCounter` calls `resolvePending` at once.

**The client adds nothing.** When no window opened, the curtain follows §4.1's predicate alone: a `turn` (or `discard`, `seven-return`) handoff when control passes to the opponent, and **no curtain at all** when it stays with the mover (a 7 goes straight to its seven panel; a counter the original player cannot answer cancels the chain, and the counterer plays on). There is no hand-off to the opponent for a "let it resolve" prompt. The acting player sees the result on their own screen (for a 5, the drawn cards, §4.7) and then passes the phone for the opponent's normal turn. The opponent learns what happened from their recap.

**The accepted leak** *(ruling 2026-09-29)*. The acting player can now tell whether the opponent held a 2: the phone goes to the opponent for a counter prompt only when they do. The product owner accepts this. It supersedes the earlier indistinguishability requirement ("the acting player must not be able to tell 'the opponent had no 2' from 'the opponent declined'"), the client-staged **synthetic acknowledgment** that implemented it, and the 2026-09-29 "an empty hand needs no disguise" exception, which this rule generalises. Every other privacy rule stands: no card is ever shown to a viewer not entitled to it.

**Detection.** None is needed. `next(pre, mv, post)` returns `result` at game over, a handoff to `post.active` when §4.1's predicate holds, and `none` otherwise. The `ack` curtain appears only through `afterRecap`, when `post.phase === PhaseAwaitingCounter` and `post.active` is the incoming player. Every one-off rank reaches the same engine gate, a one-off played through a 7 (`MoveSevenPick` with `subKind === OneOff`) included, so no per-rank or per-kind branch exists in the machine.

**Presentation.** The counter prompt (`CounterPrompt`, curtain `ack`) shows:

| | Counter window (`post.phase === 1`) |
|---|---|
| Curtain text | "Pass the phone to `NAME`", label "Your response" |
| Reveal gate | tap-and-hold, as every handoff |
| Card shown | the one-off as a `mini` card face, read from `counterPromptEntries(history)`, never `pending` |
| Counter chain | the same `history` slice, as mini faces |
| Controls | "Let it resolve" + one button per legal 2 (always at least one) |
| On confirm | `apply(indexOf MoveDecline)`, or the staged Counter's index |

**No duplicate recap before the prompt** *(ruling 2026-09-29)*. The prompt already lists the one-off and every 2 played on it, so the recap step before it leaves those entries out and is skipped when nothing else is new. This saves a tap, and removes a hazard where a fast double-tap on the recap's dismiss pill landed on "Let it resolve". Entries the prompt does not show stay in the recap (for example the mover's discard earlier in the same exchange, or a 7 whose revealed card is the one-off now in the window). Dropped: nothing. Every line the recap carried either appears in the prompt with the same wording (the prompt uses the same formatter, `formatRecapLines`) or stays in the recap. One difference: a recap dismissal stamps `lastSeenSeq`; with the recap skipped, the responder is stamped by their own apply at the prompt instead (§4.6), which covers the same entries. Implementation: `withoutPromptEntries` in `curtain.svelte.ts` drops trailing Counters and then the one-off that opened the chain (kinds only; the window is open, so history ends with that chain).

**Staging a counter locks "Let it resolve"** *(added 2026-09-28, W25 playtest fixes, merged `b8238db`)*. Tapping a counter option stages it (R12): the options give way to a staging bar with the move's description in sentence case ("Counter with 2♣") and Confirm / Cancel. While a counter is staged, "Let it resolve" is disabled (the `disabled` attribute, dimmed to 35% opacity) and a tap on it does nothing. Cancel re-enables it. Unstaged, the button carries no `disabled` attribute.

**The board never mounts at `ack`** *(amended 2026-09-28, W13 GameScreen review; reason restated 2026-09-29)*. At the counter window the one-off has not resolved yet; the prompt is a full-screen decision. The card and chain are read from `game.history`, never `pending`.

**The `ack` screen must not be skippable, fast-forwardable, or auto-dismissed.** It is a decision.

**The 7 costs no round trip any more.** A 7 resolves to `PhaseSevenChoosing` with `Active` back on the player who played it (`engine/apply.go`, `case card.Seven`). With no 2 against it the actor keeps the phone and goes straight to the seven panel. With a 2 against it: curtain to the opponent → counter prompt → Decline → curtain back to the actor for the reveal. **OQ-6** (§8) is resolved by the ruling.

### 4.4 Full transition table

Read as: an actor in `pre.phase` applies a move of `mv.kind`; the table gives the resulting phase, the new decider, and what the UI does. `A` = pre-state actor, `O` = `other(A)`. Every `(phase, MoveKind)` pair the engine can produce appears; pairs the engine cannot produce are marked *unreachable* and, if reached, are a bug that must raise `INTERNAL`.

**From `PhaseNormal` (0).** Decider is `A`.

| `mv.kind` | Post phase | Post `Active` | Curtain? | Incoming screen |
|---|---|---|---|---|
| `Draw` (0) | Normal | `O` | **yes** — `turn` | reveal → recap → live |
| `PlayPoint` (1) | Normal, or **GameOver** if it wins (`apply.go:188`) | `O` / — | yes / **no** | live / result screen |
| `PlayPermanent` (2), non-Jack | Normal, or GameOver (`apply.go:238`) | `O` / — | yes / no | live / result |
| `PlayPermanent` (2), Jack | Normal, or GameOver (`apply.go:226`) | `O` / — | yes / no | steal animation, then live / result |
| `Scuttle` (3) | Normal | `O` | yes — `turn` | never wins (no points gained) |
| `OneOff` (4), opponent **has** an unfrozen 2 | **AwaitingCounter** (1) | `O` | yes — `counter` | reveal → recap → **counter prompt** |
| `OneOff` (4), rank 4, no 2 | **AwaitingDiscard** (3) | `O` | yes — `discard` | reveal → recap → discard picker |
| `OneOff` (4), rank 4, no 2, **opponent hand empty** | Normal (auto-resume, `apply.go:621-623`) | `O` | yes — `turn` | reveal → recap → live |
| `OneOff` (4), rank 7, no 2 | **SevenChoosing** (2) | **`A`** | **no** | the actor goes straight to the seven panel |
| `OneOff` (4), other ranks, no 2 | Normal, or GameOver (`apply.go:746`) | `O` / — | yes — `turn` / no | reveal → recap → live / result |
| `Pass` (9), `PassesInARow` reaches 3 | **GameOver** (4), `Winner` nil | — | no | **stalemate** result screen (R2) |
| `Pass` (9), otherwise | Normal | `O` | yes — `turn` | reveal → recap → live |
| `Counter`/`Decline`/`SevenPick`/`DiscardPair` | *unreachable* | | | `INTERNAL` |

*Amended 2026-09-29 (§4.3 ruling).* Every "no 2" row here and below follows §4.1's predicate alone, whatever the responder holds: there is no `acknowledge` handoff and no synthetic ack. The "O has a 2" rows skip the recap before the prompt when the prompt shows everything new (§4.3).

**From `PhaseAwaitingCounter` (1).** Decider is `A` (the player being offered the counter). Legal moves are exactly one `MoveDecline` plus one `MoveCounter` per unfrozen 2 (`engine/apply.go:546-555`).

| `mv.kind` | Post phase | Post `Active` | Curtain? | Incoming screen |
|---|---|---|---|---|
| `Decline` (6), chain length **even** (resolves) | whatever the one-off resolves to — Normal / SevenChoosing / AwaitingDiscard / GameOver | per §resolution | per rule below | as the Normal-row equivalents |
| `Decline` (6), chain length **odd** (cancelled, `apply.go:565-571`) | Normal | `O` (= original player's opponent) | per rule | the one-off is scrapped with no effect |
| `Counter` (5), the **next** player has an unfrozen 2 | AwaitingCounter (1) | `O` | **yes** — `counter` | reveal → recap → counter prompt, chain now longer |
| `Counter` (5), the next player has **none** | resolution phase per parity | per §resolution | per §4.1: a handoff when `post.active` is `O`; none when the chain cancels and control stays with the counterer | as the Normal-row equivalents |
| anything else | *unreachable* | | | `INTERNAL` |

**Resolution note.** `resolvePending` (`engine/apply.go:560-577`) sets `Active = Pending.PlayedBy`, then: odd chain length ⇒ cancelled, scrap everything, `endTurn` ⇒ `Active` becomes the original player's opponent. Even ⇒ `resolveOneOffWith` runs the original effect, which itself decides the final phase and `Active`. The UI does not model this; it reads `post.active` and `post.phase` and applies §4.1's predicate. It is written out here only so a developer can follow a counter chain in the debugger.

**From `PhaseSevenChoosing` (2).** Decider is `A`, the player who played the 7 (`apply.go:704`). Legal moves wrap each revealed card's legal inner moves as `MoveSevenPick` with a `SubMove` (`engine/apply.go:501-513`); nesting is single-level.

| `mv.kind` | Post phase | Post `Active` | Curtain? | Incoming screen |
|---|---|---|---|---|
| `SevenPick` (7), `SubMove` = PlayPoint/PlayPermanent/Scuttle | Normal, or GameOver | `O` / — | yes — `turn` / no | live / result |
| `SevenPick` (7), `SubMove` = OneOff, opponent has an unfrozen 2 | **AwaitingCounter** (1) | `O` | yes — `counter` | counter prompt |
| `SevenPick` (7), `SubMove` = OneOff, no 2 | per the one-off's own row above | | per §4.1 | as the one-off's own row |
| — | *empty legal-move list* | | | **E-2 (§2.10)** → stuck-state screen |
| — | every offered move returns `ILLEGAL_MOVE` | | | **E-1 (§2.10)** → stuck-state screen |
| `Draw`/`Pass` | *unreachable* — filtered at `apply.go:534-536` and rejected at `apply.go:408-410` | | | `INTERNAL` |

**From `PhaseAwaitingDiscard` (3).** Decider is `A`, the opponent of the 4's player. Legal moves are every unordered pair of hand indices; a 1-card hand yields the single move `{DiscardA: 0, DiscardB: -1}`; an empty hand never reaches this phase because the 4 handler auto-resumes (`engine/apply.go:480-496`, `:621-623`).

| `mv.kind` | Post phase | Post `Active` | Curtain? | Incoming screen |
|---|---|---|---|---|
| `DiscardPair` (8) | Normal (`apply.go:396-399`) | the 4's player, then `endTurn` ⇒ **`O`** | **yes** — `turn` | reveal → recap ("`NAME` discarded 2 cards") → live |
| anything else | *unreachable* | | | `INTERNAL` |

Note the double flip at `apply.go:395-399`: `Active` is set to `Pending.PlayedBy` and then `endTurn` flips it again, so control lands on the discarder — who is the same person who was just deciding. **`post.active === pre.active`, so §4.1's predicate says no curtain**, and it is right: the discarder finishes discarding and it is now their turn. The discard picker gives way directly to their live view, with a brief confirmation of what they discarded.

**From `PhaseGameOver` (4).** `LegalMoves` returns `nil` (`apply.go:16-18`); `Apply` rejects everything (`apply.go:139-141`). The result screen is terminal; the only actions are Rematch and Home (R3).

### 4.5 Reveal interaction (R13)

The curtain must reveal nothing and must not be dismissible by an accidental brush.

- **Handoff screen.** Full-viewport opaque surface. Content: "Pass the phone to `NAME`", a label, and the reveal control. *(Amended 2026-09-28, playtest friction: "Pass the phone to" only on a phone — a coarse pointer on a screen under 768 px in either dimension; everywhere else, a laptop included, the device-neutral "Pass to `NAME`". It depends on the device alone, never on game state or the reason, so it can't vary between turns.)* The label is **"Your turn"** for `turn` and `seven-return`, and the single neutral **"Your response"** for `counter` and `discard` *(amended 2026-09-27, ApisMellow; `acknowledge` retired 2026-09-29, §4.3)*; the resume gate (`resume`, §5.7) reads **"Resume game"** whatever it resumes into *(added 2026-09-29)*. The handoff is on screen while the *acting* player still holds the phone, so the label names nothing the receiver will be asked to do. *(Since the 2026-09-29 ruling the acting player can infer whether the opponent held a 2 from whether the phone passes at all, §4.3; the neutral label stays.)* The machine's internal `HandoffReason` may still distinguish them; it must not reach the DOM before the reveal gate in any form (text, attribute, class, `data-testid`, or layout). What the receiver needs to do is shown only after the reveal. **Zero game state** — no counts, no scores, no scrap, nothing that changes between turns. A rendering that varies with hidden state is a leak even if no card is drawn. The board must be unmounted, not merely covered: a covered board is one CSS bug away from visible, and screenshots taken during a judged playtest have caught exactly this class of defect.
- **Reveal gate.** Two-step by default, matching R13's "tap and hold (or tap through a two-step reveal)":
  - **Primary — press-and-hold**, 600 ms, with a progress ring. `pointerdown` starts, `pointerup`/`pointercancel`/`pointerleave` abort and reset.
  - **Fallback — two-step tap** ("I'm `NAME`" → "Show my hand"), used when `prefers-reduced-motion: reduce` is set, when the pointer is coarse-less (desktop, R19's "functioning afterthought"), and as the accessible path. Both are always present in the DOM; the hold path is progressive enhancement.
  - Hold duration is a single constant in `lib/curtain.ts`. Playwright drives the two-step path in e2e (holding is flaky to automate); the hold path gets its own focused unit + one e2e test.
  - **Keyboard** *(r16, 2026-09-29 playtest)*. When the curtain comes up, focus lands on its text block (`tabindex="-1"`, never a control), so reaching the next player's hand always takes a deliberate step: one Tab reaches the "I'm `NAME`" pill (it precedes the ring in the DOM; both are absolutely placed, so nothing moves). *(Review B1, 2026-09-29: focusing the pill let the previous player's rapid Enter presses on Confirm walk through "I'm `NAME`", "Show my hand" and the recap.)* Also, a pill click produced by a key that went down before the screen mounted, or by an auto-repeat, is ignored (`lib/keyGuard.ts`), and the ring ignores auto-repeated keydowns, so a key held across the curtain and Tabbed onto either control does nothing; the recap and counter prompt use the same guard and likewise focus their heading, not a button. *(Re-review, same day, R12:)* since focus moves to the next control after each keyboard step, every control focus can move to ignores auto-repeats too: every board tap (hand cards, lit targets, deck, scrap, the 7's cards), the board's staging Confirm and Cancel, Pass, the chooser and scrap-pick options, and the counter prompt's staged Confirm and Cancel. A held key therefore never walks select → target → stage → Confirm. Evidence: `keyboard.spec.ts` "Enter held from Confirm, Tab, Tab…", "Enter held on a hand card for 1 s…", "a repeated Enter on the board's staged Confirm…". Evidence: `keyboard.spec.ts` "privacy: Enter x4 from Confirm…" (dies when the pill is auto-focused), `reveal-gate.svelte.test.ts`, `recap-panel.svelte.test.ts`, `counter-prompt.svelte.test.ts` (die when the guard always allows). The ring works from the keyboard too: Space or Enter held on it is a press and hold, a key-repeat adds nothing, and releasing the key (or leaving the ring) before 600 ms resets it, exactly as a pointer does. Focus changes no DOM, so the §8 invariance rule is untouched. Evidence: `reveal-gate.svelte.test.ts` "Keyboard (r16, desktop)", `keyboard.spec.ts` "keyboard hold".
- **Tap target** ≥ 44 px (R19), centered, thumb-reachable in the lower two-thirds of a 390×844 viewport.
- **No auto-advance anywhere in the curtain sequence.** Every screen waits for an explicit action.

### 4.6 R20 — "while you were away" recap

**What it is.** On the incoming player's post-reveal screen, before they act: the moves applied since that player's last look, oldest first, as short lines. Skipped entirely when there are none.

**How "last look" is tracked.** The game store holds `lastSeenSeq: Record<PlayerId, number>`, updated to `envelope.seq` at the moment a player's live view is rendered (not at reveal — at the transition into `kind: 'none'`). The recap is `history.filter(h => h.seq > lastSeenSeq[viewer])`. This survives reload because `lastSeenSeq` is in the R4 snapshot. **The mover's own moves are seen:** a successful `apply` also stamps `lastSeenSeq[mover]` to the post-apply `envelope.seq`, so a player's recap shows only what happened while they were away, never their own previous move. **Recap dismissal also stamps:** leaving `kind: 'recap'` stamps `lastSeenSeq[viewer]` to the current `envelope.seq`, matching the Presentation line below, so a responder who goes from the recap to the counter prompt is stamped then. *(amended 2026-09-27, ApisMellow delegated the call to the orchestrator.)* *(Amended 2026-09-29, §4.3:)* when the recap before the counter prompt is skipped because the prompt shows everything new, nothing is stamped at that step; the responder's own apply at the prompt stamps them.

**Per-viewer formatting — the recap must not be raw `Describe` output.** `Move.Describe` (`engine/moves.go:36-70`) is written for a terminal REPL and is neither redaction-aware nor player-aware. Two problems:

- `MoveDiscardPair` yields `"discard hand[0] and hand[3]"` — hand indices, meaningless to a human and useless to an opponent.
- Every string is second-person-less and unattributed: `"draw a card"` with no subject.

The recap formatter takes `(entry: AppliedMove, viewer: PlayerId, names: [string,string])` and emits a sentence. `entry.description` (the pre-state `Describe`, frozen at apply time per §2.7) is the source for card identities, and `entry.targetCard` (§2.7, amended 2026-09-27) supplies the targeted card for the Jack-steal and one-off target clauses, which `Describe` omits; the formatter supplies the subject and handles the redaction-sensitive kinds:

| Kind | Recap line (viewer is the opponent of the actor) |
|---|---|
| `Draw` | "`NAME` drew a card." |
| `PlayPoint` | "`NAME` played 7♥ for points." |
| `PlayPermanent` (non-Jack) | "`NAME` played Q♦ as a permanent." |
| `PlayPermanent` (Jack) | "`NAME` stole your 10♥ with J♣." |
| `Scuttle` | "`NAME` scuttled your 7♥ with 9♠." (target card comes from the frozen pre-state description) |
| `OneOff` | "`NAME` played 9♥ as a one-off." (+ target clause when `Target` is set). A 5 adds what it does: "`NAME` played 5♥ as a one-off to draw 2 cards." *(amended 2026-09-28)* — the card's effect, never the count: on the real counter-window path the recap shows the 5 before it resolves, so the count (`drawn`, §2.7) is never read here (R14). |
| `Counter` | "`NAME` countered with 2♠." |
| `Decline` | **never shown** — Decline entries are filtered out of the recap before the "skipped when empty" check *(amended 2026-09-27, ApisMellow)*. "`NAME` let it resolve." adds nothing the one-off's own line and the board don't already say. *(The original reason, the synthetic acknowledgment, was retired 2026-09-29, §4.3; the filter stays.)* |
| `SevenPick` | "`NAME` revealed the top of the deck and played 5♥ for points." — **the unchosen card is never named** (R16). *(Amended 2026-09-27, ApisMellow: was "revealed two cards", which is false when the deck held one card.)* |
| `DiscardPair` | "`NAME` discarded 2 cards." — **never the indices, never the identities**; the cards are in the scrap pile, which the viewer can browse (R6) |
| `Pass` | "`NAME` passed." |

**No recap line may name a card the viewer is not entitled to see.** Audited against the table: every card named above is one that became public by being played or scrapped. The 7's unchosen card returns to the top of the deck (`engine/apply.go:431-433`) and is never named — it is known to the player who revealed it, which is inherent to the rules and not a UI leak (**OQ-11**).

**Presentation.** At most the last 6 entries, oldest first; if more, a "+N earlier" affordance expands the rest. Each line pairs with a theme `mini` card face where a card is named. Dismissed by one tap; the dismissal is also what stamps `lastSeenSeq`.

**The idle last-move line** on the board's center strip (R20, `docs/design.md` §6) is the **last `isRecapVisible` entry in `history`**, never raw `lastMove` *(amended 2026-09-28, W13 GameScreen review)*. `lastMove` can be a filtered-out kind such as `Decline`, and showing it told the acting player whether the opponent had held a 2.

*Amended 2026-09-28 (playtest friction), `lastMoveLine` in `lib/recap.ts`:* the line is the formatter's sentence for the viewer, for the viewer's own move too ("You played 7♥ for points."), never the raw engine description. When a 5 has resolved, it reports the count from `drawn` (§2.7): "Alice played 5♥ as a one-off and drew 2 cards.", or, when the chain ended on a counter, "Alice countered with 2♥. Alice drew 2 cards." It reads `drawn` only on entries from the last visible one onward (anything after it is a Decline), so a 5 that went through a counter window (`drawn` on the Decline) and one that resolved at once (`drawn` on the 5) read the same line; the board only renders after any counter prompt, so the 5 has resolved by then. A count only; no line ever names a drawn card.

**Player-facing wording for engine strings** *(amended 2026-09-28, playtest friction)*. No raw `Describe` text reaches the screen. The recap and idle line use the formatter above. The viewer's own options — the staging bar, the ambiguity chooser (§6.4) and the counter buttons (§4.3) — go through `plainMoveText` (`lib/recap.ts`): an instruction plus, where the card does something, one short clause from the engine's `RULES.md` ("Scuttle their 4♣ with 9♣: both cards go to the scrap.", "Play 5♥ as a one-off: draw 2 cards.", "Counter with 2♦: stop their card."). A 9 follows the engine, not RULES.md's wording (`engine/apply.go` v0.2.1 case Nine returns a point card to its original `Owner`; logged as C-1 in `docs/loop-log/engine-issues.md`): where the UI knows the target (`nineReturn`, from public board state) it says "back to their hand; they can’t play it next turn" or, for a card they stole from you, "your stolen card comes back to your hand" (with the target named since 2026-09-29, below); without that context, "send a card back to its owner’s hand". *(Amended 2026-09-29, card labels: every effect clause now lives in `lib/cardText.ts`, the one source shared with the card popover, the selected-card hint and the Rules sheet, and was tightened so no staged line is cut off at 393 wide.)* A 7's dead-end scrap reads "Scrap X: no revealed card can be played." An unrecognised string passes through sentence-cased rather than throwing, because it labels a control the player still has to use. The error and boot-failure screens show plain copy and at most a code. The test hook's `description` stays raw engine text (it is not UI).

**Result screen** *(amended 2026-09-28, playtest friction)*: under the headline, one third-person line naming the winning move, `winningMoveLine` in `lib/recap.ts`, from the last visible history entry and the winner's final points and goal (read off the scoreboard): "Alice won by reaching 21 with the 10♥.", "Blake won by reaching 22, stealing the 9♥ with the J♣.", "Alice won by playing the K♠, which lowered the goal to 14."; any other move falls back to "`NAME` won with N points. Last move: …". Every card it names was played face up; no hand renders (R2). *(Engine v0.2.1, 2026-09-29: points that reach a player during the opponent's turn win at the start of that player's next turn, so the winner can be the player who did not make the last move, and at game over `Active` equals the winner. When the last visible entry is the opponent's 2 one-off, `winningMoveLine` says so: "Blake reached 15 of 14 when Alice's 2♥ scrapped the J♠, and won at the start of their turn." A 6 reads "… scrapped every permanent, and won at the start of their turn." Only the played card and the board-visible target are named, never a hand card.)*

*Amended 2026-09-29 (playtest wording, `loop/r15-wording`).* Recap and prompt lines say what happened, under the same R14 rule as the 5: a line that can render before its one-off resolves states the card's effect, never its outcome, and reads nothing a resolution sets (`drawn`, a later Decline).
- **3:** "`NAME` played 3♦ as a one-off to take a card from the scrap." It never names the card: before resolution that is the actor's intent (§3.2 drops `pending.scrapIndex` for this reason), and `AppliedMove` carries no taken card. Naming it after resolution, on the idle line, needs a bridge field like `drawn` (open).
- **4:** "`NAME` played 4♠ as a one-off: you’ll discard 2 cards (or all you have, if fewer)." (actor's view: "`NAME` will discard …"). The idle line, which only shows a 4 when the target's hand was empty, drops the clause. While the viewer picks discards the centre line is `discardPromptLine`: "Alice's 4♠: choose 2 to discard." ("discard your last card" for a one-card hand).
- **Counter:** each 2 names what it stops, from the entry before it: "Blake countered with 2♣ to stop your 5♥." The counter prompt reads the run it shows; the recap panel reads `history` (so a 2 whose one-off was already seen still names it). Both are the same on both paths. On the idle line, a chain ending in an odd number of 2s says the one-off was stopped: "Blake countered with 2♣: your 5♥ was stopped.", or for three 2s "… to stop your 2♦. Your 9♥ was stopped." Only Counters and the origin are counted, so a trailing Decline changes nothing (R14).
- **Glasses:** an 8 as a permanent recaps "as glasses", as staging says.
- **Steal-back:** a Jack steal whose point card was put down by the actor (the last `PlayPoint` of that card in `history`) reads "`NAME` took back the A♠ you stole, with J♦." ("You took back your A♠ with J♦."), directly or through a 7; otherwise "stole". The owner is the player of the latest `PlayPoint` of that card, since a card recovered from the scrap can be put down by the other player.
- **Staging and chooser** name the target from public board state (`optionContext` in `lib/recap.ts`, mirroring the bridge's `targetCardFor`): "Play 9♠: send K♣ back to their hand; they can’t play it next turn.", "Play 9♠: your stolen 7♦ comes back to your hand.", "Steal their 7♦ with J♣." / "Take back your 7♦ with J♣.", "Play 2♣ as a one-off: scrap their K♦." A 2 aimed at a card is headed "Scrap K♦" instead of its name. A 5 stages the count it will draw from the viewer's own hand and the public deck, capped at `HandLimit` 8 after the 5 leaves the hand: "draw 1 card" with 8 in hand, and "your hand is full, so you draw nothing" at 9 (a 9's return can push a hand past 8). The count is a prediction made at staging; a counter-back that later shrinks the hand can make the real draw larger, which the idle line then reports from `drawn`.
- **Result:** the goal beside the total, "Alice won by reaching 16 of 14 with the 10♥.", and the tally is labelled "Match: Alice 0 – Blake 1".
- **Blocked reasons** (`lib/blockedReason.ts`, text in `lib/cardText.ts`), shown only after the engine has refused, from the viewer's own hand and public board state: the dimmed-card popover says "A 9 just sent this card back …", "Play one of the revealed cards first.", "Their Queen protects their cards from your Jack." or "They have no point cards for your Jack to steal.", else the generic line. A tap that did nothing puts one line in the action bar until the next tap: the deck gives "Your hand is full (8 cards)." or "The deck is empty."; a 2, 9 or Jack tapped onto a card a Queen protects gives "Their Queen protects that card from your 9." The Queen reason appears only when the Queen is the cause, that is, when the card is one that rank could otherwise target (engine v0.2.1 LegalMoves): for a 2, a permanent or a Jack-topped point on either side ("Your own Queen protects that card." on the viewer's side); for a 9, any opponent card; for a Jack, an opponent point. Any other refused tap gets no line. The reason never reads the opponent's hand, hand count or the scrap. A dimmed-card tap while another card is selected clears that selection first, so no stale target stays lit behind the popover.

### 4.7 The 5's draw reveal *(added 2026-09-29, issue #27)*

When a 5 resolves and draws cards, the player who drew sees them: the cards leave a face-down deck, travel into that player's hand and turn face up. A tap anywhere, the Continue button (`draw-reveal-continue`), or 3 seconds of waiting (`DRAW_REVEAL_MS` in `lib/drawReveal.ts`) goes on. The panel (`DrawRevealPanel`, `data-testid="draw-reveal"`) shows "You drew N card(s)" and, at the drawer's own next view, the drawer's whole hand with the drawn cards marked. Before the pass it shows **only the drawn cards** (see "Which cards").

**Who sees it.** Only the drawer, on the drawer's own screen. The drawer is the 5's player: `fiveDrawer(history, i)` in `lib/recap.ts` reads the entry whose `drawn` is set (§2.7) and walks back over Counters to the one-off that opened the chain, reading kinds and `by` only. The opponent's screens never carry a reveal, and the handoff that follows one carries nothing of it.

**When** *(re-derived 2026-09-29 with the §4.3 ruling)*. Never before the 5 has resolved; otherwise as soon as the drawer holds the phone:

- *Before the pass.* Whenever the drawer's own apply resolved their own 5, that is, no counter window stood between the draw and the pass: the opponent held no 2, so the engine resolved the OneOff (or the 7's pick) at once, or the drawer's own Counter closed an even chain. The mover still holds the phone and the handoff has not been shown, so the reveal comes first and continuing raises that handoff. The old condition ("the responder holds no cards") is gone with the synthetic ack; showing the draw here now tells the drawer nothing the ruling's accepted leak doesn't already.
- *Otherwise at the drawer's next own view*: the opponent's Decline resolved the 5 in a counter window, so the cards arrived while the opponent held the phone. The draw shows at the drawer's board (`none`) or counter window (`ack`), whichever comes first. The ack counts because a counter there could take a drawn 2 out of the hand before the next board.
- A 5 that drew nothing (empty deck, or the hand at `HandLimit`) shows nothing. A 5 that drew one card shows one. A cancelled 5 has `drawn: null` and shows nothing.

**Which cards.** The store never holds a drawn card. `game.drawReveal` is `{ to, indices, beforePass }`: indices into the drawer's own `you.hand`, and the panel reads the identities from that envelope when it renders. The drawn cards are the end of the hand (engine v0.2.0 `engine/apply.go` `resolveOneOffWith` case Five appends them). Between the draw and the drawer's next own view only the opponent moves, and the only opponent move that adds to the drawer's hand is a 9 (case Nine), which runs `endTurn` first and then appends and freezes the returned card. So on the drawer's own normal turn (`phase === Normal`, `active === viewer`) a frozen tail is a 9's returned card and is skipped; anywhere else no `endTurn` has handed the drawer the turn, a freeze can be stale, and no 9 has resolved, so nothing is skipped (`drawnHandIndices` in `lib/drawReveal.ts`). The reveal comes before any move of the drawer's own.

*Before the pass, only the drawn cards* *(amended 2026-09-29, #27 review)*. The phone is about to change hands, so the panel must not put the rest of the drawer's hand on screen. `drawReveal.beforePass` is set on that path only; GameScreen then hands the panel just the cards at `indices` (all marked drawn) and nothing else of `you.hand`. At the drawer's own next view (`beforePass: false`) the whole hand with the drawn cards marked is shown, as it is their own screen. `game-draw-reveal-wasm.test.ts` checks every reveal against the cards the bridge actually drew across 100 seeded games.

**Store rules** (`game.svelte.ts`):

- *Memory only.* `drawReveal` is never written to the save, and the snapshot shape is unchanged (no `v` bump). Before the pass, the save already holds the handoff the reveal gives way to, written by `apply()` exactly as without a reveal; in memory the curtain stays `none` with the mover's own envelope (no legal moves: the turn has passed) until `dismissDrawReveal()` raises that handoff, dropping the envelope, the viewer and mover-only `index` keys, and writing nothing.
- *Nothing else moves while it is up.* `apply()`, `refresh()` and `advanceCurtain()` throw. `dismissDrawReveal()` is idempotent.
- *Shown once.* A per-player memory mark records the resolving seq last shown. `newGame()`, `goHome()` and a discarded save clear the reveal and the marks.
- *Reload.* A reload mid-reveal before the pass comes back to the saved handoff; at a board or an ack it comes back behind the resume gate (§5.7), and the reveal is not replayed there. *(Amended 2026-09-29, §4.3 ruling.)* `restore()` sets each player's mark to their saved `lastSeenSeq`. A draw resolved by that player's own move was shown before the pass, so a reload (or Home → Resume) while the opponent holds the phone does not show it again at the drawer's next view; one resolved by the opponent's Decline is later than that stamp and is still shown. The cost: a reload in the 3 seconds of a before-the-pass reveal itself drops the rest of it (the cards are in the drawer's hand, unmarked). It was one below the stamp while the synthetic ack deferred most draws; with before-the-pass now the common path, that repeated the draw after every mid-turn reload.

**GameScreen gate.** `DrawRevealPanel` mounts in place of the board or the counter prompt only while `game.drawReveal` is up, the curtain is `none` or `ack`, and both the exposed envelope's viewer and `game.viewer` are the drawer. It never mounts behind a withheld curtain. The in-game menu floats top right over it.

**Input.** Focus moves to Continue on mount. *Pointer* *(amended 2026-09-29, #27 review)*: a click continues only if its press (`pointerdown`) landed inside the panel after it mounted. The panel can mount under a finger still down from the previous screen (the 600 ms ring hold on iOS), and that finger's lift must not dismiss it. *Keys*: the panel uses `lib/keyGuard.ts` like the curtain screens. A click that a key produced (`detail` 0) counts only if that key went down after the panel mounted and is not an auto-repeat, so a key held from the previous screen can't skip the reveal. The guard keeps no state past the key's own task, so letting go of a held key never swallows the next tap. Once Continue unmounts, GameScreen's keyboard focus rescue puts focus on the board; while the panel is up the rescue finds nothing to focus and leaves Continue alone.

**Menu.** The in-game menu floats over the panel. While it is open *(amended 2026-09-29, #27 review)* the 3-second wait stops (the countdown bar holds still) and clicks on the panel are ignored; when it closes the wait resumes with the time it had left, so the total showing time is still 3 seconds. The 3-second wait is not a curtain auto-advance (§4.5): the reveal sits outside the curtain, and before the pass it only brings the handoff sooner, which then waits for a tap like any handoff.

**Reduced motion** (the setting or the OS): no travel and no flip; the faces are simply there, and the wait is still 3 seconds.

*Glasses.* Under an opponent's glasses-8 the opponent's view already includes the drawer's whole hand (R7, §3.2); the reveal adds nothing to it.

---

## 5. Component breakdown

### 5.1 Stack and conventions

Svelte 5 + TypeScript + Vite + `vite-plugin-pwa` (A4). DOM/CSS/SVG only — **no `<canvas>`** (A4: Playwright needs real selectors, and the playtest judge depends on them).

Binding conventions, because A4 flags Svelte-5-vs-legacy drift as a live risk (PRD §9):

- **Runes only.** `$state`, `$derived`, `$props`, `$effect`. No `export let`, no legacy reactive `$:` statements, no `svelte/store` writables in new code.
- Shared state lives in `.svelte.ts` modules exporting rune-backed objects (§5.3), not in Svelte stores.
- `svelte-check` runs in the mechanical gate and must be clean (`loop-workflow.md` §5.3a).
- **Pin the official Svelte 5 LLM docs file in-repo** at `docs/vendor/svelte-5-llms.txt` (A4, PRD §9). Every developer brief names it as required reading.
- Every interactive element carries a stable `data-testid`. The judge and the R11 invariant walk select on these; they are part of the contract, not debug scaffolding, and removing one is a breaking change.

### 5.2 Component tree

```
App.svelte                        # ensureEngine(), global error boundary, route switch
├── HomeScreen.svelte             # R1: names, New game, Resume (if snapshot), Rules; "Card style" picker (§5.6)
├── GameScreen.svelte             # the board host; owns the curtain overlay
│   ├── Curtain.svelte            # R13 — full-viewport; board is UNMOUNTED behind it
│   │   ├── HandoffPanel.svelte   # "Pass the phone to NAME"
│   │   ├── RevealGate.svelte     # press-and-hold + two-step fallback (§4.5)
│   │   └── RecapPanel.svelte     # R20 (§4.6)
│   ├── Board.svelte
│   │   ├── ScoreBar.svelte       # R5: both totals + thresholds, always visible; names whose turn it is (§4.2)
│   │   ├── OpponentZone.svelte
│   │   │   ├── OpponentHand.svelte   # backs + count; face-up under glasses-8 (R7)
│   │   │   ├── PointRow.svelte       # shared with PlayerZone
│   │   │   └── PermanentRow.svelte   # shared
│   │   ├── CenterZone.svelte
│   │   │   ├── DeckPile.svelte       # count only; tap = MoveDraw (R10)
│   │   │   └── ScrapPile.svelte      # tap = browser (R6); pick mode for the 3
│   │   ├── PlayerZone.svelte
│   │   │   ├── PointRow.svelte
│   │   │   ├── PermanentRow.svelte
│   │   │   ├── watched marker       # while the opponent has glasses (§3.2)
│   │   │   └── handTray slot        # PlayerHand.svelte, or SevenRevealPanel while the 7's choice is open
│   │   │       └── HandCard.svelte   # dim when no legal play (R9); FrozenBadge (R8)
│   │   └── DropZones.svelte          # "Points" / "Permanents" / "One-off" targets
│   ├── StagingBar.svelte         # R9/R12: staged move + Confirm/Cancel
│   ├── AmbiguityChooser.svelte   # R11: >1 move for one (card, target) pair
│   ├── CounterPrompt.svelte      # R14 — the counter window (§4.3)
│   ├── DrawRevealPanel.svelte    # issue #27 — the 5's draw, drawer only, in place of the board or counter prompt (§4.7)
│   ├── DiscardPicker.svelte      # R15
│   ├── SevenRevealPanel.svelte   # R16 — mounted here, gated on viewer === active; RENDERS in Board's `handTray` slot, not here (see below)
│   ├── ScrapBrowser.svelte       # R6 — browse mode and pick mode
│   ├── GameMenu.svelte           # in-game menu: Rules, Card style, Home, New game (§5.5, §5.6 rule 5, §5.7)
│   └── StuckState.svelte         # §2.10 — E-1/E-2 diagnostic + scenario export
├── ResultScreen.svelte           # R2/R3: win or stalemate, tally, final score, Rematch, Home
└── RulesScreen.svelte            # R17 — overlay, never unmounts the game
```

`PointRow.svelte` renders a `PointEntry` including its `JackStack`: only the top (newest) Jack is drawn, full card size, offset downward only, so the point card's upper-left corner index stays visible above it; extra Jacks are not drawn separately, and at 2 or more a thin "deck thickness" edge (two card-back slivers past the Jack's bottom-right corner) shows there's more than one. No count number and no player colour render on the stack; the count is exposed only via the aria-label ("stolen, N Jacks"), and only the top Jack is a legal tap target — including as the target of a 2 or a 9. Buried Jacks are never targetable and never answer a tap (the engine only ever offers the top Jack). An ownership badge is driven by `Controller` (§2.8(f)) when the controller differs from the owner. A stolen point renders in the **controller's** row — which is where the engine already puts it (`engine/state.go:3-22`) — with a marker indicating the original `Owner`, so a player can see at a glance which of their points is on loan. (Amended 2026-09-28, ApisMellow — supersedes "fanned above" and the multi-Jack cascade; the card-face redo the same day further supersedes the "top strip" phrasing with the corner index; see `docs/design.md` §6–§7.)

*Amended r16 (2026-09-29 playtest, friction 3):* the board still shows no count; extra Jacks are only the thin edge (owner ruling, 2026-09-29, after a brief "×N" pill was tried and withdrawn). The card's button carries one accessible name for the whole stack, with player names and never a raw id: "10 of Hearts, stolen from Blake, 3 Jacks on it, top Jack of Spades" (a single Jack: "…, Jack of Spades on it"; an even stack, stolen back, drops "stolen from"). Board passes `names` down to both zones' `PointRow` for it. The old "on loan from player 0" text is gone. Evidence: `point-row.test.ts` (r16 cases), `point-row-stacking.spec.ts`.

**Accessible card names** *(r16, 2026-09-29 playtest)*. Every card button is named in words, the same in every theme: `cardSpokenName(card)` ("King of Hearts"), exported from `lib/theme` (index) beside the glyph mapping it mirrors, so no rank or suit rendering leaves the theme (§5.6 rule 1). A bitmap face's `<img>` stays `alt=""`; the name is the container's `aria-label`. Hand cards: "Ace of Clubs", plus ", frozen" or ", staged". Permanents: the name plus "glasses" for a sideways 8 and the in-play badge ("King of Diamonds, Goal 14"). The 7's revealed cards, scrap picks and the scrap browser's cards are named; the opponent's hand is named only when it is face up under glasses. The deck reads "Deck, 41 cards" and the scrap "Scrap, 3 cards, King of Hearts on top" (the scrap is public, §3.2). **Privacy:** a name is computed only from a card the viewer's view already shows face up; a back (the opponent's hidden hand, the deck) has no name at all. Evidence: `card-names-a11y.test.ts` (both themes; the hidden-hand check was mutation-tested by labelling the backs).

**`SevenRevealPanel` mounting vs. rendering.** GameScreen mounts `SevenRevealPanel`, gated on `viewer === active` — that gate is where R16's privacy boundary lives and it stays in GameScreen, not in Board. The panel itself renders through Board's `handTray` slot, the same slot `PlayerHand` occupies, so while the 7's choice is open the reveal panel takes the hand's place in the layout instead of appearing as a separate overlay; the slot reverts to `PlayerHand` once the sub-move resolves. *(Amended r16, 2026-09-29 playtest, friction 4:)* the panel also shows the viewer's own hand (`you.hand`) as a read-only row of `mini` faces beside the revealed cards (no buttons, no testids; the hand has no legal move in this phase), so choosing never hides your hand. The panel no longer reaches into the hand slot's 12 px lift room, where the "can see your hand" pill sits; the two no longer overlap.

**W25 playtest fixes** *(2026-09-28, merged `b8238db`)*:

- **ResultScreen** shows the tally labelled "Match: `NAME` N – `NAME` N" (2026-09-29), and under it "Final score: `NAME` N – `NAME` N" (`data-testid="final-scores"`), and a Home button (`result-home`) beside Rematch. `App.svelte` reads the final points verbatim off the viewer-relative `scoreboard` and maps them to seats (§3.3 rule 2); nothing is recomputed. Home calls `game.goHome()` (§5.3). The screen still renders neither hand.
- **OpponentHand** pluralises its count: "1 card", "5 cards".
- **HomeScreen** fills the name fields once, at mount: from the saved game's `names` when a snapshot exists (so names survive a reload while a game is saved, §5.7), otherwise from the session's names when someone set them this session, otherwise from the last-used names in settings *(R10, 2026-09-28)*. The defaults "Player 1" / "Player 2" and blank names leave the field blank so the placeholder shows. After mount the fields belong to the user. New game saves the typed names (trimmed) to settings.

**In-game menu** *(2026-09-29, `loop/r12-menu`)*. One menu button (`menu-button`, 44×44, `aria-label` "Menu", `aria-haspopup="dialog"`, `aria-expanded`), in one of two places and never both: in `ScoreBar`'s reserved `menu` slot on the live board (Board passes GameScreen's snippet through), and fixed top right of the screen, under the safe area, in a score-bar-high box with the board gutter, on every other game screen (handoff, reveal, recap, counter prompt). Those screens are full width, so on a desktop the button sits at the screen's edge rather than the column's; on a phone the two spots coincide (within 0.5 px). The panel drops from under whichever button opened it. It opens `GameMenu`, a dialog (`game-menu`) dropping from the top-right corner over a backdrop (`menu-backdrop`): Rules (`menu-rules`), Card style (`menu-theme-option-<id>`, §5.6 rule 5), Home (`menu-home`), New game (`menu-new-game`, behind the §5.7 confirm) and Close (`menu-close`). Focus moves to the first item; Tab stays inside; Escape, Close and a backdrop tap close it and return focus to the button. While the menu or its Rules sheet is open, Escape is handled in a window capture listener and stopped there, so GameScreen's Escape (clear a selection or staged move) never fires under it. *(Amended r16, 2026-09-29 playtest, friction 8:)* Rules opens over the menu, which stays open underneath; closing the sheet (Close or Escape) comes back to the menu with focus on its Rules item, and a second Escape closes the menu. It used to close the whole menu.

*Curtain policy.* The menu is available on every game screen, curtains included, as §5.5 requires for the rules. That is safe because the menu carries no game state (no card, count, score or hand; the players' names appear only in the New game confirm), reads only the settings store and the theme catalog, and calls no store method except the host's Home (`goHome()`) and New game (`newGame()`). Opening it, Rules and a style swap never move the curtain, fetch a view, stamp `lastSeenSeq` or write the save, and the board stays gated on curtain `none` as before, so nothing the menu does can mount the board behind a curtain. The button and the panel are identical for every `HandoffReason` (§4.5 invariance): `game-menu.svelte.test.ts` 'menu invariance behind the curtain' asserts the floating button's `outerHTML` and the open panel's `outerHTML` are byte-identical across `turn`, `counter`, `discard` and `seven-return` *(the synthetic-ack comparison was dropped with the synthetic ack, 2026-09-29)*. A half-finished New game confirm is dropped whenever the menu closes, so reopening it always shows the list. Evidence: `web/tests/unit/game-menu.svelte.test.ts`, `web/tests/unit/game-go-home.test.ts` and `web/tests/e2e/menu.spec.ts`.

### 5.3 State design

Five rune-backed modules under `lib/stores/`. Each has exactly one owner and no cross-writes.

```ts
// lib/stores/game.svelte.ts — the only holder of engine-derived state.
class GameStore {
  envelope   = $state<Envelope | null>(null);
  viewer     = $state<PlayerId>(0);
  lastSeenSeq = $state<Record<PlayerId, number>>({ 0: 0, 1: 0 });
  error      = $state<EngineError | null>(null);

  view        = $derived(this.envelope?.state ?? null);
  legalMoves  = $derived(this.envelope?.legalMoves ?? []);
  isViewerActive = $derived(this.view?.viewer === this.view?.active);

  async newGame(opts: NewGameOpts): Promise<void>
  async apply(moveIndex: number): Promise<void>   // then feeds the curtain machine
  async refresh(): Promise<void>                  // re-fetches __cuttleView(this.viewer) only
}
```

*(Amended 2026-09-27, round 2.)* There is **no public viewer switch**. `setViewer(p)` was removed because it could expose the non-holder's view without a curtain (§2.4, §3.3 rule 4). The viewer changes only inside the curtain machine's transitions. `viewer` is nullable and is `null` while the curtain withholds the board. `refresh()` takes no argument and is allowed only at curtain `none` or a real counter window.

*(Amended 2026-09-29, issue #27.)* `drawReveal: { to, indices } | null` and `dismissDrawReveal()` carry the 5's draw reveal (§4.7). Memory only, indices only, and while it is up `apply()`, `refresh()` and `advanceCurtain()` throw.

- **`curtain.svelte.ts`** — the §4.2 machine. Pure: `next(pre, appliedMove, post) -> CurtainState`. Its purity is what makes the transition table of §4.4 unit-testable without WASM (§7.1).
- **`staging.svelte.ts`** — R9/R12 selection pipeline (§6). Holds `selectedHandIndex`, `stagedMoveIndex`, `candidateMoveIndices`, `highlightedTargets`. Cleared on every `apply` and on every viewer change. `clearSelection()` *(W25, merged `b8238db`)* returns a selected card to idle; it does nothing while a move is staged, while the ambiguity chooser or the 3's scrap pick is open, or at a discard position (§6.1).

*(Amended 2026-09-28, W25 playtest fixes, merged `b8238db`.)* `newGame()` raises the opening curtain (§4.2) with `envelope` and `viewer` both `null`; the first actor's view is fetched only after their reveal. `goHome()` is allowed only at curtain `result`: it drops the envelope, the viewer and the pending curtain context, and returns to the home screen. The finished game is already persisted, so Home can still Resume it to see the result. Any other curtain kind throws. *(Superseded 2026-09-29, in-game menu, `loop/r12-menu`: `goHome()` is allowed at every curtain kind. It writes nothing and calls no engine function; it drops the envelope, the viewer, the history (with its mover-only `index` keys), `seq` and the pending curtain context. The save already holds the exact position, because it is written on every apply and curtain step, so Resume restores it the way a reload does, curtain first. Evidence: `web/tests/unit/game-go-home.test.ts` round-trips Home → Resume through the real engine at handoff, reveal, recap, a real ack, `none` and `result`, with the save byte-identical *(the synthetic-ack case became "a one-off Alice cannot answer", 2026-09-29)*; a game resumed at every step ends exactly where the same game played without Home does.)*
- **`session.svelte.ts`** — R3 tally, player names, `lastDealer`, `lastSeed`. ~~Memory only; never persisted~~ *(superseded 2026-09-29, playtest: a 0–2 tally read 1–0 after a reload; `loop/r14-resume`)*: **the tally survives a reload.** It is kept in `sessionStorage` under `cuttle-web:tally` as `{ names, tally }`, so it lives as long as the browser tab (PRD §4's "browser session") and never enters the game snapshot (§5.7). It belongs to the ordered name pair: `setNames` with the same pair keeps it, a different pair takes the tally stored for that pair (a reload putting the saved game's names back) or starts at 0–0 and replaces the stored one, and swapping seats counts as a different pair. There is no other "new match": Rematch and New game with the same names keep counting. Names, `lastDealer` and `lastSeed` stay memory only (the snapshot carries names and dealer for a resumed game). Storage is best-effort; a blocked or corrupt value reads as 0–0 and never breaks play. A `SessionStore` built without a storage dependency touches none; only the app singleton gets `sessionStorage`.
- **`settings.svelte.ts`** — card theme (§5.6), reduced motion, hold-vs-two-step reveal preference, and the last-used player names (`lastNames`, R10, 2026-09-28). Persisted separately from game state, under `cuttle-web:settings`.

**One-way data flow.** Components read `$derived` values and call store methods. No component calls the bridge directly, and no component mutates another component's state.

### 5.4 Bridge module boundary

```
lib/bridge/
  wasm.ts        # ensureEngine() — load + readiness (§2.3). Nothing else.
  raw.ts         # thin typed wrappers over the __cuttle* globals; JSON.parse only.
  engine.ts      # THE public API. Returns BridgeResult. The only import for stores.
  types.ts       # §2.7 types. No runtime code.
  schema.ts      # dev/test-only runtime validation of envelope shape.
```

`engine.ts` is the seam A2 exists to create. ~~In v2 its implementation is replaced with a WebSocket client speaking the identical `Envelope`; no store and no component changes.~~ *(Superseded 2026-09-29, two-phone plan §2.)* `engine.ts` stays the local-play bridge. It can't simply be swapped for a socket: `GameStore.apply` is synchronous, the server pushes moves the store never asked for, and the curtain machine means nothing when each player has a phone. Online play instead adds `web/src/lib/online/` (connection, frames, HTTP; W11) and `OnlineGameStore` (W12), and `GameScreen` reads either store through the `TableSource` interface (W10, `lib/stores/tableSource.ts`). The wire contract is §2.12. What survives as a review criterion: the envelope is the only game data either store holds, both validate it with `schema.ts`, and no bridge-shaped or rule logic leaks into a component.

`schema.ts` validates envelopes against the §2.7 shape in dev and test builds and is tree-shaken from production. It is the tripwire for the §2.8 normalization bugs — particularly `JackOwners`, which typechecks as an array while being a base64 string at runtime and would otherwise surface as a rendering oddity in the rare Jack-chain case rather than as a loud failure.

### 5.5 Rules screen (R17)

Content is the engine repo's `RULES.md` (PRD R17), converted to a Svelte component **at build time** by a small script in `scripts/`, so there is no runtime Markdown parser in the bundle and no risk of the rules text drifting from the engine that implements them. The build script records the engine commit it read from and stamps it in the footer of the screen.

*Amended 2026-09-28 (playtest friction):* shipped first as a short hand-written cheat-sheet (`RulesSheet.svelte`, opened by the home screen's Rules button): how to win, one line per one-off rank (Ace, 2, 3, 4, 5, 6, 7, 9), a turn, points and scuttling, and the permanents (the 9 line covers a stolen card coming home; the Jack line notes a 9 also ends a steal; the 7 line covers the dead-end scrap). The sheet is a dialog: focus moves into it on open and back to the Rules button on close, and Escape closes it. Every line is sourced from the engine's `RULES.md` at v0.2.1 and cross-checked against `engine/apply.go`; no suit glyphs (§5.6 rule 1: suits are named). The build-time `RULES.md` screen with the engine-commit footer (R17.1) is still open. *In-game access (R17.2), 2026-09-29:* the in-game menu's Rules item opens the same `RulesSheet`, unchanged, over the game screen on every game screen (board, handoff, reveal, recap, counter prompt). ~~The menu closes first and focus moves to the menu button, so closing the sheet returns focus there~~ *(superseded r16: the menu stays open under the sheet, and closing the sheet returns to the menu, focus on its Rules item, §5.2)*; Escape closes it without reaching the board's own Escape (clear a selection). Opening it calls no store method: the curtain, `lastSeenSeq` and the save are untouched and a recap stays up.

*Amended 2026-09-29 (card labels, `loop/r11-labels`):* the sheet's one-off and permanent lines are built from `lib/cardText.ts`, the same effect clauses the card popover, the selected-card hint, the staging line and the ambiguity chooser (`plainMoveText`) use, so the sheet and the table can't disagree. Each line opens with the rank and its Classic name ("Ace, Board Wipe:", "5, Draw Two:"), then the effect clause, then any extra detail (the 2's counter use, the 9's freeze and stolen-card return, the 7's one-card and dead-end cases). The Queen's line is about targeting, as the engine is: their 2s, 9s and Jacks can't target your other cards, and a Queen itself can still be hit (staged as "Play Q♠: …", the short form that fits 393 wide), and it doesn't stop a scuttle, an Ace, a 4 or a 6. *(Reworded 2026-09-29; the 9's stolen card "comes back to your hand".)* *(Engine v0.2.1, 2026-09-29: the Win line says points that reach your side during the opponent's turn win at the start of your next turn, never off-turn; the Jack line says a 2 scraps only the top Jack of a stack, and the point card goes to whoever controls the next Jack, or back to its owner. Wording lives in `RulesSheet.svelte` and `lib/cardText.ts`.)*

Presented as a scroll-locked overlay above the board. **It never unmounts `GameScreen`** ("without disturbing the game"), and it is reachable from the menu in every phase including mid-curtain — a player who forgets a rule while deciding whether to counter must not have to leave the decision. Opening it does not stamp `lastSeenSeq` and does not dismiss a recap.

### 5.6 Card art theme seam

**The functional baseline is vector/SVG/CSS card faces** (A4, R19, PRD §10 amendment A-1). Bitmap art is a *theme layer* delivered by the separate P-ART phase (`loop-workflow.md` §11, PRD **R21–R23**) and must be swappable without touching game logic.

PRD A-1 is explicit that generated art is "never a dependency of game logic or of any R1–R20 acceptance criterion." **This section is the seam R23 names.** It is written now, in P1a, so that P-ART has a fixed target to generate against and the loop can verify R1–R20 with zero art present.

The seam is a single component with a fixed contract, plus a registry:

```ts
// lib/theme/types.ts
export interface CardTheme {
  id: string;                       // 'vector' | 'art-v1' | …
  label: string;
  /** Any Svelte component honouring CardFaceProps. */
  Face: Component<CardFaceProps>;
  Back: Component<CardBackProps>;
  Table?: Component<TableProps>;    // optional background skin
  assetBytes: number;               // declared precache cost (§5.8)
  available: () => boolean;         // false until its assets are cached
}

export interface CardFaceProps {
  card: Card;
  size: 'hand' | 'field' | 'mini';
  state?: 'normal' | 'dimmed' | 'highlighted' | 'staged' | 'frozen';
  variant?: 'standard' | 'glasses'; // defaults to 'standard'; reflected as data-variant
}
// CardTheme also carries an optional `names?: Partial<Record<Rank, string>>`
// (card labels, 2026-09-29): per-rank card names; any rank left out keeps
// its Classic name.
```

**`variant`** *(added 2026-09-28, W24 glasses 8, merged `1fbe15f`)*. `'standard'` is the ordinary rank-and-suit face. `'glasses'` is an 8 in play as a permanent (R7): `PermanentRow` passes it for every 8 in the row, since the permanents row holds only Queens, Kings and glasses-8s. The container lays that card on its side: the box itself is landscape (one card-height wide, one card-width tall), with no CSS transform, so layout, clipping and hit-testing see the same rectangle, and the element, testid and `perm:` key are unchanged (`data-orientation="sideways"`). The theme paints the glasses face for a landscape box. In the vector theme it is one full-bleed SVG: goggles on a stained-glass ground tinted by suit (hearts red, diamonds amber, clubs green, spades blue-black), no rank, and a small suit pip in the top-left corner as the only identity mark, with `aria-label` "Glasses, `suit`". A theme with no glasses art falls back to its standard face.

Rules that keep the seam real:

1. **Nothing outside `lib/theme/` renders a rank or suit glyph.** Every card pixel in the app comes from `<CardFace>` or `<CardBack>`. A component that draws its own "7♥" has broken the seam; code review rejects it.
2. **Layout is the theme's business; geometry is not.** The aspect ratio (one token, `--cuttle-card-aspect`, about 1.3 height to width — amended 2026-09-28, ApisMellow, from 2.5:3.5; `docs/design.md` §5) and the three size tokens are fixed by the app in CSS custom properties. Every card at every size shows its rank and suit as an upper-left corner index (`docs/design.md` §7), except the `glasses` variant above. A theme paints inside a box it does not get to resize, so swapping themes never reflows the board.
3. **State styling is the theme's responsibility to honour, not to invent.** `state` is passed in; the theme renders it. Highlight/dim/stage semantics belong to §6 and must look consistent across themes.
4. **`vector` is always available and is the fallback.** It has zero external assets, so it works on first paint, offline, and before any art is cached. If a theme's `available()` returns false — assets not yet precached, decode failure, or the user is on a metered connection — the app falls back to `vector` silently, per card, without a layout shift.
5. **Toggle** lives in the menu, persisted in `settings.svelte.ts`, and is a `screenshot-judge` item so the judge can compare both skins at phone viewport (R23). **The default theme at ship time is ApisMellow's call** (R23) — the app reads it from a single constant, `DEFAULT_THEME_ID` in `lib/theme/default.ts`, re-exported by `lib/theme/index.ts`, so flipping the default is a one-line change and not a refactor. `settings.svelte.ts` imports `default.ts` directly, which keeps components out of the store's import graph. *(amended 2026-09-27, orchestrator, from the round-2 W8 review)* **The default is Mythic** *(ApisMellow, 2026-09-29)*: `DEFAULT_THEME_ID = 'mythic'`; Classic stays one tap away in Card style (home and menu) and remains the per-card fallback (rule 4). Settings save `themeId` only once a player has picked a style (or a saved one was read), so saving names or other settings never pins the default. No migration: in the beta, any saved choice is simply kept.

**Rule 5 ruling: the picker is on the home screen** *(2026-09-28, round 8 themes, `loop/r08-themes`)*. There is no in-game menu yet, so the control rule 5 places "in the menu" is a "Card style" radio group on `HomeScreen`, under the name fields (`data-testid="theme-option-<id>"`, each option ≥ 44 px tall). It lists Classic first, then every catalog theme in catalog order, and it shows only when there is more than one choice. To change style mid-game, a player goes Home, picks a style, and taps Resume. The choice is saved in `settings.svelte.ts` under its own key (`cuttle-web:settings`), never in the game snapshot (§5.7). A saved choice the catalog doesn't list (offline, or a removed theme) shows Classic checked, and the board falls back to it anyway (rule 4). The vector theme's player-facing label is now **Classic**; its id stays `vector`. When an in-game menu exists, the picker may move or be duplicated there; this ruling doesn't block that.

**Rule 5 ruling, amended: the picker is also in the in-game menu** *(2026-09-29, `loop/r12-menu`)*. The home screen keeps its picker; the in-game menu duplicates it as a "Card style" group (`data-testid="menu-theme-option-<id>"`, same labels, same order, same show-only-when-more-than-one rule, each ≥ 44 px). A pick calls `settings.setThemeId` and nothing else, so the style changes mid-game on every screen without leaving the game; the save is untouched (the style is never in it, §5.7) and the board does not reflow (rule 2). "Home, pick, Resume" still works but is no longer needed.

**Bitmap themes are data (PRD §10 A-6)** *(added 2026-09-28, round 8 themes)*. A bitmap theme is a folder under `web/static/themes/<id>/` holding its images and a `manifest.json`, plus one line in `web/static/themes/index.json` (`{ "id", "label", "manifest" }`, the manifest path relative to `themes/`). Adding a theme needs no code change. `lib/theme/catalog.ts` parses both files; `lib/theme/bitmap.ts` builds a `CardTheme` from a manifest.

- **Manifest slots.** `faces` is keyed `<rank>-<suit>` (`"A-spades"`, `"10-hearts"`, `"K-clubs"`); `glasses` is keyed by suit name and holds landscape art for the glasses 8 (the `glasses` variant); `back` and `table` (the playmat) are single slots. Each slot is a list of `{ src, w }` sources that becomes an `<img srcset>` with `w` descriptors. `index` is the box, as fractions of the face image, where the art's painted corner index sits. `assetBytes` is the total size of every image the manifest names. *(Card labels, 2026-09-29, `loop/r11-labels`.)* An optional `names` object renames cards, keyed by rank label (`"A"`, `"2"` … `"10"`, `"J"`, `"Q"`, `"K"`) with a short string (≤ 14 characters, trimmed, the length of the longest Classic name, so any name fits the staging line). A missing, empty, overlong or unknown entry keeps the Classic name for that rank only (`lib/cardText.ts` `CLASSIC_NAMES`), so a theme can name its King and nothing else. Mythic ships no names yet.
- **Per-slot fallback.** Every slot is optional, and each one falls back to the vector baseline on its own: a face, a glasses face, the back or the playmat that is missing from the manifest, or whose image fails to load, renders vector for that slot only, in the same box. A failed image URL is remembered for the session (`lib/theme/failed-images.ts`), so every card showing it drops to vector together and a remount never retries it. A missing playmat shows the plain ink table. A bitmap theme's `available()` stays `true`; rule 4's per-card fallback happens at the image level instead.
- **Lazy loading.** After first paint the app fetches only `index.json` plus the chosen theme's manifest — which, with Mythic the default (2026-09-29), means Mythic's manifest loads at boot, alongside the engine and never blocking first paint. Another theme's manifest is fetched when that theme is chosen. Images load per card, when a card is displayed. Until the manifest has loaded, `getTheme` returns `vector`, so first paint never waits on art. A missing or malformed catalog leaves Classic as the only choice, and none of these calls throws.
- **The `mini` size** zooms the face image to the manifest's `index` box, so the rank and suit stay readable at 32 px. Glasses art has no rank and is never zoomed.
- **The playmat** is drawn by `GameScreen` behind the board only, never behind a curtain; `Board` is transparent so it shows through.
- **Privacy.** A face image is requested only for a card the viewer may see. The opponent's hidden hand and the deck render backs. Before the reveal (the handoff and reveal screens) no face image and no playmat is in the DOM; after the reveal, the recap and the counter prompt show `mini` faces only for the public cards their lines name (§4.6), which the viewer is entitled to see. The playmat is never behind any curtain screen. *(Reworded r16, 2026-09-29, re-review carry-over: the earlier "behind the curtain no face image" read as excluding the recap's mini faces.)*

**Mythic, the first bitmap theme** *(2026-09-28, round 8 themes)*. It ships 52 faces, four glasses faces and a card back, and no playmat, so the table is Classic. The back is a painted cathedral dome with its own gold frame, exported from a finished 800×1040 image (already ~1:1.3, so it is not cropped) with `--back PATH`. The source faces are 2:3 portraits with the rank and suit index already stamped on; each is cropped to the game's ~1:1.3 card while keeping the whole stamped index. Faces are WebP at 132×172 and 264×344 (glasses 172×132 and 344×264); the back is WebP at the same two sizes (132×172, 264×344); the total is 1.39 MiB, against R22's 4 MB budget. Its painted index is smaller than Classic's (about a 10 px rank on a 60–66 px hand card); legibility on a real phone is still to be checked.

**Adding or regenerating a theme.** Run `scripts/export_theme.py SOURCE --theme-id ID --label LABEL` (Python 3 with Pillow). It reads finished art from `SOURCE` and never modifies it: one folder per rank (`aces/A-spades.png` … `kings/K-clubs.png`, any folder overridable with `--rank-dir RANK=DIR`, for example `--rank-dir 8=eights-v2`), optional `glasses-<suit>.png` in the 8s folder or `--glasses-dir`, and optional `back.png` (or `--back PATH`) and `table.png`. It writes the WebP files and `manifest.json` to `web/static/themes/ID/`, adds or updates the theme's line in `index.json`, prints the total bytes, and exits non-zero if the theme is over the 4 MB budget (the files are still written, so check the exit status). A missing source file is left out of the manifest and the game draws vector for it. Then run the gate: `theme-mythic-assets.test.ts` checks that every shipped catalog theme's images exist and that its declared `assetBytes` is the real total and within budget.

**Asset budget (R18, R22).** The WASM engine already occupies ~806 KiB of the precache (§2.2). R22 budgets the full art theme at **≤ 4 MB compressed, loaded lazily so R18's first-load/offline budget is unaffected** — which this seam implements as follows:

- ~~The `vector` theme and the WASM engine are the only precached game assets.~~ ~~Bitmap themes are runtime-cached, not precached.~~ *(Superseded 2026-09-29, offline play, product-owner brief: a pass-and-play game has to work fully offline in either card style, so every catalog theme's files are **precached** (§5.8). Mythic adds 1.47 MB to the precache. Rendering is still lazy: a face image is requested only when a card shows it, and from the precache once the worker is installed.)*
- P-ART must declare `assetBytes` per theme and produce a single sprite sheet or a small set of atlases, not 52 separate requests. The declared figure is what the R22 budget check measures. *(Ruling, 2026-09-28, round 8 themes: per-card files replace the atlas requirement. Mythic ships one small WebP per card and size, loaded lazily per displayed card, so a game fetches only the faces on the table rather than a whole atlas. `assetBytes` is declared in the manifest and checked against the real total by `theme-mythic-assets.test.ts`.)*
- ~~R18's precache assertion (§7.6) doubles as the R22 guard: if an art asset ever appears in `sw.js`'s precache list, the gate fails.~~ *(Superseded 2026-09-29: the assertion now fails if any catalog theme's image is **missing** from the list, and if anything under `gallery/` is in it.)*

### 5.7 Persistence (R4)

```ts
const SNAPSHOT_KEY = 'cuttle-web:game';

interface Snapshot {
  v: 2;                       // schema version — bump on ANY shape change (2 since 2026-09-28: AppliedMove.drawn)
  savedAt: string;            // ISO 8601
  engineState: unknown;       // opaque: __cuttleSnapshot() output, never inspected by TS
  history: AppliedMove[];
  lastSeenSeq: Record<PlayerId, number>;
  viewer: PlayerId;
  curtain: CurtainState;      // so a reload mid-curtain does not leak the board
  names: [string, string];
  seed: string;
  dealer: PlayerId;
}
```

- Written after every successful `apply` and every curtain transition, synchronously, before the UI updates. A crash between apply and write must not lose a move.
- **`engineState` is opaque to TypeScript.** It is produced by `__cuttleSnapshot()` and handed back to `__cuttleRestore()` as the first argument, verbatim. No TS code reads inside it — that would be the redaction bypass of §3.3(1) through the back door.
- **`viewer` is passed to restore, not inferred.** `__cuttleRestore(engineState, viewer)` (§2.4) takes the persisted `viewer` field as its second argument and returns that player's envelope. *(amended 2026-09-26)*
- **`curtain` is persisted.** This matters: reloading the page while the curtain is up must come back to the curtain, not to the board. Restoring to the board would hand the previous player's hand to whoever reloads. The persisted `curtain` is reapplied before the first render (§2.4), so the reload never flashes the live board ahead of it.
- **The opening curtain is persisted too** *(amended 2026-09-28, W25 playtest fixes, merged `b8238db`; no `v` bump, the shape is unchanged)*. `newGame()` writes the snapshot with `viewer` = the first actor and `curtain` = the opening `handoff`. The decoder normally rejects a curtain other than `none` over an empty `history`; it now allows `handoff` with reason `turn` and `reveal` there, since those are the opening deal's. On restore, a curtain with no move behind it is treated as the opening deal's (§4.2).
- **Names survive a reload through the snapshot.** `names` is part of the snapshot, and the home screen pre-fills its fields from it (§5.2). With no saved game the fields fall back to the session's names, then to the last-used names in settings *(R10, 2026-09-28)*, so a reload with no saved game still shows the last names used. Those live under the settings key, never in this snapshot; the snapshot shape is unchanged.
- **Version mismatch discards the snapshot** and returns to the home screen with a brief notice. Bumping `v` is mandatory for any change to this shape or to the engine's state layout.
- **v1 → v2 migration** *(orchestrator ruling, 2026-09-28; supersedes "no migration code")*. v2 differs from v1 only in `AppliedMove.drawn` (§2.7); the engine's state layout is unchanged, so a v1 save is upgraded rather than discarded, and family-beta games survive the upgrade. `decodeSnapshot` accepts `v` ∈ {1, 2}: for v1 it adds `drawn: null` to every `history` entry and every recap-curtain entry (an entry that already carries `drawn` is not a real v1 save: malformed). The opaque `engineState` keeps its own v1 tag; the bridge's `restore` accepts engine-snapshot `v` ∈ {1, 2} and, for v1, injects `"drawn": null` into each raw history entry before the strict decode, then validates as usual. The next write is v2 inside and out. A migrated save shows no draw count for 5s resolved before the upgrade. Any other `v` is still a version mismatch. Evidence: a genuine base-commit v1 engine snapshot (`internal/game/testdata/snapshot-v1-bce9fb2.json`) and live saves at every curtain kind rewritten as v1 (`web/tests/unit/snapshot-migration.test.ts`).
- **The session tally is not in the snapshot** (R3, PRD §4). *Amended 2026-09-29:* it survives a reload in `sessionStorage` under its own key (§5.3), keyed to the name pair, and dies with the tab. The snapshot shape is unchanged; a restored game restores the game, and the tally comes back through the names.
- **The card style is not part of the snapshot** *(2026-09-28, round 8 themes)*. It lives in settings (§5.6 rule 5), so the same game saved under Classic and under Mythic is identical apart from `savedAt`, and a save made under either style resumes the same under the other.
- "New game" from the menu requires a confirm before clearing (R4), and the confirm names the in-progress game. *(Built 2026-09-29: "Abandon `NAME` vs `NAME`?" with Cancel / Abandon, `cancel-abandon` / `confirm-abandon`, the same testids as the home and error screens; Abandon deals a new game behind the opening curtain, which overwrites the save.)*
- **The `ack` curtain lost its `synthetic` flag** *(2026-09-29, §4.3 ruling; no `v` bump, pending orchestrator confirmation)*. The written shape only loses a field, and the reader accepts the old one: `decodeSnapshot` maps `ack` + `synthetic: false` to `ack`, `ack` + `synthetic: true` to `reveal` for the same player, and a `handoff` with the retired reason `acknowledge` to `turn` (§4.2). A family-beta game saved mid-acknowledgment therefore resumes instead of being discarded. This is an exception to "bump on ANY shape change" above: a bump would need a v2 → v3 migration doing exactly this mapping. A non-boolean `synthetic` on an `ack` is still malformed.
- **Resume always raises a curtain** *(ruling 2026-09-29, playtest privacy finding; `loop/r14-resume`; no `v` bump, the shape is unchanged)*. A restore into a resting position, the live board (`none`) or a counter window (`ack`), first raises a **resume gate** for the saved `viewer`: `handoff` (`to: viewer`, `reason: 'resume'`, label "Resume game") → `reveal` → the saved resting curtain. Whoever taps Resume after a reload or Menu → Home may not be that player, so nothing view-bearing is held until the gate is passed: `envelope` and `viewer` are `null`, `history` has every mover-only `index` stripped, and no hand, card, board, counter option or "Let it resolve" is in the DOM. Passing the reveal fetches the viewer's view fresh with `__cuttleView(viewer)` (never the envelope `__cuttleRestore` returned) and rests on the saved curtain; no recap is shown, since the resting position had already been seen.
  - *Invariance.* The gate is the same state and the same markup for every resting kind: a board and a counter window for the same player produce byte-identical gate DOM, so it tells a bystander nothing about the resting position.
  - *Never saved.* The gate writes nothing, on entry or on either step, because the save already holds the resting position. A reload, or Home, during the gate comes back to the gate, and a save naming `reason: 'resume'` is rejected as malformed. `goHome()` and `newGame()` drop a pending gate.
  - *Failure.* If the fetch at the reveal fails, `error` is set and the gate stays at `reveal`; a retry passes it.
  - *Withheld curtains are unchanged.* A save at `handoff`, `reveal` or `recap` comes back to that curtain, which is already a gate.
  - *`result` is not gated.* The result screen is public: it renders neither hand (§5.2), only names, the tally, the final score and the winning move, all public. The finished game's envelope is held for those figures, as before.
  - This supersedes "B4" in `game.svelte.ts` and AGENTS.md "Stores" (which exposed the saved viewer's envelope at `none` and either `ack` straight after restore). Evidence: `web/tests/unit/game-resume-gate.test.ts`, `resume-gate-dom.svelte.test.ts`, and `web/tests/e2e/menu.spec.ts` "R4 privacy".
- **Home from the in-game menu keeps the game** *(2026-09-29)*. No confirm, like the result screen's Home: nothing is lost. `goHome()` writes nothing (§5.3); Resume restores the saved position, withheld curtains included, so Home at a handoff comes back to that handoff, never to a board.

### 5.8 PWA and offline (R18)

*(Rewritten 2026-09-29, offline play, `feat/offline-play`. The earlier sketch had a `prompt` update and runtime-cached bitmap themes; both are superseded below.)*

`vite-plugin-pwa` in `generateSW` mode (A4). After one online visit the whole game, both card styles included, boots and plays with no network, in a browser tab and from the home screen.

```ts
// vite.config.ts — the parts that are not defaults
VitePWA({
  registerType: 'prompt',          // the worker never skipWaiting()s itself
  injectRegister: false,           // lib/pwa/register.ts registers it (prod only)
  manifest: false,                 // static/manifest.webmanifest (W23) is the manifest
  workbox: {
    globPatterns: ['**/*.{html,js,css,wasm,json,webmanifest,png,svg,webp,woff2}'],
    globIgnores: ['gallery/**'],
    // REQUIRED: the default is 2 MiB and the ~3.4 MiB raw .wasm would be
    // SILENTLY SKIPPED — the app then fails offline (§2.2).
    maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
    ignoreURLParametersMatching: [/^v$/],   // cuttle.wasm?v=<hash> (R10)
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [/\/gallery(\/|$)/, /\/api(\/|\?|$)/],   // W14: REST and /api/play reach the network
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
    // no runtimeCaching
  },
  devOptions: { enabled: false },
})
```

- **What is precached.** Everything the build emits that the game can load: `index.html`, the JS and CSS bundles, `cuttle.wasm`, `wasm_exec.js`, the web manifest, the icons, `themes/index.json`, and every file of every catalog theme (Mythic's 52 faces, 4 glasses faces and back, at both sizes, plus its `manifest.json`). Classic is drawn by the JS bundle and has no files. The app loads no fonts (the UI face falls back to the system stack) and makes no third-party request. Measured 2026-09-29: 126 entries, 5,322,676 bytes raw (wasm 3.57 MB, Mythic 1.47 MB, JS/CSS 0.23 MB); Pages gzips the wasm, so the first visit transfers about 2.7 MB.
- **What is not.** The card gallery (`/cuttle-web/gallery/`, copied into the site after the build) and its ~4.8 MB of images. Its navigations are on the fallback denylist, so the worker never answers them with the app shell; offline, the gallery is simply unavailable.
- **The game server is never answered by the worker (W14).** `/api/` (REST and the `/api/play` socket) is on the fallback denylist, so a navigation there is never served the app shell. The server lives on its own origin, which the worker's precache and navigation routes don't match anyway; the denylist covers a same-origin proxy. `web/tests/unit/online-sw-guard.test.ts` asserts the entry.
- **Server origin (W14).** `lib/online/config.ts` is the one reader of `VITE_CUTTLE_SERVER`, set at build time (`pages.yml` passes the `CUTTLE_SERVER_ORIGIN` repo variable). In a production build, unset, empty or invalid means Play online is hidden (it is always available in dev builds). A production build accepts an `https` origin only; plain `http` to loopback is honoured in dev builds only, where localStorage `cuttle.online.devServer` may also override it. There is no user-facing override.
- **No runtime caching.** The worker caches only files from its own build, so it never stores anything user-specific (there is nothing user-specific on the server anyway). Saves stay in `localStorage` (§5.7).
- **Base path.** The worker is `BASE/sw.js` and its scope is `BASE` (`/cuttle-web/` on Pages), so it controls only the app. Navigations in scope that aren't a precached file fall back to `index.html`. The manifest's `start_url` and `scope` are `.`, which resolve to the same `BASE`.
- **Engine URL token.** R10 fetches `cuttle.wasm?v=<hash>` and `wasm_exec.js?v=<hash>`. The precache matches them with `v` ignored, which is safe because the worker only ever serves the engine from its own build, the same build as the JS it serves.

**Updates without breaking games.** A new deploy's `sw.js` installs in the background and **waits**. It never activates over a running page by itself, so a game keeps the engine it started with. It takes over in one of two ways (`lib/pwa/update.ts`):

1. **Next launch.** When the app is closed, no page is left on the old worker, and the browser activates the waiting one on its own. The next launch runs the new build.
2. **A safe point.** On the home screen (and not while a name field has focus), the loading screen or the boot-failure screen, the page tells the waiting worker to take over (`SKIP_WAITING`) and reloads once it has. On the game, result and error screens it never does. If a new worker takes control while a game is on screen (for example from another tab), the reload waits for the next safe point.

The page asks for a new `sw.js` when it reaches the home screen and when it returns to the foreground, at most once a minute (the browser also checks on each navigation). No update prompt is shown. A save is in `localStorage`, which a worker swap doesn't touch, so after the reload Resume brings the same game back on the new build; the snapshot format is unchanged by this feature.

**Acceptance (R18).** An evidenced offline run, not a config review (`web/tests/e2e/offline.spec.ts`, against a real `/cuttle-web/` build on a local static server): install, go offline, reload, choose Mythic, play a seeded game through curtain passes with every response served by the worker and no failed request; a save made online resumes offline; the gallery never gets the app shell; a new build waits through a game and takes over at Home. The precache list is checked by `web/tests/smoke/precache-manifest.mjs` in `test:smoke` and again by `web/scripts/precache-manifest.mjs` in the Pages workflow before upload. A browser "hard reload" (Shift-reload) bypasses service workers by design and is not an offline path.

### 5.9 Mobile quality bar (R19)

- **Target devices: iPhone 15 or larger** *(amended 2026-09-28, ApisMellow, PRD §10 A-5)*. Primary viewport **393×852**, also **430×932**. The 360–430 range and the 360×740 compact target are dropped. Playwright's 390×844 default (`loop-workflow.md` §4) stays as a slightly smaller stand-in until the iPhone design pass retargets it.
- **Safe areas:** `viewport-fit=cover`, with the column padded by `env(safe-area-inset-*)` — about 59 pt for the Dynamic Island at the top and 34 pt for the home indicator at the bottom.
- **Short visible area:** Mobile Safari with toolbars can leave about 393×660. The hand and the action bar stay fully visible; only the board region above them may scroll. Token values for these targets are tuned in the iPhone design pass (`docs/design.md` §5–§6, §10).
- **No horizontal scroll at any width in range.** An e2e assertion on `document.documentElement.scrollWidth <= clientWidth` runs on every screen and every phase; it is the cheapest regression catch in the suite.
- All tap targets **≥ 44 px**, verified by an e2e sweep of every `[data-testid]` element's bounding box.
- Animations (draw, play, scuttle-to-scrap, Jack steal) are **CSS transforms only** — `transform` and `opacity`, no layout-affecting properties, no JS animation loop.
- **`prefers-reduced-motion: reduce` disables all of them** and the game remains fully playable: every animation is decorative, and no state transition waits on an animation's completion. Any `await animation` in a state path is a bug.
- Portrait is the design target. Landscape and desktop must be usable and must not overflow, but are explicitly "a functioning afterthought" (G3).

### 5.10 Table mode (GitHub issue #37)

*(Added 2026-09-29.)* A variant of pass-and-play for a phone lying flat between the two players, one at each end. Player 1 (seat 0) sits at the phone's bottom edge and player 2 (seat 1) at its top edge. The board never appears to flip: player 1's side is always at the physical bottom, player 2's at the physical top.

- **Setting.** A home-screen toggle, "Table mode: phone lies flat between you", stored as `tableMode` in `settings.svelte.ts` under the settings key (never in the game snapshot) and kept across reloads. Off by default: normal pass-and-play is unchanged.
- **Who a screen faces** (`lib/tableMode.ts` `screenAddressee`). A handoff (every reason, the resume gate included), the reveal gate, the recap and the counter prompt face their curtain's `to`. The live board, and the draw reveal and pickers drawn with or in place of it, face the player whose view is held. The home screen, the result screen and the boot and error screens face player 1.
- **Rotation.** In table mode every game screen facing player 2 is turned 180° by one CSS `transform: rotate(180deg)` on the `game-screen` root (`data-table-rotated="true"`). Nothing below the root knows about it. The root is exactly the viewport, so the turn maps it onto itself; its fixed-position overlays (curtain, prompt, menu, sheets, popover) sit in the root's box instead of the viewport's, which is the same rectangle, and turn with it. The in-game menu and the Rules sheet opened from it therefore face whoever holds the screen.
- **Geometry.** Each player's own view draws their side at the bottom of the view. A 180° turn about the centre maps a point at fraction *f* of the height to 1 − *f*, so player 2's side (bottom of their view) lands at the physical top and player 1's side (top of player 2's view) at the physical bottom. Player 1's view is not turned. Checked in `table-mode.test.ts` and by element boxes in e2e `table-mode.spec.ts`.
- **Safe areas.** The turned root swaps `--cu-safe-top` and `--cu-safe-bottom`, so the Dynamic Island and the home indicator stay clear on the physical edges (§5.9).
- **Drag and drop (§6.1).** Pointer deltas are in screen space and the dragged card's `translate` is in the turned frame, so both axes are negated (`toViewDelta`). The drop hit test (`document.elementFromPoint`) takes screen coordinates and needs no change.
- **When a change takes effect.** GameScreen reads the setting only when the curtain, the viewer or the move count changes. A change never turns the screen mid-turn or mid-staged-move; it applies at the next curtain or view change. The turn is instant (no animation), so `prefers-reduced-motion` needs nothing extra.
- **Handoff copy.** The phone is never passed in table mode, so the handoff heading reads "`NAME`'s turn" instead of "Pass the phone to `NAME`" (§4.5), for every reason and in both the handoff and reveal stages. The sub-label follows `handoffLabel(reason, tableMode)`: `turn` and `seven-return` read "Hold to show your hand" (the reveal control) rather than repeat "Your turn"; `counter` and `discard` keep the single neutral "Your response" (R14); `resume` keeps "Resume game". The heading is the same for every reason, so §4.5's no-reason-in-the-DOM rule is unchanged. Normal pass-and-play copy is unchanged.
- **Privacy is unchanged.** Table mode changes orientation and handoff wording only. What mounts behind each curtain kind (§3.3, §4), the reveal gate, the key auto-repeat guard and the finger-lift guard are exactly as in normal pass-and-play.

---

## 6. Move interaction flow (R9–R12)

### 6.1 The pipeline

R12 is absolute: **no single tap ever applies a move.** Every commit is `select → target → stage → confirm`.

```
  idle
   │  tap a hand card (or the deck, or a phase control)
   ▼
  selected            candidateMoveIndices computed; legal targets highlighted
   │  tap a highlighted target  (skipped when the affordance needs no target)
   ▼
  staged              StagingBar shows the move's description + Confirm / Cancel
   │  tap Confirm  (a staged Draw: or tap the deck again, issue #24)
   ▼
  applying            engine.apply(index) — bar disabled, no double-submit
   │
   ▼
  idle (new state)    staging cleared; curtain machine runs
```

- **Cancel** is always available while staged and returns to `idle`.
- Tapping the selected card itself again (a hand card, or the 7's revealed card) clears to `idle` *(added 2026-09-29, issue #25)*; once staged, only Confirm/Cancel act, plus the deck re-tap that confirms a staged Draw (issue #24, below).
- Tapping a different hand card while `selected` re-selects. Tapping a **non-highlighted** area while `selected` clears to `idle` and never stages anything (R9's explicit non-goal).
- Cards with no legal play render **dimmed but still inspectable** (R9) — tapping one opens a card-detail popover and does not enter `selected`. The popover shows only the tapped card from the viewer's own hand, never hidden information (no opponent card, no deck card, nothing from another viewer's history) *(2026-09-28: privacy bound restated while the popover is built)*.
- While `applying`, the whole board is inert. A second Confirm tap must be impossible.

*(Added 2026-09-28, W25 playtest fixes, merged `b8238db`.)*

- **Deck tap while a card is selected draws.** The deck is never a selected card's target, so the tap clears the selection and is then handled as a deck tap from idle: when Draw is legal it stages the draw in the same tap, and when it isn't the tap only clears the selection. Only Confirm, or a second deck tap (below), applies it (R12).
- **A second deck tap confirms a staged draw** *(added 2026-09-29, issue #24)*. While the staged move is a Draw, tapping the deck again does exactly what Confirm does: `staging.tap('deck')` calls `confirm()`, the only caller of `apply`, and the pass curtain follows. It is still two taps, so R12 holds. A deck tap while any other move is staged does nothing, and Confirm still works as before. On the keyboard, Enter or Space twice on the focused deck acts as two taps; an auto-repeat keydown (a held key) on the deck is ignored, so holding Enter only stages the draw. The deck button sets `touch-action: manipulation` so a quick double tap on a phone arrives as two taps rather than a zoom. No card is shown on commit: the drawn card appears only in the drawer's own hand on their next turn, behind their own curtain, as with any draw.
- **Tapping blank space clears a selection.** A tap on the board that doesn't land on a button, link, input or `role="button"` element, including a tap on the score bar, calls `staging.clearSelection()` (§5.3): a selected card goes back to idle. A staged move keeps waiting for Confirm or Cancel, the chooser and the scrap pick keep their own Cancel, and discard picks are left alone. This is a pointer convenience; the board ignores it while inert.
- **Desktop mouse.** On devices that really hover (`@media (hover: hover)`), a hand card lifts `--cu-lift-hover` (−4 px, less than the selected lift) under the pointer. Dimmed, selected and staged cards don't hover-lift, and a touch tap never leaves a card raised.
- **Desktop keyboard.** Every target is its own `<button>`, including the Points, Permanents and One-off drop zones. When Enter or Space selects a hand card, focus moves to the first lit target, so the next Tab or Enter lands on a target (for example the Points or One-off zone). A pointer click never moves focus. Escape cancels a staged move, the chooser or the scrap pick, and otherwise clears a selection. Focused board targets (deck, scrap, drop zones, point and permanent cards, the 7's revealed cards) show a 3 px `--cu-pearl` ring drawn inset (`outline-offset: -3px`), so a clipping row or well can't hide it. Hand cards keep their 2 px outset ring.
- **Focus never falls to `<body>`** *(r16, 2026-09-29 playtest)*. The curtain, the recap and the counter prompt each focus their text or heading, never a control (§4.5, review B1); one Tab reaches the first button. Staging a counter moves focus to its Confirm; Cancel returns it to the first option. On the board, a key press that stages a move goes straight to Confirm (it was 7 Tabs away), and one that opens the chooser or the 3's pick goes to its first option. Whenever the focused element unmounts during keyboard play (the curtain lifting, the chooser or scrap sheet closing, Cancel or Confirm leaving the bar), GameScreen moves focus to the next sensible control: Confirm while staged; the chooser's or scrap pick's first option; the first lit target while selected; else the 7's first revealed card, the first playable hand card, Pass, then the deck. This rescue runs only after a key press (never after a pointer, where it would scroll the board under a finger) and never takes focus from somewhere else (the menu, a card). Evidence: `keyboard.spec.ts` "keyboard only…", `counter-prompt.svelte.test.ts` "CounterPrompt focus".

*(Added 2026-09-29, issue #26, drag and drop.)*

- **Dragging a hand card onto a target** is a pointer shortcut for the same taps, never a separate path. A press on a hand card arms a gesture (Pointer Events, so touch and mouse behave alike). If the pointer moves 8 px or more from where it went down, it is a drag; under that it stays a tap, and the browser's own click selects the card as before. Starting the drag selects the card with `staging.tap('hand:<i>')` (unless it is already the selected card, so it isn't toggled off, issue #25), which lights its legal targets exactly as a tap does; unlit zones stay unlit. The card itself follows the pointer (HandCard's `dragOffset`, drawn as CSS `translate`); there is no ghost or preview copy.
- **Drop.** On release, `document.elementFromPoint` finds the target under the pointer and its testid gives its target key (`lib/dragDrop.ts`, the inverse of the key→testid map). After the same rewrite a tap gets (`resolveBoardTap`: a card in your own lit points or permanents row counts as that zone), a lit target is tapped through `onBoardTap`, so a zone or card with one play stages, several plays open the §6.4 chooser, and a 3's scrap choices open the pick sheet, all as for a tap. Only Confirm (or a second deck tap for a staged Draw) applies (R12). Any other drop, whether on an unlit zone or card, the deck, a hand card, empty board space or off the board, snaps the card back and calls `staging.clearSelection()`: the card ends **unselected**, which is what a tap on an unlit target or on empty space does. It never stages a Draw, even though a tap on the deck while selected would. An unlit board target shows the same blocked-reason line a tap there shows. A `pointercancel` (the system taking the pointer) also snaps the card back but leaves it selected, since nothing was dropped.
- **When a drag can start.** Only where a tap on that card would select it for a play: at curtain `none`, board not inert, nothing staged, no chooser or scrap pick open, not at a discard position, and never a dimmed card (a dimmed card doesn't open its popover from a drag either). Primary button only; a second finger is ignored. The 7's revealed cards are tap-only.
- **Scrolling.** A non-passive `touchmove` listener calls `preventDefault()` only while a drag is in progress, so under the threshold a touch still scrolls the board and still taps; once the drag starts the board doesn't scroll. Hand cards set `user-select: none` and `-webkit-touch-callout: none`, and a `dragstart` during a press is cancelled, so a bitmap face's image can't start the browser's own drag-and-drop.
- **The click after a drag.** A browser may still fire a click on the dragged card after a drag (a mouse released over it, a short touch drag inside the browser's own tap slop). That one click, only on that card and only within 400 ms, is swallowed so it can't re-select the card. Confirm, the chooser and every other control take their taps at once.
- **Motion.** While dragging the card has no transition, `pointer-events: none` (so the hit-test sees what is under it) and sits above its neighbours. On release it eases back over `--cu-dur-fast`; reduced motion zeroes that token, so the snap back is instant.
- **Privacy.** The dragged card is the viewer's own hand card, already on their screen. The drag state (`HandDrag`: hand index and offset) lives in GameScreen and is cleared with staging on every apply, viewer change and curtain change, and when GameScreen unmounts; the board, and every hand card with it, is unmounted behind the curtain, so nothing of a drag renders on or survives a curtain (`game-screen-drag.svelte.test.ts` "drag and the curtain").
- **Keyboard and accessibility are unchanged.** Drag is an extra; tap and keyboard stay the accessible route. No testid was added or removed; HandCard gains `data-dragging`. Evidence: `drag-drop.test.ts` (gesture threshold, key mapping, drop decision), `game-screen-drag.svelte.test.ts` (wiring through the real StagingStore, chooser on drop, snap back, click swallow, scroll, curtain), `drag-drop.spec.ts` (real touch at 393×852 and 393×660, mouse, reduced motion).

*(Added 2026-09-29, card labels, `loop/r11-labels`.)*

- **Selected card.** While a hand card (or the 7's revealed card, for the actor) is selected, the action bar, which is otherwise empty then, shows the card's name and one line on what it does ("Draw Two  One-off: draw 2 cards."), at most two lines, in the reserved height. It is derived from the board's own envelope (curtain `none`) and the store's selection, which clears on every apply and viewer change, so nothing survives a curtain.
- **Staged.** When the staged move uses the card's ability (a one-off or a permanent, a Jack steal included, directly or as a 7's pick), the staging line opens with the card's name, inline in bold ochre; playing it for points, scuttling, drawing, passing or discarding shows no name. The description (name included) takes up to three lines at `--cu-text-sm` inside the reserved bar, so no staged move is cut off at 393×852, 430×932 or 1440×900, and the bar never grows (`web/tests/e2e/staging-fit.spec.ts` stages every one-off and permanent kind, both 9 cases included, at all three; `staging-desktop.spec.ts` stages a real 9 one-off in the live GameScreen at 1440×900 and checks the bar and board keep their idle heights and that the 76 px desktop reserve holds the three-line worst case).
- **Popover.** The dimmed-card popover (R9.3) names the card and says what it does, beside its face; still only the viewer's own hand card.
- **In-play badges.** A King in either permanents row wears "Goal N", where N is that side's `scoreboard.*.threshold` from the bridge (engine `Threshold(KingCount)`: 21/14/10/7/5 for 0–4 Kings), never recomputed in TS (§3.3 rule 2). A Queen wears "Protects", a glasses 8 "8 Sees hand" (the 8 named since 2026-09-29: the glasses face has no rank), and the top Jack on a point card "Stole", only while the card is really stolen (`Controller !== Owner`): an even stack, stolen and stolen back, is home and wears no badge. Badges sit at the card's foot, centred, clear of the corner index; they are part of the card button's accessible name. No label renders on a back, the deck, the scrap, a hand card, the opponent's hand (even face up under glasses), or anywhere behind the curtain (`card-labels-privacy.svelte.test.ts`).

### 6.2 Deriving affordances from the legal-move list

The engine hands the UI a flat `Move[]`. The UI groups it into affordances. **This derivation is the whole of R11 and it must be total: every element of `legalMoves` must land in exactly one affordance, and every affordance must map back to ≥ 1 legal move.**

```ts
/** Identifies the affordance a move belongs to. Total over MoveKind. */
function slotKey(m: Move): string {
  switch (m.Kind) {
    case MoveKind.Draw:          return 'deck';
    case MoveKind.Pass:          return 'pass';
    case MoveKind.Decline:       return 'decline';
    case MoveKind.Counter:       return `counter:${m.HandIndex}`;
    case MoveKind.DiscardPair:   return `discard:${m.DiscardA}:${m.DiscardB}`;
    case MoveKind.PlayPoint:     return `hand:${m.HandIndex}|zone:points`;
    case MoveKind.PlayPermanent:
      return m.JackTarget
        ? `hand:${m.HandIndex}|jack:${m.JackTarget.Owner}:${m.JackTarget.Index}`
        : `hand:${m.HandIndex}|zone:permanents`;
    case MoveKind.Scuttle:
      return `hand:${m.HandIndex}|scuttle:${m.Target!.Owner}:${m.Target!.Index}`;
    case MoveKind.OneOff:
      return m.Target
        ? `hand:${m.HandIndex}|oneoff:${m.Target.Owner}:${m.Target.Zone}:${m.Target.Index}`
        : `hand:${m.HandIndex}|zone:oneoff`;      // 3's ScrapIndex handled in pick mode
    case MoveKind.SevenPick:
      // single-level. A dead-end SevenPick (no revealed card has a legal play) carries
      // SubMove: null and scraps the chosen revealed card. (amended 2026-09-27)
      return m.SubMove
        ? `seven:${cardKey(m.Card!)}|${slotKey(m.SubMove)}`
        : `seven:${cardKey(m.Card!)}|scrap`;
  }
}
```

Two moves sharing a `slotKey` are **the same affordance** and are disambiguated by the chooser (§6.4) — except the 3, whose `ScrapIndex` variants deliberately collapse into one slot and are disambiguated by the scrap browser in pick mode.

### 6.3 Complete `MoveKind` → affordance mapping

Totality table. Random-playout frequencies from the §2.10 survey are included so a developer knows which paths are hot and the judge knows what a normal game exercises. All ten kinds occur.

| Kind | Freq. | Affordance | Target step | Confirm |
|---|---|---|---|---|
| `Draw` (0) | 44,369 | Tap the deck pile (R10). Deck shows its count; disabled and visibly so when the deck is empty or the hand is at 8 (`apply.go:34`). | none | StagingBar: "Draw a card"; Confirm or a second deck tap (§6.1, issue #24) |
| `PlayPoint` (1) | 29,161 | Tap hand card → the **Points** drop zone in your field highlights. | tap zone | "Play 7♥ as a point card" |
| `PlayPermanent` (2), non-Jack | 19,650 (with Jacks) | Tap hand card (Q/K/8) → **Permanents** zone highlights. | tap zone | "Play Q♦ as a permanent" |
| `PlayPermanent` (2), **Jack** | — | Tap the Jack → each stealable opponent point card highlights. Engine omits all of them when a Queen protects (`apply.go:88-97`), so **the UI shows no targets and needs no Queen rule of its own.** | tap a point | "Steal 10♥ with J♣" |
| `Scuttle` (3) | 9,527 | Tap hand card → opponent point cards it beats highlight. Beat rule is engine-side (`card/card.go:51-56`); the UI highlights what it is given. | tap a point | "Scuttle 7♥ with 9♠" |
| `OneOff` (4), no target (A, 3, 4, 5, 6, 7) | 25,026 (all one-offs) | Tap hand card → the **One-off** zone highlights. | tap zone | "Play A♥ as a one-off" |
| `OneOff` (4), **rank 3** | — | Same zone tap, then the **ScrapBrowser opens in pick mode** listing exactly the scrap cards the engine offered (one move per `ScrapIndex`, `apply.go:98-111`). With exactly one card in the scrap, only one `ScrapIndex` candidate exists, so per §6.4's single-candidate rule the move stages directly — the browser never opens. | tap a scrap card (skipped when there's only one) | "Play 3♣ — take 5♠ from the scrap" |
| `OneOff` (4), **rank 2 as scrap** | — | Tap the 2 → every legal target highlights: opponent/own permanents, and Jack-topped point stacks (`apply.go:44-69`) — the **top Jack only**; buried Jacks are never targetable (2026-09-28, ApisMellow). Queen protection is already applied by the engine. | tap a target | "Play 2♥ — scrap K♠" |
| `OneOff` (4), **rank 9** | — | Tap the 9 → opponent points and permanents highlight (`apply.go:70-87`); on a Jack-topped stack only the **top Jack** is a target, never a buried one (2026-09-28, ApisMellow). | tap a target | "Play 9♥ — return 10♦ to their hand" |
| `Counter` (5) | 2,008 | **CounterPrompt** (§4.3): one button per unfrozen 2. Not a board interaction. | none | "Counter with 2♠" |
| `Decline` (6) | 1,868 | **CounterPrompt**: the "Let it resolve" button. Always present in a real window. | none | confirm inline — this *is* the confirm step |
| `SevenPick` (7) | 2,680 | **SevenRevealPanel**: the revealed cards (1 or 2). Tap one → its inner affordances replay **on the real board** exactly as a hand card would (the sub-move is a normal move). | per the sub-move | "7: play 5♥ as a point card" |
| `DiscardPair` (8) | 2,598 | **DiscardPicker**: select 2 cards. A 1-card hand offers the single `{DiscardA:0, DiscardB:-1}` move as a pre-selected confirm (`apply.go:485-488`). Never reached with an empty hand (`apply.go:621-623`). | selection is the target step | "Discard 4♦ and 5♠" |
| `Pass` (9) | 412 | **Pass control**, shown only when it is the sole legal move — which is engine-guaranteed (`apply.go:131-133`, re-checked at `:160-166`), so the UI applies no policy. | none | "Pass" |

The `DiscardPair` confirm text names cards only for the acting player's own move: `recap.ts` builds it by reading the viewer's own hand at the selected indices, never from `history` or engine `Describe`. This is sound because it's the viewer's own hand — the opponent-facing recap line stays identity-free per §4.6.

`Decline` is the single case where a one-tap button is the confirm. This does not violate R12: it commits nothing to the board, applies no card, and is reversible in effect only by the engine's own resolution. The misclick R12 protects against is playing the wrong card, and Decline plays none. *(The synthetic ack that shared this button was retired 2026-09-29, §4.3.)*

### 6.4 Ambiguity chooser (R11)

Triggered when, after target selection (or immediately, for affordances with no target step), **more than one** candidate move remains for the chosen `(handIndex, slot)`. **Single-candidate rule:** when exactly one candidate remains — including the 3's scrap pick with only one card in the scrap (§6.3) — that move stages directly and no chooser (or, for the 3, no ScrapBrowser) ever opens.

Canonical cases, all present in the golden scenario of §2.6:

- **An 8** — point card or glasses permanent. Two different zones, so actually resolved by the zone tap; a chooser appears only if a design later merges the zones. Listed because R11 names it explicitly.
- **An Ace** — one-off (wipe all points) or point card. In the golden scenario, `A♥` at hand index 2 yields moves `[3]` and `[4]`. Two different zones again: the zone the Ace is dropped or tapped on resolves the move, and **no chooser opens** *(ruled 2026-09-28, ApisMellow: prefer implicit actions to extra prompts; ledger R11.3)*.
- **A 2** — point card, or one-off against any of several targets. Mixed: the zone tap separates point from one-off, and the target tap separates the one-off variants.
- **A 7 sub-pick** where one revealed card affords several plays — resolved on the board by the sub-move's own target step.

The genuinely ambiguous residue is small, which is the point: **most disambiguation falls out of zone-and-target geometry, and the chooser is the backstop.** When it appears it is a modal list of the candidate `descriptions[i]` strings (engine-authored, §2.7), each tappable, plus Cancel. Selecting one goes straight to `staged` — the chooser does not skip the confirm step.

*Amended 2026-09-28 (playtest friction):* each option renders as one plain line saying what it does, via `plainMoveText` (§4.6), e.g. a 9 on a point card offers "Scuttle their 4♣ with 9♣: both cards go to the scrap." and "Play 9♣: send 4♣ back to their hand; they can’t play it next turn." (or, on a card they stole from you, "Play 9♣: your stolen 4♣ comes back to your hand."; target named since 2026-09-29, §4.6). A chooser holds at most two options: its candidates share one card and one target, and the engine offers at most a Scuttle plus one targeted one-off for that pair. The sheet overlays the hand and action bar at the bottom of the screen instead of taking a slot in the game screen's column, so the board never shrinks and the player's own Permanents row stays visible (`docs/design.md` §6).

*Amended r16 (2026-09-29 playtest, friction 5):* the bottom sheet hid the hand, and with it the very card being played. The chooser is now a panel on the centre strip: GameScreen hands it to `Board`'s `centerOverlay` snippet, which `CenterZone` draws centred over the strip (absolute, above the sticky hand), so the board still never changes size, and the card being played (hand), its target (the other side's points, the only place a two-option pair can aim: a scuttle plus a 2 or 9 one-off on one point card) and your own rows all stay uncovered at 393×852 and 430×932. `chooser-fit.spec.ts` checks all four at both sizes. **The scrap browser** (R6, both modes) moved the same way: it drops from the top of the column, capped at 48% of the visible height with its card grid scrolling inside, so your own Points and Permanents rows and your hand (the 3 being played) stay in view below it (`pickers.spec.ts` at 393×852 and 430×932).

### 6.5 R11's invariant, stated as the property to test

> The set of moves reachable through the UI equals `LegalMoves(state)`, exactly, at every position.

Both directions matter and both are tested (§7.4):

- **Completeness** — every index in `legalMoves` is reachable by some tap sequence. Catches an affordance the UI forgot to render (a rule the players cannot use).
- **Soundness** — no tap sequence stages an index outside `legalMoves`, and no tap sequence stages anything at all when the board is dimmed. Catches a highlight the engine did not authorize.

The app exposes a test-only hook — `window.__cuttleTestHook.affordances()`, compiled out of production builds — returning the derived affordance map with the move indices behind each. The invariant test compares that map's flattened index set to the envelope's `legalMoves` index set. Comparing derived-affordances to engine-output is what makes this a real invariant rather than a re-assertion of the UI's own beliefs.

---

## 7. Test strategy

**Test authoring is P1b's assignment**, given to Claude developer agents on its own feature branch. This section specifies *what* the tests are — layers, scenarios, seeds, assertions, and the invariant design. P1b writes the code. Everything here maps to a `verify:` value in the `requirements.yaml` ledger (`loop-workflow.md` §3.1): `unit-test`, `e2e-test`, `bridge-smoke`, `screenshot-judge`.

### 7.1 Layer 1 — vitest unit (`verify: unit-test`)

Pure TypeScript, **no WASM**, fast enough to run on every save. Everything here is a pure function precisely so it can be tested this way.

| Suite | What it pins |
|---|---|
| **Normalization** (§2.8) | Golden raw-JSON inputs → expected normalized output. **Must include the `JackOwners` base64 case**: `"AQA="` → `[1, 0]`. Also nil→`[]`, `FrozenIDs` string keys → sorted `number[]`, `Rank:0` → `null`, `Winner` bare number, `opponent.hand` `null`-vs-`[]`. |
| **View redaction** (§3.2) | Table-driven over the field matrix. Asserts `deck` contents absent in every phase; `opponent.hand` null without glasses and non-null with; `sevenRevealed` null for the non-actor; `pending.scrapIndex` absent. A test that greps the serialized view for a known hidden card's `{Rank,Suit}` pair is the blunt instrument that catches new leaks when fields are added. |
| **Curtain machine** (§4.4) | The whole transition table as cases. `next(pre, move, post)` is pure, so all 5 phases × all reachable move kinds are cheap. Includes the no-window branches (`OneOff`-with-no-2, `Counter`-with-no-2, a 7 with no 2: no ack, §4.1 only) and the recap trim before the counter prompt (§4.3, 2026-09-29). |
| **Affordance derivation** (§6.2) | `slotKey` totality over all 10 `MoveKind`s; grouping produces the expected slots for canned legal-move lists; ambiguity detection fires exactly when >1 candidate shares a slot. |
| **Recap formatter** (§4.6) | Per-viewer strings; the redaction assertions — `DiscardPair` names no identities, `SevenPick` names no unchosen card. |
| **Snapshot round-trip** (§5.7) | Serialize → parse → same shape; a `v: 2` snapshot is discarded, not crashed on. |

### 7.2 Layer 2 — bridge smoke (`verify: bridge-smoke`)

Node, headless, the **real compiled `.wasm`**. This is PRD §9's named mitigation for WASM bridge friction and it is the first thing P1b makes green.

1. **Boot** — load `wasm_exec.js` + `cuttle.wasm`, await readiness, assert every `__cuttle*` global is a function, assert the Go runtime is still alive after the first call (catches a `main` that returned).
2. **Golden deal** — `newGame({seed:"42", dealer:1})` reproduces §2.6's scenario byte-for-byte: both hands, deck length 41, `Active` 0, and all 7 legal-move descriptions in order.
3. **Full random game × N seeds** (N ≥ 200, fixed corpus, committed): loop `legalMoves` → pick pseudo-randomly from a seeded PRNG → `apply`, until `phase === 4`. Assert per step:
   - `ok === true`;
   - `legalMoves.length === descriptions.length`;
   - the envelope validates against `schema.ts`;
   - `phase !== 4 ⟹ legalMoves.length > 0` (**catches E-2**);
   - `apply` on any offered index does not return `ILLEGAL_MOVE` (**catches E-1**);
   - `seq` increments by exactly 1 and `history.length === seq`.
4. **Termination** — every game ends in ≤ 3,000 steps (observed max in the 4,000-game survey: 109). Both endings occur across the corpus: wins ~95.6%, stalemates ~2.5%.
5. **Redaction** — for a sample of positions, `view(0)` and `view(1)` are each free of the other player's hand (absent glasses) and neither contains deck contents.
6. **E-1/E-2 corpus policy** — the committed seed corpus **excludes known-bad seeds** and the exclusion list cites §2.10 with the specific seeds. When the engine is fixed upstream, deleting the exclusion list is the whole re-enablement.

Cost: seconds. Value: it fails loudly on the Go/JS lifecycle mistakes that are otherwise diagnosed as mysterious UI bugs three rounds later.

### 7.3 Scenarios — the shared backbone

**One scenario format, reused by unit, e2e, invariant, and judge layers.** A scenario is a seed plus a scripted sequence of move indices. Because dealing (§2.6) and `LegalMoves` enumeration are both deterministic, a seed plus an index sequence reproduces a position exactly.

```yaml
# web/tests/scenarios/counter-chain.yaml
id: counter-chain
description: "P1 plays a 9, P2 counters, P1 counters back, resolves."
seed: "42"                # decimal uint64 as a string (§2.6)
dealer: 1                 # P2 deals; P1 is non-dealer and goes first
names: ["Alice", "Blake"]
moves:
  - i: 0                  # index into legalMoves at this position
    expect: "draw a card" # description assertion — see the guard rail below
  - i: 3
    expect: "play A♥ as one-off"
checkpoints:              # optional assertions at a given step
  - afterStep: 2
    phase: 1              # PhaseAwaitingCounter
    active: 1
    curtain: counter
```

**The `expect` field is the guard rail, and it is not optional.** Move indices are positional, and `LegalMoves`'s enumeration order — while deterministic for a given engine version (it is a fixed loop order over hand, then targets, in `engine/apply.go:32-134`) — is **not a stability guarantee the engine makes**. An engine change that reorders enumeration would silently repoint every scenario at a different move. With `expect`, the same change fails with `step 4: expected "play A♥ as one-off", got "play K♦ as permanent"` — a diagnosis instead of a mystery. Every step in every committed scenario carries one.

**Required scenario corpus** (split 2026-09-26: P1b builds the scenario format, loader, and replayer, proven on `opening` only; P2 adds each remaining scenario below alongside the requirement it tests):

| Scenario | Exercises |
|---|---|
| `opening` | R1 deal, R5 layout, R9 first tap-to-play |
| `counter-chain` | R14 real window, 2-counters-2, chain parity, curtain per link |
| `no-counter-ack` | *(repurposed 2026-09-29)* a one-off the opponent cannot answer: no counter prompt, the turn simply passes (§4.3) |
| `four-discard` | R15, including the 1-card and empty-hand branches |
| `seven-reveal` | R16, both the point-play and the one-off-through-7 sub-moves |
| `jack-steal-queen` | R9 Jack targeting, Queen protection producing **zero** highlights |
| `glasses-eight` | R7 opponent hand face-up for the glasses owner only |
| `nine-freeze` | R8 frozen marker appears and clears after one turn |
| `scuttle-suit-tiebreak` | equal rank, higher suit (`card/card.go:51-56`) |
| `stalemate` | R2 three passes → `phase 4, winner null` — **scripted, not discovered**; at 2.5% of random games it is too rare to rely on the smoke test hitting it |
| `win-with-kings` | R2 threshold 14/10/7/5 display and win detection |
| `full-game` | the §6 final gate: new game → curtained turns → counter chain → Jack steal → seven-reveal → win → rematch |

### 7.4 Layer 3 — Playwright e2e (`verify: e2e-test`)

Real browser, **390×844 portrait**, driven by scenarios.

- **Scenario replay.** A test-only entry point seeds the game and applies a scenario's prefix, then the test drives the UI for the step under assertion. Tests never hand-navigate 20 moves to reach an interesting position.
- **R11 invariant walk** — the centerpiece. For each scenario, at **every** position: read the envelope's `legalMoves` index set; read `window.__cuttleTestHook.affordances()`; assert set equality (both directions, §6.5). Then spot-check reachability by actually performing the tap sequence for a sampled index and asserting the correct move stages. This single test covers R9, R11, and R12 across every scenario and is the highest-value test in the suite.
- **Curtain leak tests.** At every handoff in every scenario: assert the board is **not in the DOM** (not merely hidden), and assert the serialized page content contains no card identity belonging to the incoming player's opponent. The "not in the DOM" form matters — `visibility:hidden` passes a screenshot check and fails a real one.
- ~~**R14 indistinguishability.**~~ *(Superseded 2026-09-29, §4.3: the accepted leak.)* In its place: `no-counter-ack` shows no counter prompt and no "Let it resolve" anywhere, and `counter-chain` shows the prompt straight after the reveal, with no recap repeating the one-off.
- **R12 misclick.** No single tap on any hand card, target, or zone changes the engine state. Assert `seq` is unchanged after each exploratory tap.
- **R19 sweep, every screen and phase:** `scrollWidth <= clientWidth`; every `[data-testid]` bounding box ≥ 44 px; the suite runs once with `prefers-reduced-motion: reduce` forced and must fully pass.
- **R18 offline.** Install the service worker, `context.setOffline(true)`, reload, complete a turn including a WASM `apply`. *(2026-09-29: "hard-reload" read as a full page reload; Shift-reload bypasses service workers by design. `web/tests/e2e/offline.spec.ts`.)*
- **R4 resume.** Mid-game reload restores the position; **mid-curtain reload restores the curtain, not the board** (§5.7).

### 7.5 Layer 4 — screenshot judge (`verify: screenshot-judge`)

Per `loop-workflow.md` §4, a Claude Opus model, at 390×844, playing real moves. It rules on the criteria a machine cannot: board legibility at phone size, whether the curtain flow feels like a chore (PRD §9's named risk), animation quality, theme-swap consistency (§5.6), and whether a rules-aware human would find the board readable.

It runs on UI-visible items and on the final gate only — not on every submission (`loop-workflow.md` §8).

### 7.6 Mechanical gate alignment

The gate in `loop-workflow.md` §5.3a, made concrete for this repo. All are hard-fail.

```sh
go build ./...                                              # server binary
GOOS=js GOARCH=wasm go build -o /dev/null ./internal/wasm   # WASM target
go vet ./...
go test ./...
npm --prefix web run check          # svelte-check
npm --prefix web run lint
npm --prefix web run test:unit      # vitest
npm --prefix web run test:smoke     # bridge smoke (§7.2)
npm --prefix web run test:e2e       # Playwright
```

Two additions specific to this spec, run as part of `test:smoke`:

- **WASM size budget (R18):** fail if the gzipped `cuttle.wasm` exceeds 1.5 MB. Current headroom is large (806 KiB) but the check is cheap and the budget is a requirement.
- **Precache manifest check (R18):** fail if the generated `sw.js` precache list omits `cuttle.wasm` or `wasm_exec.js` (§5.8) — the silent-skip failure has no other symptom until a user is offline. *(Built 2026-09-29: `web/tests/smoke/precache-manifest.mjs` builds for `/cuttle-web/` and also fails on a missing shell file, icon or catalog-theme image, an entry that doesn't exist in the build, any `gallery/` entry, a missing gallery fallback denylist, or a worker that could activate itself.)*

---

## 8. Open questions and risks

Each carries a recommendation. Items marked **needs ApisMellow** are outside the loop's authority (`loop-workflow.md` §10) and should be resolved before or at relaunch rather than discovered mid-round.

**OQ-1 — RESOLVED 2026-09-26.** Two engine defects broke the `LegalMoves`/`Apply` contract in `PhaseSevenChoosing`: E-1 (stale `FrozenIDs` index ⇒ every offered `MoveSevenPick` illegal, ~1.6% of random games) and E-2 (empty legal-move list when all revealed cards are unplayable Jacks, ~0.3%). Full diagnosis and minimal repros in §2.10.
**Resolved:** fixed upstream in the engine (`github.com/ApisMellow/cuttle` v0.2.0); verified against the SPEC §2.10 repros at `engine/seven_test.go:209` and `:242`, plus a green 500-game random playout. The smoke exclusion list (`web/tests/smoke/exclusions.json`) is expected to go away in P1b Batch 2.

**OQ-2 — Should the bridge defend against E-1 by clearing stale frozen indices before `apply`?** It could drop `FrozenIDs` keys ≥ `len(hand)` in its held state.
**Recommendation: no.** That is the UI implementing a rule, which PRD §2 forbids, and it would mask the defect from the smoke test that is meant to detect it. Surface the error; fix it upstream.

**OQ-3 — RESOLVED 2026-09-26.** PRD A7's module path was wrong: A7 said `github.com/ApisMellow/Cuttle-card-game`; `go.mod:1` says `github.com/ApisMellow/cuttle` (§2.1).
**Resolved:** the engine repo was renamed to `github.com/ApisMellow/cuttle` to match the module path and tagged `v0.1.0`/`v0.2.0`; `cuttle-web` requires `v0.2.0` directly with no committed `replace` (§2.1).

**OQ-4 — A2 specifies four bridge functions; this spec adds three** (`view`, `snapshot`, `restore`, §2.4).
**Recommendation: accept.** R4 cannot restore from a redacted view, and R13 must render the incoming player's view before that player is the viewer. The four mutation/read functions A2 names are unchanged; the additions are read-only or persistence-only and preserve the v2 story — a v2 server implements `view` natively and `snapshot`/`restore` become server-side session handling.

**OQ-5 — The envelope's `state` is a redacted `PlayerView`, not the raw `GameState`.** A2's wording is ambiguous between the two.
**Recommendation: accept the redacted reading.** It is what makes PRD §7's v1-obligation-to-v2 structural rather than a matter of developer discipline (§3.1), and the envelope's shape — `{state, legalMoves[], descriptions[]}` — is preserved exactly as locked.

**OQ-6 — R14's synthetic ack costs an extra full handoff for every 7.** Curtain to opponent, ack, curtain back (§4.3). Sevens occur in roughly two-thirds of games. **Resolved 2026-09-29** by the product owner's ruling (§4.3): the synthetic ack is gone, and a 7 with no 2 against it costs no handoff.
*(Historical)* **Recommendation: accept; it is required for the R14 property.** Mitigate with a fast reveal gate and let the playtest judge score it. If the judge flags it as intolerable, the fallback worth considering is a shortened hold duration on ack-only curtains — but **not** skipping the curtain, which would reintroduce the tell.

**OQ-7 — Move-index scenarios are positional and depend on `LegalMoves` enumeration order.**
**Recommendation:** mandatory `expect` description assertions on every scenario step (§7.3). Cheap, and converts a silent repoint into a named failure. Already specified as binding.

**OQ-8 — Stalemates are 2.5% of random games**, so the smoke corpus will hit them but no single seed reliably does.
**Recommendation:** the scripted `stalemate` scenario (§7.3) is the R2 evidence; the smoke test's role is only to confirm both terminal states occur across the corpus.

**OQ-9 — RESOLVED 2026-09-26 (accepted for v1).** `localStorage` holds the full unredacted state (§3.4, §5.7); the threat model is a shoulder-glance, not devtools, and both players share the device. ~~Revisit for v2, where the client should hold only its own redacted view plus `{roomCode, playerToken, seq}` per PRD §7.~~ *(Closed for online play 2026-09-29.)* An online phone stores no game state at all: `localStorage` holds only `{v, server, code, seat, token, names}` under `cuttle.online.v1` (W11 `seat.ts`), and the redacted envelope lives in memory, refetched from the server on every `hello` (§2.12.2). The full state never leaves the server. Pass-and-play keeps the accepted v1 behaviour above.

**OQ-10 — Workbox's 2 MiB default would silently exclude the WASM binary** from precache and break R18 offline with no build error (§2.2, §5.8).
**Recommendation:** set `maximumFileSizeToCacheInBytes` to 5 MiB **and** add the precache-manifest assertion to the mechanical gate (§7.6). Config alone is too easy to lose in a refactor.

**OQ-11 — A 7's unchosen card returns to the top of the deck and is known to the player who revealed it.** R16 says its identity "is not shown again to either player"; the UI honours that, but the knowledge is inherent to the rules.
**Recommendation: accept.** This is how the physical game works. The UI's obligation is to never re-display it, which §3.2 and §4.6 enforce.

**OQ-12 — Dealer alternation and seed handling across a rematch** (R1, R3). The bridge is stateless across games; the client supplies `dealer`.
**Recommendation:** `session.svelte.ts` holds `lastDealer` and passes `1 - lastDealer` on rematch; the first game of a session passes no `dealer` and gets a random one. Seeds are random in normal play and explicit only in scenarios — the UI should surface the current seed on the stuck-state screen (§2.10) and nowhere else.

**OQ-13 — A 9 played on your own Jack-stolen point returns the card to *your* hand with a freeze that expires before your next turn.** `resolveOneOffWith` sets the freeze on `pe.Owner` (`engine/apply.go:706-744`), which can be the acting player; `endTurn` then clears it before their turn comes around. The R8 marker will appear and vanish without ever restricting anything.
**Recommendation:** render the marker straight from `frozenHandIndices` and do not special-case it. The display is truthful about engine state, which is the correct behaviour under PRD §2. Note it in the engine issues file as low-severity alongside OQ-1, since it shares a root cause with E-1 (`FrozenIDs` lifecycle).

---

## Appendix A — requirement-to-section index

For the ledger seeder: where each PRD requirement's binding detail lives.

| PRD | Sections | Primary `verify:` |
|---|---|---|
| R1 new game | §2.6, §5.3 | bridge-smoke, e2e-test |
| R2 win/stalemate | §2.10, §3.2, §4.4 | unit-test, e2e-test |
| R3 rematch/tally | §5.3, §5.7, §8 OQ-12 | e2e-test |
| R4 resume | §5.7, §7.4 | e2e-test |
| R5 board layout | §3.2, §5.2, §5.9 | screenshot-judge |
| R6 scrap public | §3.2, §5.2, §6.3 | e2e-test |
| R7 glasses-8 / redaction | §3 (whole) | unit-test, e2e-test |
| R8 frozen marker | §2.8(c), §5.2, §8 OQ-13 | e2e-test |
| R9 tap-to-play | §6.1–§6.3 | e2e-test, screenshot-judge |
| R10 draw and pass | §6.3 | e2e-test |
| R11 legal-move parity | §6.2, §6.5, §7.4 | e2e-test |
| R12 misclick protection | §6.1, §7.4 | e2e-test |
| R13 curtain | §4.1, §4.2, §4.5 | e2e-test, screenshot-judge |
| R14 counter without leak | §4.3, §4.7, §7.4 | unit-test, e2e-test |
| R15 four-discard | §4.4, §6.3 | e2e-test |
| R16 seven privacy | §3.2, §4.6, §6.3 | unit-test, e2e-test |
| R17 rules screen | §5.5 | screenshot-judge |
| R18 PWA/offline | §2.2, §5.8, §7.6 | e2e-test, bridge-smoke |
| R19 mobile quality | §4.5, §5.9 | e2e-test, screenshot-judge |
| R20 event feedback | §2.7, §4.6, §4.7 | unit-test, e2e-test |
| R21 style lock (P-ART) | §5.6 (target contract only — the brief itself is P-ART's output) | screenshot-judge |
| R22 full-deck generation | §5.6 asset budget, §5.8, §7.6 | screenshot-judge, e2e-test |
| R23 theme integration | §5.6 (whole) | e2e-test, screenshot-judge |
