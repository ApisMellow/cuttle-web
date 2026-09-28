# Upstream engine issues

These defects are in `github.com/ApisMellow/cuttle` and must not be hidden or
repaired in Cuttle Web. The intentionally red bridge tests require future
implementation to report `ILLEGAL_MOVE` and `NO_LEGAL_MOVES`, so a later UI can
render the diagnostic state required by `docs/SPEC.md` §2.10.

## E-1 — stale frozen hand index rejects offered seven picks

`FrozenIDs` is keyed by hand index. Hand removal does not remap stale keys;
`legalForCard` clears them while enumerating seven-pick moves, but `Apply`
injects the selected card at `len(hand)` against the real stale map. If that
index is marked, every offered pick at the index is rejected.

Minimal state from SPEC §2.10:

```text
Hand [3♣, 4♣], FrozenIDs {2:true}, PhaseSevenChoosing, Revealed [5♥]
LegalMoves -> "7: play 5♥ as one-off", "7: play 5♥ as point card"
Apply(either) -> illegal move
```

The fixed walking-skeleton corpus currently excludes seeds 6, 110, 142, and
176. Their precise step and offered description are recorded in
`web/tests/smoke/exclusions.json`. Remove those exclusions when the upstream
fix lands; do not compensate in web code.

## E-2 — seven reveal can have no legal pick

If every revealed card is a Jack and the opponent has no stealable point,
`legalSevenPickMoves` returns an empty list outside game over.

Minimal state from SPEC §2.10:

```text
PhaseSevenChoosing, Revealed [J♦, J♠], opponent has no unprotected points
LegalMoves -> []
```

No E-2 seed was encountered by the initial fixed 1–240 corpus under its
committed move-selection PRNG. The bridge still reports `NO_LEGAL_MOVES` and
the smoke invariant remains active for every non-excluded seed.

## 2026-09-26 — E-1/E-2 resolved in engine v0.2.0; exclusions removed

`go.mod` now requires `github.com/ApisMellow/cuttle v0.2.0` (Batch 0). An
independent reviewer found that all four previously-excluded seeds (6, 110,
142, 176) play cleanly on this engine version, and that the full committed
240-seed corpus (`web/tests/smoke/corpus.json`, seeds 1-240) produces zero
`ILLEGAL_MOVE`/`NO_LEGAL_MOVES` defects with no exclusions.

Verified independently before removing anything: temporarily emptied
`web/tests/smoke/exclusions.json`'s seed list and ran
`npm --prefix web run test:smoke` against the full 240-seed corpus, twice.
Both runs were green — 0 defects, wins and stalemates both occurred. Per
SPEC §7.2(6) ("deleting the exclusion list is the whole re-enablement"),
`web/tests/smoke/exclusions.json` has been deleted and the filtering code
that read it removed from `web/tests/smoke/bridge-smoke.mjs`. The corpus
test (now named `R11.4: full committed seed corpus reaches terminal state
via offered indices with zero legal-move-contract breaks`) runs all 240
seeds unfiltered.

E-1's fix and E-2's handling are engine-side (v0.2.0 changelog, not
inspected here — out of scope per this batch's brief: no engine edits). The
dead-end scrap fallback for E-2 is visible bridge-side as a `SevenPick` move
with `subKind: null` and description "7: no legal play — scrap X"
(`docs/assumptions.md` Batch 1, "History `subKind` validation on restore").
No E-2 case was hit in this 240-seed corpus, matching the note below that
E-2 is rare (~0.3% in the original 4,000-game survey).

If a future corpus expansion or reviewer ever reproduces either defect
again, **stop and report** — do not re-add an exclusion list or work around
it in web code (SPEC OQ-2's "no" still applies).

## Related low-severity frozen marker lifecycle

A 9 played on the acting player's own Jack-stolen point can add a frozen mark
that clears before their next turn. Cuttle Web must render the engine-provided
frozen indices directly and must not add compensating rules (SPEC §8 OQ-13).
