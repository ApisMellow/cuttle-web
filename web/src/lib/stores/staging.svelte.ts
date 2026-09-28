// SPEC §5.3 ("staging.svelte.ts — R9/R12 selection pipeline"), §6.1–§6.5 —
// the tap-to-play pipeline: idle → selected → staged → applying → idle
// (§6.1). This module owns zero game rules: it only organizes the flat
// `Move[]` an envelope already declared legal (mirroring the "zero rule
// logic" posture of `lib/affordances.ts`, which it builds on for grouping,
// ambiguity detection, and the move→board-key mapping).
//
// P2 W11 scope (this round): Draw, PlayPoint, PlayPermanent (including a
// Jack steal), Scuttle, and OneOff — both targeted (2-as-scrap, 9) and
// untargeted (A, 4, 5, 6, 7) — plus the Pass phase control. `Counter`,
// `Decline`, `SevenPick`, `DiscardPair`, and a rank-3 OneOff's ScrapIndex
// pick mode are round-4 UI (`CounterPrompt`, `SevenRevealPanel`,
// `DiscardPicker`, `ScrapBrowser`). This store never invents UI for them: a
// hand card playable only through one of them renders dimmed (never enters
// `selected`), and a tap that would otherwise need the `ScrapBrowser` (a
// rank-3's ScrapIndex group) is a deliberate no-op — see `#handleTargetTap`.
//
// R12 is absolute: `apply` is called from exactly one place, `confirm()`,
// and only when `state === 'staged'`. `state` flips to `'applying'`
// synchronously before the injected `apply` is ever awaited, so a second,
// rapid `confirm()` (or any `tap()`/`choose()`) sees `'applying'` and is a
// no-op — no double-submit is possible regardless of how the two calls
// interleave (SPEC §6.1's "applying" state).

import { boardTargetKey, isAmbiguousSlot } from '../affordances';
import type { Move } from '../bridge/schema';
import { MoveKind } from '../enums';
import type { TargetKey } from '../targetKey';

export type StagingState = 'idle' | 'selected' | 'staged' | 'applying';

export interface ChooserCandidate {
  index: number;
  description: string;
}

export interface ChooserModel {
  candidates: ChooserCandidate[];
}

/** What the integrator's `getEnv()` hands the store: the current position's legal moves and their engine-authored descriptions (SPEC §2.7). */
export interface StagingEnv {
  legalMoves: Move[];
  descriptions: string[];
  /**
   * P2 W13: the viewer's hand length. With it, `dimmedHand` dims every hand
   * index no stageable move names (R9.3), not only the indices the engine
   * mentioned in some other move. Omitted, the W11 behaviour stands.
   */
  handSize?: number;
}

// SPEC §6.3 — the MoveKinds this round's pipeline can carry all the way to
// `staged`. A hand card playable only through a kind NOT in this set (e.g.
// Counter, during a counter window) contributes to `dimmedHand` instead of
// `selected` (see `HAND_ROOTED_KINDS` below and its doc comment).
const IN_SCOPE_HAND_KINDS: ReadonlySet<Move['Kind']> = new Set([
  MoveKind.PlayPoint,
  MoveKind.PlayPermanent,
  MoveKind.Scuttle,
  MoveKind.OneOff,
]);

// Kinds that name a specific hand card at all — the in-scope ones, plus
// Counter (round 4). Used only to compute `dimmedHand`: a hand index that
// appears here but not in `IN_SCOPE_HAND_KINDS` is known to exist (the
// engine offered *some* move for it) but has no play this round's pipeline
// can stage, so it dims exactly like a genuinely unplayable card (R9.3) —
// this store has no way to distinguish the two without the hand's total
// size, which `getEnv()` does not carry (see the report's dimmedHand
// assumption). Draw, Pass, Decline and DiscardPair don't use `HandIndex` to
// mean "a specific hand card", so they're deliberately excluded here too.
const HAND_ROOTED_KINDS: ReadonlySet<Move['Kind']> = new Set([...IN_SCOPE_HAND_KINDS, MoveKind.Counter]);

const EMPTY_KEYS: ReadonlySet<TargetKey> = new Set();
const EMPTY_NUMBERS: ReadonlySet<number> = new Set();

