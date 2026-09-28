# Cuttle Web — Technical Specification

**Status:** P1 output — binding for the loop
**Date:** 2026-08-23
**Companions:** `docs/PRD.md` (requirements R1–R20, architecture A1–A7), `docs/loop-workflow.md` (the loop that consumes this spec)
**Engine under test:** `github.com/ApisMellow/cuttle` v0.2.0, Go 1.25.2

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
  internal/wasm/                # NOT built into the server binary
    main.go                     # //go:build js && wasm — the bridge (§2)
    deal.go                     # bridge-side dealing (§2.6)
    view.go                     # bridge-side redaction (§3)
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

**Resolved 2026-09-26 (OQ-3, §8): the engine repo was renamed to `github.com/ApisMellow/cuttle`**, matching its module declaration, and is tagged `v0.1.0` (787bbf5) and `v0.2.0` (e4f91b8, latest). `cuttle-web/go.mod` requires the published module directly:

```
require github.com/ApisMellow/cuttle v0.2.0
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

**Bridge owns the state.** The Go side holds one package-level `engine.GameState` plus the move history. The TypeScript side never holds a `GameState` and never constructs a `Move` (A3). This is what makes the v2 transport swap a swap: in v2 the same envelope arrives over a WebSocket from the server's copy of exactly this code.

`__cuttleApply` takes an **index into the legal-move list of the current state** (A3). The bridge recomputes `engine.LegalMoves(state)` and bounds-checks the index. An out-of-range index is an error, not a panic. Illegal moves are unrepresentable because the client can only name a position in a list the engine produced.

**Which viewer each call returns** *(amended 2026-09-26)*. `__cuttleApply` returns the envelope for the **pre-apply `Active`** (the mover). After the curtain reveal the UI fetches the incoming actor's envelope with `__cuttleView(newActor)` (§3.3 rule 4). `__cuttleNewGame` returns the envelope for the first actor (`state.Active` after the deal). Whoever starts the game is the first player, so there is no opening curtain. `__cuttleRestore(snapshotJson, viewerId)` returns the envelope for `viewerId`; TS passes its persisted `Snapshot.viewer` (§5.7) and puts the persisted curtain back up before rendering (R4.2). A `viewerId` that isn't exactly 0 or 1 is `BAD_REQUEST`, and the held state is unchanged. `__cuttleLegalMoves` and `__cuttleDescribe` return the envelope for `state.Active`, and `__cuttleView(p)` returns `p`'s. No mutating call returns the view of a player who is not holding the phone.

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
// internal/wasm/deal.go
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

P1b must include this as the bridge smoke test's first assertion. Note what it already demonstrates for §6: the `A♥` at hand index 2 produces two moves in two different slots — that is the R11 ambiguity chooser's trigger case. The `2♥` produces only a point play, because 2-as-scrap requires a target and the board is empty.

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
                                     // steals and one-offs. (amended 2026-09-27, David)
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

---

## 3. Redacted-view rules (R7)

### 3.1 Where redaction happens, and why it matters

**Redaction is performed in Go, inside the bridge, in `internal/wasm/view.go`.** The `GameState` never crosses the WASM boundary. The only game data the TypeScript side can reach is a `PlayerView` already stripped for one named viewer.

This is not defense-in-depth for its own sake. PRD §7 makes it a v1 obligation to v2: *"the UI consumes only the envelope + redacted views (never reaches into full state for opponent info)."* If redaction lives in TypeScript, v2 has to write it a second time in Go and the two will drift. Writing it once, Go-side, means the v2 server calls the identical `viewFor(state, viewerId)` and ships its output over the WebSocket. The transport becomes a swap, exactly as G4 requires.

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

**`viewerHasGlasses` (R7).** `Players[viewer].Permanents` contains any card with `Rank === card.Eight`. `Permanents` holds only Queens, Kings, and glasses-8s (`engine/state.go:56`), so no further filtering is needed. Suit is irrelevant (RULES.md §Notes: "Glasses 8: any 8"). Note the direction carefully: **the glasses' owner sees the other hand.** A viewer with glasses sees `opponent.hand`; a viewer whose *opponent* has glasses sees nothing extra and gets no indication beyond the glasses-8 visibly sitting in the opponent's permanents row — which is correct, since a permanent on the board is public.

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

Recorded as **OQ-9** so David can overrule if he wants the snapshot redacted-and-reconstructed instead.

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

The one addition to the predicate is the synthetic acknowledgment of §4.3, which fires on an actor change that the engine already produced but whose *content* the UI must supply.

### 4.2 States

```ts
type CurtainState =
  | { kind: 'none' }                                   // viewer === active, playing
  | { kind: 'handoff';  to: PlayerId; reason: HandoffReason }
  | { kind: 'reveal';   to: PlayerId }                 // tap-and-hold gate (R13)
  | { kind: 'recap';    to: PlayerId; entries: RecapEntry[] }  // R20
  | { kind: 'ack';      to: PlayerId; synthetic: boolean }     // R14
  | { kind: 'result' };                                // PhaseGameOver

