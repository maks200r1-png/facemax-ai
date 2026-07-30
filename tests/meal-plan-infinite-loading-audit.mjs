import fs from 'node:fs';

const files = ['web/index.html', 'ios/App/App/public/index.html'];
for (const file of files) {
  const s = fs.readFileSync(file, 'utf8');
  const checks = [
    ['watchdog helper', s.includes('function startMealPlanLoading(maxMs)')],
    ['invalid exists recovery', s.includes('if (j.exists && !isCompatibleMealPlanPayload(j))')],
    ['cache cleared', s.includes('localStorage.removeItem(MEAL_PLAN_CACHE_KEY)')],
    ['open watchdog', s.includes('startMealPlanLoading(26000)')],
    ['generation watchdog', s.includes('startMealPlanLoading(135000)')],
    ['resume recovery', s.includes('Previous meal plan request stopped. Try again.')],
  ];
  for (const [name, ok] of checks) {
    if (!ok) throw new Error(`${file}: missing ${name}`);
  }
  console.log(`${file}: PASS`);
}
