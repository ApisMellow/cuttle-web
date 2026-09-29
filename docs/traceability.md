# Traceability

A view of `docs/requirements.yaml`, which remains the single source of truth.
Regenerate this file when the ledger changes; do not edit statuses here.

Layers: `go unit` = `go test ./internal/game`; `bridge-smoke` =
`npm --prefix web run test:smoke`. The `verify` column is the ledger's
required layer set. Entries marked PARTIAL stay `todo` until every layer passes.

## Ledger IDs

| ID | Title | Test(s) | Layer | verify | Status |
|---|---|---|---|---|---|
| R1.1 | Golden-seed deal matches SPEC scenario | `TestR1_1a_GoldenSeedDeal`<br>`TestR1_1b_CanonicalDeckOrder`<br>`TestR1_1c_GoldenDealThroughBridge`<br>`smoke: reproduces the seed-42 golden deal byte-for-byte` | go unit + bridge-smoke | bridge-smoke, unit-test | verified |
| R1.2 | Dealer alternates across rematch/session | `vitest: "R1.2: the first game of a session passes no dealer"`<br>`vitest: "R1.2: computes dealer = 1 - lastDealer on rematch"` | vitest (unit-test done; e2e-test open) | unit-test, e2e-test | todo (PARTIAL) |
| R1.3 | Deal counts, first-player, and default names | `e2e: game-happy-path.spec.ts`<br>`e2e: app-shell.spec.ts "R1.3: blank names default to Player 1 / Player 2"` | Playwright | e2e-test | verified |
| R2.1 | Win detection and King-lowered threshold display | `TestR2_1a_ScoreboardFromEngineHelpers`<br>`vitest: "R2.1: scoreboard fields cross verbatim from the engine's helpers, never recomputed in TS"` | go unit + vitest (unit-test done; e2e-test open) | unit-test, e2e-test | todo (PARTIAL) |
| R2.2 | Three-pass stalemate detection | `TestR2_2a_StalemateDerivedFromPhaseAndWinner`<br>`TestR2_2b_ThreePassesReachStalemateThroughBridge`<br>`vitest: "R2.2: state.stalemate is passed through verbatim, never independently derived by the schema"` | go unit + vitest (unit-test done; e2e-test open) | unit-test, e2e-test | todo (PARTIAL) |
| R2.3 | Result screen names win vs stalemate | — | — | e2e-test | implemented |
| R3.1 | Rematch alternates dealer | — | — | e2e-test | implemented |
| R3.2 | Session win tally displays and increments | — | — | e2e-test | implemented |
| R3.3 | Tally survives reload for the same players, outside the game snapshot (amended 2026-09-29) | `vitest: "the persisted snapshot JSON has no 'tally' key, even with a non-zero tally"` (game.test.ts)<br>`vitest: session-tally-persist.test.ts`<br>`vitest: resume-gate-dom.svelte.test.ts "the tally survives a reload (R3.3 amended)"` | vitest (unit-test done; e2e-test open) | unit-test, e2e-test | todo (PARTIAL) |
| R4.1 | Mid-game reload restores state | — | — | e2e-test | todo |
| R4.2 | Mid-curtain reload restores curtain, not board; Resume at a board or counter window raises a gate first (2026-09-29) | `e2e: menu.spec.ts "R4 privacy: after a reload, Resume at the board and at a real counter window shows the gate first…"`<br>`vitest: game-resume-gate.test.ts`, `resume-gate-dom.svelte.test.ts` | e2e + vitest (resume gate done; mid-curtain reload e2e open) | e2e-test | todo |
| R4.3 | New-game confirm before abandoning | — | — | e2e-test | implemented |
| R4.4 | Snapshot version mismatch discards cleanly | `vitest: snapshot.test.ts "a snapshot with v !== 1 decodes as version-mismatch, not thrown"`<br>`vitest: game-restore.test.ts "v !== 1 -> home screen with a notice, engine.restore never called, no throw"` | vitest | unit-test | verified |
| R5.1 | All board zones visible on one portrait screen | — | — | screenshot-judge | todo |
| R5.2 | Score bar always visible | — | — | e2e-test | implemented |
| R6.1 | Scrap pile browsable by either player, any time | — | — | e2e-test | implemented |
| R7.1 | Opponent hand hidden without glasses-8 | `TestR7_1a_OpponentHandNullWithoutGlassesEveryPhase`<br>`TestR7_3b_SampledGamesLeakNoDeckOrHiddenHand`<br>`TestSPEC3_2_GlassesOwnerSeesOpponentHandOnly` | go unit | unit-test | verified |
| R7.2 | Opponent hand face-up under glasses-8 | — | — | e2e-test | todo |
| R7.3 | Deck contents never transmitted | `TestR7_3a_DeckNeverTransmittedEveryPhase`<br>`TestR7_3b_SampledGamesLeakNoDeckOrHiddenHand` | go unit | unit-test | verified |
| R7.4 | opponent.hand null-vs-empty distinguished through every layer | `TestR7_4a_OpponentHandNullVersusEmptyOnWire`<br>`TestR7_4b_NullVersusEmptySurvivesSnapshotRoundTrip`<br>`vitest: schema.test.ts / engine.test.ts R7.4`<br>`vitest: game.test.ts, game-curtain.test.ts N4, game-restore.test.ts N4 (store leg, incl. real-WASM round trip)` | go unit + vitest | unit-test | verified |
| R8.1 | Frozen marker visible to owner | — | — | e2e-test | implemented |
| R8.2 | Frozen marker derived from frozenHandIndices only | `TestR8_2a_FrozenIndicesVerbatimIncludingSelfFreeze`<br>`vitest: hand-card.svelte.test.ts (single-instance OQ-13 freeze/clear, membership matrix)` | go unit + vitest | unit-test | verified |
| R9.1 | Tap highlights exactly legal targets, all move kinds | — | — | e2e-test | implemented |
| R9.2 | Tapping a highlighted target stages; confirm commits | — | — | e2e-test | implemented |
| R9.3 | No-legal-play cards render dimmed but inspectable | — | — | e2e-test | in-progress |
| R9.4 | Tapping non-highlighted area clears selection | — | — | e2e-test | implemented |
| R10.1 | Deck tap draws when legal | — | — | e2e-test | implemented |
| R10.2 | Pass control shown only when sole legal move | — | — | e2e-test | implemented |
| R11.1 | Completeness: every legal index reachable | — | — | e2e-test | implemented |
| R11.2 | Soundness: no tap stages an illegal index | — | — | e2e-test | implemented |
| R11.3 | Ambiguity chooser resolves multi-candidate slots | — | — | e2e-test | implemented |
| R11.4 | Zero legal-move-contract breaks across random corpus | `smoke: R11.4: full committed seed corpus reaches terminal state via offered indices with zero legal-move-contract breaks` | bridge-smoke | bridge-smoke, e2e-test | todo (PARTIAL) |
| R12.1 | No single tap ever applies a move | — | — | e2e-test | implemented |
| R12.2 | Board inert during apply; no double-submit | — | — | e2e-test | implemented |
| R13.1 | Curtain fires exactly per actor-change predicate | `vitest: "R13.1: [actor P1\|P2] <row>"` (every §4.4 row)<br>`vitest: "R13.1: curtainRequired matches …"`<br>`vitest: "R13.1: PhaseAwaitingDiscard double flip"`<br>`vitest: "R13.1: every unreachable (phase, MoveKind) pair raises an INTERNAL CurtainError"` | vitest | unit-test | verified |
| R13.2 | Curtain shows zero state; board unmounted | — | — | e2e-test | implemented |
| R13.3 | Reveal gate: hold-with-abort and two-step fallback | `vitest: "R13.3: the hold duration is the single constant 600 ms"`<br>`vitest: "R13.3: pointerup\|pointercancel\|pointerleave before 600 ms aborts …"` | vitest (unit-test done; e2e-test open) | unit-test, e2e-test | implemented |
| R13.4 | Curtain tap targets ≥44px; no auto-advance | — | — | e2e-test | implemented |
| R14.1 | Real counter window renders correctly | — | — | e2e-test | implemented |
| R14.2 | ~~Synthetic ack indistinguishable from real decline~~ (superseded 2026-09-29, SPEC §4.3: no synthetic ack) | `vitest: "R14.2: fires for OneOff, Counter, and SevenPick-wrapping-OneOff …"`<br>`vitest: "R14.2: real and synthetic paths walk identical curtain sequences"` | vitest (unit-test done; e2e-test open) | e2e-test, unit-test | implemented |
| R14.3 | Counter chain parity and repeated curtains | `vitest: "R14.3: issues one counter curtain per counter link"` | vitest (unit-test done; e2e-test open) | unit-test, e2e-test | implemented |
| R14.4 | ~~Seven's synthetic-ack round trip~~ (superseded 2026-09-29, SPEC §4.3: a 7 with no 2 goes straight to its pick) | — | — | e2e-test | implemented |
| R15.1 | Four curtains to opponent for discard | `e2e: pickers.spec.ts` (seed 17 4-discard line) | Playwright | e2e-test | verified |
| R15.2 | One-card and empty-hand discard branches | `vitest: "R15.2: a 1-card discarding hand pre-selects …"`<br>`vitest: "R15.2: the picker never renders outside PhaseAwaitingDiscard"`<br>`vitest (real WASM): pinned replay seed 2 / ply 23, 4 vs empty hand lands in phase 0` | vitest | unit-test | verified |
| R15.3 | Curtain returns to discarder with no leak | — | — | e2e-test | implemented |
| R16.1 | Seven-reveal shown only to acting player | `TestR16_1a_SevenRevealedOnlyToActorWhileChoosing` | go unit | unit-test | verified |
| R16.2 | Unchosen seven card never re-shown | `vitest: "R16.2: played branch names only the played card …"`<br>`vitest: "R16.2: dead-end … names the scrapped card …"`<br>`vitest: "R16.2: fails loudly … smuggles a second card"` | vitest | unit-test | verified |
| R16.3 | Seven sub-move plays via normal affordances | — | — | e2e-test | implemented |
| R17.1 | Rules content built from engine RULES.md | — | — | e2e-test | todo |
| R17.2 | Rules reachable from menu without disturbing game | — | — | e2e-test | todo |
| R18.1 | WASM gzip size budget | `smoke: R18.1: gzipped cuttle.wasm stays within the 1.5 MB budget` | bridge-smoke | bridge-smoke | verified |
| R18.2 | Precache manifest includes engine assets | — | — | bridge-smoke | todo |
| R18.3 | Full offline run after first load | — | — | e2e-test | todo |
| R18.4 | Installable PWA manifest | — | — | e2e-test | todo |
| R19.1 | No horizontal scroll at the iPhone target widths | — | — | e2e-test | todo |
| R19.2 | All tap targets ≥44px | — | — | e2e-test | todo |
| R19.3 | CSS-transform-only animations; reduced-motion playable | — | — | e2e-test, unit-test | todo |
| R19.4 | Phone-viewport legibility | — | — | screenshot-judge | todo |
| R19.5 | iPhone targets: safe areas and the short Safari viewport | — | — | e2e-test, unit-test | todo |
| R20.1 | Last move description shown after each action | — | — | e2e-test | todo |
| R20.2 | Recap formatter is per-viewer and redaction-safe | `vitest: web/tests/unit/recap.test.ts` (every §4.6 row)<br>`TestSPEC2_7_TargetCardPerMoveKind`<br>`TestSPEC2_7_TargetCardNamesOnlyBoardCards`<br>`TestSPEC2_9_RestoreTargetCardKindConsistency` | vitest + go unit | unit-test | verified |
| R20.3 | Recap presentation and lastSeenSeq stamping | — | — | e2e-test | implemented |
| R21.1 | Reference candidate set generated | — | — | image-judge | todo |
| R21.2 | Style-lock document authored | — | — | image-judge | todo |
| R21.3 | ApisMellow approves the reference set | — | — | human-approval | todo |
| R22.1 | Full 52-face + back fan-out generation | — | — | image-judge | todo |
| R22.2 | Consistency judge scoring with regeneration | — | — | image-judge | todo |
| R22.3 | Complete theme asset budget ≤4MB | `vitest: theme-mythic-assets.test.ts "declared assetBytes equals the real total and is within the 4 MB budget (R22.3)"` | vitest | unit-test | implemented |
| R22.4 | Bitmap assets are runtime-cached, not precached | — | — | e2e-test | todo |
| R23.1 | Theme seam contract wiring | `vitest: theme.test.ts "every registry entry conforms to the Face/Back component contract"`<br>`vitest: theme-glyph-boundary.test.ts`<br>`vitest: theme-bitmap.test.ts "bitmap Face/Back contract (SPEC §5.6, R23.1)"`<br>`e2e: themes.spec.ts "swapping Classic for Mythic never moves or resizes anything on the board"` | vitest + Playwright | unit-test, e2e-test | implemented |
| R23.2 | User-facing theme toggle, persisted | `e2e: themes.spec.ts "the home screen offers Classic and Mythic; the pick persists across a reload and never enters the save"`<br>`vitest: home-theme-picker.test.ts`<br>`vitest: theme-save-resume.test.ts` | Playwright + vitest | e2e-test | implemented |
| R23.3 | Automatic fallback to vector baseline | `e2e: themes.spec.ts "a face image that fails to load falls back to the vector face for that card only, in the same box"`<br>`vitest: theme-bitmap.test.ts "per-slot fallback to vector"` | Playwright + vitest | e2e-test | implemented |
| R23.4 | Full playability with theme off | — | — | e2e-test | todo |
| R23.5 | Theme-swap visual consistency | — | — | screenshot-judge | todo |

