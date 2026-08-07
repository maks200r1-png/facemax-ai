import fs from 'node:fs';
import assert from 'node:assert/strict';

const web = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const ios = fs.readFileSync(new URL('../ios/App/App/public/index.html', import.meta.url), 'utf8');

assert.equal(web, ios, 'web/index.html and bundled iOS index.html must match');

assert.ok(web.includes('id="guMomentumStatus"'), 'Home momentum / streak state should remain enabled');
assert.ok(!web.includes('id="guHomeWeekRow"'), 'Home weekly strip should be removed from the classic Glow Up card');
assert.ok(!web.includes('id="guCompletionOverlay"'), 'completion overlay should not alter the classic Glow Up UI');
assert.ok(web.includes('streakTxt.textContent = "🔥 " + streakCount + " day streak"'), 'classic streak callout missing');

assert.ok(web.includes('done.length >= _guGetPlanTotal()'), 'full-plan completion gate missing');
assert.equal((web.match(/_guUpdateStreak\(\)/g) || []).length, 2, 'streak updater should only exist as definition + completion call');
assert.equal((web.match(/_guMarkWeekToday\(\)/g) || []).length, 2, 'week day should only be marked by full completion');
assert.ok(web.includes('GU_BROKEN_STREAK_KEY'), 'broken streak state missing');
assert.ok(web.includes('Your ${ctx.streak}-day streak ends tonight'), 'evening streak-risk notification missing');
assert.ok(web.includes('one completed plan starts the comeback'), 'missed-day comeback notification missing');

assert.ok(web.includes('lateAt.setHours(21, 45, 0, 0)'), 'last-chance notification time missing');
assert.ok(web.includes('ctx.atRisk && ctx.streak >= 3'), 'last-chance notification must require meaningful at-risk streak');
assert.ok(web.includes('await window.facemax.notif.cancel(window.facemax.notif.ids.STREAK)'), 'streak notification must cancel after state changes');
assert.ok(web.includes('if (eveningAt.getTime() > Date.now() + 5000)'), 'stale evening notification must not roll into tomorrow');

assert.ok(web.includes('const AI_METRIC_TIPS = Array.isArray(plan.chips) ? plan.chips : []'), 'Glow Plan metric coaching must come from AI chips');
assert.ok(web.includes('data.chips.length === 8'), 'all eight AI metric coaching cards must be rendered/validated');
assert.ok(web.includes('data.steps.length !== 6'), 'classic six-task layout must be fixed');
assert.ok(!web.includes('const METRIC_IMPROVE_TIPS = {'), 'hardcoded Glow Plan metric advice table still exists');
assert.ok(!web.includes('Keep mewing daily'), 'hardcoded mewing advice still exists in Glow Plan');

console.log('PASS: Glow streak / Duolingo-style retention mechanics audit');
