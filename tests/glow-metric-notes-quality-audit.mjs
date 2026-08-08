import fs from "node:fs";
const w = fs.readFileSync("workers/api/src/worker.js", "utf8");
function ok(v, m) { if (!v) { console.error("FAIL:", m); process.exit(1); } }
ok(w.includes('note: { type: "string", minLength: 120, maxLength: 320 }'), "metric note length is constrained");
ok(w.includes("METRIC-CARD QUALITY GUARDRAILS:"), "quality guardrails are present");
ok(w.includes("Potential: synthesize the 1–2 highest-impact modifiable opportunities"), "Potential must be specific");
ok(w.includes("Do not tell the user to reduce body fat because FaceMax does not measure body-fat percentage"), "no unsupported body-fat claim");
ok(w.includes("do not claim sleeping position or facial exercises will correct structural asymmetry"), "no symmetry exercise/sleep-position claim");
ok(w.includes("Do not use \"internal health\" as an explanation"), "no vague internal-health filler");
ok(w.includes('model: "google/gemini-2.5-flash-lite"'), "Gemini 2.5 Flash-Lite remains pinned");
console.log("PASS: Glow metric notes are concise, evidence-aware and safety-constrained");
