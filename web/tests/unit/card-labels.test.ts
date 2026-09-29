// @vitest-environment jsdom
// ROADMAP "Card labels", light tier: the shared wording module
// (lib/cardText.ts), theme name overrides, and one render check per surface
// (the popover, the staging line, the Rules sheet). The King's goal and the
// privacy bound have their own strict files (card-labels-king.test.ts,
// card-labels-privacy.svelte.test.ts).
import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Card, PlayerId, PointEntry, Rank } from '../../src/lib/bridge/schema';
import {
  CLASSIC_NAMES,
  ONE_OFF_EFFECT,
  PERMANENT_EFFECT,
  cardEffectLine,
  cardName,
  inPlayBadge,
  rulesOneOffLines,
  rulesPermanentLines,
} from '../../src/lib/cardText';
import CardDetailPopover from '../../src/lib/components/CardDetailPopover.svelte';
import PointRow from '../../src/lib/components/PointRow.svelte';
import RulesSheet from '../../src/lib/components/RulesSheet.svelte';
import StagingBar from '../../src/lib/components/StagingBar.svelte';
import { plainMoveText } from '../../src/lib/recap';
import { vectorTheme } from '../../src/lib/theme';
import { bitmapTheme } from '../../src/lib/theme/bitmap';
import { parseManifest, resolveAssets } from '../../src/lib/theme/catalog';
import type { CardTheme } from '../../src/lib/theme/types';

const RANKS: Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const card = (Rank: Rank, Suit: Card['Suit'] = 2): Card => ({ Rank, Suit });

let instances: Array<{ instance: ReturnType<typeof mount>; host: HTMLElement }> = [];
afterEach(() => {
  for (const { instance, host } of instances) {
    unmount(instance);
    host.remove();
  }
  instances = [];
});

function render<P extends Record<string, unknown>>(Comp: Component<P>, props: P): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const instance = mount(Comp, { target: host, props });
  flushSync();
  instances.push({ instance, host });
  return host;
}

describe('names', () => {
  it('every rank has a short Classic name', () => {
    for (const rank of RANKS) {
      const name = CLASSIC_NAMES[rank];
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(14);
      expect(cardName(card(rank))).toBe(name);
      expect(cardName(card(rank), vectorTheme)).toBe(name);
    }
  });

  it('a theme may rename some ranks; every rank it leaves out keeps its Classic name', () => {
    const theme: Pick<CardTheme, 'names'> = { names: { 13: 'Storm King', 1: '' } };
    expect(cardName(card(13), theme)).toBe('Storm King');
    expect(cardName(card(1), theme)).toBe(CLASSIC_NAMES[1]); // empty -> fallback
    expect(cardName(card(12), theme)).toBe(CLASSIC_NAMES[12]);
  });

  it('a manifest `names` block is parsed by rank label; bad entries fall back', () => {
    const manifest = parseManifest(
      { names: { K: '  Storm King ', Q: 42, J: '', A: 'x'.repeat(15), '2': 'Fourteen chars', '10': 'Hoard', Z: 'nope' } },
      { id: 'mythic', label: 'Mythic', manifest: 'mythic/manifest.json' },
    );
    expect(manifest.names).toEqual({ 2: 'Fourteen chars', 13: 'Storm King', 10: 'Hoard' });
    expect(parseManifest({}, { id: 'mythic', label: 'Mythic', manifest: 'm' }).names).toEqual({});
  });
});

describe('effects: one source for cards, chooser, staging and the Rules sheet', () => {
  it('each rank has a one-line effect', () => {
    expect(cardEffectLine(card(5))).toBe('One-off: draw 2 cards.');
    expect(cardEffectLine(card(8))).toBe('Glasses: you see their hand.');
    expect(cardEffectLine(card(10))).toBe('No one-off: play it for points or to scuttle.');
    expect(cardEffectLine(card(2))).toBe('One-off: scrap one royal or glasses 8, or stop a one-off as it’s played.');
    expect(cardEffectLine(card(11))).toBe('Permanent: steal one of their point cards.');
    expect(cardEffectLine(card(12))).toBe('Permanent: their 2s, 9s and Jacks can’t target your other cards.');
    expect(cardEffectLine(card(13))).toBe('Permanent: you need fewer points to win.');
  });

  it('the chooser/staging text and the Rules sheet both carry each one-off’s effect clause verbatim', () => {
    const tokens: Partial<Record<Rank, string>> = { 1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 9: '9' };
    const rules = rulesOneOffLines();
    for (const [rank, token] of Object.entries(tokens)) {
      const effect = ONE_OFF_EFFECT[Number(rank) as Rank] as string;
      expect(plainMoveText(`play ${token}♣ as one-off`)).toBe(`Play ${token}♣ as a one-off: ${effect}.`);
      expect(cardEffectLine(card(Number(rank) as Rank))).toContain(`One-off: ${effect}`);
      const line = rules.find((l) => l.name === CLASSIC_NAMES[Number(rank) as Rank]);
      expect(line?.text.toLowerCase().startsWith(effect.toLowerCase())).toBe(true);
    }
    for (const rank of [8, 12, 13] as Rank[]) {
      const effect = PERMANENT_EFFECT[rank] as string;
      expect(rulesPermanentLines().some((l) => l.text.toLowerCase().startsWith(effect.toLowerCase()))).toBe(true);
      expect(cardEffectLine(card(rank))).toContain(effect);
    }
  });
});