type HandoffReason = 'turn' | 'counter' | 'discard' | 'seven-return' | 'acknowledge';
```

The sequence a receiving player walks through is always the same shape, which is what makes the R14 disguise work:

```
handoff  →  reveal  →  [recap]  →  [ack | counter-prompt]  →  live view
```

`recap` is skipped when there is nothing new (`entries.length === 0`). `ack` and the counter prompt are mutually exclusive and both are skipped when the incoming player has no one-off to acknowledge. Everything else is unconditional.

### 4.3 R14 — the synthetic acknowledgment

**The engine auto-resolves a counterable one-off when the opponent holds no unfrozen 2.** `Apply` checks `hasLegalCounter(out.Players[opp])` (`engine/apply.go:329`, helper at `:467-474`) and calls `resolveOneOffWith` in the same call (`:340`) — no pending state, no phase change, no decision point. The engine offers the opponent nothing to acknowledge. R14's acknowledgment curtain is therefore **entirely synthesized by the client**, exactly as the PRD's spec note anticipated.

The requirement is an indistinguishability property: **the acting player must not be able to tell "the opponent had no 2" from "the opponent declined."** That means the synthetic path must match the real path in *flow*, in *screen count*, and in *pacing*.

**Detection.** After every successful `apply`, with `pre` = state before, `mv` = the applied move, `post` = state after:

```ts
function needsSyntheticAck(pre: PlayerView, mv: AppliedMove, post: PlayerView): boolean {
  const counterable =
    mv.kind === MoveKind.OneOff ||
    mv.kind === MoveKind.Counter ||
    (mv.kind === MoveKind.SevenPick && mv.subKind === MoveKind.OneOff);
  if (!counterable) return false;
  return post.phase !== Phase.AwaitingCounter;   // engine opened no real window
}
// The player who would have decided is always the opponent of the pre-state actor:
const ackTarget = other(pre.active);
```

Three facts make this total:

- **Every one-off rank passes the same gate.** A, 2, 3, 4, 5, 6, 7, 9 all reach the `hasLegalCounter` check at `engine/apply.go:329`; there is no per-rank branch above it. No rank filter is needed or permitted.
- **A one-off played through a 7 is included.** `MoveSevenPick` dispatches its inner move via a recursive `Apply` (`engine/apply.go:445`), so `PhaseSevenChoosing` can transition straight to `PhaseAwaitingCounter`. The `subKind` clause covers it.
- **Counter links need it too.** If P1 plays a one-off, P2 counters, and P1 holds no second 2, `MoveCounter` calls `resolvePending` immediately (`engine/apply.go:360-365`). P1 gets no window. Without a synthetic ack at that link, P2 learns P1 had no 2. The `mv.kind === Counter` clause closes it, and the rule generalizes to a chain of any depth.

**Presentation.** The synthetic `ack` screen and the real counter prompt are the same component with a different control set:

| | Real window (`post.phase === 1`) | Synthetic ack |
|---|---|---|
| Curtain text | "Pass the phone to `NAME`" | identical |
| Reveal gate | tap-and-hold | identical |
| Card shown | `pending.card`, plus `pending.target` highlighted on the board | the same card and target, from `lastMove` |
| Counter chain | `pending.counterChain` rendered | prior chain from `history`, rendered identically |
| Controls | "Let it resolve" + one button per legal 2 | **"Let it resolve" only** |
| On confirm | `apply(indexOf MoveDecline)` | no bridge call — advance the local curtain machine |
| Minimum dwell | none beyond the reveal gate | **identical** — no artificial delay, no extra animation |

The acting player observes exactly the same thing in both cases: the phone goes to the opponent, comes back (or doesn't, if the turn passed), and the one-off resolved. The two cases are indistinguishable because the only difference is the presence of a button the acting player cannot see.

**The `ack` screen must not be skippable, fast-forwardable, or auto-dismissed.** Any of those reintroduces a timing tell.

**The 7 costs a round trip.** A 7 resolves to `PhaseSevenChoosing` with `Active` back on the player who played it (`engine/apply.go:704`). In the real path: curtain to opponent → decline → curtain back to actor for the reveal. The synthetic path must mirror it: curtain to opponent → ack → curtain back to actor for the reveal. This is a genuine two-handoff cost for one card, and it is required. Recorded as **OQ-6**; the playtest judge scores handoff friction (`loop-workflow.md` §4) and this is the sharpest instance of it.

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
| `OneOff` (4), rank 4, no 2 | **AwaitingDiscard** (3) | `O` | yes — `discard` | reveal → recap → **ack** → discard picker |
| `OneOff` (4), rank 4, no 2, **opponent hand empty** | Normal (auto-resume, `apply.go:621-623`) | `O` | yes — `acknowledge` | reveal → recap → **ack** → live |
| `OneOff` (4), rank 7, no 2 | **SevenChoosing** (2) | **`A`** | yes — `acknowledge` to `O`, then **back to `A`** | `O`: ack; then handoff to `A` → reveal → seven panel |
| `OneOff` (4), other ranks, no 2 | Normal, or GameOver (`apply.go:746`) | `O` / — | yes — `acknowledge` / no | reveal → recap → **ack** → live / result |
| `Pass` (9), `PassesInARow` reaches 3 | **GameOver** (4), `Winner` nil | — | no | **stalemate** result screen (R2) |
| `Pass` (9), otherwise | Normal | `O` | yes — `turn` | reveal → recap → live |
| `Counter`/`Decline`/`SevenPick`/`DiscardPair` | *unreachable* | | | `INTERNAL` |

**From `PhaseAwaitingCounter` (1).** Decider is `A` (the player being offered the counter). Legal moves are exactly one `MoveDecline` plus one `MoveCounter` per unfrozen 2 (`engine/apply.go:546-555`).

| `mv.kind` | Post phase | Post `Active` | Curtain? | Incoming screen |
|---|---|---|---|---|
| `Decline` (6), chain length **even** (resolves) | whatever the one-off resolves to — Normal / SevenChoosing / AwaitingDiscard / GameOver | per §resolution | per rule below | as the Normal-row equivalents |
| `Decline` (6), chain length **odd** (cancelled, `apply.go:565-571`) | Normal | `O` (= original player's opponent) | per rule | the one-off is scrapped with no effect |
| `Counter` (5), the **next** player has an unfrozen 2 | AwaitingCounter (1) | `O` | **yes** — `counter` | reveal → recap → counter prompt, chain now longer |
| `Counter` (5), the next player has **none** | resolution phase per parity | per §resolution | **yes** — `acknowledge` to `O` | reveal → recap → **synthetic ack** → onward |
| anything else | *unreachable* | | | `INTERNAL` |

**Resolution note.** `resolvePending` (`engine/apply.go:560-577`) sets `Active = Pending.PlayedBy`, then: odd chain length ⇒ cancelled, scrap everything, `endTurn` ⇒ `Active` becomes the original player's opponent. Even ⇒ `resolveOneOffWith` runs the original effect, which itself decides the final phase and `Active`. The UI does not model this; it reads `post.active` and `post.phase` and applies §4.1's predicate. It is written out here only so a developer can follow a counter chain in the debugger.

**From `PhaseSevenChoosing` (2).** Decider is `A`, the player who played the 7 (`apply.go:704`). Legal moves wrap each revealed card's legal inner moves as `MoveSevenPick` with a `SubMove` (`engine/apply.go:501-513`); nesting is single-level.

| `mv.kind` | Post phase | Post `Active` | Curtain? | Incoming screen |
|---|---|---|---|---|
| `SevenPick` (7), `SubMove` = PlayPoint/PlayPermanent/Scuttle | Normal, or GameOver | `O` / — | yes — `turn` / no | live / result |
| `SevenPick` (7), `SubMove` = OneOff, opponent has an unfrozen 2 | **AwaitingCounter** (1) | `O` | yes — `counter` | counter prompt |
| `SevenPick` (7), `SubMove` = OneOff, no 2 | per the one-off's own row above | | yes — `acknowledge` | **synthetic ack** then onward |
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

- **Handoff screen.** Full-viewport opaque surface. Content: "Pass the phone to `NAME`", a label, and the reveal control. The label is **"Your turn"** for `turn` and `seven-return`, and the single neutral **"Your response"** for `counter`, `acknowledge` and `discard` *(amended 2026-09-27, David)*. The handoff is on screen while the *acting* player still holds the phone, so distinct labels ("You may counter" vs "Acknowledge" vs "Choose discards") would tell them whether the opponent held a 2 — the exact R14 leak §4.3 forbids. The machine's internal `HandoffReason` may still distinguish the three; it must not reach the DOM before the reveal gate in any form (text, attribute, class, `data-testid`, or layout). What the receiver needs to do is shown only after the reveal. **Zero game state** — no counts, no scores, no scrap, nothing that changes between turns. A rendering that varies with hidden state is a leak even if no card is drawn. The board must be unmounted, not merely covered: a covered board is one CSS bug away from visible, and screenshots taken during a judged playtest have caught exactly this class of defect.
- **Reveal gate.** Two-step by default, matching R13's "tap and hold (or tap through a two-step reveal)":
  - **Primary — press-and-hold**, 600 ms, with a progress ring. `pointerdown` starts, `pointerup`/`pointercancel`/`pointerleave` abort and reset.
  - **Fallback — two-step tap** ("I'm `NAME`" → "Show my hand"), used when `prefers-reduced-motion: reduce` is set, when the pointer is coarse-less (desktop, R19's "functioning afterthought"), and as the accessible path. Both are always present in the DOM; the hold path is progressive enhancement.
  - Hold duration is a single constant in `lib/curtain.ts`. Playwright drives the two-step path in e2e (holding is flaky to automate); the hold path gets its own focused unit + one e2e test.
- **Tap target** ≥ 44 px (R19), centered, thumb-reachable in the lower two-thirds of a 390×844 viewport.
- **No auto-advance anywhere in the curtain sequence.** Every screen waits for an explicit action.

### 4.6 R20 — "while you were away" recap

**What it is.** On the incoming player's post-reveal screen, before they act: the moves applied since that player's last look, oldest first, as short lines. Skipped entirely when there are none.

**How "last look" is tracked.** The game store holds `lastSeenSeq: Record<PlayerId, number>`, updated to `envelope.seq` at the moment a player's live view is rendered (not at reveal — at the transition into `kind: 'none'`). The recap is `history.filter(h => h.seq > lastSeenSeq[viewer])`. This survives reload because `lastSeenSeq` is in the R4 snapshot. **The mover's own moves are seen:** a successful `apply` also stamps `lastSeenSeq[mover]` to the post-apply `envelope.seq`, so a player's recap shows only what happened while they were away, never their own previous move. **Recap dismissal also stamps:** leaving `kind: 'recap'` stamps `lastSeenSeq[viewer]` to the current `envelope.seq`, matching the Presentation line below, so an acknowledger who synthetic-acks and hands the phone back without ever reaching `'none'` doesn't see the same entries again. *(amended 2026-09-27, David delegated the call to the orchestrator)*

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
| `OneOff` | "`NAME` played 9♥ as a one-off." (+ target clause when `Target` is set) |
| `Counter` | "`NAME` countered with 2♠." |
| `Decline` | **never shown** — Decline entries are filtered out of the recap before the "skipped when empty" check *(amended 2026-09-27, David)*. A synthetic ack (§4.3) writes no history, so a "`NAME` let it resolve." line would appear only when the opponent really held a 2, and would even change whether a recap screen appears at all. |
| `SevenPick` | "`NAME` revealed the top of the deck and played 5♥ for points." — **the unchosen card is never named** (R16). *(Amended 2026-09-27, David: was "revealed two cards", which is false when the deck held one card.)* |
| `DiscardPair` | "`NAME` discarded 2 cards." — **never the indices, never the identities**; the cards are in the scrap pile, which the viewer can browse (R6) |
| `Pass` | "`NAME` passed." |

**No recap line may name a card the viewer is not entitled to see.** Audited against the table: every card named above is one that became public by being played or scrapped. The 7's unchosen card returns to the top of the deck (`engine/apply.go:431-433`) and is never named — it is known to the player who revealed it, which is inherent to the rules and not a UI leak (**OQ-11**).

**Presentation.** At most the last 6 entries, oldest first; if more, a "+N earlier" affordance expands the rest. Each line pairs with a small card glyph where a card is named. Dismissed by one tap; the dismissal is also what stamps `lastSeenSeq`.

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
├── HomeScreen.svelte             # R1: names, New game, Resume (if snapshot), Rules
├── GameScreen.svelte             # the board host; owns the curtain overlay
│   ├── Curtain.svelte            # R13 — full-viewport; board is UNMOUNTED behind it
│   │   ├── HandoffPanel.svelte   # "Pass the phone to NAME"
│   │   ├── RevealGate.svelte     # press-and-hold + two-step fallback (§4.5)
│   │   └── RecapPanel.svelte     # R20 (§4.6)
│   ├── Board.svelte
│   │   ├── ScoreBar.svelte       # R5: both totals + thresholds, always visible
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
│   │   │   └── PlayerHand.svelte
│   │   │       └── HandCard.svelte   # dim when no legal play (R9); FrozenBadge (R8)
│   │   └── DropZones.svelte          # "Points" / "Permanents" / "One-off" targets
│   ├── StagingBar.svelte         # R9/R12: staged move + Confirm/Cancel
│   ├── AmbiguityChooser.svelte   # R11: >1 move for one (card, target) pair
│   ├── CounterPrompt.svelte      # R14 — real window AND synthetic ack (§4.3)
│   ├── DiscardPicker.svelte      # R15
│   ├── SevenRevealPanel.svelte   # R16 — only when viewer === active
│   ├── ScrapBrowser.svelte       # R6 — browse mode and pick mode
│   └── StuckState.svelte         # §2.10 — E-1/E-2 diagnostic + scenario export
├── ResultScreen.svelte           # R2/R3: win or stalemate, tally, Rematch
└── RulesScreen.svelte            # R17 — overlay, never unmounts the game
```

