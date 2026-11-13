/* A stand-in for the store's daily photo counter (photosLeft / recordPhoto), for tests of the vision module. */
import { cleanUsage, photosLeft, recordPhoto } from '../../app/core/limits.js';

export function memoryUsage({ today = '2026-11-12', start = null, limit } = {}) {
  let usage = cleanUsage(start);
  const day = { current: today };
  return {
    day,
    photosLeft: () => photosLeft(usage, day.current, limit),
    recordPhoto: () => { usage = recordPhoto(usage, day.current); return photosLeft(usage, day.current, limit); },
    get usage() { return usage; },
  };
}