describe('in-play badges', () => {
  it('King: the goal it is given; Queen protects; glasses see the hand; a top Jack stole', () => {
    expect(inPlayBadge(card(13), 'permanent', { goal: 14 })).toBe('Goal 14');
    expect(inPlayBadge(card(13), 'permanent')).toBeNull();
    expect(inPlayBadge(card(12), 'permanent')).toBe('Protects');
    expect(inPlayBadge(card(8), 'permanent')).toBe('8 Sees hand');
    expect(inPlayBadge(card(11), 'jack', { stolen: true })).toBe('Stole');
    expect(inPlayBadge(card(11), 'jack', { stolen: false })).toBeNull();
    expect(inPlayBadge(card(11), 'jack')).toBeNull();
    for (const rank of [1, 2, 3, 4, 5, 6, 7, 9, 10] as Rank[]) expect(inPlayBadge(card(rank), 'permanent')).toBeNull();
  });
});

describe('surfaces', () => {
  it('the popover names the card and says what it does', () => {
    const el = render(CardDetailPopover, { card: card(5), onclose: () => {} });
    const dialog = el.querySelector('[data-testid="card-detail-popover"]')!;
    expect(dialog.querySelector('[data-card-label="name"]')?.textContent).toBe('Draw Two');
    expect(dialog.querySelector('[data-card-label="effect"]')?.textContent).toBe('One-off: draw 2 cards.');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Draw Two');
  });

  it('the popover uses a theme’s own name', () => {
    const theme: CardTheme = { ...vectorTheme, id: 'named', names: { 13: 'Storm King' } };
    const el = render(CardDetailPopover, { card: card(13), onclose: () => {}, theme });
    expect(el.querySelector('[data-card-label="name"]')?.textContent).toBe('Storm King');
  });

  it('the staging line opens with the staged card’s name, inline, and no name when none is given', () => {
    const el = render(StagingBar, { description: 'Play 5♥ as a one-off: draw 2 cards.', title: 'Draw Two' });
    expect(el.querySelector('[data-card-label="name"]')?.textContent?.trim()).toBe('Draw Two');
    const draw = render(StagingBar, { description: 'Draw a card.' });
    expect(draw.querySelector('[data-card-label="name"]')).toBeNull();
  });

  it('the Rules sheet names each one-off rank and the permanents', () => {
    const el = render(RulesSheet, { onclose: () => {} });
    const text = el.textContent ?? '';
    for (const rank of [1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 13] as Rank[]) expect(text).toContain(CLASSIC_NAMES[rank]);
    expect(text).toContain('8 as glasses:');
    expect(text).not.toMatch(/[♠-♧]/);
  });
});

describe('review S4: a manifest’s names reach the CardTheme', () => {
  it('bitmapTheme() carries the parsed names; the popover shows them, with Classic for the rest', () => {
    const entry = { id: 'mythic', label: 'Mythic', manifest: 'http://localhost/themes/mythic/manifest.json' };
    const manifest = parseManifest({ names: { K: 'Storm King' } }, entry);
    const theme = bitmapTheme(manifest, resolveAssets(manifest, entry.manifest));
    expect(theme.names).toEqual({ 13: 'Storm King' });
    expect(cardName(card(13), theme)).toBe('Storm King');
    expect(cardName(card(12), theme)).toBe(CLASSIC_NAMES[12]);
  });
});

describe('review B2: a Jack says "Stole" only while its card is really stolen', () => {
  const J = (Suit: Card['Suit']): Card => ({ Rank: 11, Suit });
  function stack(jacks: number, owner: PlayerId): PointEntry {
    // Jacks alternate owners: the first steals from `owner`, the next steals it back, and so on.
    const owners = Array.from({ length: jacks }, (_, i) => ((i % 2 === 0 ? 1 - owner : owner) as PlayerId));
    return {
      Card: card(7, 1),
      Owner: owner,
      JackStack: Array.from({ length: jacks }, (_, i) => J(i as Card['Suit'])),
      JackOwners: owners,
      Controller: owners[owners.length - 1],
    };
  }
  function badge(entry: PointEntry): string | null {
    const el = render(PointRow, {
      rowId: entry.Controller,
      entries: [entry],
      pointTotal: 7,
      label: 'Points',
      highlighted: new Set<string>(),
      staged: new Set<string>(),
      ontap: () => {},
      theme: vectorTheme,
    });
    return el.querySelector('[data-card-label="badge"]')?.textContent ?? null;
  }

  it('1 Jack (stolen): Stole', () => expect(badge(stack(1, 1))).toBe('Stole'));
  it('2 Jacks (stolen, then stolen back: the card is home): no badge', () => {
    const entry = stack(2, 1);
    expect(entry.Controller).toBe(entry.Owner);
    expect(badge(entry)).toBeNull();
  });
  it('3 Jacks (stolen again): Stole', () => {
    const entry = stack(3, 1);
    expect(entry.Controller).not.toBe(entry.Owner);
    expect(badge(entry)).toBe('Stole');
  });
});
