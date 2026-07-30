import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const workerSource = fs.readFileSync(path.join(root, 'workers/api/src/worker.js'), 'utf8');
const web = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'ios/App/App/public/index.html'), 'utf8');

assert.equal(web, ios, 'web and iOS index must be identical');
assert.match(workerSource, /order:\s*\["google-vertex\/eu"\]/);
assert.match(workerSource, /allow_fallbacks:\s*false/);
assert.match(workerSource, /data_collection:\s*"deny"/);
assert.doesNotMatch(workerSource, /allow_fallbacks:\s*true/);
assert.match(workerSource, /maxTokens:\s*4096/);
assert.match(workerSource, /contentAttempt < 2/);
assert.match(workerSource, /meals:\s*\{[\s\S]*morning:[\s\S]*midday:[\s\S]*evening:[\s\S]*snacks:/);
assert.match(web, /isCompatibleMealPlanPayload/);
assert.match(web, /tryRecoverMealPlanFromServer/);
assert.match(web, /115000/);

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64');
const workerModule = await import(moduleUrl);
const worker = workerModule.default;

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
}

const validPlan = {
  summary: 'A balanced full-day plan built around steady energy and practical whole foods.',
  meals: {
    morning: { e: '🥣', n: 'Oat berry bowl', items: 'oats, oat milk, blueberries', d: 'Supports steady morning energy without dairy.' },
    midday: { e: '🥗', n: 'Chicken quinoa salad', items: 'quinoa, greens, tomatoes', d: 'Combines lean protein, fibre and a satisfying base.' },
    evening: { e: '🐟', n: 'Salmon rice plate', items: 'brown rice, broccoli, lemon', d: 'Provides protein and omega-three fats for recovery.' },
    snacks: [
      { e: '🍎', n: 'Apple with peanut butter', items: 'apple, peanut butter', d: 'Adds fibre and a filling plant-fat snack.' }
    ]
  },
  eat: [
    { section: 'Protein basics', items: [
      { e: '🍗', n: 'Lean poultry', d: 'Easy protein for meals.' },
      { e: '🐟', n: 'Oily fish', d: 'Supports recovery and skin.' },
      { e: '🫘', n: 'Beans', d: 'Adds fibre and plant protein.' }
    ] },
    { section: 'Produce', items: [
      { e: '🫐', n: 'Berries', d: 'Useful antioxidant-rich fruit.' },
      { e: '🥦', n: 'Green vegetables', d: 'Adds fibre and micronutrients.' },
      { e: '🍊', n: 'Citrus fruit', d: 'Adds vitamin C and variety.' }
    ] }
  ],
  avoid: [
    { section: 'Limit often', items: [
      { e: '🍟', n: 'Deep-fried meals', d: 'Easy to overeat and low in fibre.' },
      { e: '🥤', n: 'Sugary drinks', d: 'Adds calories without much fullness.' },
      { e: '🍬', n: 'Large candy portions', d: 'Can crowd out balanced meals.' }
    ] },
    { section: 'Keep occasional', items: [
      { e: '🍕', n: 'Heavy takeaway pizza', d: 'Often high in salt and saturated fat.' },
      { e: '🍩', n: 'Pastries', d: 'Low satiety for their energy density.' },
      { e: '🍺', n: 'Alcohol', d: 'Can interfere with sleep and recovery.' }
    ] }
  ]
};

const kv = new MemoryKV();
await kv.put('premium:test-user', JSON.stringify({ premium_until: Date.now() + 86400000, source: 'test' }));
const env = { PREMIUM_KV: kv, OPENROUTER_API_KEY: 'test-key' };

const upstreamBodies = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
  const body = JSON.parse(String(init.body || '{}'));
  upstreamBodies.push(body);
  assert.deepEqual(body.provider.order, ['google-vertex/eu']);
  assert.equal(body.provider.allow_fallbacks, false);
  assert.equal(body.provider.data_collection, 'deny');
  assert.equal(body.model, 'google/gemini-2.5-flash-lite');
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan) } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'test-request' },
  });
};

try {
  const req = new Request('https://api.example.com/api/meal-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: 'test-user',
      profile: {
        sex: 'm', age: 25, activity: 'moderate', goal: 'maintain',
        restrictions: ['lactose_free'], dislikes: []
      },
      metrics: {},
    }),
  });
  const res = await worker.fetch(req, env);
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.equal(data.source, 'openrouter');
  assert.equal(data.plan.meals[0].slot, 'Morning');
  assert.equal(data.plan.meals[1].slot, 'Midday');
  assert.equal(data.plan.meals[2].slot, 'Evening');
  assert.equal(data.plan.meals[3].slot, 'Snack');
  assert.equal(upstreamBodies.length, 1);
  assert.ok(await kv.get('mealplan:test-user'), 'meal plan must be saved to KV');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('PASS: Meal Plan stays on Google Vertex EU and accepts a complete full-day AI response');

// A schema-valid but semantically incomplete first answer should be regenerated
// on the same Vertex EU endpoint instead of surfacing an intermittent failure.
const retryKv = new MemoryKV();
await retryKv.put('premium:retry-user', JSON.stringify({ premium_until: Date.now() + 86400000, source: 'test' }));
const retryEnv = { PREMIUM_KV: retryKv, OPENROUTER_API_KEY: 'test-key' };
let retryCalls = 0;
globalThis.fetch = async (_url, init = {}) => {
  const body = JSON.parse(String(init.body || '{}'));
  assert.deepEqual(body.provider.order, ['google-vertex/eu']);
  assert.equal(body.provider.allow_fallbacks, false);
  retryCalls++;
  const payload = retryCalls === 1
    ? { ...validPlan, meals: { ...validPlan.meals, snacks: [] } }
    : validPlan;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': `retry-${retryCalls}` },
  });
};
try {
  const req = new Request('https://api.example.com/api/meal-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: 'retry-user',
      profile: { sex: 'f', age: 29, activity: 'light', goal: 'skin_focus', restrictions: [], dislikes: [] },
      metrics: { skin: 58 },
    }),
  });
  const res = await worker.fetch(req, retryEnv);
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(retryCalls, 2, 'invalid first content should trigger one content retry');
  assert.equal(data.plan.meals.filter(x => x.slot === 'Snack').length, 1);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('PASS: incomplete Meal Plan output is retried once on the same Vertex EU endpoint');
