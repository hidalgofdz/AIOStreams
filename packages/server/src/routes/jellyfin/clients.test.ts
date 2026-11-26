import { describe, expect, it } from 'vitest';
import { readsTotalOnce } from './clients.js';

describe('readsTotalOnce', () => {
  it('holds for Infuse, which names itself only in its user agent', () => {
    expect(readsTotalOnce('Unknown', 'Infuse-Direct/8.5.11')).toBe(true);
  });

  it('holds for Infuse and Kodi by client name', () => {
    expect(readsTotalOnce('Infuse', undefined)).toBe(true);
    expect(readsTotalOnce('Kodi', undefined)).toBe(true);
  });

  it('does not hold for a client that rereads the total on every page', () => {
    expect(readsTotalOnce('Jellyfin Web', 'Mozilla/5.0')).toBe(false);
  });
});
