import { describe, expect, it, vi } from 'vitest';

import { copyLink, shareInvite } from '../../src/lib/online/share';

const URL_ = 'https://example.test/app/#/join/K7QX';

describe('shareInvite', () => {
  it('uses the share sheet when present', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    expect(await shareInvite(URL_, { share, writeText })).toBe('shared');
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: URL_ }));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard when there is no share sheet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await shareInvite(URL_, { writeText })).toBe('copied');
    expect(writeText).toHaveBeenCalledWith(URL_);
  });

  it('falls back to the clipboard when the share sheet errors', async () => {
    const share = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await shareInvite(URL_, { share, writeText })).toBe('copied');
  });

  it('treats a dismissed share sheet as a cancel, not an error', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('dismissed', 'AbortError'));
    const writeText = vi.fn();
    expect(await shareInvite(URL_, { share, writeText })).toBe('cancelled');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports failure when nothing works', async () => {
    expect(await shareInvite(URL_, {})).toBe('failed');
    expect(await shareInvite(URL_, { writeText: vi.fn().mockRejectedValue(new Error('denied')) })).toBe('failed');
  });
});

describe('copyLink', () => {
  it('copies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyLink(URL_, { writeText })).toBe(true);
  });
  it('is false without a clipboard', async () => {
    expect(await copyLink(URL_, {})).toBe(false);
  });
});
