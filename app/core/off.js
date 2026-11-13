/* foodie · Open Food Facts (pure logic: no network, no DOM). Turns a scanned code and an Open Food Facts record into the same
   "composition per 100 g" every other food in the app uses. Nothing in a record is trusted: names are cleaned like any text,
   numbers are range-checked by cleanPer100, and the image address must belong to Open Food Facts.
   Data: Open Food Facts contributors, Open Database Licence (ODbL). */
import { cleanText, cleanPer100 } from './schema.js';
import { kcalFromMacros } from './nutrition.js';

export const OFF_FIELDS = 'code,product_name,product_name_es,brands,quantity,serving_size,serving_quantity,image_front_small_url,nutriments';
export const OFF_ORIGIN = 'https://world.openfoodfacts.org';
const IMAGE_PREFIX = 'https://images.openfoodfacts.org/';

/** GS1 check digit: the last digit makes the weighted sum (3, 1, 3, 1 ... from the right, the check digit excluded) a multiple of 10. */
export function hasValidCheckDigit(digits) {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits.slice(-1));
}

/**
 * UPC-E is a zero-suppressed UPC-A (small packs, mostly North America): 8 digits = number system, six digits, check digit.
 * The last of the six digits says where the suppressed zeros go. Returns the 12-digit UPC-A it stands for, or null.
 */
export function expandUpcE(digits) {
  if (!/^[01]\d{7}$/.test(digits)) return null;
  const n = digits[0];
  const [a, b, c, d, e, f] = digits.slice(1, 7);
  const check = digits[7];
  let body;
  if ('012'.includes(f)) body = `${n}${a}${b}${f}0000${c}${d}${e}`;
  else if (f === '3') body = `${n}${a}${b}${c}00000${d}${e}`;
  else if (f === '4') body = `${n}${a}${b}${c}${d}00000${e}`;
  else body = `${n}${a}${b}${c}${d}${e}0000${f}`;
  const upcA = body + check;
  return hasValidCheckDigit(upcA) ? upcA : null;
}

/**
 * What a scanner returned (a barcode number, or the text of a QR code) as a product code, or null.
 * A QR is accepted only when it is a bare number or a GS1 Digital Link (…/01/<gtin>/…); any other text, and any link, is ignored.
 * `format` is what the scanner says it read: an 8-digit `upc_e` is expanded to its UPC-A (its check digit is not an EAN-8 one).
 */
