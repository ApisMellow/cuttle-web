// Sharing the invite link: the Web Share API where the phone has it, the
// clipboard otherwise. Only the link and a short line leave the app.

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export interface ShareEnv {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

export function browserShareEnv(): ShareEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    share: nav && typeof nav.share === 'function' ? (data) => nav.share(data) : undefined,
    writeText:
      nav?.clipboard && typeof nav.clipboard.writeText === 'function'
        ? (text) => nav.clipboard.writeText(text)
        : undefined,
  };
}

export async function copyLink(url: string, env: ShareEnv = browserShareEnv()): Promise<boolean> {
  if (!env.writeText) return false;
  try {
    await env.writeText(url);
    return true;
  } catch {
    return false;
  }
}

/** Share sheet first; if it is missing or errors (not a cancel), copy the link instead. */
export async function shareInvite(url: string, env: ShareEnv = browserShareEnv()): Promise<ShareOutcome> {
  if (env.share) {
    try {
      await env.share({ title: 'Cuttle', text: 'Join my game of Cuttle', url });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyLink(url, env)) ? 'copied' : 'failed';
}