`PointRow.svelte` renders a `PointEntry` including its `JackStack`: the point card with each Jack fanned above it and an ownership badge driven by `Controller` (§2.8(f)). A stolen point renders in the **controller's** row — which is where the engine already puts it (`engine/state.go:3-22`) — with a marker indicating the original `Owner`, so a player can see at a glance which of their points is on loan.

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

- **`curtain.svelte.ts`** — the §4.2 machine. Pure: `next(pre, appliedMove, post) -> CurtainState`. Its purity is what makes the transition table of §4.4 unit-testable without WASM (§7.1).
- **`staging.svelte.ts`** — R9/R12 selection pipeline (§6). Holds `selectedHandIndex`, `stagedMoveIndex`, `candidateMoveIndices`, `highlightedTargets`. Cleared on every `apply` and on every viewer change.
- **`session.svelte.ts`** — R3 tally, player names, `lastDealer`, `lastSeed`. **Memory only; never persisted** (PRD §4: "the win tally lives only for the browser session"; R3: "does not survive a page reload").
- **`settings.svelte.ts`** — card theme (§5.6), reduced motion, hold-vs-two-step reveal preference. Persisted separately from game state.

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

`engine.ts` is the seam A2 exists to create. In v2 its implementation is replaced with a WebSocket client speaking the identical `Envelope`; **no store and no component changes.** That property is a review criterion: any bridge-shaped logic that leaks upward into a store or a component breaks it.

