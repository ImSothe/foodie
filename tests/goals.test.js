import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES, PACES, DEFAULT_PACE, toNum, cleanProfile, bmr, goalKcal, waterLitres, stepsTarget,
  computePlan, toGoals, pacePreview, microTargets, ageOf,
} from '../app/core/goals.js';
import { NUTRIENTS } from '../app/core/nutrition.js';

const YEAR = 2026;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const man = { sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' };
const woman = { sex: 'female', age: 28, heightCm: 165, weightKg: 60, activity: 'light', goal: 'lose', pace: 0.2 };

test('toNum: numbers and typed strings with a decimal comma, nothing else', () => {
  assert.equal(toNum(72.5), 72.5);
  assert.equal(toNum('72,5'), 72.5);
  assert.equal(toNum(' 180 '), 180);
  for (const bad of ['', 'abc', '12abc', NaN, Infinity, null, undefined, {}, [], '1,2,3']) assert.equal(toNum(bad), null, String(bad));
});

test('cleanProfile: accepts age or birth year, stores the birth year', () => {
  const a = cleanProfile(man, YEAR);
  assert.equal(a.birthYear, 1996);
  assert.equal(ageOf(a, YEAR), 30);
  assert.equal('age' in a, false);
  assert.deepEqual(cleanProfile({ ...man, age: undefined, birthYear: 1996 }, YEAR), a);
  assert.equal(a.pace, null);                                                 // maintain has no pace
  assert.equal(cleanProfile({ ...man, heightCm: '180,5', weightKg: '80,25' }, YEAR).heightCm, 180.5);
  assert.equal(cleanProfile({ ...man, heightCm: '180,5', weightKg: '80,25' }, YEAR).weightKg, 80.3);
});

test('cleanProfile: rejects absurd or missing values and never throws', () => {
  const bad = [
    null, undefined, 'x', 5, [], {},
    { ...man, sex: 'other' }, { ...man, activity: 'extreme' }, { ...man, goal: 'bulk' },
    { ...man, age: 13 }, { ...man, age: 101 }, { ...man, age: 30.5 }, { ...man, age: 'treinta' }, { ...man, age: undefined },
    { ...man, birthYear: 2020, age: undefined }, { ...man, birthYear: 1800, age: undefined },
    { ...man, heightCm: 119 }, { ...man, heightCm: 231 }, { ...man, heightCm: -170 }, { ...man, heightCm: NaN },
    { ...man, weightKg: 29.9 }, { ...man, weightKg: 301 }, { ...man, weightKg: 0 }, { ...man, weightKg: Infinity },
  ];
  for (const b of bad) assert.equal(cleanProfile(b, YEAR), null, JSON.stringify(b));
});

test('cleanProfile: the limits themselves are valid', () => {
  assert.ok(cleanProfile({ ...man, age: 14, heightCm: 120, weightKg: 30 }, YEAR));
  assert.ok(cleanProfile({ ...man, age: 100, heightCm: 230, weightKg: 300 }, YEAR));
});

test('cleanProfile: an unknown pace falls back to the default of the goal', () => {
  assert.equal(cleanProfile({ ...woman, pace: 0.5 }, YEAR).pace, DEFAULT_PACE.lose);
  assert.equal(cleanProfile({ ...woman, pace: undefined }, YEAR).pace, DEFAULT_PACE.lose);
  assert.equal(cleanProfile({ ...woman, goal: 'gain', pace: 0.2 }, YEAR).pace, DEFAULT_PACE.gain);
  assert.equal(cleanProfile({ ...woman, pace: 0.25 }, YEAR).pace, 0.25);
});

test('bmr: Mifflin-St Jeor worked examples', () => {
  near(bmr({ sex: 'male', age: 30, heightCm: 180, weightKg: 80 }), 800 + 1125 - 150 + 5);   // 1780
  near(bmr({ sex: 'female', age: 28, heightCm: 165, weightKg: 60 }), 600 + 1031.25 - 140 - 161); // 1330.25
  near(bmr({ sex: 'male', age: 40, heightCm: 170, weightKg: 70 }) - bmr({ sex: 'female', age: 40, heightCm: 170, weightKg: 70 }), 166);
});

test('goalKcal: lose, maintain and gain', () => {
  near(goalKcal(2000, 'lose', 0.2), 1600);
  near(goalKcal(2000, 'gain', 0.1), 2200);
  near(goalKcal(2000, 'maintain', null), 2000);
});

test('computePlan: man maintaining, every figure by hand', () => {
  const p = computePlan(man, YEAR);
  near(p.bmr, 1780);
  near(p.tdee, 2759);
  assert.equal(p.kcal, 2760);
  assert.equal(p.floored, false);
  assert.equal(p.protein_g, 128);                    // 1.6 g/kg
  assert.equal(p.fat_g, 72);                         // 0.9 g/kg (648 kcal is 23 % of 2760, above the 20 % minimum)
  assert.equal(p.carbs_g, 400);                      // (2760 - 512 - 648) / 4
  assert.equal(p.waterL, 3.1);                       // 80 * 0.033 + 0.5 = 3.14
  assert.equal(p.steps, 8000);
});

test('computePlan: woman losing weight at the default pace', () => {
  const p = computePlan(woman, YEAR);
  near(p.tdee, 1330.25 * 1.375);
  assert.equal(p.kcal, 1460);                        // 1829.09 * 0.8 = 1463.3
  assert.equal(p.floored, false);
  assert.equal(p.protein_g, 120);                    // 2.0 g/kg
  assert.equal(p.fat_g, 54);                         // 0.9 g/kg
  assert.equal(p.carbs_g, 124);                      // (1460 - 480 - 486) / 4 = 123.5
  assert.equal(p.waterL, 2.2);                       // 1.98 + 0.25
  assert.equal(p.steps, 10000);
});

test('computePlan: the minimum fat share of 20 % applies to light people', () => {
  const p = computePlan({ sex: 'male', age: 25, heightCm: 190, weightKg: 52, activity: 'very_active', goal: 'maintain' }, YEAR);
  // 0.9 g/kg would be 46.8 g (421 kcal) but 20 % of the calories is more
  assert.ok(p.fat_g * 9 >= 0.2 * p.kcal - 9, `${p.fat_g} g of fat for ${p.kcal} kcal`);
  assert.ok(p.fat_g > 46.8);
});

test('computePlan: safety floor by sex, flagged', () => {
  const f = computePlan({ sex: 'female', age: 40, heightCm: 155, weightKg: 50, activity: 'sedentary', goal: 'lose', pace: 0.25 }, YEAR);
  // BMR 1107.75, TDEE 1329.3, target 997: below max(1200, BMR * 1.05 = 1163)
  assert.equal(f.kcal, 1200);
  assert.equal(f.floored, true);
  const m = computePlan({ sex: 'male', age: 50, heightCm: 160, weightKg: 55, activity: 'sedentary', goal: 'lose', pace: 0.25 }, YEAR);
  assert.equal(m.kcal, 1500);
  assert.equal(m.floored, true);
});

test('computePlan: the floor is never below 105 % of the BMR', () => {
  const p = computePlan({ sex: 'male', age: 30, heightCm: 190, weightKg: 100, activity: 'sedentary', goal: 'lose', pace: 0.25 }, YEAR);
  // BMR 2042.5 -> floor 2144.6 -> 2150, well above 1500
  assert.equal(p.floored, true);
  assert.equal(p.kcal, 2150);
  assert.ok(p.kcal >= p.bmr * 1.05);
});

test('computePlan: a plan that is not floored is not flagged', () => {
  for (const goal of ['maintain', 'gain']) assert.equal(computePlan({ ...man, goal, pace: 0.1 }, YEAR).floored, false);
});

test('computePlan: kcal is a multiple of 10 and macros add up to roughly the calories', () => {
  for (const sex of ['male', 'female']) for (const goal of ['lose', 'maintain', 'gain']) for (const activity of ACTIVITIES) {
    for (const pace of PACES[goal].length ? PACES[goal] : [null]) {
      const p = computePlan({ sex, age: 35, heightCm: 172, weightKg: 75, activity, goal, pace }, YEAR);
      assert.equal(p.kcal % 10, 0);
      const fromMacros = 4 * p.protein_g + 4 * p.carbs_g + 9 * p.fat_g;
      assert.ok(Math.abs(fromMacros - p.kcal) < 15, `${sex} ${goal} ${activity}: ${fromMacros} vs ${p.kcal}`);
      assert.ok(p.carbs_g >= 0);
    }
  }
});

test('computePlan: heavy people keep carbs above zero (protein and fat shares are capped)', () => {
  const p = computePlan({ sex: 'male', age: 30, heightCm: 175, weightKg: 300, activity: 'sedentary', goal: 'lose', pace: 0.25 }, YEAR);
  assert.ok(p.protein_g * 4 <= 0.35 * p.kcal + 4);
  assert.ok(p.fat_g * 9 <= 0.35 * p.kcal + 9);
  assert.ok(p.carbs_g >= 0.3 * p.kcal / 4 - 2);
});

test('computePlan: more activity means more calories and more water', () => {
  let kcal = 0; let water = 0;
  for (const activity of ACTIVITIES) {
    const p = computePlan({ ...man, activity }, YEAR);
    assert.ok(p.kcal > kcal, `${activity} kcal`);
    assert.ok(p.waterL >= water, `${activity} water`);
    kcal = p.kcal; water = p.waterL;
  }
  assert.ok(computePlan({ ...man, activity: 'very_active' }, YEAR).waterL > computePlan({ ...man, activity: 'sedentary' }, YEAR).waterL);
});

test('computePlan: lose < maintain < gain, and a faster pace changes more', () => {
  const k = (goal, pace) => computePlan({ ...man, goal, pace }, YEAR).kcal;
  assert.ok(k('lose', 0.25) < k('lose', 0.2) && k('lose', 0.2) < k('lose', 0.1));
  assert.ok(k('lose', 0.1) < k('maintain', null) && k('maintain', null) < k('gain', 0.05));
  assert.ok(k('gain', 0.05) < k('gain', 0.1) && k('gain', 0.1) < k('gain', 0.15));
});

test('computePlan: men and women get different figures from the same measurements', () => {
  const m = computePlan({ ...man }, YEAR);
  const w = computePlan({ ...man, sex: 'female' }, YEAR);
  assert.ok(m.kcal > w.kcal);
  near(m.bmr - w.bmr, 166);
});

test('computePlan: protein per kg depends on the goal', () => {
  const protein = (goal) => computePlan({ ...man, goal, pace: DEFAULT_PACE[goal] }, YEAR).protein_g;
  assert.equal(protein('lose'), 160);
  assert.equal(protein('maintain'), 128);
  assert.equal(protein('gain'), 144);
});

test('computePlan: invalid profile gives null', () => {
  assert.equal(computePlan(null, YEAR), null);
  assert.equal(computePlan({ ...man, weightKg: 5 }, YEAR), null);
});

test('waterLitres: 33 ml per kg plus activity, clamped to 1.5-4 L and rounded to 0.1', () => {
  assert.equal(waterLitres(80, 'moderate'), 3.1);
  assert.equal(waterLitres(30, 'sedentary'), 1.5);   // 0.99 -> floor
  assert.equal(waterLitres(300, 'very_active'), 4);  // 10.9 -> ceiling
  assert.equal(waterLitres(70, 'light'), 2.6);       // 2.31 + 0.25 = 2.56
});

test('stepsTarget: by goal, less when sedentary, never below 5000', () => {
  assert.equal(stepsTarget('maintain', 'moderate'), 8000);
  assert.equal(stepsTarget('lose', 'active'), 10000);
  assert.equal(stepsTarget('gain', 'light'), 7000);
  assert.equal(stepsTarget('maintain', 'sedentary'), 6000);
  assert.equal(stepsTarget('lose', 'sedentary'), 8000);
  assert.equal(stepsTarget('gain', 'sedentary'), 5000);
});

test('toGoals keeps only the stored figures', () => {
  assert.deepEqual(Object.keys(toGoals(computePlan(man, YEAR))), ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'waterL', 'steps']);
  assert.equal(toGoals(null), null);
});

