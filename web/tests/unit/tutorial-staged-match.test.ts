// @vitest-environment jsdom
// R25.3 S3b at the matcher (docs/tutorial-plan.md T6, design §7.2): the
// staged-setup reader and classifier, on fixture DOM and fixture envelopes.
//
// `readStagedPage` reads only the attributes design §7.2 lists:
// `aria-pressed` and `data-staged` on `hand-card-<i>`, `data-state="staged"`
// on `deck-pile`, on a `zone-*` hit button, on `counter-link` and on the
// theme face inside a `point-<o>-<i>` / `perm-<o>-<i>` button, and whether
// `staging-confirm` is present. The fixture markup mirrors the real
// components (HandCard, DeckPile, DropZones, CenterZone, PointRow,
// PermanentRow, StagingBar).
//
// `classifyStaged` groups candidates per plan P4: legal moves with the staged
// hand index (or Kind Draw for the deck) whose `boardTargetKey` is the staged
// target (a 2 on `counter-link` is its Counter, issue #93); two staged hand
// cards take the DiscardPair of those two.
// Move shapes are wire-true for the engine (engine/moves.go:24-34):
// a Jack steal is PlayPermanent with JackTarget (apply.go:88-97); Scuttle and
// a targeted 9 one-off carry Target (apply.go:70-87, :112-123); a Counter
// carries the 2's HandIndex and no target, and a DiscardPair its two hand
// indices (v0.3.0).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { boardTargetKey, slotKey } from '../../src/lib/affordances';
import type { Card, Envelope, Move, PointEntry, Target } from '../../src/lib/bridge/schema';
import { classifyStaged, readStagedPage, type StagedPage } from '../../src/lib/tutorial/match';
import type { MoveStep } from '../../src/lib/tutorial/types';
import { Kind, Phase, envelope, playerView } from './game-test-support';

const card = (Rank: Card['Rank'], Suit: Card['Suit']): Card => ({ Rank, Suit });
const C = 0, D = 1, H = 2, S = 3;

function move(over: Partial<Move> & { Kind: Move['Kind'] }): Move {
  return { Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null, ...over };
}

const tgt = (Owner: 0 | 1, Zone: 0 | 1, Index: number): Target => ({ Owner, Zone, Index });
const pt = (c: Card, owner: 0 | 1): PointEntry => ({ Card: c, Owner: owner, JackStack: [], JackOwners: [], Controller: owner });

// ---------------------------------------------------------------------------
// Fixture DOM
// ---------------------------------------------------------------------------

interface BoardFixture {
  hand?: number;
  pressed?: number[];
  stagedHand?: number[];
  deck?: 'normal' | 'highlighted' | 'staged';
  zones?: Partial<Record<'points' | 'permanents' | 'oneoff', 'normal' | 'highlighted' | 'staged'>>;
  /** testid → the face's data-state, e.g. `{ 'point-1-0': 'staged' }`. */
  faces?: Record<string, string>;
  /** The last-turn marker's data-state (issue #93). */
  link?: 'normal' | 'highlighted' | 'staged';
  confirm?: boolean;
}

function face(state: string): string {
  return `<div class="cuttle-card-face" data-size="field" data-state="${state}"></div>`;
}

function boardHtml(f: BoardFixture): string {
  const hand = Array.from({ length: f.hand ?? 3 }, (_, i) => {
    const pressed = f.pressed?.includes(i) ?? false;
    const staged = f.stagedHand?.includes(i) ?? false;
    const faceState = staged ? 'staged' : 'normal';
    return `<button data-testid="hand-card-${i}" data-staged="${staged}" data-dimmed="false" aria-pressed="${pressed}">${face(faceState)}</button>`;
  }).join('');
  const zone = (name: 'points' | 'permanents' | 'oneoff', inner = '') => {
    const st = f.zones?.[name] ?? 'normal';
    return `<div class="drop-zone" data-state="${st}"><button data-testid="zone-${name}" data-state="${st}"></button><div class="drop-zone__content">${inner}</div></div>`;
  };
  const faces = f.faces ?? {};
  const cardBtn = (id: string) => `<button data-testid="${id}"><span>${face(faces[id] ?? 'normal')}</span></button>`;
  return `
    <div data-testid="board">
      <div data-testid="opponent-zone">
        ${zone('permanents', cardBtn('perm-1-0'))}
        ${zone('points', cardBtn('point-1-0') + cardBtn('point-1-1'))}
      </div>
      <div data-testid="center-zone">
        <button data-testid="deck-pile" data-state="${f.deck ?? 'normal'}"><span>${face('normal')}</span></button>
        <button data-testid="scrap-pile" data-state="normal"></button>
        ${zone('oneoff', `<button data-testid="counter-link" data-state="${f.link ?? 'normal'}" aria-label="Last turn"></button>`)}
      </div>
      <div data-testid="player-zone">
        ${zone('points', cardBtn('point-0-0'))}
        ${zone('permanents', cardBtn('perm-0-0') + cardBtn('perm-0-1'))}
        <div data-testid="player-hand">${hand}</div>
      </div>
      ${f.confirm ? '<div data-testid="staging-bar"><button data-testid="staging-cancel">Cancel</button><button data-testid="staging-confirm">Confirm</button></div>' : ''}
    </div>`;
}