export function normalizeCode(raw, format = '') {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const text = raw.trim();
  let digits = null;
  if (format === 'upc_e' && /^\d{8}$/.test(text)) return expandUpcE(text);
  if (/^\d{8,14}$/.test(text)) digits = text;
  else {
    const link = text.match(/^https?:\/\/[^\s/]+\/(?:[^\s/]+\/)*01\/(\d{14})(?:[/?#]|$)/i);
    if (link) digits = link[1];
  }
  if (!digits) return null;
  if (digits.length === 14 && digits.startsWith('0')) digits = digits.slice(1);      // GTIN-14 of a single item: the EAN-13 behind it
  return hasValidCheckDigit(digits) ? digits : null;
}

export const offUrl = (code) => `${OFF_ORIGIN}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`;

const num = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };

// Open Food Facts stores every nutrient per 100 g in GRAMS (energy aside); the app uses mg and µg for minerals and vitamins.
const DIRECT = { protein_g: 'proteins', carbs_g: 'carbohydrates', fat_g: 'fat', fiber_g: 'fiber', sugars_g: 'sugars', sat_fat_g: 'saturated-fat' };
const MG = { potassium_mg: 'potassium', calcium_mg: 'calcium', iron_mg: 'iron', magnesium_mg: 'magnesium', vit_c_mg: 'vitamin-c', vit_e_mg: 'vitamin-e',
  vit_b1_mg: 'vitamin-b1', vit_b2_mg: 'vitamin-b2', vit_b3_mg: 'vitamin-pp', vit_b6_mg: 'vitamin-b6' };
const UG = { vit_a_ug: 'vitamin-a', vit_d_ug: 'vitamin-d', vit_b9_ug: 'vitamin-b9', vit_b12_ug: 'vitamin-b12' };

/** Composition per 100 g from OFF `nutriments`, or null. `estimated` is true when the energy had to be derived from the macros. */
export function per100FromNutriments(n) {
  if (!n || typeof n !== 'object') return null;
  const raw = {};
  for (const [key, off] of Object.entries(DIRECT)) { const v = num(n[`${off}_100g`]); if (v !== null) raw[key] = v; }
  for (const [key, off] of Object.entries(MG)) { const v = num(n[`${off}_100g`]); if (v !== null) raw[key] = v * 1000; }
  for (const [key, off] of Object.entries(UG)) { const v = num(n[`${off}_100g`]); if (v !== null) raw[key] = v * 1e6; }
  const sodium = num(n.sodium_100g);
  const salt = num(n.salt_100g);
  if (sodium !== null) raw.sodium_mg = sodium * 1000;
  else if (salt !== null) raw.sodium_mg = salt * 400;                       // salt is 40 % sodium
  const kcal = num(n['energy-kcal_100g']);
  const kj = num(n['energy-kj_100g']);
  let estimated = false;
  if (kcal !== null) raw.kcal = kcal;
  else if (kj !== null) raw.kcal = kj / 4.184;
  else if ('protein_g' in raw || 'carbs_g' in raw || 'fat_g' in raw) { raw.kcal = kcalFromMacros(raw); estimated = true; }
  else return null;
  for (const k of Object.keys(raw)) raw[k] = Math.round(raw[k] * 100) / 100;
  const per100 = cleanPer100(raw);
  return per100 ? { per100, estimated } : null;
}

/** @returns {{ok:true, code:string, name:string, brand:string, imageUrl:string|null, per100:object, estimated:boolean, servingG:number|null, servingLabel:string, quantity:string, missing:string[]}|{ok:false, reason:'not-found'|'no-nutrition'|'invalid'}} */
export function productFromOff(json, code) {
  if (!json || typeof json !== 'object' || json.status !== 1 || !json.product || typeof json.product !== 'object') return { ok: false, reason: json && json.status === 0 ? 'not-found' : 'invalid' };
  const p = json.product;
  const name = cleanText(p.product_name_es, 120) || cleanText(p.product_name, 120);
  const parsed = per100FromNutriments(p.nutriments);
  if (!parsed) return { ok: false, reason: 'no-nutrition' };
  const brand = cleanText(String(p.brands || '').split(',')[0], 60);
  const image = typeof p.image_front_small_url === 'string' && p.image_front_small_url.startsWith(IMAGE_PREFIX) && p.image_front_small_url.length < 300 && !/[\s"'<>]/.test(p.image_front_small_url) ? p.image_front_small_url : null;
  const serving = num(p.serving_quantity);
  const missing = ['protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugars_g', 'sat_fat_g', 'sodium_mg'].filter((k) => !(k in parsed.per100));
  return {
    ok: true, code, name: name || 'Producto sin nombre', brand, imageUrl: image, per100: parsed.per100, estimated: parsed.estimated,
    servingG: serving !== null && serving >= 1 && serving <= 2000 ? Math.round(serving * 10) / 10 : null,
    servingLabel: cleanText(p.serving_size, 40), quantity: cleanText(p.quantity, 40), missing,
  };
}

// ---------- the local cache of products that were looked up ----------

export const MAX_PRODUCTS = 200;
const MISSING_KEYS = ['protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugars_g', 'sat_fat_g', 'sodium_mg'];

/** The address of a product picture if it belongs to Open Food Facts and is plain, otherwise null. */
export function cleanImageUrl(v) {
  return typeof v === 'string' && v.startsWith(IMAGE_PREFIX) && v.length < 300 && !/[\s"'<>\\]/.test(v) ? v : null;
}

/**
 * A product as stored in the cache (or read back from it): everything is checked again, as for any data read from storage.
 * Returns null unless it is a complete, valid product.
 */
export function cleanProduct(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.ok !== true) return null;
    const code = typeof raw.code === 'string' && /^\d{8,14}$/.test(raw.code) && hasValidCheckDigit(raw.code) ? raw.code : null;
    const per100 = cleanPer100(raw.per100);
    const name = cleanText(raw.name, 120);
    if (!code || !per100 || !name) return null;
    const serving = typeof raw.servingG === 'number' && Number.isFinite(raw.servingG) && raw.servingG >= 1 && raw.servingG <= 2000 ? Math.round(raw.servingG * 10) / 10 : null;
    return {
      ok: true, code, name, brand: cleanText(raw.brand, 60), imageUrl: cleanImageUrl(raw.imageUrl), per100, estimated: raw.estimated === true,
      servingG: serving, servingLabel: cleanText(raw.servingLabel, 40), quantity: cleanText(raw.quantity, 40),
      missing: MISSING_KEYS.filter((k) => !(k in per100)),
    };
  } catch (e) { return null; }
}

/** { [code]: { p: product, at: stamp } }, no prototype, only valid entries, the MAX_PRODUCTS newest. */
export function cleanProducts(raw) {
  const out = Object.create(null);
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const entries = [];
    for (const [code, e] of Object.entries(raw)) {
      const p = e && typeof e === 'object' ? cleanProduct(e.p) : null;
      const at = e && typeof e.at === 'number' && Number.isFinite(e.at) && e.at >= 0 && e.at <= 32503680000000 ? Math.floor(e.at) : 0;
      if (p && p.code === code) entries.push([code, { p, at }]);
    }
    entries.sort((a, b) => b[1].at - a[1].at || (a[0] < b[0] ? -1 : 1));
    for (const [code, e] of entries.slice(0, MAX_PRODUCTS)) out[code] = e;
  } catch (e) { /* an unreadable cache is an empty cache */ }
  return out;
}
