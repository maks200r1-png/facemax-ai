import fs from 'node:fs';
import assert from 'node:assert/strict';

const index = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../workers/api/src/worker.js', import.meta.url), 'utf8');

assert.ok(index.includes('const MEAL_PLAN_SCHEMA_VERSION = 3;'));
assert.ok(worker.includes('const MEAL_PLAN_SCHEMA_VERSION = 3;'));
assert.ok(index.includes('{ slot: "Morning", title: "Morning" }'));
assert.ok(index.includes('{ slot: "Midday", title: "Midday" }'));
assert.ok(index.includes('{ slot: "Evening", title: "Evening" }'));
assert.ok(index.includes('{ slot: "Snack", title: "Snacks" }'));
assert.ok(index.includes('class="meal-section meal-time-section"'));
assert.ok(index.includes('isCompatibleMealPlanPayload(cached)'));
assert.ok(index.includes('isCompatibleMealPlanPayload(j)'));
assert.ok(worker.includes('isStoredFullDayMealPlan(saved.plan)'));
assert.ok(worker.includes('slots.filter(x => x === "Morning").length !== 1'));
assert.ok(worker.includes('slots.filter(x => x === "Midday").length !== 1'));
assert.ok(worker.includes('slots.filter(x => x === "Evening").length !== 1'));

console.log('PASS: full-day meal plan UI and cache migration audit');
