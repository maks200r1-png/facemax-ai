import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const workerPath = path.join(root, 'workers/api/src/worker.js');
const indexPath = path.join(root, 'web/index.html');
const workerSource = await fs.readFile(workerPath, 'utf8');
const indexSource = await fs.readFile(indexPath, 'utf8');
const worker = (await import(pathToFileURL(workerPath).href + '?audit=' + Date.now())).default;

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
  keys(prefix = '') { return [...this.map.keys()].filter(k => k.startsWith(prefix)); }
}

const USER = 'ai_audit_user';
function envWithPremium({ key = '' } = {}) {
  const kv = new FakeKV();
  kv.map.set(`premium:${USER}`, JSON.stringify({
    user_id: USER,
    premium_until: Date.now() + 7 * 86400000,
    source: 'test',
  }));
  return { PREMIUM_KV: kv, OPENROUTER_API_KEY: key };
}

function request(pathname, body) {
  return new Request('https://api.test' + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function call(env, pathname, body) {
  const res = await worker.fetch(request(pathname, body), env, {});
  const data = await res.json().catch(() => null);
  return { res, data };
}

const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(300);
const METRICS = { skin: 58, jawline: 61, eyes: 67, cheekbones: 70, symmetry: 74, harmony: 68, lips: 72, nose: 71 };
const PROFILE = { sex: 'm', age: 25, height_cm: 180, weight_kg: 78, activity: 'moderate', goal: 'maintain', restrictions: [], dislikes: [] };

const missingKeyCases = [
  ['/api/glow-plan', { user_id: USER, metrics: METRICS, overall_score: 67 }],
  ['/api/meal-plan', { user_id: USER, profile: PROFILE, metrics: METRICS }],
  ['/api/food-scan', { user_id: USER, image: IMG }],
  ['/api/full-report', { user_id: USER, image: IMG, visual_scan: true, local_date: '2026-07-23' }],
  ['/api/skin-plan', { user_id: USER, metrics: METRICS, score: 67 }],
  ['/api/jawline-plan', { user_id: USER, metrics: METRICS, score: 67 }],
  ['/api/face-check', { image: IMG }],
];
for (const [pathname, body] of missingKeyCases) {
  const env = envWithPremium();
  const { res, data } = await call(env, pathname, body);
  assert.ok(res.status >= 500, `${pathname} must fail closed without OPENROUTER_API_KEY`);
  assert.notEqual(data?.source, 'fallback', `${pathname} must never return fallback source`);
  assert.equal(env.PREMIUM_KV.keys('mealplan:').length, 0, `${pathname} must not save a meal fallback`);
  assert.equal(env.PREMIUM_KV.keys('report:').length, 0, `${pathname} must not save a report fallback`);
}

const validFullReport = {
  overall_score: 67,
  photo_check: 'Use even front lighting.',
  summary: 'Balanced face with skin and jawline as the clearest priorities.',
  fastest_upgrade: { title: 'Skin consistency', text: 'Keep a simple daily routine.' },
  scores: {
    jawline: 61, skin: 58, hair: 70, eye_area: 67, lips: 72, nose: 71,
    face_shape: 69, photo_angle: 66, symmetry: 74, cheekbones: 70,
    harmony: 68, improvement_potential: 76,
  },
  strengths: [
    { title: 'Symmetry', text: 'Good left-right balance.' },
    { title: 'Lips', text: 'Balanced proportions.' },
    { title: 'Nose', text: 'Fits the face well.' },
  ],
  weak_points: [
    { title: 'Skin', text: 'Texture needs consistency.' },
    { title: 'Jawline', text: 'Definition is moderate.' },
    { title: 'Eye area', text: 'Recovery could improve.' },
  ],
  haircut: 'Keep moderate volume on top.',
  jawline: 'Reduce temporary puffiness and improve posture.',
  skin: 'Use cleanser, moisturizer and SPF consistently.',
  photo_angle: 'Keep camera near eye level.',
  key_points: ['Skin texture | Keep a basic routine', 'Jawline softness | Improve posture', 'Eye fatigue | Prioritize sleep'],
};
const validGlow = {
  focus: 'Skin recovery and jaw definition',
  motivation: 'Skin is the lowest score, so fix consistency first.',
  steps: [
    { e: '☀️', label: 'Apply broad-spectrum SPF this morning', sub: 'Protect the weakest skin metric', area: 'skin' },
    { e: '🧴', label: 'Use a gentle evening cleanser', sub: 'Reduce irritation without over-stripping', area: 'skin' },
    { e: '🧂', label: 'Keep dinner sodium moderate tonight', sub: 'Limit temporary morning puffiness', area: 'depuff' },
    { e: '🧍', label: 'Do a two-minute posture reset', sub: 'Improve visible neck-jaw alignment', area: 'jawline' },
    { e: '📵', label: 'Take a screen break before bed', sub: 'Support tired eye-area recovery', area: 'eyes' },
    { e: '🫐', label: 'Add berries to one meal', sub: 'Simple skin-supportive nutrition step', area: 'nutrition' },
  ],
  chips: [
    { label: 'Skin', score: 58, note: 'Keep the routine gentle and consistent.' },
    { label: 'Jawline', score: 61, note: 'Prioritize posture and de-puffing.' },
    { label: 'Eyes', score: 67, note: 'Improve sleep and screen habits.' },
  ],
  food_tip: '🫐 Add berries to one meal for a simple skin-supportive choice.',
  face_tip: '👐 Use light outward-to-downward drainage strokes toward the neck.',
  skin_tip: '✨ Finish the morning routine with broad-spectrum SPF.',
};
const validMeal = {
  summary: 'Use balanced whole-food meals with varied protein and produce.',
  meals: [
    { slot: 'Morning', e: '🥣', n: 'Greek yogurt berry bowl', items: 'berries, oats, chia', d: 'Balanced and practical for maintenance.' },
    { slot: 'Midday', e: '🥗', n: 'Chicken quinoa salad', items: 'greens, quinoa, tomatoes', d: 'Provides protein and fiber.' },
    { slot: 'Evening', e: '🐟', n: 'Salmon rice plate', items: 'rice, broccoli, lemon', d: 'Varied protein with a simple base.' },
    { slot: 'Snack', e: '🍎', n: 'Apple with yogurt', items: 'apple, plain yogurt', d: 'Easy snack with protein and fruit.' },
  ],
  eat: [
    { section: 'Protein anchors', items: [
      { e: '🐟', n: 'Fish', d: 'Use as a varied protein option.' },
      { e: '🥚', n: 'Eggs', d: 'Convenient breakfast protein.' },
      { e: '🥣', n: 'Greek yogurt', d: 'Simple protein-rich snack.' },
    ] },
    { section: 'Produce and fiber', items: [
      { e: '🫐', n: 'Berries', d: 'Easy fruit option.' },
      { e: '🥦', n: 'Broccoli', d: 'Adds fiber and volume.' },
      { e: '🥬', n: 'Leafy greens', d: 'Fits lunches and dinners.' },
    ] },
  ],
  avoid: [
    { section: 'Keep occasional', items: [
      { e: '🍟', n: 'Very salty fast food', d: 'Can worsen temporary water retention.' },
      { e: '🥤', n: 'Sugary drinks', d: 'Easy calories with little satiety.' },
      { e: '🍺', n: 'Alcohol', d: 'Can disrupt sleep and recovery.' },
    ] },
    { section: 'Watch portions', items: [
      { e: '🍰', n: 'Desserts', d: 'Keep them occasional.' },
      { e: '🥓', n: 'Processed meats', d: 'Often high in sodium.' },
      { e: '🍿', n: 'Salty snacks', d: 'Easy to overeat.' },
    ] },
  ],
};
const validFood = {
  detected: 'Chicken rice bowl', bloat_score: 48, bloat_label: 'Moderate', calories_est: 620,
  sodium_level: 'medium', sugar_level: 'low', processed_level: 'low', dairy_level: 'low', alcohol_level: 'low',
  summary: 'Moderate bloating potential, mainly from sauce and portion size.',
  why: 'The sauce likely contributes most of the sodium while the core meal is minimally processed.',
  key_ingredients: [
    { name: 'Sauce', impact: 'medium', note: 'Likely the main sodium source.' },
    { name: 'Chicken', impact: 'low', note: 'Provides the meal protein.' },
    { name: 'Rice', impact: 'low', note: 'Main carbohydrate base.' },
  ],
  swaps: [
    { e: '🥣', name: 'Use sauce on the side', benefit: 'Makes sodium easier to control.' },
    { e: '🥦', name: 'Add a vegetable side', benefit: 'Adds fiber and volume.' },
    { e: '🍗', name: 'Choose grilled chicken', benefit: 'Keeps the meal less processed.' },
  ],
  best_time: { slot: 'Midday', reason: 'The moderate portion and sauce are easier to manage earlier than late at night.' },
  tip: 'Keep the rest of tonight lower in sodium if you are prone to morning puffiness.',
};
const validTool = { title: 'Skin', text: 'Your skin score is the clearest priority, while symmetry is already stronger.', steps: [
  'Use a gentle cleanser each evening.', 'Apply moisturizer after cleansing.', 'Use broad-spectrum SPF each morning.',
  'Avoid adding multiple actives at once.', 'Track irritation for two weeks.', 'Keep pillowcases clean and dry.',
] };

function openRouterResponse(payload) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (_url, options = {}) => {
    const req = JSON.parse(String(options.body || '{}'));
    const prompt = String(req?.messages?.[0]?.content?.[0]?.text || '');
    if (prompt.includes('CRITICAL FIRST CHECK') && prompt.includes('actual food or drink')) return openRouterResponse(validFood);
    if (prompt.includes('hyper-personalised Glow Up plan')) return openRouterResponse(validGlow);
    if (prompt.includes('repeatable full-day meal-plan template')) return openRouterResponse(validMeal);
    if (prompt.includes('Return has_face=true ONLY')) return openRouterResponse({ has_face: true, reason: 'Clear front-facing human face.' });
    if (prompt.includes('Create ONE personalised plan')) return openRouterResponse(validTool);
    if (prompt.includes('facial analysis assistant')) return openRouterResponse(validFullReport);
    throw new Error('Unexpected OpenRouter prompt in test');
  };

  const env = envWithPremium({ key: 'test-key' });
  const successCases = [
    ['/api/glow-plan', { user_id: USER, metrics: METRICS, overall_score: 67, profile: { goal: 'skin', concerns: ['acne'], commitment_minutes: '10' } }],
    ['/api/meal-plan', { user_id: USER, profile: PROFILE, metrics: METRICS }],
    ['/api/food-scan', { user_id: USER, image: IMG }],
    ['/api/full-report', { user_id: USER, image: IMG, gender: 'male', visual_scan: true, local_date: '2026-07-24' }],
    ['/api/skin-plan', { user_id: USER, metrics: METRICS, score: 67 }],
    ['/api/face-check', { image: IMG }],
  ];
  for (const [pathname, body] of successCases) {
    const { res, data } = await call(env, pathname, body);
    assert.equal(res.status, 200, `${pathname} should accept valid AI output`);
    assert.equal(data?.source, 'openrouter', `${pathname} must identify real AI output`);
    assert.equal(data?.ok, true, `${pathname} should return ok=true`);
    if (pathname === '/api/meal-plan') assert.equal(data?.schema_version, 3);
  }
  const savedMeal = JSON.parse(await env.PREMIUM_KV.get(`mealplan:${USER}`));
  assert.equal(savedMeal.source, 'openrouter');
  assert.equal(savedMeal.schema_version, 3);
  assert.deepEqual(savedMeal.plan.meals.map(x => x.slot), ['Morning', 'Midday', 'Evening', 'Snack']);
  assert.ok(savedMeal.plan.meals.every(x => x.e), 'every meal must keep its AI-selected sticker');
  assert.equal(savedMeal.plan.meals[0].n, 'Greek yogurt berry bowl');
  const savedReport = JSON.parse(await env.PREMIUM_KV.get(`report:${USER}`));
  assert.equal(savedReport.source, 'openrouter');

  // A vegan plan is allowed to NAME animal products in its avoid section, but
  // must be rejected if it recommends one in meals/eat.
  const veganSafe = structuredClone(validMeal);
  veganSafe.meals = [
    { slot: 'Morning', e: '🥣', n: 'Oat berry bowl', items: 'oats, berries, chia', d: 'Plant-based breakfast.' },
    { slot: 'Midday', e: '🥗', n: 'Lentil quinoa salad', items: 'lentils, quinoa, greens', d: 'Plant protein and fiber.' },
    { slot: 'Evening', e: '🍛', n: 'Tofu rice bowl', items: 'tofu, rice, broccoli', d: 'Balanced plant-based dinner.' },
    { slot: 'Snack', e: '🍎', n: 'Apple and hummus', items: 'apple, hummus', d: 'Simple plant-based snack.' },
  ];
  veganSafe.eat = [
    { section: 'Plant protein', items: [
      { e: '🫘', n: 'Lentils', d: 'Plant protein and fiber.' }, { e: '🌱', n: 'Tofu', d: 'Versatile plant protein.' }, { e: '🫛', n: 'Peas', d: 'Adds protein and fiber.' },
    ] },
    { section: 'Produce', items: [
      { e: '🫐', n: 'Berries', d: 'Easy fruit.' }, { e: '🥦', n: 'Broccoli', d: 'Adds fiber.' }, { e: '🥬', n: 'Greens', d: 'Easy meal base.' },
    ] },
  ];
  veganSafe.avoid[0].items[0] = { e: '🍗', n: 'Chicken', d: 'Not compatible with a vegan plan.' };

  globalThis.fetch = async () => openRouterResponse(veganSafe);
  const veganEnv = envWithPremium({ key: 'test-key' });
  let result = await call(veganEnv, '/api/meal-plan', { user_id: USER, profile: { ...PROFILE, restrictions: ['vegan'] }, metrics: METRICS });
  assert.equal(result.res.status, 200, 'safe vegan plan should not be rejected merely because avoid section names chicken');

  const veganBad = structuredClone(veganSafe);
  veganBad.meals[1].n = 'Chicken quinoa salad';
  globalThis.fetch = async () => openRouterResponse(veganBad);
  const badEnv = envWithPremium({ key: 'test-key' });
  result = await call(badEnv, '/api/meal-plan', { user_id: USER, profile: { ...PROFILE, restrictions: ['vegan'] }, metrics: METRICS });
  assert.equal(result.res.status, 502, 'vegan-conflicting recommendation must be rejected');
  assert.equal(await badEnv.PREMIUM_KV.get(`mealplan:${USER}`), null, 'conflicting plan must never be saved');

  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const invalidEnv = envWithPremium({ key: 'test-key' });
  for (const [pathname, body] of [
    ['/api/glow-plan', { user_id: USER, metrics: METRICS, overall_score: 67 }],
    ['/api/meal-plan', { user_id: USER, profile: PROFILE, metrics: METRICS }],
    ['/api/food-scan', { user_id: USER, image: IMG }],
  ]) {
    const { res, data } = await call(invalidEnv, pathname, body);
    assert.ok(res.status >= 500, `${pathname} must reject invalid model output`);
    assert.notEqual(data?.source, 'fallback');
  }
  assert.equal(await invalidEnv.PREMIUM_KV.get(`mealplan:${USER}`), null, 'invalid AI response must not create cached plan');
} finally {
  globalThis.fetch = originalFetch;
}

const forbiddenWorkerPatterns = [
  /source\s*:\s*["']fallback["']/,
  /fallbackReport/,
  /fallbackFoodScan/,
  /generic safe response if/i,
];
for (const re of forbiddenWorkerPatterns) assert.ok(!re.test(workerSource), `Worker still contains forbidden AI fallback: ${re}`);
for (const token of ['GLOWUP_CASES', 'SKIN_ROUTINE', 'JAWLINE_EXERCISES', 'HAIRCUTS_BY_SHAPE', 'FALLBACK_BENEFITS']) {
  assert.ok(!indexSource.includes(token), `Client still contains legacy generated-content constant ${token}`);
}
assert.ok(indexSource.includes('json.source === "openrouter"'), 'Glow plan cache must require OpenRouter source');
assert.ok(indexSource.includes('isCompatibleMealPlanPayload(j)'), 'Meal plan must require OpenRouter source and a valid plan payload');
assert.ok(indexSource.includes('data.source !== "openrouter"'), 'AI screens must reject non-OpenRouter results');
assert.ok(workerSource.includes('requireAiEmoji(st?.e'), 'Glow Up steps must require AI-selected stickers');
assert.ok(!indexSource.includes('function guStepEmoji('), 'Client must not infer Glow Up stickers from hardcoded keywords');
assert.ok(!indexSource.includes('const swapEmojis = ['), 'Food swap stickers must come from AI');
assert.ok(!workerSource.includes('it?.e || "🍽️"'), 'Meal-plan worker must not invent fallback food stickers');
assert.ok(indexSource.includes('const MEAL_PLAN_SCHEMA_VERSION = 3'), 'Meal-plan cache must invalidate old non-strict plans');

console.log('AI-only audit passed');
console.log('- AI endpoints fail closed when the key/model is unavailable');
console.log('- valid results are accepted only with source=openrouter');
console.log('- invalid JSON is rejected and never cached');
console.log('- meal restrictions are validated before saving');
console.log('- legacy static plan/advice constants are absent');
