import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const worker = fs.readFileSync(path.join(root, 'workers/api/src/worker.js'), 'utf8');
const web = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'ios/App/App/public/index.html'), 'utf8');

assert.equal(web, ios, 'web and iOS index must be identical');
assert.match(worker, /order:\s*\["google-vertex\/eu"\]/);
assert.match(worker, /allow_fallbacks:\s*false/);
assert.doesNotMatch(worker, /allow_fallbacks:\s*true/);
assert.match(worker, /data_collection:\s*"deny"/);
assert.match(worker, /response_format/);
assert.match(worker, /response-healing/);
assert.match(worker, /GLOW_PLAN_RESPONSE_FORMAT/);
assert.match(worker, /MEAL_PLAN_RESPONSE_FORMAT/);
assert.match(worker, /new AbortController\(\)/);
assert.match(worker, /Retry-After/);
assert.match(worker, /contentAttempt < 2/);
assert.match(worker, /maxTokens:\s*4096/);
assert.match(web, /fetchWithTimeout/);
assert.match(web, /AI generation timed out/);
assert.match(web, /tryRecoverMealPlanFromServer/);
assert.doesNotMatch(web, /for \(let attempt = 0; attempt < 3; attempt\+\+\) \{\s*try \{\s*if \(attempt > 0\).*\/api\/glow-plan/s);
assert.doesNotMatch(worker, /Glow step emoji .* is duplicated/);

const previousRoot = path.resolve(root, '../facemax_age13_fixed');
for (const name of ['ios-build.yml', 'ios-signing-reset.yml', 'web-deploy.yml']) {
  const a = fs.readFileSync(path.join(root, '.github/workflows', name));
  const b = fs.readFileSync(path.join(previousRoot, '.github/workflows', name));
  assert.equal(crypto.createHash('sha256').update(a).digest('hex'), crypto.createHash('sha256').update(b).digest('hex'), `${name} changed`);
}

console.log('PASS: AI stability audit with Google Vertex EU-only routing');
