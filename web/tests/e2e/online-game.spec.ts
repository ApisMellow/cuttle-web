import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

// W13b: the in-game online screens at the phone viewports (plan §12 light
// tier: a fit check at 393x852 and 393x660). The dev build's server override
// points the app at a loopback origin, and `page.routeWebSocket` plays the
// server there, so no real server runs. Sample players are Alice (this
// phone, seat 0) and Blake.

const ORIGIN = 'http://127.0.0.1:9';
const SOCKET = 'ws://127.0.0.1:9/api/play';
/** Fixture token, shaped like the server's (43 base64url characters). */
const TOKEN = 'q9Zt3vYkP1xLm8Rw0aBcDeFgHiJkLmNoPqRsTuVwXyZ';

type Card = { Rank: number; Suit: number };
const card = (Rank: number, Suit: number): Card => ({ Rank, Suit });

function entry(o: { by: 0 | 1; kind: number; seq: number; description: string; card?: Card | null; index?: number }) {
  return { card: null, subKind: null, targetCard: null, drawn: null, ...o };
}

function draws(n: number) {
  return Array.from({ length: n }, (_, i) =>
    entry({ by: (i % 2) as 0 | 1, kind: 0, description: 'draw a card', seq: i + 1, ...(i % 2 === 0 ? { index: 0 } : {}) }),
  );
}

const point = (c: Card, owner: 0 | 1) => ({ Card: c, Owner: owner, JackStack: [], JackOwners: [], Controller: owner });

/** Review blocker 1: the worst-case board, an 8-card hand plus points and permanents on both sides. */
const FULL_BOARD = {
  you: {
    hand: [card(1, 3), card(3, 0), card(4, 1), card(6, 2), card(9, 0), card(10, 1), card(11, 3), card(12, 2)],
    frozenHandIndices: [],
    points: [point(card(10, 3), 0), point(card(9, 2), 0), point(card(2, 1), 0)],
    permanents: [card(13, 0), card(12, 1)],
    watched: false,
  },
  opponent: {
    handCount: 6,
    hand: null,
    points: [point(card(8, 3), 1), point(card(7, 0), 1), point(card(6, 1), 1)],
    permanents: [card(13, 2), card(12, 3)],
  },
};

function envelopeFor(
  history: ReturnType<typeof entry>[],
  o: { active?: 0 | 1; phase?: number; winner?: 0 | 1 | null; board?: typeof FULL_BOARD } = {},
) {
  const active = o.active ?? 0;
  const phase = o.phase ?? 0;
  const myTurn = active === 0 && phase === 0;
  return {
    ok: true,
    state: {
      viewer: 0,
      active,
      phase,
      passesInARow: 0,
      winner: o.winner ?? null,
      stalemate: false,
      you: o.board?.you ?? { hand: [card(1, 3), card(5, 1)], frozenHandIndices: [], points: [], permanents: [], watched: false },
      opponent: o.board?.opponent ?? { handCount: 5, hand: null, points: [], permanents: [] },
      deckCount: 30,
      scrap: [],
      scoreboard: {
        you: { points: 0, threshold: 21, kings: 0, hasWon: o.winner === 0 },
        opponent: { points: 0, threshold: 21, kings: 0, hasWon: o.winner === 1 },
      },
      sevenRevealed: null,
      pending: null,
    },
    legalMoves: myTurn ? [{ Kind: 0, Card: null, HandIndex: 0, Target: null, JackTarget: null, ScrapIndex: 0, DiscardA: 0, DiscardB: 0, SubMove: null }] : [],
    descriptions: myTurn ? ['draw a card'] : [],
    lastMove: null,
    history,
    seq: history.length,
  };
}

function state(env: ReturnType<typeof envelopeFor>, game = 1) {
  return JSON.stringify({ t: 'state', game, envelope: env, opponentOnline: true, tally: [0, 0] });
}

async function openGame(page: Page): Promise<() => WebSocketRoute> {
  let server: WebSocketRoute | null = null;
  await page.routeWebSocket(SOCKET, (ws) => {
    server = ws;
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as { t: string };
      if (frame.t === 'hello') {
        ws.send(JSON.stringify({ t: 'welcome', seat: 0, names: ['Alice', 'Blake'], status: 'playing' }));
        ws.send(state(envelopeFor(draws(2))));
      } else if (frame.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong' }));
      }
    });
  });
  await page.addInitScript(
    ({ origin, token }) => {
      localStorage.setItem('cuttle.online.devServer', origin);
      localStorage.setItem(
        'cuttle.online.v1',
        JSON.stringify({ v: 1, server: origin, code: 'K7QX', seat: 0, token, names: ['Alice', 'Blake'] }),
      );
    },
    { origin: ORIGIN, token: TOKEN },
  );
  await page.goto('/');
  await page.getByTestId('resume-online').click();
  await expect(page.getByTestId('board')).toBeVisible();
  return () => {
    if (server === null) throw new Error('no socket routed');
    return server;
  };
}

async function fits(page: Page, testIds: string[]): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const id of testIds) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(44 - 0.5);
    expect(box?.width ?? 0, id).toBeGreaterThanOrEqual(44 - 0.5);
    expect((box?.x ?? 0) + (box?.width ?? 0), id).toBeLessThanOrEqual(393 + 0.5);
  }
}

