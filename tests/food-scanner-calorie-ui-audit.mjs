import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const workerPath = path.join(root, 'workers/api/src/worker.js');
const webPath = path.join(root, 'web/index.html');
const iosPath = path.join(root, 'ios/App/App/public/index.html');
const workerSource = await fs.readFile(workerPath, 'utf8');
const web = await fs.readFile(webPath, 'utf8');
const ios = await fs.readFile(iosPath, 'utf8');
const worker = (await import(pathToFileURL(workerPath).href + '?food=' + Date.now())).default;

assert.equal(web, ios, 'web and iOS index files must match');
assert.match(web, /\.fs-fe-card\.good\{/);
assert.match(web, /\.fs-fe-card\.warn\{/);
assert.match(web, /\.fs-fe-card\.bad\{/);
assert.match(web, /\.fs-ing-row\.impact-low\{/);
assert.match(web, /\.fs-ing-row\.impact-medium\{/);
assert.match(web, /\.fs-ing-row\.impact-high\{/);
assert.match(web, /fs-fe-card \$\{d\.cls\}/);
assert.match(web, /fs-ing-row impact-\$\{imp\}/);
assert.match(workerSource, /entire visible can\/bottle/);
assert.match(workerSource, /Food scan calories are inconsistent with a regular packaged drink/);
assert.match(workerSource, /order: \["google-vertex\/eu"\]/);
assert.match(workerSource, /allow_fallbacks: false/);
assert.match(workerSource, /model: "google\/gemini-2\.5-flash-lite"/);

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
}
const user = 'food_calorie_audit';
const env = { PREMIUM_KV: new FakeKV(), OPENROUTER_API_KEY: 'test-key' };
env.PREMIUM_KV.map.set(`premium:${user}`, JSON.stringify({ user_id: user, premium_until: Date.now() + 86400000 }));

const base = {
  detected: '500 ml energy drink', bloat_score: 65, bloat_label: 'High', calories_est: 10,
  sodium_level: 'medium', sugar_level: 'high', processed_level: 'high', dairy_level: 'low', alcohol_level: 'low',
  summary: 'A regular energy drink with high sugar.',
  why: 'Sugar and carbonation can contribute to bloating.',
  key_ingredients: [
    { name: 'Sugar', impact: 'high', note: 'High added sugar content.' },
    { name: 'Carbonation', impact: 'medium', note: 'May cause temporary fullness.' },
    { name: 'Caffeine', impact: 'medium', note: 'Can affect sleep when consumed late.' },
  ],
  swaps: [
    { e: '💧', name: 'Choose water', benefit: 'Avoids added sugar.' },
    { e: '🍋', name: 'Try lemon water', benefit: 'Adds flavour without sugar.' },
    { e: '🫖', name: 'Choose unsweetened tea', benefit: 'Provides a lower-sugar option.' },
  ],
  best_time: { slots: ['Morning', 'Midday'], reason: 'Earlier use is less likely to disrupt sleep.' },
  tip: 'Keep the rest of the day lower in sodium.'
};
const corrected = { ...base, detected: '500 ml regular energy drink', calories_est: 220 };
let calls = 0;
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || '{}'));
    assert.equal(body.model, 'google/gemini-2.5-flash-lite');
    assert.deepEqual(body.provider.order, ['google-vertex/eu']);
    assert.equal(body.provider.allow_fallbacks, false);
    calls += 1;
    const payload = calls === 1 ? base : corrected;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const req = new Request('https://api.test/api/food-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: user, local_date: '2026-07-24', image: 'data:image/jpeg;base64,' + 'A'.repeat(300) }),
  });
  const res = await worker.fetch(req, env, {});
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.data.calories_est, 220);
  assert.equal(calls, 2, 'inconsistent calorie output must trigger one content retry');

  // A visibly identified sugar-free energy drink can legitimately be low-calorie.
  const zeroEnv = { PREMIUM_KV: new FakeKV(), OPENROUTER_API_KEY: 'test-key' };
  zeroEnv.PREMIUM_KV.map.set(`premium:${user}`, JSON.stringify({ user_id: user, premium_until: Date.now() + 86400000 }));
  const zeroDrink = { ...base, detected: '500 ml sugar-free energy drink', calories_est: 10, sugar_level: 'low', summary: 'A sugar-free energy drink.', why: 'The visible can is marked sugar-free.' };
  let zeroCalls = 0;
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || '{}'));
    assert.deepEqual(body.provider.order, ['google-vertex/eu']);
    zeroCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(zeroDrink) } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const zeroReq = new Request('https://api.test/api/food-scan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: user, local_date: '2026-07-25', image: 'data:image/jpeg;base64,' + 'A'.repeat(300) }),
  });
  const zeroRes = await worker.fetch(zeroReq, zeroEnv, {});
  const zeroData = await zeroRes.json();
  assert.equal(zeroRes.status, 200);
  assert.equal(zeroData.data.calories_est, 10);
  assert.equal(zeroCalls, 1, 'confirmed sugar-free variant should not be rejected');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('PASS: Food Scanner semantic card colours and packaged-drink calorie validation');
