# foodie

A mobile-first PWA to track calories, macros and micronutrients without weighing your food: take a photo of the plate, scan a barcode or search a food, then fix the estimate with a slider.

**Live app:** https://imsothe.github.io/foodie/ (open it on your phone and add it to the home screen)

<p>
  <img src="docs/img/home-dark.png" alt="Home screen in dark mode: calories left, macro rings and the week strip" width="280">
  <img src="docs/img/meal-editor-light.png" alt="Ingredient editor in light mode: one slider per ingredient" width="280">
</p>

## Status

Early. The app is being built in steps, and this README only lists what exists.

| Step | What | State |
|---|---|---|
| 1 | Architecture and data model | Done |
| 2 | Repository, PWA shell, design system, GitHub Pages deploy | Done |
| 3a | Local-first app: profile and goals (deficit, maintenance, surplus), daily log, search of basic foods, favourites, water, steps typed by hand, progress, export | Done |
| 3b | Google sign-in and cloud sync | Next |
| 4 | Barcode scanner (Open Food Facts) and photo analysis with AI | Planned |

What works today, all on your device (nothing is sent anywhere, there is no account yet):

- **Onboarding:** a few questions (sex, age, height, weight, activity, goal) and an editable daily plan for calories, protein, carbohydrates, fat, water and steps, estimated with the Mifflin-St Jeor formula. These are estimates, not medical advice.
- **Log a meal by searching** about 100 common foods in Spain (portions, grams slider, several foods per meal), then fix the grams afterwards. Duplicate a meal on another day, save it as a favourite, delete it with undo.
- **Home:** calories left, macros, water, steps, vitamins and minerals against sex-specific reference values, and a week strip you can move back through.
- **Progress:** month calendar of the days you met your goal, average calories per week, weight history.
- **Settings:** edit your profile and goals (past days keep the goals they had), export your data as JSON, delete it from the device.

Not there yet: sign-in and cloud copy, and the other three options of the `+` menu (photo, barcode, nutrition label), which show a notice. Steps are typed by hand for now.

## The idea

Photo-based calorie trackers are fast, but when the AI misjudges a portion, fixing it is slow and usually costs another AI call. foodie stores every food the same way, whatever its source:

```
composition per 100 g  +  grams on the plate
```

Totals are always derived (`per100 × grams / 100`), never stored. Moving a slider only changes one number, so calories, macros and 18 vitamins, minerals and other nutrients are recalculated on the device, instantly and for free. The AI is asked once for the two things it is good at: naming the ingredients and estimating their weight.

Three ways to log, only one of them uses AI:

1. **Barcode**: exact data from the package through Open Food Facts.
2. **Search and saved meals**: a local table of basic foods and one-tap favourites.
3. **Photo**: a vision model returns each ingredient with its estimated grams, a min–max range and its composition per 100 g.

## How it is built

- **No framework and no build step.** Plain ES modules served as they are; the `app/` folder is what GitHub Pages publishes.
- **Pure core, tested in Node.** `app/core/` has no DOM code and is covered by `node --test`.
- **Strict Content Security Policy.** No inline scripts or styles, no `eval`, no third-party hosts. The UI is built with `createElement` and text nodes, never from HTML strings, so text from a product database or an AI cannot run as code.
- **Offline first.** The service worker caches the whole app as one version. `npm run stamp` writes the file list and a content hash into `app/sw.js`, and a test fails if it is out of date.
- **Light and dark themes** from one set of design tokens (`app/css/tokens.css`), following the system by default.

```
app/
  core/      nutrition, goals, data shapes, search, progress and dates (pure, tested)
  data/      local store (localStorage, validated on load) and the table of foods
  ui/        DOM helpers, ring, week strip, ingredient editor, screens
  css/       tokens, base, components
  sw.js      service worker        boot.js   theme and anti-clickjacking, before first paint
tests/       unit tests and static guards (CSP, offline shell, pinned workflows, no secrets)
tools/       dev server, service worker stamp, icon renderer
```

## Run it locally

Requires Node 22 or newer. There is nothing to install.

```bash
npm run dev     # http://localhost:8790
npm test        # unit tests and static guards
npm run stamp   # after changing anything in app/, before committing
```

The service worker is off on localhost so you always get fresh files; add `?sw=1` to the URL to test offline behaviour.

## Credits

- The interaction model (week strip, calories-left ring, macro rings, camera-first logging) follows the pattern popularised by photo calorie trackers such as Cal AI. foodie is an independent project: it shares no code, assets or branding with them.
- Display typeface: [Bricolage Grotesque](https://github.com/ateliertriay/bricolage), SIL Open Font License 1.1 (`app/fonts/OFL.txt`).
- Daily reference values for vitamins and minerals: Regulation (EU) No 1169/2011, with the EFSA dietary reference values for iron, magnesium, vitamin A and vitamin C by sex.
- Food composition values (`app/data/foods.es.json`) are rounded, approximate averages in the range of standard composition tables (USDA FoodData Central, BEDCA). They were not copied line by line from those tables, so treat them as estimates; tests only check them for internal consistency.
- Built with the help of AI coding tools.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). You can read, run and modify the code for any noncommercial purpose. Commercial use is reserved to the author.