## SPEC contracts not traced to a ledger ID

| SPEC § | Test(s) | Layer |
|---|---|---|
| §2.4 function surface, read calls don't mutate, snapshot/restore | `TestSPEC2_4_ReadCallsDoNotMutate`<br>`TestSPEC2_4_SnapshotRestoreRoundTrip`<br>`TestSPEC2_4_RestoreReturnsNamedViewer`<br>`TestSPEC2_4_NewGameReturnsFirstActorView` | go unit + bridge-smoke |
| §2.6 seed string, random seed/dealer, pinned dealStream | `TestSPEC2_6_SeedIsDecimalStringUint64`<br>`TestSPEC2_6_OmittedSeedAndDealerAreRandom`<br>`TestSPEC2_6_DealStreamIsPinned` | go unit |
| §2.7 envelope invariants and wire shape | `TestSPEC2_7_EnvelopeInvariantsAcrossRandomGames`<br>`TestSPEC2_7_AppliedMoveRecordsPreState`<br>`TestSPEC2_7_ApplyReturnsMoverView`<br>`TestSPEC2_7_SubKindOnAppliedMove`<br>`TestSPEC2_7_SubKindNullForDeadEndSevenPick`<br>`TestSPEC2_7_ViewLegalMovesOnlyForActor`<br>`TestSPEC2_7_PointEntryWireKeys`<br>`TestSPEC2_7_PlayerViewWireKeys`<br>`TestSPEC2_7_MoveWireShape` | go unit |
| §2.8 normalization | `TestSPEC2_8_JackOwnersArray`<br>`TestSPEC2_8_NilSlicesAreEmptyArrays`<br>`TestSPEC2_8_FrozenIDsSortedDropFalse`<br>`TestSPEC2_8_Rank0CardIsNull`<br>`TestSPEC2_8_WinnerBareNumber`<br>`TestSPEC2_8_GlassesAndNormalization` | go unit |
| §2.9 errors | `TestSPEC2_9_ErrorShape`<br>`TestSPEC2_9_NoGame`<br>`TestSPEC2_9_BadRequest`<br>`TestSPEC2_9_IndexOutOfRange`<br>`TestSPEC2_9_IllegalMove`<br>`TestSPEC2_9_NoLegalMoves`<br>`TestSPEC2_9_InternalOnPanic`<br>`TestSPEC2_9_RestorePendingMatchesPhase`<br>`TestSPEC2_9_CommitRequiresActorEnvelope` | go unit |
| §3.2 redaction | `TestSPEC3_2_ViewRedactsHandsDeckSevenAndScrapIndex`<br>`TestSPEC3_2_PendingOmitsScrapIndex`<br>`TestSPEC3_2_GlassesOwnerSeesOpponentHandOnly`<br>`TestSPEC3_2_IndexRedactedForNonMover` | go unit |
| §2.3 readiness, main never returns | smoke: boots the real compiled Go WASM bridge and keeps it alive | bridge-smoke |
| §7.2(5) redaction sampling across corpus positions | `smoke: §7.2(5): redaction holds across sampled positions in multiple corpus games` | bridge-smoke |
| §2.4/§5.7 snapshot restore round-trip through the compiled bridge | `smoke: SPEC §2.4/§5.7: snapshot restore round-trip preserves seq and viewer` | bridge-smoke |
| §5.4 bridge module boundary (`lib/bridge/{wasm,engine,schema}.ts`), §2.3 boot, §2.4 typed call surface incl. amended `restore(snapshotJson, viewerId)`, §3.4 opaque `snapshot()` | `vitest: "SPEC §2.4/§2.6: newGame serializes NewGameOpts as JSON..."`<br>`"SPEC §2.4/A3: apply takes an index..."`<br>`"SPEC §2.4: view requests a named redacted viewer"`<br>`"SPEC §2.4: legalMoves and describe take no arguments"`<br>`"SPEC §2.4 (amended 2026-09-26): restore takes (snapshotJson, viewerId)..."`<br>`"SPEC §3.4/§5.7: snapshot returns the opaque unredacted string verbatim, unvalidated"`<br>`"SPEC §2.3: a bridge call throws a clear error before ensureEngine()..."` (web/tests/unit/engine.test.ts) | vitest |
| §2.7 envelope schema, amended 2026-09-26 (`AppliedMove.index?` omitted for non-movers, `subKind: MoveKind \| null` always present, `legalMoves.length === descriptions.length`, `seq === history.length`) | `vitest: "SPEC §2.7: accepts a normalized redacted envelope unchanged"`<br>`"SPEC §2.8: rejects raw JackOwners base64 and a nil own-hand array"`<br>`"SPEC §3.2: rejects any full deck field crossing the view boundary"`<br>`"SPEC §2.7 (amended 2026-09-26): AppliedMove.index is optional..."`<br>`"SPEC §2.7 (amended 2026-09-26): AppliedMove.subKind is always present as a key, and nullable"`<br>`"SPEC §2.7: legalMoves.length must equal descriptions.length"`<br>`"SPEC §2.7: seq must equal history.length"` (web/tests/unit/schema.test.ts) | vitest |
| §1.2/§5.2 P1b walking-skeleton status page — `ensureEngine()` boot through a real `App.svelte`, golden-deal (seed 42, dealer 1) smoke check, §3.3 rule 4 (renders only the phone-holder's own envelope) | `e2e: "boots the compiled engine and verifies the golden deal through the app shell"` (web/tests/e2e/walking-skeleton.spec.ts), 390×844 viewport | e2e-test |
| §5.6 bitmap themes: lazy catalog and manifest loading, face images only for cards the viewer may see, none behind the curtain | `vitest: theme-bitmap.test.ts "catalog and lazy loading (A-6)"`<br>`vitest: theme-privacy.test.ts "Mythic active: face images only for cards the viewer may see"` | vitest |
