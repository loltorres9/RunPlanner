/** Zugriff auf die Server-API. Das Token liegt im localStorage des Geräts. */

import type { ExpenseInput, Settlement, SettlementInput, RaceTrack, TrackInput, EventComment, NotificationSettingsInput, AccommodationInput, EventInput, StayInput, GroupDetail, ImportResult, Language, Me, ParticipationStatus, RunEvent } from '@runplanner/shared';

const TOKEN_KEY = 'token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Ohne Speicher bleibt man nur bis zum Neuladen angemeldet.
  }
}

/** Wird aufgerufen, wenn der Server die Sitzung nicht mehr anerkennt. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) {
    if (response.status === 401 && token) onUnauthorized();
    throw new ApiError(response.status, data.error ?? 'error', data.message ?? response.statusText);
  }
  return data as T;
}

export const api = {
  config: () => request<{ importEnabled: boolean }>('GET', '/api/config'),
  register: (body: { email: string; name: string; password: string; language: Language; inviteCode?: string | null }) =>
    request<{ token: string; me: Me }>('POST', '/api/auth/register', body),
  login: (body: { email: string; password: string }) => request<{ token: string; me: Me }>('POST', '/api/auth/login', body),
  me: () => request<Me>('GET', '/api/me'),
  updateMe: (body: { name?: string; language?: Language; notifications?: NotificationSettingsInput }) =>
    request<Me>('PATCH', '/api/me', body),
  pushKey: () => request<{ publicKey: string | null }>('GET', '/api/push/key'),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request<void>('POST', '/api/push/subscribe', subscription),
  pushUnsubscribe: (endpoint: string) => request<void>('POST', '/api/push/unsubscribe', { endpoint }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<{ token: string }>('POST', '/api/me/password', body),

  createGroup: (name: string) => request<GroupDetail>('POST', '/api/groups', { name }),
  group: (id: string) => request<GroupDetail>('GET', `/api/groups/${id}`),
  renameGroup: (id: string, name: string) => request<GroupDetail>('PATCH', `/api/groups/${id}`, { name }),
  rotateInvite: (id: string) => request<GroupDetail>('POST', `/api/groups/${id}/invite`),
  setRole: (id: string, userId: string, role: 'admin' | 'member') =>
    request<GroupDetail>('PATCH', `/api/groups/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => request<Me>('DELETE', `/api/groups/${id}/members/${userId}`),
  resetLink: (id: string, userId: string) =>
    request<{ code: string; expiresAt: number }>('POST', `/api/groups/${id}/members/${userId}/reset`),
  resetPreview: (code: string) => request<{ name: string }>('GET', `/api/resets/${encodeURIComponent(code)}`),
  resetPassword: (code: string, password: string) =>
    request<{ token: string; me: Me }>('POST', `/api/resets/${encodeURIComponent(code)}`, { password }),
  invitePreview: (code: string) => request<{ groupName: string }>('GET', `/api/invites/${encodeURIComponent(code)}`),
  joinGroup: (code: string) => request<{ groupId: string; me: Me }>('POST', `/api/invites/${encodeURIComponent(code)}/join`),

  events: (groupId: string) => request<{ events: RunEvent[] }>('GET', `/api/groups/${groupId}/events`),
  createEvent: (groupId: string, input: EventInput) => request<RunEvent>('POST', `/api/groups/${groupId}/events`, input),
  updateEvent: (id: string, input: EventInput) => request<RunEvent>('PUT', `/api/events/${id}`, input),
  deleteEvent: (id: string) => request<void>('DELETE', `/api/events/${id}`),
  setParticipation: (raceId: string, status: ParticipationStatus | null) =>
    request<RunEvent>('PUT', `/api/races/${raceId}/participation`, { status }),
  addAccommodation: (eventId: string, input: AccommodationInput) =>
    request<RunEvent>('POST', `/api/events/${eventId}/accommodations`, input),
  updateAccommodation: (id: string, input: AccommodationInput) => request<RunEvent>('PUT', `/api/accommodations/${id}`, input),
  deleteAccommodation: (id: string) => request<RunEvent>('DELETE', `/api/accommodations/${id}`),
  setStay: (eventId: string, input: StayInput | { night?: string | null; choice: null }) =>
    request<RunEvent>('PUT', `/api/events/${eventId}/stay`, input),
  setStayMode: (eventId: string, perNight: boolean) => request<RunEvent>('PUT', `/api/events/${eventId}/stay-mode`, { perNight }),
  track: (raceId: string) => request<RaceTrack>('GET', `/api/races/${raceId}/track`),
  setTrack: (raceId: string, input: TrackInput) => request<RunEvent>('PUT', `/api/races/${raceId}/track`, input),
  deleteTrack: (raceId: string) => request<RunEvent>('DELETE', `/api/races/${raceId}/track`),
  comments: (eventId: string) => request<EventComment[]>('GET', `/api/events/${eventId}/comments`),
  addComment: (eventId: string, text: string) => request<EventComment[]>('POST', `/api/events/${eventId}/comments`, { text }),
  deleteComment: (id: string) => request<EventComment[]>('DELETE', `/api/comments/${id}`),
  addExpense: (eventId: string, input: ExpenseInput) => request<RunEvent>('POST', `/api/events/${eventId}/expenses`, input),
  updateExpense: (id: string, input: ExpenseInput) => request<RunEvent>('PUT', `/api/expenses/${id}`, input),
  deleteExpense: (id: string) => request<RunEvent>('DELETE', `/api/expenses/${id}`),
  settlements: (groupId: string) => request<Settlement[]>('GET', `/api/groups/${groupId}/settlements`),
  addSettlement: (groupId: string, input: SettlementInput) =>
    request<Settlement[]>('POST', `/api/groups/${groupId}/settlements`, input),
  deleteSettlement: (id: string) => request<Settlement[]>('DELETE', `/api/settlements/${id}`),
  importFromUrl: (url: string, language: Language) => request<ImportResult>('POST', '/api/import', { url, language }),
};
