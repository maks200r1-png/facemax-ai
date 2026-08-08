import fs from 'node:fs';

const web = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const ios = fs.readFileSync(new URL('../ios/App/App/public/index.html', import.meta.url), 'utf8');
const checks = [];
function check(name, cond) {
  checks.push({ name, ok: !!cond });
  if (!cond) process.exitCode = 1;
}
check('web and iOS index files are identical', web === ios);
check('Glow plan cache schema bumped to v10', web.includes('const PLAN_VER = "v10"'));
check('AI sticker validator exists', web.includes('function _guHasAiSticker(value)'));
check('full Glow plan validator exists', web.includes('function _guIsValidAiPlanData(data)'));
check('stale cache purge rejects invalid plans', web.includes('const hasInvalidPlan = !_guIsValidAiPlanData(d)'));
check('memory cache is validated before reuse', web.includes('_guAiPlanCache[dailyKey]?.source === "openrouter" && _guIsValidAiPlanData'));
check('localStorage cache is validated before reuse', web.includes('entry.source === "openrouter" && _guIsValidAiPlanData(entry.data)'));
check('network response is validated before saving', web.includes('json.source === "openrouter" && _guIsValidAiPlanData(json.data)'));
check('renderer uses AI sticker field', web.includes('const emoji = String(s.e || "").trim()'));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