/** The opponent's points zone appears once in the fixture above; the own zones keep their real testids too, so only one of each is ever "staged" per fixture. */
function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const NOTHING: StagedPage = { selectedHand: null, source: null, target: null, confirm: false, pair: null };

describe('readStagedPage (fixture DOM)', () => {
  it('nothing staged → every field null or false', () => {
    expect(readStagedPage(root(boardHtml({})))).toEqual(NOTHING);
    expect(readStagedPage(root(''))).toEqual(NOTHING);
  });

  it('a pressed hand card is the selection, not a source', () => {
    expect(readStagedPage(root(boardHtml({ pressed: [2], zones: { points: 'highlighted' } })))).toEqual({ ...NOTHING, selectedHand: 2 });
  });

  it('deck staged → source deck, and the deck is its own target', () => {
    expect(readStagedPage(root(boardHtml({ deck: 'staged', confirm: true })))).toEqual({
      ...NOTHING,
      source: 'deck',
      target: 'deck',
      confirm: true,
    });
  });

  it('a lit deck is not a staged deck', () => {
    expect(readStagedPage(root(boardHtml({ deck: 'highlighted' }))).source).toBeNull();
  });

  it('a staged hand card and a staged zone → hand source and zone key', () => {
    for (const z of ['points', 'permanents', 'oneoff'] as const) {
      const page = readStagedPage(root(boardHtml({ pressed: [1], stagedHand: [1], zones: { [z]: 'staged' }, confirm: true })));
      expect(page).toEqual({ selectedHand: 1, source: { hand: 1 }, target: `zone:${z}`, confirm: true, pair: null });
    }
  });

  it('a staged point face → point:o:i; a staged permanent face → perm:o:i', () => {
    expect(readStagedPage(root(boardHtml({ stagedHand: [0], faces: { 'point-1-1': 'staged' }, confirm: true }))).target).toBe('point:1:1');
    expect(readStagedPage(root(boardHtml({ stagedHand: [0], faces: { 'point-1-0': 'staged' }, confirm: true }))).target).toBe('point:1:0');
    expect(readStagedPage(root(boardHtml({ stagedHand: [0], faces: { 'perm-0-1': 'staged' }, confirm: true }))).target).toBe('perm:0:1');
  });

  it('ignores lit faces, the hand card\'s own staged face, the drop-zone wrapper and the scrap pile', () => {
    // The hand card's face carries data-state="staged" while staged; it is the
    // source, never a target.
    const page = readStagedPage(root(boardHtml({ stagedHand: [2], faces: { 'point-1-0': 'highlighted' }, confirm: true })));
    expect(page.source).toEqual({ hand: 2 });
    expect(page.target).toBeNull();
    // A wrapper div with data-state but no testid is not read.
    const el = root(`<div class="drop-zone" data-state="staged"><button data-testid="zone-points" data-state="normal"></button></div>`);
    expect(readStagedPage(el).target).toBeNull();
    const scrap = root(`<button data-testid="scrap-pile" data-state="staged"></button>`);
    expect(readStagedPage(scrap)).toEqual(NOTHING);
  });

  it('reads attributes, not classes or labels', () => {
    const el = root(
      '<button data-testid="hand-card-0" class="staged pressed" aria-label="Nine, staged" data-staged="false" aria-pressed="false"></button>' +
        '<button data-testid="zone-points" class="staged" data-state="highlighted"></button>',
    );
    expect(readStagedPage(el)).toEqual(NOTHING);
  });

  it('two staged hand cards (a discard pair) give no single source; they are the pair', () => {
    const page = readStagedPage(root(boardHtml({ stagedHand: [0, 2], confirm: true })));
    expect(page.source).toBeNull();
    expect(page.pair).toEqual([0, 2]);
  });

  it('only exact testids count (no sibling-prefix lookalikes)', () => {
    const el = root(
      '<button data-testid="hand-card-frozen" data-staged="true" aria-pressed="true"></button>' +
        '<button data-testid="point-row-1" data-state="staged"><div data-state="staged"></div></button>',
    );
    expect(readStagedPage(el)).toEqual(NOTHING);
  });

  it('issue #93: a staged last-turn marker is the target counter-link; a lit one is not', () => {
    expect(readStagedPage(root(boardHtml({ pressed: [1], stagedHand: [1], link: 'staged', confirm: true })))).toEqual({
      selectedHand: 1,
      source: { hand: 1 },
      target: 'counter-link',
      confirm: true,
      pair: null,
    });
    expect(readStagedPage(root(boardHtml({ pressed: [1], link: 'highlighted' })))).toEqual({ ...NOTHING, selectedHand: 1 });
  });
});