test('pacePreview: one entry per pace, calories decrease as the pace grows when losing', () => {
  const prof = { ...man };
  const lose = pacePreview(prof, 'lose', YEAR);
  assert.deepEqual(lose.map((x) => x.pace), PACES.lose);
  assert.ok(lose[0].kcal > lose[1].kcal && lose[1].kcal > lose[2].kcal);
  assert.deepEqual(pacePreview(prof, 'maintain', YEAR), []);
});

test('microTargets: complete map, sex-specific where intakes differ', () => {
  const m = microTargets('male');
  const f = microTargets('female');
  const keys = NUTRIENTS.filter((n) => n.nrv).map((n) => n.key);
  assert.deepEqual(Object.keys(m).sort(), keys.sort());
  assert.deepEqual(Object.keys(f).sort(), keys.sort());
  assert.deepEqual([m.iron_mg, f.iron_mg], [11, 16]);
  assert.deepEqual([m.magnesium_mg, f.magnesium_mg], [350, 300]);
  assert.deepEqual([m.vit_a_ug, f.vit_a_ug], [750, 650]);
  assert.deepEqual([m.vit_c_mg, f.vit_c_mg], [110, 95]);
  assert.equal(m.calcium_mg, f.calcium_mg);       // not overridden: label value
  assert.equal(m.sodium_mg, 2400);
  for (const v of [...Object.values(m), ...Object.values(f)]) assert.ok(v > 0);
});
