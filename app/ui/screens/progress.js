/* foodie · Progress: month calendar, calories per week against the goal, and weight. Hand-written SVG, no library. */
import { h, s, toast } from '../dom.js';
import { icon } from '../icons.js';
import { ring } from '../ring.js';
import { numberField } from '../fields.js';
import { sumMeals, fmtNum } from '../../core/nutrition.js';
import { dayStatus, monthWeeks, shiftMonth, weeklyAverages } from '../../core/progress.js';
import { weightList } from '../../core/schema.js';
import { monthTitle, shortDate, DOW_LETTERS, dayNumber, fullDate, parse } from '../../core/dates.js';

const STATUS_TEXT = { ok: 'dentro del objetivo', off: 'registrado, fuera del objetivo' };
const nf1 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const kg = (v) => `${nf1.format(v)} kg`;
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf1.format(Math.abs(v))} kg`;

let shown = null; // month on screen, { year, month }

// ---------- calendar ----------
function calendarCard({ store, today, onChange, onOpenDay }) {
  const cur = parse(today);
  if (!shown) shown = { year: cur.getFullYear(), month: cur.getMonth() };
  const isCurrent = shown.year === cur.getFullYear() && shown.month === cur.getMonth();
  const go = (delta) => { shown = shiftMonth(shown, delta); onChange(); };

  const cell = (iso) => {
    if (!iso) return h('span', { class: 'cal-empty' });
    const future = iso > today;
    const { totals } = sumMeals(store.mealsOf(iso));
    const goals = store.goalsFor(iso);
    const status = future ? null : dayStatus(totals, goals);
    const label = `${fullDate(iso)}${iso === today ? ' (hoy)' : ''}: ${future ? 'todavía no ha llegado' : STATUS_TEXT[status] || 'sin registrar'}`;
    const face = status
      ? ring({ size: 38, stroke: 4, value: Math.min(1, totals.kcal / goals.kcal), animate: false, color: status === 'ok' ? 'var(--ok)' : 'var(--warn)',
        label: '', center: h('span', { class: 'cal-num' }, String(dayNumber(iso))) })
      : h('span', { class: 'cal-plain' }, h('span', { class: 'cal-num' }, String(dayNumber(iso))));
    return h('button', { type: 'button', class: 'cal-day' + (iso === today ? ' is-today' : ''), disabled: future, 'aria-label': label, onClick: () => onOpenDay(iso) }, face);
  };

  return h('section', { class: 'card cal', 'aria-label': 'Calendario' },
    h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Mes anterior', dataset: { focus: 'cal-prev' }, onClick: () => go(-1) }, icon('left', 22)),
      h('h2', { class: 'section-title cal-title', 'aria-live': 'polite' }, monthTitle(shown.year, shown.month)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Mes siguiente', disabled: isCurrent, dataset: { focus: 'cal-next' }, onClick: () => go(1) }, icon('right', 22))),
    h('div', { class: 'cal-grid cal-dow', 'aria-hidden': 'true' }, DOW_LETTERS.map((l) => h('span', null, l))),
    h('div', { class: 'cal-grid' }, monthWeeks(shown.year, shown.month).flat().map(cell)),
    h('ul', { class: 'legend small' },
      h('li', null, h('span', { class: 'legend-dot is-ok' }), 'Dentro del objetivo'),
      h('li', null, h('span', { class: 'legend-dot is-off' }), 'Registrado, fuera del objetivo')),
    h('p', { class: 'small muted' }, 'Un día cuenta como cumplido si tus calorías están a menos de un 10 % del objetivo y llegas al menos al 90 % de tu proteína. Toca un día para verlo.'));
}

// ---------- weekly calories ----------
function weeklyChart({ store, today }) {
  const weeks = weeklyAverages((iso) => sumMeals(store.mealsOf(iso)).totals.kcal, today, 8);
  const goal = store.goalsFor(today).kcal;
  const withData = weeks.filter((w) => w.avg !== null);
  if (!withData.length) {
    return h('section', { class: 'card', 'aria-label': 'Calorías por semana' },
      h('h2', { class: 'section-title' }, 'Calorías por semana'),
      h('p', { class: 'muted' }, 'Todavía no hay semanas con comidas registradas. Cuando registres algunas verás aquí tu media diaria frente a tu objetivo.'));
  }

  const W = 340; const H = 170; const left = 6; const right = 6; const top = 22; const bottom = 26;
  const plotH = H - top - bottom;
  const slot = (W - left - right) / weeks.length;
  const barW = Math.min(26, slot - 10);
  const maxV = Math.max(goal * 1.2, ...withData.map((w) => w.avg * 1.08));
  const y = (v) => top + plotH * (1 - v / maxV);
  const overall = withData.reduce((a, w) => a + w.avg, 0) / withData.length;
  const summary = `Media de las semanas con datos (${withData.length}): ${fmtNum(overall)} kcal al día, frente a un objetivo de ${fmtNum(goal)} kcal.`;

  const bars = weeks.map((w, i) => {
    const cx = left + slot * i + slot / 2;
    return s('g', null,
      w.avg !== null ? s('rect', { class: 'chart-bar', x: (cx - barW / 2).toFixed(1), y: y(w.avg).toFixed(1), width: barW, height: (top + plotH - y(w.avg)).toFixed(1), rx: 5 }) : null,
      w.avg !== null ? s('text', { class: 'chart-text chart-val', x: cx.toFixed(1), y: (y(w.avg) - 5).toFixed(1), 'text-anchor': 'middle' }, fmtNum(w.avg)) : null,
      s('text', { class: 'chart-text', x: cx.toFixed(1), y: H - 8, 'text-anchor': 'middle' }, w.avg !== null ? shortDate(w.start) : '–'));
  });

  return h('section', { class: 'card', 'aria-label': 'Calorías por semana' },
    h('h2', { class: 'section-title' }, 'Calorías por semana'),
    h('p', { class: 'small muted' }, 'Media diaria de las últimas 8 semanas, contando solo los días con comidas. Cada columna empieza el lunes que indica debajo.'),
    s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': summary },
      s('line', { class: 'chart-goal', x1: left, x2: W - right, y1: y(goal).toFixed(1), y2: y(goal).toFixed(1) }),
      s('text', { class: 'chart-text chart-goal-text', x: W - right, y: (y(goal) - 5).toFixed(1), 'text-anchor': 'end' }, `Objetivo ${fmtNum(goal)}`),
      bars),
    h('p', { class: 'small' }, summary));
}

// ---------- weight ----------
function weightCard({ store, today }) {
  const list = weightList(store.getWeights());
  const last = list[list.length - 1];
  const field = numberField({ label: 'Tu peso de hoy', unit: 'kg', inputmode: 'decimal', value: store.getWeights()[today] ?? '',
    hint: 'Un peso por día: si vuelves a guardarlo hoy, se sustituye.' });
  field.input.addEventListener('input', () => field.setError(''));
  const save = (e) => {
    e.preventDefault();
    const v = field.read();
    if (v === null || v < 30 || v > 300) { field.setError('Escribe tu peso en kilos, entre 30 y 300. Por ejemplo: 72,5.'); return; }
    if (store.logWeight(today, v) === null) { field.setError('No se pudo guardar ese peso. Revisa el número e inténtalo de nuevo.'); return; }
    toast('Peso guardado');
  };

  let chart = null;
  let summary = null;
  if (list.length >= 2) {
    const pts = list.slice(-30);
    const W = 340; const H = 120; const padX = 10; const padY = 16;
    const t0 = parse(pts[0].iso).getTime();
    const span = Math.max(1, parse(pts[pts.length - 1].iso).getTime() - t0);
    const lo = Math.min(...pts.map((p) => p.kg)) - 0.5;
    const hi = Math.max(...pts.map((p) => p.kg)) + 0.5;
    const px = (p) => padX + ((parse(p.iso).getTime() - t0) / span) * (W - 2 * padX);
    const py = (p) => padY + (1 - (p.kg - lo) / (hi - lo)) * (H - 2 * padY);
    const line = pts.map((p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(' ');
    const first = list[0];
    summary = `Último peso: ${kg(last.kg)} (${shortDate(last.iso)}). Desde el primero que anotaste, ${signed(last.kg - first.kg)}.`;
    chart = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': summary },
      s('polyline', { class: 'chart-line', points: line }),
      pts.map((p) => s('circle', { class: 'chart-dot', cx: px(p).toFixed(1), cy: py(p).toFixed(1), r: 3 })),
      s('text', { class: 'chart-text', x: padX, y: 11 }, kg(hi - 0.5)),
      s('text', { class: 'chart-text', x: padX, y: H - 2 }, kg(lo + 0.5)));
  } else if (last) {
    summary = `Último peso: ${kg(last.kg)} (${shortDate(last.iso)}). Con un par de días más verás la evolución.`;
  }

  return h('section', { class: 'card weight', 'aria-label': 'Peso' },
    h('h2', { class: 'section-title' }, 'Peso'),
    h('form', { class: 'weight-form', novalidate: true, onSubmit: save }, field.el, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Guardar peso')),
    last ? null : h('p', { class: 'muted' }, 'Aún no has anotado tu peso. Guárdalo de vez en cuando y verás cómo evoluciona.'),
    chart,
    summary ? h('p', { class: 'small' }, summary) : null,
    list.length ? h('ul', { class: 'weight-list' }, [...list].reverse().slice(0, 5).map((p) =>
      h('li', null, h('span', { class: 'muted' }, shortDate(p.iso)), h('span', { class: 'num' }, kg(p.kg))))) : null);
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} o.today
 * @param {boolean} o.fresh     entering the screen: show the current month again
 * @param {()=>void} o.onChange draw the screen again (month changed)
 * @param {(iso:string)=>void} o.onOpenDay
 */
export function progressScreen({ store, today, fresh, onChange, onOpenDay }) {
  if (fresh) shown = null;
  return [
    h('h1', { class: 'title' }, 'Progreso'),
    store.loggedDays().size === 0
      ? h('p', { class: 'note small' }, 'Aún no has registrado ninguna comida. El calendario, las medias y el peso se irán llenando según uses la app.')
      : null,
    calendarCard({ store, today, onChange, onOpenDay }),
    weeklyChart({ store, today }),
    weightCard({ store, today }),
  ];
}
