// P2 W13 — the one target-key vocabulary the board reports taps in and the
// staging store resolves them against (round-3 coupling note). Pure: a key
// names a board location, never a rule.
//
//   hand:<i>              a card in the viewer's hand
//   deck | scrap | pass   the deck pile, the scrap pile, the Pass control
//   zone:points|permanents|oneoff   a drop zone
//   point:<owner>:<i>     entry i of <owner>'s points row (engine Target.Owner/Index)
//   perm:<owner>:<i>      entry i of <owner>'s permanents row

import type { PlayerId } from './bridge/schema';

export type ZoneKey = 'zone:points' | 'zone:permanents' | 'zone:oneoff';

export type TargetKey =
  | `hand:${number}`
  | 'deck'
  | 'scrap'
  | 'pass'
  | ZoneKey
  | `point:${PlayerId}:${number}`
  | `perm:${PlayerId}:${number}`;

const TARGET_KEY = /^(?:hand:\d+|deck|scrap|pass|zone:(?:points|permanents|oneoff)|(?:point|perm):[01]:\d+)$/;

/** Narrows a raw string (a DOM-reported key) to a `TargetKey`, or `null` if it is not one. */
export function parseTargetKey(raw: string): TargetKey | null {
  return TARGET_KEY.test(raw) ? (raw as TargetKey) : null;
}

/**
 * The integrator's one tap rewrite (round-3 W9 carry-over). A card in the
 * viewer's own points or permanents row sits inside that row's drop zone,
 * and its button takes the tap, so without this a player aiming for a lit
 * "Play for points" zone who lands on a card already there would clear
 * their selection. A card that is itself highlighted keeps its own key.
 */
export function resolveBoardTap(key: TargetKey, highlighted: ReadonlySet<string>, viewer: PlayerId): TargetKey {
  if (highlighted.has(key)) return key;
  if (key.startsWith(`point:${viewer}:`) && highlighted.has('zone:points')) return 'zone:points';
  if (key.startsWith(`perm:${viewer}:`) && highlighted.has('zone:permanents')) return 'zone:permanents';
  return key;
}
