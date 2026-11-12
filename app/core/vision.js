/* foodie · reading what a vision model says about a photo of food (pure logic: no network, no DOM, no SDK).
   The model is asked for JSON in a fixed shape; whatever comes back is untrusted text from a remote system, so every field is
   range-checked and every string cleaned like any other text before the app shows it or stores it.
   An estimate from a photo is an estimate: the result carries a confidence, marks ingredients that are implied rather than
   visible (cooking oil), and says when the photo does not show enough, so the app can ask for context instead of pretending. */
import { cleanText, cleanPer100 } from './schema.js';
import { toNum } from './goals.js';
import { macroMismatch } from './nutrition.js';

export const SCALE_REFS = ['plate', 'cutlery', 'hand', 'glass', 'package', 'none'];
export const MAX_ITEMS = 12;
export const MAX_GRAMS = 2000;
export const LOW_CONFIDENCE = 0.45;
export const MAX_CONTEXT = 300;
const MAX_RESPONSE_CHARS = 200000;

const NUMBER = { type: 'number' };
const REQUIRED_PER100 = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugars_g', 'sodium_mg'];
const OPTIONAL_PER100 = ['sat_fat_g', 'potassium_mg', 'calcium_mg', 'iron_mg', 'magnesium_mg', 'vit_a_ug', 'vit_c_mg', 'vit_d_ug', 'vit_e_mg',
  'vit_b1_mg', 'vit_b2_mg', 'vit_b3_mg', 'vit_b6_mg', 'vit_b9_ug', 'vit_b12_ug'];

/** What the model must answer, as JSON Schema. `toSdkSchema` turns it into the SDK's own schema helpers. */
export const VISION_JSON_SCHEMA = {
  type: 'object',
  required: ['is_food', 'dish', 'confidence', 'scale_ref', 'needs_context', 'items'],
  properties: {
    is_food: { type: 'boolean' },
    dish: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    scale_ref: { type: 'string', enum: SCALE_REFS },
    needs_context: { type: 'boolean' },
    notes: { type: 'string' },
    items: {
      type: 'array', minItems: 1, maxItems: MAX_ITEMS,
      items: {
        type: 'object',
        required: ['name', 'grams', 'grams_min', 'grams_max', 'confidence', 'hidden', 'per100'],
        properties: {
          name: { type: 'string' },
          grams: { type: 'number', minimum: 1 },
          grams_min: NUMBER,
          grams_max: NUMBER,
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          hidden: { type: 'boolean' },
          per100: {
            type: 'object',
            required: REQUIRED_PER100,
            properties: Object.fromEntries([...REQUIRED_PER100, ...OPTIONAL_PER100].map((k) => [k, NUMBER])),
          },
        },
      },
    },
  },
};

/**
 * Converts a JSON Schema (the subset above) into the SDK's Schema objects.
 * @param {object} json
 * @param {{object:Function, string:Function, number:Function, boolean:Function, enumString:Function, array:Function}} Schema
 */
export function toSdkSchema(json, Schema) {
  switch (json.type) {
    case 'object': {
      const required = new Set(json.required || []);
      const properties = Object.fromEntries(Object.entries(json.properties).map(([k, v]) => [k, toSdkSchema(v, Schema)]));
      return Schema.object({ properties, optionalProperties: Object.keys(properties).filter((k) => !required.has(k)) });
    }
    case 'array': return Schema.array({ items: toSdkSchema(json.items, Schema), maxItems: json.maxItems });
    case 'string': return json.enum ? Schema.enumString({ enum: json.enum }) : Schema.string();
    case 'number': return Schema.number();
    case 'boolean': return Schema.boolean();
    default: throw new Error(`unsupported schema type ${json.type}`);
  }
}

const SYSTEM_PROMPT = `You are a nutritionist who estimates the amount of food on a plate from a single photo.
Work in this order:
1. Find a scale reference in the photo: a standard dinner plate (about 26 cm across), a fork (about 19 cm), a hand, a glass, or a food package. Say which one in scale_ref ("none" if there is nothing to compare with).
2. Separate the ingredients you can see.
3. For each ingredient estimate its weight in grams AS SERVED (cooked, not raw), from the volume it occupies and its typical density. Give a plausible range in grams_min and grams_max.
4. Add the cooking fat, butter, sauce or dressing that is visible or clearly implied as its own item with hidden = true (for example "aceite de oliva" for fried or sautéed food).
5. For each item give its composition per 100 g from standard food composition tables (USDA style) for that exact preparation. carbs_g is AVAILABLE carbohydrate (fibre is counted apart in fiber_g). Include the optional micronutrients only when you are confident.
Be honest about uncertainty: lower the confidence values when there is no scale reference, when foods overlap or are covered, or when the photo is blurry.
If the photo does not show food, set is_food to false and give an empty-looking best guess.
If you cannot see what is inside (a wrapped burrito, a closed container, a sealed package without a readable label, a drink in an opaque cup), set needs_context to true and still give your best guess.
If the user supplies context, treat it as true and use it.
Write dish, name and notes in Spanish; use generic ingredient names ("arroz blanco cocido", "pechuga de pollo a la plancha"). Answer only with JSON in the requested format.`;