`schema.ts` validates envelopes against the §2.7 shape in dev and test builds and is tree-shaken from production. It is the tripwire for the §2.8 normalization bugs — particularly `JackOwners`, which typechecks as an array while being a base64 string at runtime and would otherwise surface as a rendering oddity in the rare Jack-chain case rather than as a loud failure.

### 5.5 Rules screen (R17)

Content is the engine repo's `RULES.md` (PRD R17), converted to a Svelte component **at build time** by a small script in `scripts/`, so there is no runtime Markdown parser in the bundle and no risk of the rules text drifting from the engine that implements them. The build script records the engine commit it read from and stamps it in the footer of the screen.

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
}
```

Rules that keep the seam real:

1. **Nothing outside `lib/theme/` renders a rank or suit glyph.** Every card pixel in the app comes from `<CardFace>` or `<CardBack>`. A component that draws its own "7♥" has broken the seam; code review rejects it.
2. **Layout is the theme's business; geometry is not.** The aspect ratio (2.5:3.5) and the three size tokens are fixed by the app in CSS custom properties. A theme paints inside a box it does not get to resize, so swapping themes never reflows the board.
3. **State styling is the theme's responsibility to honour, not to invent.** `state` is passed in; the theme renders it. Highlight/dim/stage semantics belong to §6 and must look consistent across themes.
4. **`vector` is always available and is the fallback.** It has zero external assets, so it works on first paint, offline, and before any art is cached. If a theme's `available()` returns false — assets not yet precached, decode failure, or the user is on a metered connection — the app falls back to `vector` silently, per card, without a layout shift.
5. **Toggle** lives in the menu, persisted in `settings.svelte.ts`, and is a `screenshot-judge` item so the judge can compare both skins at phone viewport (R23). **The default theme at ship time is David's call** (R23) — the app reads it from a single constant, `DEFAULT_THEME_ID` in `lib/theme/default.ts`, re-exported by `lib/theme/index.ts`, so flipping the default is a one-line change and not a refactor. `settings.svelte.ts` imports `default.ts` directly, which keeps components out of the store's import graph. *(amended 2026-09-27, orchestrator, from the round-2 W8 review)*

**Asset budget (R18, R22).** The WASM engine already occupies ~806 KiB of the precache (§2.2). R22 budgets the full art theme at **≤ 4 MB compressed, loaded lazily so R18's first-load/offline budget is unaffected** — which this seam implements as follows:

- The `vector` theme and the WASM engine are the **only** precached game assets. Together they are the offline-guaranteed baseline (R18), and adding art must not change that number.
- Bitmap themes are **runtime-cached, not precached** — a `CacheFirst` Workbox route with an explicit cache name and entry cap, warmed on first use of the theme. This is what makes R22's "loaded lazily" true rather than aspirational: the art cannot enter the precache manifest even by accident, because the manifest's `globPatterns` (§5.8) do not match its directory.
- P-ART must declare `assetBytes` per theme and produce a single sprite sheet or a small set of atlases, not 52 separate requests. The declared figure is what the R22 budget check measures.
- **R18's precache assertion (§7.6) doubles as the R22 guard:** if an art asset ever appears in `sw.js`'s precache list, the gate fails.

### 5.7 Persistence (R4)

```ts
const SNAPSHOT_KEY = 'cuttle-web:game';

