/* foodie · portions of a packaged product (pure logic): how much is "one serving", "the whole package", and what meal that makes. */
import { cleanText } from './schema.js';
import { fmtNum } from './nutrition.js';

const MAX_PACKAGE_G = 5000;
const UNIT_G = { g: 1, gr: 1, grs: 1, kg: 1000, mg: 0.001, ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000, litro: 1000, litros: 1000, oz: 28.35, 'fl oz': 29.57 };

/**
 * Grams (or millilitres, as grams: 1 ml of a drink is about 1 g) in an Open Food Facts `quantity` such as "400 g", "1,5 L",
 * "6 x 125 g" or "4 x 25g (100 g)". Null when it cannot be told or is not plausible for one package.
 */
export function parseQuantityG(text) {
  if (typeof text !== 'string' || text.length > 60) return null;
  const t = text.toLowerCase().replace(/,/g, '.').replace(/×/g, 'x').trim();
  const total = t.match(/\(\s*(\d+(?:\.\d+)?)\s*(fl oz|kg|mg|gr|grs|g|ml|cl|dl|lt|l|litros?|oz)\s*\)/);   // "4 x 25 g (100 g)": the total is spelled out
  const multi = t.match(/^(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(fl oz|kg|mg|gr|grs|g|ml|cl|dl|lt|l|litros?|oz)\b/);
  const single = t.match(/^(\d+(?:\.\d+)?)\s*(fl oz|kg|mg|gr|grs|g|ml|cl|dl|lt|l|litros?|oz)\b/);
  let grams = null;
  if (total) grams = Number(total[1]) * UNIT_G[total[2]];
  else if (multi) grams = Number(multi[1]) * Number(multi[2]) * UNIT_G[multi[3]];
  else if (single) grams = Number(single[1]) * UNIT_G[single[2]];
  if (grams === null || !Number.isFinite(grams) || grams < 1 || grams > MAX_PACKAGE_G) return null;
  return Math.round(grams * 10) / 10;
}

/** The portions to offer for a product, in the order to show them: a serving, the whole package, 100 g. */
export function servingOptions(product) {
  const options = [];
  if (product.servingG) options.push({ key: 'serving', label: `1 ración (${fmtNum(product.servingG)} g)`, grams: product.servingG });
  const pack = parseQuantityG(product.quantity);
  if (pack && pack !== product.servingG) options.push({ key: 'package', label: `Envase (${fmtNum(pack)} g)`, grams: pack });
  if (product.servingG !== 100 && pack !== 100) options.push({ key: 'hundred', label: '100 g', grams: 100 });
  return options;
}

/** True when the quantity is a volume (a drink): a can or a bottle is drunk whole, a jar is not eaten whole. */
export const isLiquidQuantity = (text) => typeof text === 'string' && /\d\s*(ml|cl|dl|l|lt|litros?|fl oz)\b/i.test(text);

/**
 * What to preselect: a serving if the label states one; otherwise the whole package only when one person plausibly finishes it
 * (a drink up to 500 ml, a food up to 200 g, like a yoghurt or a tin of tuna); otherwise 100 g.
 */
export function defaultGrams(product) {
  if (product.servingG) return product.servingG;
  const pack = parseQuantityG(product.quantity);
  if (!pack) return 100;
  return pack <= (isLiquidQuantity(product.quantity) ? 500 : 200) ? pack : 100;
}

export const sliderMax = (product, grams) => {
  const pack = parseQuantityG(product.quantity) || 0;
  return Math.min(5000, Math.max(500, Math.ceil(Math.max(grams * 2, pack * 1.2, (product.servingG || 0) * 4) / 5) * 5));
};

const MISSING_WORD = { protein_g: 'proteínas', carbs_g: 'carbohidratos', fat_g: 'grasas', fiber_g: 'fibra', sugars_g: 'azúcares', sat_fat_g: 'grasa saturada', sodium_mg: 'sal' };

/** Calm sentences about what the product does not state, for the result screen. Empty when nothing is missing. */
export function missingNotes(product) {
  const notes = [];
  const words = (product.missing || []).map((k) => MISSING_WORD[k]).filter(Boolean);
  if (words.length) notes.push(`Este producto no indica ${words.length > 1 ? `${words.slice(0, -1).join(', ')} ni ${words[words.length - 1]}` : words[0]}, así que esos totales pueden quedarse cortos.`);
  if (product.estimated) notes.push('Las calorías se han calculado a partir de los macros del envase.');
  return notes;
}

/**
 * The meal to store for `grams` of a product. Its single item keeps the composition per 100 g, so the grams stay editable later.
 * @param {object} product  from productFromOff / cleanProduct
 * @param {number} grams
 * @param {{slot:string, time?:string}} o
 */
export function productMeal(product, grams, { slot, time }) {
  const item = { name: cleanText(product.name, 120) || 'Producto', grams, gramsMin: 0, gramsMax: sliderMax(product, grams), per100: product.per100 };
  const meal = { name: cleanText(product.brand ? `${product.name} ${product.brand}` : product.name, 80) || item.name, slot, source: 'barcode', items: [item] };
  if (time) meal.time = time;
  return meal;
}
