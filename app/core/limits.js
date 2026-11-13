/* foodie · the daily limit of photo analyses (pure logic: no DOM, no storage, no network).

   It is a SOFT limit, kept by the app: it protects the shared free quota of the AI from one person using it all, and it is not enforced
   by any server (see SECURITY.md). Rules, decided by the owner:
   - the limit is per photo and per local day: a photo counts once, when the AI answered it (a "not food" answer counts too);
   - a call that fails (timeout, quota, offline, an unreadable answer) is free and does not count;
   - adding context to a photo that was already counted and running it again is free, up to MAX_FREE_RERUNS times per photo;
   - barcode and text search never touch this limit.
   The counter is a record { day: 'YYYY-MM-DD', photos: n }: it only means something for the day it names. It is kept on the device and,
   for a signed-in person, in users/{uid}/meta/usage so that two phones share it. */
import { isIso } from './dates.js';

export const DAILY_PHOTO_LIMIT = 10;
export const MAX_FREE_RERUNS = 2;
export const MAX_USAGE_PHOTOS = 1000;            // what the rules accept; far above any real limit

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const emptyUsage = () => ({ day: '', photos: 0 });

/** Whatever was stored or came from the cloud, as a valid record (never throws). */
export function cleanUsage(raw) {
  try {
    if (!isObj(raw)) return emptyUsage();
    const day = typeof raw.day === 'string' && isIso(raw.day) ? raw.day : '';
    const n = typeof raw.photos === 'number' && Number.isFinite(raw.photos) ? Math.floor(raw.photos) : 0;
    return day && n > 0 ? { day, photos: Math.min(n, MAX_USAGE_PHOTOS) } : emptyUsage();
  } catch (e) {
    return emptyUsage();
  }
}

/** Photos counted on `today` (a record from another day counts for nothing: the limit renews at local midnight). */
export const photosToday = (usage, today) => {
  const u = cleanUsage(usage);
  return u.day === today ? u.photos : 0;
};

export const photosLeft = (usage, today, limit = DAILY_PHOTO_LIMIT) => Math.max(0, limit - photosToday(usage, today));

/** The record after one more photo was counted on `today`. */
export const recordPhoto = (usage, today) => ({ day: today, photos: Math.min(MAX_USAGE_PHOTOS, photosToday(usage, today) + 1) });

/** Two copies of the record (two devices, or this device and the cloud): the later day wins; on the same day the higher count wins.
    Commutative, associative and idempotent, so devices converge in any order. */
export function mergeUsage(a, b) {
  const x = cleanUsage(a);
  const y = cleanUsage(b);
  if (x.day !== y.day) return x.day > y.day ? x : y;           // '' sorts before every date
  return x.photos >= y.photos ? x : y;
}

export const usageEqual = (a, b) => {
  const x = cleanUsage(a);
  const y = cleanUsage(b);
  return x.day === y.day && x.photos === y.photos;
};

/** "Te quedan 7 fotos hoy" (Spanish, singular and zero handled). */
export function leftText(left) {
  if (left <= 0) return 'No te quedan fotos hoy';
  return left === 1 ? 'Te queda 1 foto hoy' : `Te quedan ${left} fotos hoy`;
}

export const limitMessage = (limit = DAILY_PHOTO_LIMIT) => [
  `Has llegado al límite de ${limit} fotos de hoy`,
  'Se renueva a medianoche. Puedes seguir añadiendo comidas con el escáner o la búsqueda.',
];
