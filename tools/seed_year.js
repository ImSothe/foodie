/* foodie · seed a year of heavy use for the browser checks. Plain script, not loaded by the app.

   How to use it (dev server running: npm run dev, then http://localhost:8790/ in Chromium, console open or the evaluate_script tool):
     1. Paste this file, then run one of
          await seedIndexedDB({ days: 365, thumbsPerDay: 1 })      // what the app uses now: writes the database directly, then reload
          seedLocalStorage({ days: 365, thumbsPerDay: 0 })          // the OLD format, to test the one-time migration, then reload
        (localStorage holds about 5 MB: a year with a thumbnail every day does not fit, which is why the data moved to IndexedDB.)
     2. Reload. Read how long the data took to load:  (await import('/data/store.js')).store.timing
        and the mode: (await import('/data/store.js')).store.mode  ('indexeddb').
     3. To start over:  indexedDB.deleteDatabase('foodie'); localStorage.clear(); and reload.

   Data written: 4 meals a day for the last N days (the newest day is today), every meal with 3 items, the first `thumbsPerDay` meals of a day
   with a 12 KB JPEG-shaped thumbnail (not a real picture: a data URL of the right size), 30 favourites, a weight every third day, a profile and goals. */

function buildYearData({ days = 365, mealsPerDay = 4, thumbsPerDay = 1 } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (offset) => { const d = new Date(); d.setDate(d.getDate() - offset); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const per100 = (k) => ({ kcal: 100 + k, protein_g: 10, carbs_g: 12 + (k % 5), fat_g: 3, fiber_g: 1, sugars_g: 2, sat_fat_g: 1, sodium_mg: 100, potassium_mg: 200, calcium_mg: 50, iron_mg: 1, magnesium_mg: 20, vit_c_mg: 5 });
  const head = 'data:image/jpeg;base64,';
  const thumb = head + 'A'.repeat(12 * 1024 - head.length - ((12 * 1024 - head.length) % 4)); // base64 length multiple of 4, or the browser rejects the URL
  const now = Date.now();
  const daysObj = {};
  for (let d = 0; d < days; d += 1) {
    const meals = {};
    for (let m = 0; m < mealsPerDay; m += 1) {
      const id = 'm' + d + 'x' + m;
      meals[id] = {
        id, name: 'Comida ' + d + '-' + m + ' con arroz y pollo', slot: ['Desayuno', 'Almuerzo', 'Snack', 'Cena'][m % 4], time: pad(8 + m * 3) + ':15',
        source: m < thumbsPerDay ? 'ai' : 'db', updatedAt: now - d * 86400000 + m, ...(m < thumbsPerDay ? { thumb } : {}),
        items: [
          { name: 'Pechuga de pollo a la plancha', grams: 150, gramsMin: 0, gramsMax: 500, per100: per100(d) },
          { name: 'Arroz blanco cocido', grams: 180, gramsMin: 0, gramsMax: 500, per100: per100(d + 1) },
          { name: 'Aceite de oliva (estimado)', grams: 10, gramsMin: 0, gramsMax: 40, per100: per100(d + 2) },
        ],
      };
    }
    daysObj[iso(d)] = { meals, waterMl: 1500 + d, steps: 6000 + d };
  }
  const saved = Array.from({ length: 30 }, (_, i) => ({ id: 's' + i, name: 'Favorita ' + i, slot: 'Almuerzo', source: 'db', items: [{ name: 'Pollo', grams: 150, per100: per100(i) }] }));
  const weights = {};
  for (let i = 0; i < Math.ceil(days / 3); i += 1) weights[iso(i * 3)] = 80 - (i % 10) / 10;
  const year = new Date().getFullYear();
  return {
    'fd.profile': JSON.stringify({ sex: 'female', birthYear: year - 30, heightCm: 165, weightKg: 60, activity: 'light', goal: 'lose', pace: 0.2 }),
    'fd.goals': JSON.stringify([{ from: iso(days), goals: { kcal: 1800, protein_g: 120, carbs_g: 180, fat_g: 60, waterL: 2.2, steps: 8000 } }]),
    'fd.days': JSON.stringify(daysObj), 'fd.saved': JSON.stringify(saved), 'fd.weights': JSON.stringify(weights),
  };
}

function seedLocalStorage(options) {
  const data = buildYearData(options);
  for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
}

async function seedIndexedDB(options) {
  const data = buildYearData(options);
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('foodie', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    for (const [k, v] of Object.entries(data)) tx.objectStore('kv').put(v, k);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
}
