// Two-phone play: which online screen is showing. Screen state only, nothing
// about the game or a seat (W11 stores the seat, W12 the game).
import { parseJoinHash } from '../online/code';

export type OnlineView = 'none' | 'create' | 'waiting' | 'join' | 'connected';

class OnlineUi {
  view = $state<OnlineView>('none');
  /** Normalized code to prefill on the join screen; '' for manual entry. */
  joinCode = $state('');
  /** The link had `#/join/` but no usable code. */
  badLink = $state(false);
  /** The room this phone created, while waiting. */
  roomCode = $state('');
  /** Who we're connected with, once a game is about to start. */
  opponentName = $state('');
  /** W12: why the online game ended ("This game has ended."), shown on Home. Fixed text only. */
  notice = $state<string | null>(null);

  openCreate(): void {
    this.notice = null;
    this.view = 'create';
  }

  openJoin(code = '', badLink = false): void {
    this.notice = null;
    this.joinCode = code;
    this.badLink = badLink;
    this.view = 'join';
  }

  waiting(code: string): void {
    this.roomCode = code;
    this.view = 'waiting';
  }

  connected(opponentName: string): void {
    this.notice = null;
    this.opponentName = opponentName;
    this.view = 'connected';
  }

  /** W12: the online game is over for this phone (Home, or a terminal error); back to Home with an optional notice. */
  leave(notice: string | null): void {
    this.close();
    this.opponentName = '';
    this.notice = notice;
  }

  close(): void {
    this.view = 'none';
    this.joinCode = '';
    this.badLink = false;
    this.roomCode = '';
  }

  /** Handle a location hash. Returns true when it was a join link. */
  applyHash(hash: string): boolean {
    const parsed = parseJoinHash(hash);
    if (!parsed) return false;
    if (parsed.kind === 'join') this.openJoin(parsed.code);
    else this.openJoin('', true);
    return true;
  }
}

export const online = new OnlineUi();