for (const viewport of [
  { width: 393, height: 852 },
  { width: 393, height: 660 },
]) {
  test.describe(`online game screens at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    // Review blocker 1: the recap never covers the hand or the deck, closed
    // or open, with the worst-case board and 8 missed lines.
    test('with a full board and 8 missed moves, the recap never covers the hand or the deck', async ({ page }) => {
      const server = await openGame(page);
      const missed = Array.from({ length: 8 }, (_, i) =>
        entry({ by: 1, kind: 1, description: `play ${i + 2}♦ as point card`, seq: 4 + i, card: card(i + 2, 1) }),
      );
      const history = [...draws(2), entry({ by: 0, kind: 0, description: 'draw a card', seq: 3, index: 0 }), ...missed];
      server().send(state(envelopeFor(history, { board: FULL_BOARD })));
      await expect(page.getByTestId('online-recap')).toBeVisible();
      // Worst case for height: a status banner below the action bar too.
      server().send(JSON.stringify({ t: 'presence', opponentOnline: false }));
      await expect(page.getByTestId('online-status')).toBeVisible();

      for (const open of [false, true]) {
        if (open) {
          await page.getByTestId('online-recap-toggle').click();
          await expect(page.getByTestId('online-recap').locator('li')).toHaveCount(6);
        }
        // Let a scroll the layout makes settle before measuring.
        await page.waitForTimeout(100);
        const recap = await page.getByTestId('online-recap').boundingBox();
        const hand = await page.getByTestId('player-hand').boundingBox();
        const board = await page.getByTestId('board').boundingBox();
        // The whole hand is inside the board's visible box, not clipped under it.
        expect((hand?.y ?? 0) + (hand?.height ?? 0), `hand bottom vs board bottom (open: ${open})`).toBeLessThanOrEqual(
          (board?.y ?? 0) + (board?.height ?? 0) + 0.5,
        );
        expect(recap).not.toBeNull();
        expect(hand).not.toBeNull();
        // The hand sits wholly above the recap, and inside the viewport.
        expect((hand?.y ?? 0) + (hand?.height ?? 0), `hand bottom vs recap top (open: ${open})`).toBeLessThanOrEqual((recap?.y ?? 0) + 0.5);
        expect(hand?.y ?? -1).toBeGreaterThanOrEqual(0);
        // Every hand card and the deck take a tap: nothing lies over them.
        for (let i = 0; i < 8; i++) await page.getByTestId(`hand-card-${i}`).click({ trial: true, timeout: 2000 });
        await page.getByTestId('deck-pile').click({ trial: true, timeout: 2000 });
        const deck = await page.getByTestId('deck-pile').boundingBox();
        expect((deck?.y ?? 0) + (deck?.height ?? 0)).toBeLessThanOrEqual((recap?.y ?? 0) + 0.5);
        await fits(page, ['online-recap', 'online-recap-dismiss', 'online-recap-toggle']);
      }
      await page.getByTestId('hand-card-7').click();
      await expect(page.getByTestId('online-recap')).toBeVisible();
    });

    test('recap, banners, responding, stuck and the rematch line fit the phone', async ({ page }) => {
      const server = await openGame(page);

      // A reconnect's jump: Alice's own draw (3), then Blake's two moves.
      const jumped = [
        ...draws(2),
        entry({ by: 0, kind: 0, description: 'draw a card', seq: 3, index: 0 }),
        entry({ by: 1, kind: 1, description: 'play 7♥ as point card', seq: 4, card: card(7, 2) }),
        entry({ by: 1, kind: 4, description: 'play 5♥ as one-off', seq: 5, card: card(5, 2) }),
      ];
      server().send(state(envelopeFor(jumped)));
      await expect(page.getByTestId('online-recap')).toContainText('Blake played 5♥ as a one-off');
      await expect(page.getByTestId('board')).toBeVisible();
      await fits(page, ['online-recap', 'online-recap-dismiss', 'online-recap-toggle', 'board']);
      await page.getByTestId('online-recap-toggle').click();
      await expect(page.getByTestId('online-recap')).toContainText('Blake played 7♥ for points.');
      await page.getByTestId('online-recap-dismiss').click();
      await expect(page.getByTestId('online-recap')).toHaveCount(0);

      server().send(JSON.stringify({ t: 'presence', opponentOnline: false }));
      await expect(page.getByTestId('online-status')).toHaveText(/Blake is offline\./);
      await fits(page, ['online-status']);

      server().send(state(envelopeFor([...jumped, entry({ by: 0, kind: 0, description: 'draw a card', seq: 6, index: 0 })], { active: 1, phase: 3 })));
      await expect(page.getByTestId('online-waiting-on')).toHaveText('Blake is choosing what to discard.');
      await fits(page, ['online-waiting-on']);

      server().send(JSON.stringify({ t: 'responding', by: 1 }));
      await expect(page.getByTestId('online-responding')).toContainText('Blake is responding…');
      await fits(page, ['online-responding']);

      server().send(state(envelopeFor(jumped)));
      server().send(JSON.stringify({ t: 'error', code: 'ILLEGAL_MOVE', message: 'illegal' }));
      await expect(page.getByTestId('online-stuck')).toContainText('This game can’t go on');
      await fits(page, ['online-stuck', 'online-leave-game']);

      const over = [...jumped, entry({ by: 0, kind: 1, description: 'play A♠ as point card', seq: 6, index: 1, card: card(1, 3) })];
      server().send(state(envelopeFor(over, { active: 1, phase: 4, winner: 0 })));
      server().send(JSON.stringify({ t: 'rematch', requestedBy: 1 }));
      await expect(page.getByTestId('online-rematch-status')).toHaveText('Blake wants a rematch.');
      await fits(page, ['online-rematch-status', 'rematch']);
      await page.getByTestId('rematch').click();
      await expect(page.getByTestId('online-rematch-status')).toHaveText('Starting the rematch…');
      await expect(page.getByTestId('rematch')).toBeDisabled();
      server().send(state(envelopeFor(draws(0)), 2));
      await expect(page.getByTestId('board')).toBeVisible();
    });
  });
}
