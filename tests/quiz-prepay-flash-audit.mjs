import fs from 'node:fs';
import assert from 'node:assert/strict';

const web = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const ios = fs.readFileSync(new URL('../ios/App/App/public/index.html', import.meta.url), 'utf8');

assert.equal(web, ios, 'web and iOS bundled index must match');
assert.ok(
  web.includes('document.documentElement.classList.toggle("fm-quiz-active", QUIZ_SCREENS.has(id));'),
  'openScreen must restore quiz chrome when opening capture/prePay after native picker resume'
);
assert.ok(
  web.includes('"quizAnalyze", "loading"'),
  'loading screen must hide the app bottom nav during scan transitions'
);
assert.ok(
  /async function onbSetPhoto\(dataUrl\)\{[\s\S]{0,500}classList\.add\("fm-quiz-active"\)/.test(web),
  'photo return must restore quiz chrome before rendering'
);
assert.ok(
  /function onbProceedToScan\(\)\{[\s\S]{0,450}classList\.add\("fm-quiz-active"\)/.test(web),
  'capture-to-prePay transition must keep quiz chrome active'
);
assert.ok(
  web.includes('#prePay.screen.active{overflow:hidden!important;height:100dvh!important;animation:none!important}'),
  'prePay first paint must be opaque with no fade-through frame'
);
assert.ok(
  web.includes('const photoTarget = onbState.which;') && web.includes('onbState[photoTarget] = out;'),
  'async photo processing must stay bound to the original front/side target'
);
assert.ok(
  !web.includes('if (!QUIZ_SCREENS.has(id)) {\n    document.documentElement.classList.remove("fm-quiz-active");'),
  'old one-way quiz chrome logic must be removed'
);

console.log('PASS: quiz capture -> prePay flash audit');
