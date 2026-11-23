/**
 * Push-Benachrichtigungen auf diesem Gerät ein- und ausschalten.
 *
 * Auf dem iPhone gibt es Web Push erst ab iOS 16.4 und nur, wenn die App über
 * „Zum Home-Bildschirm“ installiert wurde. Deshalb wird die Unterstützung geprüft.
 */

import { api } from './api.js';

export type PushState = 'unsupported' | 'install-first' | 'denied' | 'off' | 'on';

export function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const bytes = new Uint8Array(a);
  return bytes.length === b.length && bytes.every((value, index) => value === b[index]);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !isInstalled() ? 'install-first' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  const subscription = await reg?.pushManager.getSubscription();
  return subscription ? 'on' : 'off';
}

export async function enablePush(): Promise<PushState> {
  const { publicKey } = await api.pushKey();
  if (publicKey === null) throw new Error('push_disabled');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return isIos() && !isInstalled() ? 'install-first' : 'denied';
  const reg = await navigator.serviceWorker.ready;
  const key = fromBase64Url(publicKey);
  // Ein Abonnement mit einem alten Serverschlüssel kann nie zustellen: erst wegräumen.
  const existing = await reg.pushManager.getSubscription();
  if (existing && !sameKey(existing.options.applicationServerKey, key)) await existing.unsubscribe();
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }));
  // Auch ein bestehendes Abonnement neu melden: Dem Server kann es fehlen.
  await api.pushSubscribe(subscription.toJSON());
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const subscription = await reg?.pushManager.getSubscription();
  if (subscription) {
    await api.pushUnsubscribe(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  }
  return 'off';
}

/** Nach dem Anmelden: ein vorhandenes Abonnement dem aktuellen Konto zuordnen. */
export async function refreshPushSubscription(): Promise<void> {
  try {
    const reg = await registration();
    const subscription = await reg?.pushManager.getSubscription();
    if (subscription && Notification.permission === 'granted') await api.pushSubscribe(subscription.toJSON());
  } catch {
    // egal: Beim nächsten Einschalten wird es neu gemeldet.
  }
}
