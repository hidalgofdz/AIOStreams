/**
 * Kodi and Infuse size a library from the first page's total and never read
 * it again, so an estimate that grows with the walk cuts the library short.
 */
export function readsTotalOnce(
  clientName: string,
  userAgent: string | undefined
): boolean {
  return /kodi|infuse/i.test(`${clientName} ${userAgent ?? ''}`);
}
