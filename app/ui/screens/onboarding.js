/* foodie · onboarding: one question per screen, then "Tu plan" with every target editable.
   The same screen edits an existing profile (Ajustes), starting from the saved answers. */
import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { numberField } from '../fields.js';
import { fmtNum } from '../../core/nutrition.js';
import { LIMITS, PACES, DEFAULT_PACE, ACTIVITIES, cleanProfile, computePlan, toGoals, pacePreview, ageOf } from '../../core/goals.js';
import { cleanGoals, GOAL_RANGES } from '../../core/schema.js';

export const SEX_LABEL = { male: 'Hombre', female: 'Mujer' };
export const GOAL_LABEL = { lose: 'Bajar peso', maintain: 'Mantenerme', gain: 'Ganar peso' };
export const ACTIVITY_INFO = {
  sedentary: ['Sedentario', 'Trabajo sentado y casi nada de ejercicio'],
  light: ['Ligero', 'Ejercicio suave 1 a 3 días por semana'],
  moderate: ['Moderado', 'Ejercicio 3 a 5 días por semana'],
  active: ['Activo', 'Ejercicio intenso 6 o 7 días por semana'],
  very_active: ['Muy activo', 'Entrenas a diario o tu trabajo es físico'],
};
const PACE_NAME = ['Suave', 'Moderado', 'Rápido'];
const GOAL_INFO = {
  lose: ['Bajar peso', 'Comer algo menos de lo que gastas'],
  maintain: ['Mantenerme', 'Comer lo que gastas'],
  gain: ['Ganar peso', 'Comer algo más de lo que gastas'],
};
const kcalFmt = (v) => `${fmtNum(v)} kcal`;

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} o.today         ISO day the new goals take effect
 * @param {{profile:object, goals:object}|null} [o.existing]  editing: start from these answers
 * @param {()=>void} o.onDone      saved
 * @param {()=>void} [o.onCancel]  editing only: leave without saving
 */