function indicesOfKind(legalMoves: Move[], kind: Move['Kind']): number[] {
  const out: number[] = [];
  legalMoves.forEach((m, i) => {
    if (m.Kind === kind) out.push(i);
  });
  return out;
}

/**
 * SPEC §6.2/§6.3 — every in-scope candidate rooted at `handIndex`, grouped
 * by the board key its target step resolves to. A hand card with two
 * different-zone affordances (an Ace: `zone:oneoff` and `zone:points`)
 * produces two singleton buckets, each resolved by its own zone tap — no
 * chooser needed, because the two are already distinguished before any
 * target tap happens. A hand card whose candidates land on the SAME board
 * key (a genuine ambiguity, or a rank-3's ScrapIndex collapse) produces one
 * multi-index bucket, disambiguated in `#handleTargetTap`.
 */
function candidatesByTargetKey(handIndex: number, legalMoves: Move[]): Map<TargetKey, number[]> {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain, function-local scratch map, never held as $state; the store only ever reads its finished keys/values (see call sites below).
  const byKey = new Map<TargetKey, number[]>();
  legalMoves.forEach((m, i) => {
    if (!IN_SCOPE_HAND_KINDS.has(m.Kind) || m.HandIndex !== handIndex) return;
    const key = boardTargetKey(m);
    if (key === null) return; // never happens for an in-scope kind; defensive only
    const bucket = byKey.get(key);
    if (bucket) bucket.push(i);
    else byKey.set(key, [i]);
  });
  return byKey;
}

/** SPEC §6.3 — Pass is only ever the sole legal move, engine-guaranteed; gated defensively here too so a stray `tap('pass')` can never stage it alongside anything else. */
function passAvailableFor(env: StagingEnv | null): boolean {
  return env !== null && env.legalMoves.length === 1 && env.legalMoves[0].Kind === MoveKind.Pass;
}

function computeDimmedHand(env: StagingEnv | null): ReadonlySet<number> {
  if (!env) return EMPTY_NUMBERS;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain, function-local scratch sets, never held as $state; only the returned `dimmed` set (built below, itself never mutated after `$derived.by` returns it) ever reaches a reactive field.
  const seen = new Set<number>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- see above.
  const inScope = new Set<number>();
  for (const m of env.legalMoves) {
    if (!HAND_ROOTED_KINDS.has(m.Kind)) continue;
    seen.add(m.HandIndex);
    if (IN_SCOPE_HAND_KINDS.has(m.Kind)) inScope.add(m.HandIndex);
  }
  // P2 W13: with the hand size known, every index no stageable move names
  // dims — including a card the engine offered nothing for at all.
  if (env.handSize !== undefined) {
    for (let i = 0; i < env.handSize; i++) seen.add(i);
  }
  if (inScope.size === seen.size) return EMPTY_NUMBERS; // common case, avoid allocating
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- built once here, then handed straight back to `dimmedHand`'s `$derived.by` as a finished, never-mutated-again value; the next call builds an entirely new set rather than mutating this one.
  const dimmed = new Set<number>();
  for (const idx of seen) if (!inScope.has(idx)) dimmed.add(idx);
  return dimmed;
}

/** The board keys that get the `staged` (ochre) treatment for a move about to stage: the card's own source key plus its target key, or just the root key for Draw/Pass (no separate target step, SPEC §6.3). */
function stagedKeysFor(move: Move): ReadonlySet<TargetKey> {
  switch (move.Kind) {
    case MoveKind.Draw:
      return new Set(['deck']);
    case MoveKind.Pass:
      return new Set(['pass']);
    default: {
      const target = boardTargetKey(move);
      const keys: TargetKey[] = [`hand:${move.HandIndex}`];
      if (target !== null) keys.push(target);
      return new Set(keys);
    }
  }
}

/**
 * SPEC §5.3, §6.1–§6.5 — the R9/R12 selection pipeline. Pure orchestration:
 * every candidate index it ever exposes (`stagedIndex`, a chooser
 * candidate's `index`) comes straight from the `legalMoves` array the
 * integrator's `getEnv()` returned for the position live at the moment of
 * the tap, so it is structurally impossible to stage an index the engine
 * didn't offer.
 */