const LABEL_PROMPT = `The photo shows the nutrition facts table of a packaged food, not a plate. Read the table instead of estimating: return ONE item, name it after the product if the name is visible, give its values per 100 g exactly as printed (convert per-serving values to per 100 g if that is all the label gives), grams = the serving size in grams if printed, otherwise 100, scale_ref "package", hidden false. If the table is not readable set needs_context to true.`;

/**
 * @param {{context?:string, label?:boolean}} [o]
 * @returns {{system:string, user:string}}
 */
export function buildVisionPrompt({ context = '', label = false } = {}) {
  const ctx = cleanText(typeof context === 'string' ? context : '', MAX_CONTEXT);
  const lines = ['Analiza esta foto y devuelve el JSON pedido.'];
  if (label) lines.push(LABEL_PROMPT);
  if (ctx) lines.push(`Contexto aportado por la persona (es cierto y tiene prioridad): «${ctx}»`);
  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}

// ---------- reading the answer ----------

const clamp01 = (v, fallback) => { const n = toNum(v); return n === null ? fallback : Math.min(1, Math.max(0, n)); };
const round1 = (v) => Math.round(v * 10) / 10;

function parseItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = cleanText(raw.name, 120);
  const g = toNum(raw.grams);
  const per100 = cleanPer100(raw.per100);
  if (!name || g === null || g <= 0 || !per100) return null;
  const grams = round1(Math.min(MAX_GRAMS, Math.max(1, g)));
  let min = toNum(raw.grams_min);
  let max = toNum(raw.grams_max);
  min = min === null ? Math.floor(grams * 0.5) : Math.min(grams, Math.max(0, Math.floor(min)));
  max = max === null ? Math.ceil(grams * 1.6) : Math.min(MAX_GRAMS, Math.max(grams, Math.ceil(max)));
  if (max < grams + 5) max = Math.min(MAX_GRAMS, Math.ceil(grams * 1.6));          // a range of zero width would give a slider that cannot move
  const hidden = raw.hidden === true;
  return {
    name, grams, gramsMin: min, gramsMax: max, confidence: clamp01(raw.confidence, 0.5), hidden, per100,
    inconsistent: macroMismatch(per100),                        // the calories and the macros the model gave do not agree: the UI says so
  };
}

/**
 * @param {string|object} json  the model's text (or an already parsed object)
 * @returns {{ok:true, isFood:boolean, dish:string, confidence:number, needsContext:boolean, scaleRef:string, notes:string, items:object[]}|{ok:false, reason:'invalid'|'empty'}}
 */
export function parseVision(json) {
  try { return parseVisionUnsafe(json); } catch (e) { return { ok: false, reason: 'invalid' }; }   // a getter that throws is just a bad answer
}

function parseVisionUnsafe(json) {
  let data = json;
  if (typeof json === 'string') {
    if (json.length > MAX_RESPONSE_CHARS) return { ok: false, reason: 'invalid' };
    const text = json.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { data = JSON.parse(text); } catch (e) { return { ok: false, reason: 'invalid' }; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'invalid' };
  const rawItems = Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : [];
  const items = rawItems.map(parseItem).filter(Boolean);
  const isFood = data.is_food !== false;
  if (isFood && !items.length) return { ok: false, reason: 'empty' };
  const confidence = clamp01(data.confidence, 0.4);
  return {
    ok: true,
    isFood,
    dish: cleanText(data.dish, 80) || (items[0] ? items[0].name : ''),
    confidence: isFood ? confidence : Math.min(confidence, 0.2),
    needsContext: data.needs_context === true,
    scaleRef: SCALE_REFS.includes(data.scale_ref) ? data.scale_ref : 'none',
    notes: cleanText(data.notes, 300),
    items: isFood ? items : [],
  };
}

/** The result cannot be trusted as it is: ask for context before showing numbers as if they were reliable. */
export const needsContextScreen = (r) => r.ok && (!r.isFood || r.needsContext || r.confidence < LOW_CONFIDENCE || r.items.length === 0);

/** A word, not a number: the person should not have to interpret 0.62. */
export function confidenceWord(c) {
  if (c >= 0.75) return 'Estimación segura';
  if (c >= LOW_CONFIDENCE) return 'Estimación media';
  return 'Estimación baja';
}

/**
 * The meal to store for a result (after the person has moved the sliders and maybe renamed the dish).
 * Items the model implied but nobody can see are marked "(estimado)" in their name.
 */
export function visionMeal(result, { name, slot, time, thumb }) {
  const meal = {
    name: cleanText(name, 80) || cleanText(result.dish, 80) || (result.items[0] ? result.items[0].name : 'Comida'),
    slot, source: 'ai', confidence: result.confidence,
    items: result.items.map((it) => ({
      name: it.hidden && !/estimad/i.test(it.name) ? cleanText(`${it.name} (estimado)`, 120) : it.name,
      grams: it.grams, gramsMin: it.gramsMin, gramsMax: it.gramsMax, per100: it.per100,
    })),
  };
  if (time) meal.time = time;
  if (thumb) meal.thumb = thumb;
  return meal;
}