interface Snapshot {
  v: 1;                       // schema version — bump on ANY shape change
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
- **Version mismatch (`v !== 1`) discards the snapshot** and returns to the home screen with a brief notice. No migration code in v1; a bump means the old game is gone. Bumping `v` is mandatory for any change to this shape or to the engine's state layout.
- **The session tally is not persisted** (R3, PRD §4). It lives in `session.svelte.ts` and dies with the tab. A restored game restores the game only.
- "New game" from the menu requires a confirm before clearing (R4), and the confirm names the in-progress game.

### 5.8 PWA and offline (R18)

`vite-plugin-pwa` in `generateSW` mode, `registerType: 'prompt'` (a silent update that swaps the WASM mid-game would be a correctness hazard; prompt, and apply the update only from the home screen or the result screen).

```ts
// vite.config.ts — the parts that are not defaults
VitePWA({
  registerType: 'prompt',
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,woff2,wasm}'],
    // REQUIRED: the default is 2 MiB and the ~2.9 MB raw .wasm would be
    // SILENTLY SKIPPED — no build error, but the app fails offline (§2.2).
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    runtimeCaching: [ /* bitmap card themes only — see §5.6 */ ],
  },
  manifest: {
    name: 'Cuttle', short_name: 'Cuttle',
    display: 'standalone', orientation: 'portrait',
    background_color: '#0f1115', theme_color: '#0f1115',
    icons: [ /* 192, 512, 512-maskable */ ],
  },
})
```

Acceptance for R18 is an **evidenced offline run**, not a config review: install, kill the network, hard-reload, play a full turn including a WASM `apply`. The `.wasm` and `wasm_exec.js` must both appear in the precache manifest — P1b's build script asserts this by grepping the generated `sw.js`, because a missing entry produces no error until a user is offline.

### 5.9 Mobile quality bar (R19)

- Primary viewport **390×844** (Playwright default for the judge, `loop-workflow.md` §4); layout must hold 360–430 px CSS width.
- **No horizontal scroll at any width in range.** An e2e assertion on `document.documentElement.scrollWidth <= clientWidth` runs on every screen and every phase; it is the cheapest regression catch in the suite.
- All tap targets **≥ 44 px**, verified by an e2e sweep of every `[data-testid]` element's bounding box.
- Animations (draw, play, scuttle-to-scrap, Jack steal) are **CSS transforms only** — `transform` and `opacity`, no layout-affecting properties, no JS animation loop.
- **`prefers-reduced-motion: reduce` disables all of them** and the game remains fully playable: every animation is decorative, and no state transition waits on an animation's completion. Any `await animation` in a state path is a bug.
- Portrait is the design target. Landscape and desktop must be usable and must not overflow, but are explicitly "a functioning afterthought" (G3).

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
   │  tap Confirm
   ▼
  applying            engine.apply(index) — bar disabled, no double-submit
   │
   ▼
  idle (new state)    staging cleared; curtain machine runs
```

- **Cancel** is always available while staged and returns to `idle`.
- Tapping a different hand card while `selected` re-selects. Tapping a **non-highlighted** area while `selected` clears to `idle` and never stages anything (R9's explicit non-goal).
- Cards with no legal play render **dimmed but still inspectable** (R9) — tapping one opens a card-detail popover and does not enter `selected`.
- While `applying`, the whole board is inert. A second Confirm tap must be impossible.

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
| `Draw` (0) | 44,369 | Tap the deck pile (R10). Deck shows its count; disabled and visibly so when the deck is empty or the hand is at 8 (`apply.go:34`). | none | StagingBar: "Draw a card" |
| `PlayPoint` (1) | 29,161 | Tap hand card → the **Points** drop zone in your field highlights. | tap zone | "Play 7♥ as a point card" |
| `PlayPermanent` (2), non-Jack | 19,650 (with Jacks) | Tap hand card (Q/K/8) → **Permanents** zone highlights. | tap zone | "Play Q♦ as a permanent" |
| `PlayPermanent` (2), **Jack** | — | Tap the Jack → each stealable opponent point card highlights. Engine omits all of them when a Queen protects (`apply.go:88-97`), so **the UI shows no targets and needs no Queen rule of its own.** | tap a point | "Steal 10♥ with J♣" |
| `Scuttle` (3) | 9,527 | Tap hand card → opponent point cards it beats highlight. Beat rule is engine-side (`card/card.go:51-56`); the UI highlights what it is given. | tap a point | "Scuttle 7♥ with 9♠" |
| `OneOff` (4), no target (A, 3, 4, 5, 6, 7) | 25,026 (all one-offs) | Tap hand card → the **One-off** zone highlights. | tap zone | "Play A♥ as a one-off" |
| `OneOff` (4), **rank 3** | — | Same zone tap, then the **ScrapBrowser opens in pick mode** listing exactly the scrap cards the engine offered (one move per `ScrapIndex`, `apply.go:98-111`). | tap a scrap card | "Play 3♣ — take 5♠ from the scrap" |
| `OneOff` (4), **rank 2 as scrap** | — | Tap the 2 → every legal target highlights: opponent/own permanents, and Jack-topped point stacks (`apply.go:44-69`). Queen protection is already applied by the engine. | tap a target | "Play 2♥ — scrap K♠" |
| `OneOff` (4), **rank 9** | — | Tap the 9 → opponent points and permanents highlight (`apply.go:70-87`). | tap a target | "Play 9♥ — return 10♦ to their hand" |
| `Counter` (5) | 2,008 | **CounterPrompt** (§4.3): one button per unfrozen 2. Not a board interaction. | none | "Counter with 2♠" |
| `Decline` (6) | 1,868 | **CounterPrompt**: the "Let it resolve" button. Always present in a real window. | none | confirm inline — this *is* the confirm step |
| `SevenPick` (7) | 2,680 | **SevenRevealPanel**: the revealed cards (1 or 2). Tap one → its inner affordances replay **on the real board** exactly as a hand card would (the sub-move is a normal move). | per the sub-move | "7: play 5♥ as a point card" |
| `DiscardPair` (8) | 2,598 | **DiscardPicker**: select 2 cards. A 1-card hand offers the single `{DiscardA:0, DiscardB:-1}` move as a pre-selected confirm (`apply.go:485-488`). Never reached with an empty hand (`apply.go:621-623`). | selection is the target step | "Discard 4♦ and 5♠" |
| `Pass` (9) | 412 | **Pass control**, shown only when it is the sole legal move — which is engine-guaranteed (`apply.go:131-133`, re-checked at `:160-166`), so the UI applies no policy. | none | "Pass" |

`Decline` is the single case where a one-tap button is the confirm. This does not violate R12: it commits nothing to the board, applies no card, and is reversible in effect only by the engine's own resolution. The misclick R12 protects against is playing the wrong card, and Decline plays none. **The synthetic ack's "Let it resolve" (§4.3) must be visually and positionally identical**, or the difference becomes the tell that R14 forbids.

### 6.4 Ambiguity chooser (R11)

Triggered when, after target selection (or immediately, for affordances with no target step), **more than one** candidate move remains for the chosen `(handIndex, slot)`.

Canonical cases, all present in the golden scenario of §2.6:

- **An 8** — point card or glasses permanent. Two different zones, so actually resolved by the zone tap; a chooser appears only if a design later merges the zones. Listed because R11 names it explicitly.
- **An Ace** — one-off (wipe all points) or point card. In the golden scenario, `A♥` at hand index 2 yields moves `[3]` and `[4]`. Two different zones again.
- **A 2** — point card, or one-off against any of several targets. Mixed: the zone tap separates point from one-off, and the target tap separates the one-off variants.
- **A 7 sub-pick** where one revealed card affords several plays — resolved on the board by the sub-move's own target step.

The genuinely ambiguous residue is small, which is the point: **most disambiguation falls out of zone-and-target geometry, and the chooser is the backstop.** When it appears it is a modal list of the candidate `descriptions[i]` strings (engine-authored, §2.7), each tappable, plus Cancel. Selecting one goes straight to `staged` — the chooser does not skip the confirm step.

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
| **Curtain machine** (§4.4) | The whole transition table as cases. `next(pre, move, post)` is pure, so all 5 phases × all reachable move kinds are cheap. Includes both R14 synthetic branches (`OneOff`-with-no-2, `Counter`-with-no-2) and the 7's round trip. |
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
names: ["Alice", "Bob"]
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
| `no-counter-ack` | R14 **synthetic** ack — the acting player's view must be identical to `counter-chain`'s |
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
- **R14 indistinguishability.** Run `counter-chain` and `no-counter-ack` and assert the **acting player's** screen sequence — screen count, DOM structure, testids, and the presence/absence of any timing-visible element — is identical between them. This is the direct machine check of the R14 property.
- **R12 misclick.** No single tap on any hand card, target, or zone changes the engine state. Assert `seq` is unchanged after each exploratory tap.
- **R19 sweep, every screen and phase:** `scrollWidth <= clientWidth`; every `[data-testid]` bounding box ≥ 44 px; the suite runs once with `prefers-reduced-motion: reduce` forced and must fully pass.
- **R18 offline.** Install the service worker, `context.setOffline(true)`, hard-reload, complete a turn including a WASM `apply`.
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
- **Precache manifest check (R18):** fail if the generated `sw.js` precache list omits `cuttle.wasm` or `wasm_exec.js` (§5.8) — the silent-skip failure has no other symptom until a user is offline.

---

## 8. Open questions and risks

Each carries a recommendation. Items marked **needs David** are outside the loop's authority (`loop-workflow.md` §10) and should be resolved before or at relaunch rather than discovered mid-round.

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

**OQ-6 — R14's synthetic ack costs an extra full handoff for every 7.** Curtain to opponent, ack, curtain back (§4.3). Sevens occur in roughly two-thirds of games.
**Recommendation: accept; it is required for the R14 property.** Mitigate with a fast reveal gate and let the playtest judge score it. If the judge flags it as intolerable, the fallback worth considering is a shortened hold duration on ack-only curtains — but **not** skipping the curtain, which would reintroduce the tell.

**OQ-7 — Move-index scenarios are positional and depend on `LegalMoves` enumeration order.**
**Recommendation:** mandatory `expect` description assertions on every scenario step (§7.3). Cheap, and converts a silent repoint into a named failure. Already specified as binding.

**OQ-8 — Stalemates are 2.5% of random games**, so the smoke corpus will hit them but no single seed reliably does.
**Recommendation:** the scripted `stalemate` scenario (§7.3) is the R2 evidence; the smoke test's role is only to confirm both terminal states occur across the corpus.

**OQ-9 — RESOLVED 2026-09-26 (accepted for v1).** `localStorage` holds the full unredacted state (§3.4, §5.7); the threat model is a shoulder-glance, not devtools, and both players share the device. Revisit for v2, where the client should hold only its own redacted view plus `{roomCode, playerToken, seq}` per PRD §7.

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
| R14 counter without leak | §4.3, §7.4 | unit-test, e2e-test |
| R15 four-discard | §4.4, §6.3 | e2e-test |
| R16 seven privacy | §3.2, §4.6, §6.3 | unit-test, e2e-test |
| R17 rules screen | §5.5 | screenshot-judge |
| R18 PWA/offline | §2.2, §5.8, §7.6 | e2e-test, bridge-smoke |
| R19 mobile quality | §4.5, §5.9 | e2e-test, screenshot-judge |
| R20 event feedback | §2.7, §4.6 | unit-test, e2e-test |
| R21 style lock (P-ART) | §5.6 (target contract only — the brief itself is P-ART's output) | screenshot-judge |
| R22 full-deck generation | §5.6 asset budget, §5.8, §7.6 | screenshot-judge, e2e-test |
| R23 theme integration | §5.6 (whole) | e2e-test, screenshot-judge |