export class StagingStore {
  readonly #getEnv: () => StagingEnv | null;
  readonly #applyFn: (index: number) => Promise<void>;

  state = $state<StagingState>('idle');
  selectedHand = $state<number | null>(null);
  highlighted = $state<ReadonlySet<TargetKey>>(EMPTY_KEYS);
  staged = $state<ReadonlySet<TargetKey>>(EMPTY_KEYS);
  stagedIndex = $state<number | null>(null);
  stagedDescription = $state<string | null>(null);
  chooser = $state<ChooserModel | null>(null);
  inspect = $state<number | null>(null);

  inert = $derived(this.state === 'applying');
  passAvailable = $derived.by(() => passAvailableFor(this.#getEnv()));
  dimmedHand = $derived.by(() => computeDimmedHand(this.#getEnv()));

  constructor(getEnv: () => StagingEnv | null, apply: (index: number) => Promise<void>) {
    this.#getEnv = getEnv;
    this.#applyFn = apply;
  }

  /** SPEC §6.1 — the single entry point for every board/deck/pass tap. */
  tap(key: TargetKey): void {
    if (this.state === 'applying') return; // inert: the board is locked while applying (§6.1)
    const env = this.#getEnv();
    if (!env) return;

    this.inspect = null; // any tap dismisses a prior detail popover

    if (this.state === 'idle') {
      this.#handleRootTap(key, env);
      return;
    }
    if (this.state === 'selected') {
      if (this.chooser) return; // the modal owns interaction; only choose()/cancel() act
      this.#handleTargetTap(key, env);
      return;
    }
    // state === 'staged': only confirm()/cancel() act (SPEC §6.1 — Confirm/Cancel are the only controls once staged).
  }

  /** SPEC §6.4 — selects a candidate from the ambiguity chooser. Always lands on `staged`, never on `apply` directly. */
  choose(index: number): void {
    if (this.state !== 'selected' || !this.chooser) return;
    const candidate = this.chooser.candidates.find((c) => c.index === index);
    if (!candidate) return;
    const env = this.#getEnv();
    if (!env) return;
    // Bounds-check against the CURRENT env, not just the chooser candidate
    // list: `#getEnv()` is re-fetched here, separately from the env that
    // built `this.chooser.candidates` at tap time, so a position change in
    // between (an external refresh shrinking legalMoves) can leave `index`
    // valid for the chooser but out of range for `env.legalMoves` now.
    // Staging it would read past the current array (#stage indexes it
    // unchecked) — refuse instead of guessing.
    if (index < 0 || index >= env.legalMoves.length) return;
    this.#stage(index, env);
  }

  /**
   * SPEC §6.1 — the only call site of the injected `apply`. Flips to
   * `'applying'` synchronously before awaiting, so a second `confirm()`
   * called before the first resolves sees `state !== 'staged'` and is a
   * true no-op: `apply` is invoked at most once per `confirm()` that
   * actually ran (R12).
   */
  async confirm(): Promise<void> {
    if (this.state !== 'staged' || this.stagedIndex === null) return;
    const index = this.stagedIndex;
    this.state = 'applying';
    try {
      await this.#applyFn(index);
    } finally {
      this.#clearToIdle();
    }
  }

  /** SPEC §6.1 — "Cancel is always available while staged"; the AmbiguityChooser also carries its own Cancel (§6.4). A no-op anywhere else (e.g. merely `selected`, no chooser open — that's what a non-highlighted tap is for, SPEC §6.1). */
  cancel(): void {
    if (this.state === 'staged' || (this.state === 'selected' && this.chooser !== null)) {
      this.#clearToIdle();
    }
  }

  /** Called by the integrator on every `apply` and every viewer change (SPEC §5.3). Idempotent. */
  reset(): void {
    this.#clearToIdle();
  }

  #handleRootTap(key: TargetKey, env: StagingEnv): void {
    if (key.startsWith('hand:')) {
      this.#selectHand(Number(key.slice('hand:'.length)), env);
      return;
    }
    if (key === 'deck') {
      this.#stageOrChoose(indicesOfKind(env.legalMoves, MoveKind.Draw), env);
      return;
    }
    if (key === 'pass') {
      if (passAvailableFor(env)) this.#stage(0, env);
      return;
    }
    // Any other key while idle has nothing to select from — a no-op.
  }

  #selectHand(handIndex: number, env: StagingEnv): void {
    const byKey = candidatesByTargetKey(handIndex, env.legalMoves);
    if (byKey.size === 0) {
      // SPEC §6.1 — a dimmed hand card tap does NOT enter `selected`; it
      // opens the integrator's detail popover instead.
      this.inspect = handIndex;
      return;
    }
    this.selectedHand = handIndex;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- `highlighted` is always REPLACED wholesale (never `.add()`/`.delete()`'d in place) on every transition; a plain Set's reference-equality reactivity through $state is exactly what's needed, and SvelteSet's element-level reactivity is never used.
    this.highlighted = new Set(byKey.keys());
    this.staged = EMPTY_KEYS;
    this.stagedIndex = null;
    this.stagedDescription = null;
    this.chooser = null;
    this.state = 'selected';
  }

  #handleTargetTap(key: TargetKey, env: StagingEnv): void {
    // Tapping a different (or the same) hand card while selected re-selects
    // (SPEC §6.1), even though `key` isn't a "target" in the §6.4 sense.
    if (key.startsWith('hand:')) {
      this.#selectHand(Number(key.slice('hand:'.length)), env);
      return;
    }

    const selectedHand = this.selectedHand;
    if (selectedHand === null) {
      // Reached only via the deck/pass root-tap ambiguity path (§6.1's "or
      // the chooser" branch), where the chooser is already open — handled
      // above in `tap()`. Nothing else can put us in `selected` with a null
      // `selectedHand`, so this is unreachable in practice; defensive no-op.
      return;
    }

    const byKey = candidatesByTargetKey(selectedHand, env.legalMoves);
    const indices = byKey.get(key);
    if (!indices || indices.length === 0) {
      // SPEC §6.1, R9.4 — tapping a non-highlighted key clears to idle and stages nothing.
      this.#clearToIdle();
      return;
    }

    if (indices.length === 1) {
      this.#stage(indices[0], env);
      return;
    }

    if (isAmbiguousSlot(indices, env.legalMoves)) {
      // SPEC §6.4 — more than one candidate remains for the chosen target: open the chooser.
      this.chooser = { candidates: indices.map((i) => ({ index: i, description: env.descriptions[i] })) };
      return;
    }

    // Multi-index but NOT ambiguous per `isAmbiguousSlot` — structurally,
    // the only way that happens is a scrap-pick collapse (a rank-3's
    // ScrapIndex variants, SPEC §6.2 last paragraph), which needs the
    // round-4 `ScrapBrowser`. Never guess a `ScrapIndex`: stay `selected`,
    // stage nothing, invent no UI.
  }

  #stageOrChoose(indices: number[], env: StagingEnv): void {
    if (indices.length === 0) return; // not legal right now — a no-op
    if (indices.length === 1) {
      this.#stage(indices[0], env);
      return;
    }
    if (isAmbiguousSlot(indices, env.legalMoves)) {
      this.selectedHand = null;
      this.highlighted = EMPTY_KEYS;
      this.staged = EMPTY_KEYS;
      this.stagedIndex = null;
      this.stagedDescription = null;
      this.chooser = { candidates: indices.map((i) => ({ index: i, description: env.descriptions[i] })) };
      this.state = 'selected';
      return;
    }
    // Draw/Pass never produce a scrap-pick-shaped collapse (that check only
    // fires for OneOff/SevenPick shapes) — this branch is unreachable, kept
    // only so a future engine change can't make this stage a guess.
  }

  #stage(index: number, env: StagingEnv): void {
    const move = env.legalMoves[index];
    this.stagedIndex = index;
    this.stagedDescription = env.descriptions[index];
    this.staged = stagedKeysFor(move);
    this.highlighted = EMPTY_KEYS;
    this.chooser = null;
    this.state = 'staged';
  }

  #clearToIdle(): void {
    this.state = 'idle';
    this.selectedHand = null;
    this.highlighted = EMPTY_KEYS;
    this.staged = EMPTY_KEYS;
    this.stagedIndex = null;
    this.stagedDescription = null;
    this.chooser = null;
    this.inspect = null;
  }
}
