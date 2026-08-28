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

## Related low-severity frozen marker lifecycle

A 9 played on the acting player's own Jack-stolen point can add a frozen mark
that clears before their next turn. Cuttle Web must render the engine-provided
frozen indices directly and must not add compensating rules (SPEC §8 OQ-13).