export function onboardingScreen({ store, today, existing = null, onDone, onCancel }) {
  const edit = !!existing;
  const p0 = existing && existing.profile;
  const d = p0
    ? { sex: p0.sex, age: ageOf(p0), heightCm: p0.heightCm, weightKg: p0.weightKg, activity: p0.activity, goal: p0.goal, pace: p0.pace }
    : { pace: null };
  let i = 0;
  let targets = null;          // { kcal, protein_g, ... } being edited on the last screen; null = recalculate from the answers
  const root = h('div', { class: 'onb' });

  const setDraft = (key, value) => { if (d[key] !== value) { d[key] = value; targets = null; } };
  const steps = () => ['sex', 'age', 'height', 'weight', 'activity', 'goal', ...(d.goal === 'maintain' ? [] : ['pace']), 'plan'];
  const go = (n) => { i = n; show(true); };
  const next = () => go(i + 1);
  const back = () => { if (i > 0) go(i - 1); else if (edit && onCancel) onCancel(); };
  const profileOk = () => !!cleanProfile(d);

  // ---------- question screens ----------
  const choices = (items, current, pick) => h('div', { class: 'choices', role: 'group' }, items.map(({ value, title, text }) =>
    h('button', { type: 'button', class: 'choice', 'aria-pressed': String(value === current), onClick: () => pick(value) },
      h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, title), text ? h('span', { class: 'small muted' }, text) : null),
      icon('check', 22))));

  function numberStep({ key, label, unit, inputmode, min, max, integer, message }) {
    const field = numberField({ label, unit, inputmode, value: d[key] === undefined ? '' : d[key], big: true });
    const submit = (e) => {
      e.preventDefault();
      const v = field.read();
      if (v === null || v < min || v > max || (integer && !Number.isInteger(v))) { field.setError(message); return; }
      setDraft(key, integer ? v : Math.round(v * 10) / 10);
      next();
    };
    field.input.addEventListener('input', () => field.setError(''));
    return h('form', { class: 'onb-form', novalidate: true, onSubmit: submit },
      field.el, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Continuar'));
  }

  const QUESTIONS = {
    sex: () => ({
      title: '¿Cuál es tu sexo?',
      lead: 'Lo usamos para la fórmula de calorías y para los valores de referencia de vitaminas y minerales. Tus datos se quedan en este dispositivo.',
      body: choices([{ value: 'male', title: 'Hombre' }, { value: 'female', title: 'Mujer' }], d.sex, (v) => { setDraft('sex', v); next(); }),
    }),
    age: () => ({
      title: '¿Cuántos años tienes?',
      body: numberStep({ key: 'age', label: 'Edad', unit: 'años', inputmode: 'numeric', min: LIMITS.age[0], max: LIMITS.age[1], integer: true,
        message: `Escribe tu edad en años, un número entero entre ${LIMITS.age[0]} y ${LIMITS.age[1]}.` }),
    }),
    height: () => ({
      title: '¿Cuánto mides?',
      body: numberStep({ key: 'heightCm', label: 'Altura', unit: 'cm', inputmode: 'decimal', min: LIMITS.heightCm[0], max: LIMITS.heightCm[1],
        message: `Escribe tu altura en centímetros, entre ${LIMITS.heightCm[0]} y ${LIMITS.heightCm[1]}. Por ejemplo: 172.` }),
    }),
    weight: () => ({
      title: '¿Cuánto pesas?',
      lead: 'Tu peso de hoy. Puedes usar decimales.',
      body: numberStep({ key: 'weightKg', label: 'Peso', unit: 'kg', inputmode: 'decimal', min: LIMITS.weightKg[0], max: LIMITS.weightKg[1],
        message: `Escribe tu peso en kilos, entre ${LIMITS.weightKg[0]} y ${LIMITS.weightKg[1]}. Por ejemplo: 72,5.` }),
    }),
    activity: () => ({
      title: '¿Cuánto te mueves?',
      lead: 'Piensa en una semana normal, contando el trabajo y el ejercicio.',
      body: choices(ACTIVITIES.map((a) => ({ value: a, title: ACTIVITY_INFO[a][0], text: ACTIVITY_INFO[a][1] })), d.activity,
        (v) => { setDraft('activity', v); next(); }),
    }),
    goal: () => ({
      title: '¿Cuál es tu objetivo?',
      body: choices(['lose', 'maintain', 'gain'].map((g) => ({ value: g, title: GOAL_INFO[g][0], text: GOAL_INFO[g][1] })), d.goal, (v) => {
        setDraft('goal', v);
        setDraft('pace', v === 'maintain' ? null : (PACES[v].includes(d.pace) ? d.pace : DEFAULT_PACE[v]));
        next();
      }),
    }),
    pace: () => {
      const preview = pacePreview({ ...d }, d.goal);
      const pct = (p) => Math.round(p * 100);
      return {
        title: '¿A qué ritmo?',
        lead: d.goal === 'lose' ? 'Un ritmo más suave suele ser más fácil de mantener.' : 'Ganar despacio suele significar ganar menos grasa.',
        body: choices(preview.map((o, k) => ({
          value: o.pace,
          title: PACE_NAME[k] + (o.pace === DEFAULT_PACE[d.goal] ? ' (recomendado)' : ''),
          text: `Unas ${kcalFmt(o.kcal)} al día, un ${pct(o.pace)} % ${d.goal === 'lose' ? 'menos' : 'más'} que tu gasto${o.floored ? ' (se queda en el mínimo recomendado)' : ''}`,
        })), d.pace, (v) => { setDraft('pace', v); next(); }),
      };
    },
  };

  // ---------- "Tu plan" ----------
  function planScreen() {
    const profile = cleanProfile(d);
    const plan = computePlan(profile);
    const calculated = toGoals(plan);
    if (!targets) {
      const same = edit && JSON.stringify(profile) === JSON.stringify(existing.profile);
      targets = { ...(same && existing.goals ? existing.goals : calculated) };
    }
    const fields = {};
    const defs = [
      ['kcal', 'Calorías al día', 'kcal', 'numeric'], ['protein_g', 'Proteína', 'g', 'numeric'], ['carbs_g', 'Carbohidratos', 'g', 'numeric'],
      ['fat_g', 'Grasa', 'g', 'numeric'], ['waterL', 'Agua', 'litros', 'decimal'], ['steps', 'Pasos al día', 'pasos', 'numeric'],
    ];
    const macroNote = h('p', { class: 'small muted', 'aria-live': 'polite' });
    const paintMacroNote = () => {
      const t = targets;
      if (![t.kcal, t.protein_g, t.carbs_g, t.fat_g].every((v) => typeof v === 'number')) { macroNote.textContent = ''; return; }
      const sum = 4 * t.protein_g + 4 * t.carbs_g + 9 * t.fat_g;
      const off = t.kcal > 0 && Math.abs(sum - t.kcal) / t.kcal > 0.1;
      macroNote.textContent = `Con estos gramos, tus macros suman unas ${kcalFmt(sum)}${off ? ', una cifra distinta de tu objetivo de calorías' : ''}.`;
    };
    for (const [key, label, unit, inputmode] of defs) {
      fields[key] = numberField({
        label, unit, inputmode, value: targets[key],
        onInput: (el) => { targets[key] = fields[key].read(); fields[key].setError(''); paintMacroNote(); },
      });
    }
    paintMacroNote();

    const reset = () => {
      targets = { ...calculated };
      for (const [key] of defs) { fields[key].setValue(targets[key]); fields[key].setError(''); }
      paintMacroNote();
    };

    const save = () => {
      let bad = false;
      for (const [key, [lo, hi]] of Object.entries(GOAL_RANGES)) {
        const v = fields[key].read();
        if (v === null || v < lo || v > hi) { fields[key].setError(`Escribe un valor entre ${fmtNum(lo)} y ${fmtNum(hi)}.`); bad = true; } else fields[key].setError('');
      }
      if (bad) return;
      const goals = cleanGoals(Object.fromEntries(defs.map(([key]) => [key, fields[key].read()])));
      if (!goals) return;
      const weightChanged = !edit || existing.profile.weightKg !== profile.weightKg;
      store.batch(() => {
        store.setGoals(goals, today);
        store.saveProfile(profile);
        if (weightChanged) store.logWeight(today, profile.weightKg);
      });
      onDone();
    };

    return {
      title: 'Tu plan',
      lead: 'Esto es lo que te recomendamos cada día. Toca cualquier cifra para cambiarla.',
      body: h('div', { class: 'plan' },
        h('div', { class: 'card plan-hero' },
          h('p', { class: 'num plan-kcal' }, fmtNum(plan.kcal)),
          h('p', { class: 'hero-label' }, 'kcal al día'),
          h('p', { class: 'small muted' },
            `Tu metabolismo basal es de unas ${kcalFmt(plan.bmr)} y, con tu actividad, gastas unas ${kcalFmt(plan.tdee)} al día.`),
          plan.floored ? h('p', { class: 'small plan-floor' },
            `Con el ritmo elegido saldrían menos calorías de las que consideramos seguras, así que hemos fijado el mínimo en ${kcalFmt(plan.kcal)}. Puedes cambiarlo, pero valora consultarlo con un profesional.`) : null),
        h('div', { class: 'card plan-fields' },
          fields.kcal.el,
          h('div', { class: 'plan-grid' }, fields.protein_g.el, fields.carbs_g.el, fields.fat_g.el),
          macroNote,
          h('div', { class: 'plan-grid' }, fields.waterL.el, fields.steps.el),
          h('button', { type: 'button', class: 'btn btn-quiet', onClick: reset }, 'Volver al cálculo automático')),
        h('p', { class: 'note small' },
          'Estas cifras son una estimación con una fórmula estándar (Mifflin-St Jeor), no un consejo médico. Si tienes alguna condición médica o un embarazo, consúltalo con un profesional sanitario.'),
        h('button', { type: 'button', class: 'btn btn-primary', onClick: save }, edit ? 'Guardar cambios' : 'Guardar y empezar')),
    };
  }

  // ---------- frame ----------
  function show(focus) {
    const list = steps();
    const key = list[i];
    const q = key === 'plan' ? planScreen() : QUESTIONS[key]();
    const total = list.length;
    const canBack = i > 0 || (edit && onCancel);
    const title = h('h1', { class: 'title', tabIndex: -1 }, q.title);
    mount(root,
      h('div', { class: 'onb-top' },
        canBack
          ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': i > 0 ? 'Volver a la pregunta anterior' : 'Cancelar', onClick: back }, icon('left', 22))
          : null,
        h('span', { class: 'onb-progress', role: 'progressbar', 'aria-label': `Paso ${i + 1} de ${total}`, 'aria-valuemin': '1', 'aria-valuemax': String(total), 'aria-valuenow': String(i + 1) },
          h('span', { class: 'onb-progress-fill', style: { width: `${((i + 1) / total) * 100}%` } })),
        h('span', { class: 'small muted onb-count' }, `${i + 1} de ${total}`)),
      title,
      q.lead ? h('p', { class: 'muted onb-lead' }, q.lead) : null,
      q.body,
      edit && key !== 'plan' && profileOk()
        ? h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => go(steps().length - 1) }, 'Ir directamente a mi plan')
        : null);
    if (focus) {
      const input = key === 'plan' ? null : root.querySelector('input');
      (input || title).focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }

  show(false);
  return root;
}
