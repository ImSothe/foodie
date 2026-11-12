/* foodie · XSS seed for the browser check. Plain data plus one function; nothing here is loaded by the app.

   How to use it (any Chromium or Firefox, with the dev server running: npm run dev):
     1. Open http://localhost:8790/ and open the developer console (or use the evaluate_script tool of chrome-devtools).
     2. Paste this whole file, then run:  seedHostileData()
     3. Reload the page, then visit every route and the hostile addresses listed in HOSTILE_HASHES:
        #/  #/progreso  #/guardadas  #/ajustes  #/perfil  #/kit, the "+" menu, "Buscar alimento", and open a meal.
     4. Check, in the console of the page:
          document.querySelectorAll('script:not([src]), [onerror], [onclick], iframe, object, embed').length === 0
        no alert()/confirm() dialog appeared, the console shows no error and no "Content Security Policy" violation,
        and the app still draws its screens.
   To start over: localStorage.clear() and reload (the app will show the onboarding again).

   The data it writes goes through localStorage exactly like data from a hostile backup or another script on the same origin:
   meal names, item names and favourites carry the payloads, the days map and a meals map carry "__proto__" keys. */

const HOSTILE_HASHES = ['#constructor', '#__proto__', '#toString', '#hasOwnProperty', '#/constructor', '#%', '#%E0%A4%A', '#' + 'x'.repeat(5000), '#<img src=x onerror=alert(1)>', '#javascript:alert(1)'];

function seedHostileData() {
  const ch = (...codes) => String.fromCharCode(...codes);
  const PAYLOADS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '"><svg/onload=alert(1)>',
    "';alert(1);//",
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    'javascript:alert(1)',
    '<style>@import "//evil.example/x.css"</style>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '{{constructor.constructor("alert(1)")()}}',
    '${alert(1)}',
    'evil' + ch(0x202E) + 'gnp.exe',
    'zero' + ch(0x200B) + 'width' + ch(0xFEFF),
    'nul' + ch(0) + 'byte',
    'A'.repeat(100000),
    '__proto__',
    'constructor',
  ];
  const per100 = { kcal: 120, protein_g: 10, carbs_g: 10, fat_g: 4 };
  const meal = (id, text) => ({ id, name: text, slot: 'Almuerzo', time: '13:30', source: 'db', items: [{ name: text, grams: 100, per100 }, { name: 'Plain item', grams: 50, per100 }] });
  const today = new Date();
  const iso = (offset) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, 12);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  // Built as JSON text on purpose: in JSON, "__proto__" is an ordinary own key, exactly what a hostile backup would contain.
  const meals = {};
  PAYLOADS.forEach((p, i) => { meals['m' + i] = meal('m' + i, p); });
  const hostileMeals = JSON.stringify(meals).slice(0, -1) + ',"__proto__":' + JSON.stringify(meal('__proto__', 'proto')) + ',"constructor":' + JSON.stringify(meal('constructor', 'ctor')) + '}';
  const days = '{"__proto__":{"meals":{},"waterMl":1},"' + iso(0) + '":{"meals":' + hostileMeals + ',"waterMl":500,"steps":100,"__proto__":{"polluted":true}},"' + iso(1) + '":{"meals":{"a":' + JSON.stringify(meal('a', PAYLOADS[0])) + '}}}';

  localStorage.setItem('fd.profile', JSON.stringify({ sex: 'female', birthYear: today.getFullYear() - 30, heightCm: 165, weightKg: 60, activity: 'light', goal: 'lose', pace: 0.2 }));
  localStorage.setItem('fd.goals', JSON.stringify([{ from: iso(30), goals: { kcal: 1800, protein_g: 120, carbs_g: 180, fat_g: 60, waterL: 2.2, steps: 8000 } }]));
  localStorage.setItem('fd.days', days);
  localStorage.setItem('fd.saved', JSON.stringify(PAYLOADS.map((p, i) => meal('s' + i, p))));
  localStorage.setItem('fd.weights', '{"__proto__":80,"' + iso(0) + '":60.5,"' + iso(3) + '":61}');
  return { written: Object.keys(localStorage).filter((k) => k.startsWith('fd.')), payloads: PAYLOADS.length, hostileHashes: HOSTILE_HASHES.map((h) => h.slice(0, 30)) };
}
