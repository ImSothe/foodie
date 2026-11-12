/* foodie · date helpers (pure). Days are local-time ISO strings "YYYY-MM-DD": a meal belongs to the
   day the user ate it, whatever the time zone of the server. */

const pad = (n) => String(n).padStart(2, '0');

export const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDate(parse(s)) === s;

/** Local midnight of an ISO day (noon is used internally so DST changes never shift the day). */
export function parse(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12);
}

export function addDays(iso, n) {
  const d = parse(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/** The seven days (Monday to Sunday) of the week that contains `iso`. */
export function weekOf(iso) {
  const dow = (parse(iso).getDay() + 6) % 7; // 0 = Monday
  const monday = addDays(iso, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export const DOW_LETTERS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const DOW_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export const dowIndex = (iso) => (parse(iso).getDay() + 6) % 7;
export const dayNumber = (iso) => parse(iso).getDate();

/** "Hoy", "Ayer" or "martes 3 de noviembre". */
export function dayTitle(iso, today = isoDate()) {
  if (iso === today) return 'Hoy';
  if (iso === addDays(today, -1)) return 'Ayer';
  const d = parse(iso);
  return `${DOW_NAMES[dowIndex(iso)]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

export const fullDate = (iso) => {
  const d = parse(iso);
  return `${DOW_NAMES[dowIndex(iso)]} ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
};

/** Consecutive days with something logged, counting back from today (today may still be empty). */
export function streak(loggedDays, today = isoDate()) {
  const set = loggedDays instanceof Set ? loggedDays : new Set(loggedDays || []);
  let day = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(day)) { n += 1; day = addDays(day, -1); }
  return n;
}

/** "noviembre de 2026" (month is 0-11). */
export const monthTitle = (year, month) => `${MONTHS[month]} de ${year}`;

/** "7 nov". */
export const shortDate = (iso) => {
  const d = parse(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
};