// ---------------------------------------------------------------------------
// classifyStaged (fixture envelopes)
// ---------------------------------------------------------------------------

const NINE_C = card(9, C);
const TEN_H = card(10, H);
const THREE_D = card(3, D);
const JACK_D = card(11, D);
const TWO_H = card(2, H);
const SEVEN_S = card(7, S);
const BLAKE_8D = card(8, D);
const BLAKE_4C = card(4, C);

/**
 * Alice holds 9C, 10H, 3D, JD; Blake has 8D and 4C in points. The 9 can
 * scuttle the 8 AND send it back as a one-off: one tap on `point:1:0`, two
 * slots, which is the ambiguity-chooser pair (SPEC §6.4).
 */
const BOARD_MOVES: Move[] = [
  move({ Kind: Kind.Draw }), // 0
  move({ Kind: Kind.PlayPoint, HandIndex: 0, Card: NINE_C }), // 1
  move({ Kind: Kind.Scuttle, HandIndex: 0, Card: NINE_C, Target: tgt(1, 0, 0) }), // 2  scuttle 8D
  move({ Kind: Kind.OneOff, HandIndex: 0, Card: NINE_C, Target: tgt(1, 0, 0) }), // 3  9 one-off on 8D
  move({ Kind: Kind.Scuttle, HandIndex: 1, Card: TEN_H, Target: tgt(1, 0, 0) }), // 4  10H scuttles 8D
  move({ Kind: Kind.Scuttle, HandIndex: 1, Card: TEN_H, Target: tgt(1, 0, 1) }), // 5  10H scuttles 4C
  move({ Kind: Kind.PlayPoint, HandIndex: 1, Card: TEN_H }), // 6
  move({ Kind: Kind.PlayPoint, HandIndex: 2, Card: THREE_D }), // 7
  move({ Kind: Kind.PlayPermanent, HandIndex: 3, Card: JACK_D, JackTarget: tgt(1, 0, 0) }), // 8  JD steals 8D
  move({ Kind: Kind.PlayPermanent, HandIndex: 3, Card: JACK_D, JackTarget: tgt(1, 0, 1) }), // 9  JD steals 4C
  // A SevenPick's HandIndex is unused (0); its sub-move is a point play. It is
  // rooted at a revealed card, never at hand card 0.
  move({ Kind: Kind.SevenPick, HandIndex: 0, Card: SEVEN_S, SubMove: move({ Kind: Kind.PlayPoint, HandIndex: 0, Card: SEVEN_S }) }), // 10
];

