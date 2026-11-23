/** Merkt sich pro Gerät, bis wann man die Kommentare einer Veranstaltung gesehen hat. */

import type { RunEvent } from '@runplanner/shared';

const key = (eventId: string) => `commentsSeen:${eventId}`;

export function markCommentsSeen(eventId: string, at: number | null): void {
  if (at === null) return;
  try {
    if (at > Number(localStorage.getItem(key(eventId)) ?? 0)) localStorage.setItem(key(eventId), String(at));
  } catch {
    // egal
  }
}

/** Neue Kommentare anderer seit dem letzten Blick. Ohne Gedächtnis zählt nichts als neu. */
export function hasUnreadComments(event: RunEvent, myId: string): boolean {
  const { lastAt, lastBy } = event.comments;
  if (lastAt === null || lastBy === myId) return false;
  try {
    const seen = localStorage.getItem(key(event.id));
    return seen !== null ? lastAt > Number(seen) : event.createdAt < lastAt && lastAt > Date.now() - 14 * 86_400_000;
  } catch {
    return false;
  }
}
