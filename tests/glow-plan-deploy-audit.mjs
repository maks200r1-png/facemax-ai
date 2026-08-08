import fs from "node:fs";
const w=fs.readFileSync("workers/api/src/worker.js","utf8");
const c=fs.readFileSync("web/index.html","utf8");
const y=fs.readFileSync(".github/workflows/web-deploy.yml","utf8");
function ok(v,m){ if(!v){ console.error("FAIL:",m); process.exit(1); } }
ok(w.includes('const GLOW_PLAN_SCHEMA_VERSION = 10;'),"worker glow schema v10");
ok(w.includes('glow-plan-v10-six-steps-eight-metrics'),"worker glow build marker");
ok(w.includes('glow_plan_schema_version: GLOW_PLAN_SCHEMA_VERSION'),"worker exposes glow schema");
ok(c.includes('glow_plan_schema_version: 10'),"client requests glow schema v10");
ok(c.includes('const PLAN_VER = "v10"'),"client cache bumped to v10");
ok(y.includes('d.glow_plan_schema_version===10'),"deploy verifies glow schema");
ok(y.includes('glow-plan-v10-six-steps-eight-metrics'),"deploy verifies glow build");
console.log("PASS: Glow Plan deploy/schema handshake audit");
