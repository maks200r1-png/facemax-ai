import worker from '../workers/api/src/worker.js';

const store = new Map();
const userId = 'test_user';
store.set('premium:' + userId, JSON.stringify({ premium_until: Date.now() + 86400000, source: 'test' }));
const env = {
  OPENROUTER_API_KEY: 'test-key',
  PREMIUM_KV: {
    async get(k){ return store.has(k) ? store.get(k) : null; },
    async put(k,v){ store.set(k,String(v)); },
    async delete(k){ store.delete(k); },
  },
};
const aiPlan = {
  summary: 'A balanced high-protein day built around practical whole foods.',
  meals: {
    morning: { e:'🍳', n:'Spinach egg toast', items:'Eggs, spinach, whole-grain toast, tomatoes', d:'Protein and fibre support steady morning energy.' },
    midday: { e:'🥗', n:'Chicken quinoa bowl', items:'Chicken, quinoa, cucumber, greens, olive oil', d:'A balanced lunch supports training and fullness.' },
    evening: { e:'🐟', n:'Salmon potato plate', items:'Salmon, potatoes, broccoli, lemon', d:'Protein and potassium support recovery without heaviness.' },
    snacks: [{ e:'🍓', n:'Yogurt berry cup', items:'Greek yogurt, berries, cinnamon', d:'A simple protein snack controls afternoon hunger.' }],
  },
  eat: [
    { section:'Protein staples', items:[
      {e:'🥚', n:'Eggs', d:'Easy protein for quick balanced meals.'},
      {e:'🍗', n:'Lean poultry', d:'Supports muscle recovery with practical portions.'},
      {e:'🫘', n:'Beans', d:'Adds fibre and affordable plant protein.'},
    ]},
    { section:'Produce focus', items:[
      {e:'🥦', n:'Green vegetables', d:'Supports fibre intake and meal volume.'},
      {e:'🫐', n:'Berries', d:'Adds fruit without excessive sweetness.'},
      {e:'🥑', n:'Avocado', d:'Provides filling fats in moderate portions.'},
    ]},
  ],
  avoid: [
    { section:'Limit often', items:[
      {e:'🍟', n:'Fried fast food', d:'Often combines excess salt and heavy fats.'},
      {e:'🥤', n:'Sugary drinks', d:'Adds calories without meaningful fullness.'},
      {e:'🍬', n:'Frequent sweets', d:'Can displace more filling whole foods.'},
    ]},
    { section:'Reduce puffiness', items:[
      {e:'🧂', n:'Very salty meals', d:'May worsen temporary water retention.'},
      {e:'🍺', n:'Alcohol', d:'Can disrupt sleep and hydration.'},
      {e:'🥓', n:'Processed meats', d:'Often contain high sodium and saturated fat.'},
    ]},
  ],
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('openrouter.ai')) {
    return new Response(JSON.stringify({ choices:[{ message:{ content: JSON.stringify(aiPlan) } }] }), { status:200, headers:{'content-type':'application/json','x-request-id':'test-request'} });
  }
  throw new Error('Unexpected fetch ' + url);
};
try {
  const req = new Request('https://worker.test/api/meal-plan', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ user_id:userId, profile:{ sex:'m', age:28, height_cm:180, weight_kg:80, activity:'moderate', goal:'gain_muscle', restrictions:[] }, metrics:{} }) });
  const res = await worker.fetch(req, env);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error('Worker failed: ' + JSON.stringify(data));
  const plan = data.plan;
  const slots = plan.meals.map(x=>x.slot);
  const oldClientAccepts = plan.meals.length >= 4 && plan.meals.length <= 5
    && slots.filter(x=>x==='Morning').length === 1
    && slots.filter(x=>x==='Midday').length === 1
    && slots.filter(x=>x==='Evening').length === 1
    && slots.filter(x=>x==='Snack').length >= 1
    && slots.filter(x=>x==='Snack').length <= 2
    && plan.eat.length === 2 && plan.avoid.length === 2;
  if (!oldClientAccepts) throw new Error('Current app rejects returned structure');
  if (data.schema_version !== 3) throw new Error('Expected schema 3');
  const allText = JSON.stringify(plan);
  if (allText.includes('...') || allText.includes('…')) throw new Error('Ellipsis remains');
  console.log('PASS: current iOS v3 client accepts the Worker response');
  console.log(JSON.stringify({ status:res.status, schema_version:data.schema_version, build:data.build, slots }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
