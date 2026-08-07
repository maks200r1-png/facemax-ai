import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const web = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const ios = fs.readFileSync(new URL('../ios/App/App/public/index.html', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../web/js/native-bridge.js', import.meta.url), 'utf8');
const iosBridge = fs.readFileSync(new URL('../ios/App/App/public/js/native-bridge.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../workers/api/src/worker.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.equal(web, ios, 'web and iOS index must match');
assert.equal(bridge, iosBridge, 'web and iOS native bridge must match');
assert.ok(pkg.dependencies['@capacitor/local-notifications'], 'local-notifications dependency missing');
assert.ok(!bridge.includes('lastOpenDate'), 'obsolete lastOpenDate gate still present');
assert.equal((bridge.match(/sound:\s*"default"/g) || []).length, 2, 'both notification schedulers must use default sound');
assert.ok(web.includes('prefs.dailyTime || "08:00"'), 'morning reminder must default to stored 08:00 preference');
assert.ok(web.includes('hour: reminderHour, minute: reminderMinute'), 'morning reminder must honor stored reminder time');
assert.ok(web.includes('eveningAt.setHours(20, 0, 0, 0)'), 'evening reminder must target 20:00');
assert.ok(web.includes('if (!ctx.completedToday)'), 'evening reminder must stop after full plan completion');
assert.ok(web.includes('const lastScanMs = Number(scanHistory[0] && scanHistory[0].date)'), 're-scan reminder must anchor to actual scan time');
assert.ok(web.includes('prefs.dailyOn = false;'), 'revoked iOS permission must turn the in-app switch off');
assert.ok(!/if \(step === 2\)[\s\S]{0,400}maybeOfferNotifications/.test(web), 'permission prompt still interrupts quiz step 2');
assert.ok(/function quizShowResult\(\)[\s\S]{0,700}maybeOfferNotifications/.test(web), 'permission prompt missing after quiz result');

assert.ok(web.includes('min="13" max="100"'), 'meal plan age input must match worker 13+ validation');
assert.ok(worker.includes('ageRaw < 13 || ageRaw > 100'), 'worker must accept ages from 13 and reject younger users');
assert.ok(web.includes('function isMealPlanEmoji(value)'), 'meal plan client emoji validator missing');
assert.ok(web.includes('isValidMealPlanSectionList(plan.eat)'), 'meal plan Eat sections not validated');
assert.ok(web.includes('isValidMealPlanSectionList(plan.avoid)'), 'meal plan Limit sections not validated');
assert.ok(web.includes('class="mr-reason"'), 'AI meal reasoning is not rendered');
assert.ok(worker.includes('requireAiEmoji(it?.e, `stored.meals['), 'stored meal stickers are not validated');
assert.ok(worker.includes('validSections(plan.eat, "eat") && validSections(plan.avoid, "avoid")'), 'stored Eat/Limit sections are not validated');
assert.ok(worker.includes('meals.snacks must contain one or two snacks') && worker.includes('snacks.length < 1 || snacks.length > 2'), 'AI snack count is not strictly validated');

function extractFunction(source, name) {
  const asyncMarker = `async function ${name}(`;
  const plainMarker = `function ${name}(`;
  const asyncStart = source.indexOf(asyncMarker);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(plainMarker);
  assert.ok(start >= 0, `function ${name} not found`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const scheduled = [];
const cancelled = [];
const now = Date.now();
const context = {
  console,
  Date,
  Number,
  Math,
  isFinite,
  scanHistory: [{ date: now - 2 * 86400000 }],
  _guCurrentTotal: 6,
  _guGetStreak: () => ({ count: 4 }),
  _guGetProgress: () => [0, 1],
  localStorage: { getItem: () => null },
  notifLoadPrefs: () => ({ dailyOn: true, dailyTime: '08:00' }),
  _fmReminderFocus: () => 'glow-up',
  window: {
    facemax: {
      notif: {
        ids: { DAILY: 1001, RESCAN_7D: 1002, STREAK: 1004, EVENING: 1006, WINBACK_3D: 1007, WINBACK_7D: 1008, WINBACK_14D: 1009 },
        isAvailable: () => true,
        cancel: async id => { cancelled.push(id); },
        scheduleDaily: async spec => { scheduled.push({ kind: 'daily', ...spec }); return true; },
        scheduleAt: async spec => { scheduled.push({ kind: 'at', ...spec }); return true; },
      },
    },
  },
};
vm.createContext(context);
for (const fn of ['_fmDaysSince', '_fmBuildNotifContext', '_fmPickMorningMessage', '_fmPickEveningMessage', 'scheduleRetentionPack']) {
  vm.runInContext(extractFunction(web, fn), context);
}
await vm.runInContext('scheduleRetentionPack()', context);
assert.ok(scheduled.some(x => x.kind === 'daily' && x.id === 1001 && x.hour === 8), 'morning reminder not scheduled');
assert.ok(scheduled.some(x => x.kind === 'at' && x.id === 1006 && x.at instanceof Date && x.at.getHours() === 20), 'conditional evening reminder not scheduled');
assert.ok(cancelled.includes(1006), 'old evening reminder not cancelled before rescheduling');
assert.ok(scheduled.some(x => x.kind === 'at' && x.id === 1002), 're-scan reminder not scheduled');

scheduled.length = 0;
cancelled.length = 0;
context._guGetProgress = () => [0, 1, 2, 3, 4, 5];
await vm.runInContext('scheduleRetentionPack()', context);
assert.ok(!scheduled.some(x => x.id === 1006), 'evening reminder must not remain when all steps are complete');
assert.ok(cancelled.includes(1006), 'completed plan must cancel pending evening reminder');

console.log('PASS: notifications and meal-plan hardening audit');