function boardEnv(legalMoves: Move[] = BOARD_MOVES): Envelope {
  return envelope({
    state: playerView({
      you: { hand: [NINE_C, TEN_H, THREE_D, JACK_D], frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: { handCount: 4, hand: null, points: [pt(BLAKE_8D, 1), pt(BLAKE_4C, 1)], permanents: [] },
    }),
    legalMoves,
    descriptions: legalMoves.map((_, i) => `move ${i}`),
  });
}

function step(over: Partial<MoveStep> & Pick<MoveStep, 'expect'>): MoveStep {
  return {
    kind: 'move',
    id: 'x.1',
    main: 'main line',
    spot: [],
    source: { kind: 'testid', id: 'deck-pile' },
    target: { kind: 'testid', id: 'deck-pile' },
    staged: 'staged line',
    tapRoute: 'tap route',
    nudges: [],
    generic: 'generic line',
    success: 'success line',
    demo: { kind: 'none' },
    blake: [],
    ...over,
  };
}

const staged = (source: StagedPage['source'], target: StagedPage['target']): StagedPage => ({
  selectedHand: source !== null && source !== 'deck' ? source.hand : null,
  source,
  target,
  confirm: true,
  pair: null,
});

describe('classifyStaged (fixture envelopes)', () => {
  const env = boardEnv();

  it('the fixture really has a mixed chooser group: one board key, two slots', () => {
    expect(boardTargetKey(BOARD_MOVES[2])).toBe('point:1:0');
    expect(boardTargetKey(BOARD_MOVES[3])).toBe('point:1:0');
    expect(slotKey(BOARD_MOVES[2])).not.toBe(slotKey(BOARD_MOVES[3]));
    expect(boardTargetKey(BOARD_MOVES[8])).toBe('point:1:0');
    expect(slotKey(BOARD_MOVES[8])).toBe('hand:3|jack:1:0');
  });

  it('right: the one candidate matches', () => {
    const st = step({ expect: { kind: Kind.Scuttle, card: TEN_H } });
    expect(classifyStaged(staged({ hand: 1 }, 'point:1:0'), env, st)).toEqual({ verdict: 'right' });
    expect(classifyStaged(staged({ hand: 1 }, 'point:1:1'), env, st)).toEqual({ verdict: 'right' });
  });

  it('right: a Jack steal on a point card (board key point:o:i, slot jack:o:i)', () => {
    const st = step({ expect: { kind: Kind.PlayPermanent, card: JACK_D, target: BLAKE_8D } });
    expect(classifyStaged(staged({ hand: 3 }, 'point:1:0'), env, st)).toEqual({ verdict: 'right' });
  });

  it('right: a 9 one-off on a point card when it is alone at that key', () => {
    // Without the scuttle (say the 8 outranked the 9), the one-off is the
    // only candidate at point:1:0.
    const oneOffOnly = boardEnv(BOARD_MOVES.filter((_, i) => i !== 2));
    const st = step({ expect: { kind: Kind.OneOff, card: NINE_C, target: BLAKE_8D } });
    expect(classifyStaged(staged({ hand: 0 }, 'point:1:0'), oneOffOnly, st)).toEqual({ verdict: 'right' });
  });

  it('unknown: a mixed chooser group (scuttle right, 9 one-off wrong, one tap)', () => {
    const st = step({ expect: { kind: Kind.Scuttle, card: NINE_C } });
    expect(classifyStaged(staged({ hand: 0 }, 'point:1:0'), env, st)).toEqual({ verdict: 'unknown' });
  });

  it('wrong: the step\'s specific nudge for the candidate', () => {
    const st = step({
      expect: { kind: Kind.Scuttle, card: TEN_H },
      nudges: [
        { when: { kind: Kind.PlayPoint, card: THREE_D }, text: 'three nudge' },
        { when: { kind: Kind.PlayPoint, card: TEN_H }, text: 'ten for points nudge' },
      ],
    });
    expect(classifyStaged(staged({ hand: 1 }, 'zone:points'), env, st)).toEqual({ verdict: 'wrong', nudge: 'ten for points nudge' });
    expect(classifyStaged(staged({ hand: 2 }, 'zone:points'), env, st)).toEqual({ verdict: 'wrong', nudge: 'three nudge' });
  });

  it('wrong: the generic line when no rule names the candidate', () => {
    const st = step({ expect: { kind: Kind.Scuttle, card: TEN_H }, nudges: [{ when: { kind: Kind.Draw }, text: 'draw nudge' }] });
    expect(classifyStaged(staged({ hand: 3 }, 'point:1:1'), env, st)).toEqual({ verdict: 'wrong', nudge: 'generic line' });
  });

  it('wrong: an all-wrong chooser group takes the first candidate that has a specific nudge', () => {
    // Candidates at hand 0 / point:1:0 are [2 scuttle, 3 one-off], in order.
    // Only the one-off has a rule, so its line wins over the generic.
    const st = step({
      expect: { kind: Kind.Draw },
      nudges: [{ when: { kind: Kind.OneOff, card: NINE_C }, text: 'nine one-off nudge' }],
    });
    expect(classifyStaged(staged({ hand: 0 }, 'point:1:0'), env, st)).toEqual({ verdict: 'wrong', nudge: 'nine one-off nudge' });
    // Both have rules: the first candidate's (the scuttle's) wins.
    const both = step({
      expect: { kind: Kind.Draw },
      nudges: [
        { when: { kind: Kind.OneOff, card: NINE_C }, text: 'nine one-off nudge' },
        { when: { kind: Kind.Scuttle, card: NINE_C }, text: 'nine scuttle nudge' },
      ],
    });
    expect(classifyStaged(staged({ hand: 0 }, 'point:1:0'), env, both)).toEqual({ verdict: 'wrong', nudge: 'nine scuttle nudge' });
  });

  it('the source matters: the same target from another hand card is a different setup', () => {
    // 10H and 3D both play for points. The expected move is 10H's; staging the
    // 3 there is wrong, not a mix of the two.
    const st = step({ expect: { kind: Kind.PlayPoint, card: TEN_H } });
    expect(classifyStaged(staged({ hand: 1 }, 'zone:points'), env, st)).toEqual({ verdict: 'right' });
    expect(classifyStaged(staged({ hand: 2 }, 'zone:points'), env, st)).toEqual({ verdict: 'wrong', nudge: 'generic line' });
    // 10H at point:1:0 and JD at point:1:0 are different setups too.
    const steal = step({ expect: { kind: Kind.PlayPermanent, card: JACK_D } });
    expect(classifyStaged(staged({ hand: 1 }, 'point:1:0'), env, steal)).toEqual({ verdict: 'wrong', nudge: 'generic line' });
  });

  it('a SevenPick is never a hand-0 candidate', () => {
    // Hand 0's only point play is move 1 (9C for points). The SevenPick
    // (HandIndex 0, sub-move to zone:points) must not join it.
    const st = step({ expect: { kind: Kind.PlayPoint, card: NINE_C } });
    expect(classifyStaged(staged({ hand: 0 }, 'zone:points'), env, st)).toEqual({ verdict: 'right' });
  });

  it('deck: the Draw is the only candidate', () => {
    expect(classifyStaged(staged('deck', 'deck'), env, step({ expect: { kind: Kind.Draw } }))).toEqual({ verdict: 'right' });
    const st = step({ expect: { kind: Kind.PlayPoint, card: TEN_H }, nudges: [{ when: { kind: Kind.Draw }, text: 'draw nudge' }] });
    expect(classifyStaged(staged('deck', 'deck'), env, st)).toEqual({ verdict: 'wrong', nudge: 'draw nudge' });
  });

  it('unknown: no source (nothing staged, or a Pass)', () => {
    // Without the SevenPick, every move at zone:points is a hand card's point
    // play and matches, so a classifier that ignored the missing source would
    // say "right" (or crash).
    const handOnly = boardEnv(BOARD_MOVES.filter((m) => m.Kind !== Kind.SevenPick));
    const st = step({ expect: { kind: Kind.PlayPoint } });
    expect(classifyStaged({ ...NOTHING }, handOnly, st)).toEqual({ verdict: 'unknown' });
    expect(classifyStaged({ ...NOTHING, confirm: true, target: 'zone:points' }, handOnly, st)).toEqual({ verdict: 'unknown' });
    expect(classifyStaged({ ...NOTHING, selectedHand: 1 }, handOnly, st)).toEqual({ verdict: 'unknown' });
    const passOnly = boardEnv([move({ Kind: Kind.Pass })]);
    expect(classifyStaged({ ...NOTHING, confirm: true }, passOnly, step({ expect: { kind: Kind.Pass } }))).toEqual({ verdict: 'unknown' });
  });

  it('unknown: a hand source with no staged target', () => {
    expect(classifyStaged(staged({ hand: 1 }, null), env, step({ expect: { kind: Kind.PlayPoint } }))).toEqual({ verdict: 'unknown' });
  });

  it('unknown: nothing on the page is staged until staging-confirm exists', () => {
    const page = { ...staged({ hand: 1 }, 'zone:points'), confirm: false };
    expect(classifyStaged(page, env, step({ expect: { kind: Kind.PlayPoint, card: TEN_H } }))).toEqual({ verdict: 'unknown' });
  });

  it('unknown: a setup the envelope has no move for (no vacuous "right")', () => {
    expect(classifyStaged(staged({ hand: 2 }, 'point:1:0'), env, step({ expect: { kind: Kind.PlayPoint } }))).toEqual({ verdict: 'unknown' });
    expect(classifyStaged(staged('deck', 'deck'), boardEnv(BOARD_MOVES.slice(1)), step({ expect: { kind: Kind.PlayPoint } }))).toEqual({
      verdict: 'unknown',
    });
  });

  describe('the owed discard with a counter (step 4.2, issue #93)', () => {
    // Alice holds 2H and 5C and owes a discard of 2 (phase 3, no pending):
    // the one DiscardPair, and the Counter of the 2 at hand index 0 (its
    // board target is the last-turn marker).
    const FIVE_C = card(5, C);
    const owed = envelope({
      state: playerView({
        phase: Phase.AwaitingDiscard,
        you: { hand: [TWO_H, FIVE_C], frozenHandIndices: [], points: [], permanents: [], watched: false },
      }),
      legalMoves: [move({ Kind: Kind.DiscardPair, DiscardA: 0, DiscardB: 1 }), move({ Kind: Kind.Counter, HandIndex: 0, Card: TWO_H })],
      descriptions: ['discard hand[0] and hand[1]', 'counter with 2'],
    });
    const st = step({
      expect: { kind: Kind.Counter, card: TWO_H },
      nudges: [{ when: { kind: Kind.DiscardPair }, text: 'discard nudge' }],
      generic: 'discard nudge',
    });

    it('the 2 staged on counter-link is the Counter alone: right', () => {
      expect(boardTargetKey(owed.legalMoves[1])).toBe('counter-link');
      expect(classifyStaged(staged({ hand: 0 }, 'counter-link'), owed, st)).toEqual({ verdict: 'right' });
    });

    it('a staged counter that is not the expected one is wrong', () => {
      const wrongTwo = step({ expect: { kind: Kind.Counter, card: card(2, S) }, nudges: [], generic: 'other two' });
      expect(classifyStaged(staged({ hand: 0 }, 'counter-link'), owed, wrongTwo)).toEqual({ verdict: 'wrong', nudge: 'other two' });
    });

    it('a staged discard pair is the DiscardPair, in either pick order: wrong, with its nudge', () => {
      expect(classifyStaged({ ...NOTHING, confirm: true, pair: [0, 1] }, owed, st)).toEqual({ verdict: 'wrong', nudge: 'discard nudge' });
      expect(classifyStaged({ ...NOTHING, confirm: true, pair: [1, 0] }, owed, st)).toEqual({ verdict: 'wrong', nudge: 'discard nudge' });
    });

    it('a pair with no staging-confirm, or one the engine has no move for, is unknown', () => {
      expect(classifyStaged({ ...NOTHING, pair: [0, 1] }, owed, st)).toEqual({ verdict: 'unknown' });
      expect(classifyStaged({ ...NOTHING, confirm: true, pair: [0, 2] }, owed, st)).toEqual({ verdict: 'unknown' });
    });

    it('a lone 2 picked, nothing staged: unknown', () => {
      expect(classifyStaged({ ...NOTHING, selectedHand: 0 }, owed, st)).toEqual({ verdict: 'unknown' });
    });
  });
});

// ---------------------------------------------------------------------------
// reads no store
// ---------------------------------------------------------------------------

describe('reads no store', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = resolve(here, '../../src/lib');

  /** Relative imports of a module, resolved to files under src/lib. */
  function imports(file: string): string[] {
    const text = readFileSync(file, 'utf8');
    const out: string[] = [];
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gms)) out.push(m[1]);
    for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
    return out;
  }

  it('match.ts imports nothing from lib/stores/', () => {
    const specs = imports(resolve(src, 'tutorial/match.ts'));
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => /(^|\/)stores(\/|$)/.test(s))).toEqual([]);
  });

  it('nor does anything match.ts reaches through relative imports', () => {
    const seen = new Set<string>();
    const queue = [resolve(src, 'tutorial/match.ts')];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of imports(file)) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/(^|\/)stores(\/|$)/);
        if (!spec.startsWith('.')) continue;
        const base = resolve(dirname(file), spec);
        const candidate = (base.endsWith('.ts') ? [base] : [`${base}.ts`, `${base}/index.ts`]).find((p) => {
          try {
            readFileSync(p, 'utf8');
            return true;
          } catch {
            return false;
          }
        });
        if (candidate) queue.push(candidate);
      }
    }
    expect([...seen].some((f) => f.endsWith('dragDrop.ts') || f.endsWith('affordances.ts'))).toBe(true);
  });
});
