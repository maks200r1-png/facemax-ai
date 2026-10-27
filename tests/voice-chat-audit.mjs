// Audit for the voice rewrite (POST /api/voice-chat and the legacy /api/voice-consult).
// Runs the real worker module against a mocked OpenRouter + KV, no network.
//
//   node tests/voice-chat-audit.mjs

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const worker = (await import(resolve(here, "../workers/api/src/worker.js"))).default;

const calls = [];
let chatReply = "Your jawline is solid at eighty eight. Cut late salt tonight and your face will look sharper tomorrow.";
let ttsMode = "ok"; // ok | fail-voice | fail-model | fail-auth
let sttText = "How do I debloat my face before tomorrow?";
let chatMode = "ok"; // ok | busy | timeout

const mp3 = new Uint8Array(2000).fill(7);
const pcm = new Uint8Array(4800).fill(3); // 0.1 s of 24 kHz 16-bit mono

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, body });
  if (u.endsWith("/audio/transcriptions")) {
    return new Response(JSON.stringify({ text: sttText }), { status: 200 });
  }
  if (u.endsWith("/chat/completions")) {
    if (chatMode === "busy") return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    if (chatMode === "timeout") return new Response(JSON.stringify({ error: { message: "timeout" } }), { status: 408 });
    return new Response(JSON.stringify({ choices: [{ message: { content: chatReply } }] }), { status: 200 });
  }
  if (u.endsWith("/audio/speech")) {
    if (ttsMode === "fail-auth") return new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 });
    // Mirrors the live catalog: OpenAI TTS is not served by OpenRouter.
    if (body.model.startsWith("openai/")) return new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 });
    if (ttsMode === "fail-model" && body.model === "google/gemini-3.8-flash-lite-tts") {
      return new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 });
    }
    if (ttsMode === "fail-voice" && body.voice === "Charon") {
      return new Response(JSON.stringify({ error: { message: "unknown voice" } }), { status: 400 });
    }
    // Gemini TTS only returns raw PCM.
    if (body.response_format !== "pcm") return new Response(JSON.stringify({ error: { message: "pcm only" } }), { status: 400 });
    return new Response(pcm, { status: 200, headers: { "Content-Type": "audio/pcm" } });
  }
  throw new Error("unexpected fetch " + u);
};

const kv = new Map();
const env = {
  OPENROUTER_API_KEY: "test-key",
  PREMIUM_KV: {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, v); },
  },
};
const setPremium = (id, on) => kv.set("premium:" + id, JSON.stringify({ premium_until: on ? Date.now() + 86400000 : 1 }));

async function post(path, body, headers = {}) {
  const req = new Request("https://x.test" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

const fakeAudio = Buffer.alloc(3000, 1).toString("base64");
let passed = 0;
const ok = (name) => { passed++; console.log("  ok -", name); };

// 1. premium required
{
  const r = await post("/api/voice-chat", { user_id: "u1", text: "hi", lang: "en" });
  assert.equal(r.status, 402);
  assert.equal(r.data.error, "premium_required");
  ok("non-premium user gets 402");
}

setPremium("u1", true);

// 2. missing user id
{
  const r = await post("/api/voice-chat", { text: "hi" });
  assert.equal(r.status, 400);
  ok("missing user_id rejected");
}

// 3. free mode with audio: STT -> LLM -> TTS, language hint, mp4 mapped to m4a
{
  calls.length = 0;
  const r = await post("/api/voice-chat", {
    user_id: "u1", lang: "ru", audio_base64: fakeAudio, audio_format: "audio/mp4;codecs=mp4a.40.2",
    context: { score: 84, metrics: { jawline: 88, skin: 70 } }, history: [{ role: "user", text: "hello" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.transcript, sttText);
  assert.ok(r.data.answer.length > 10);
  assert.ok(r.data.audio_base64 && r.data.audio_base64.length > 100);
  assert.equal(r.data.audio_format, "wav");
  assert.equal(r.data.tts_ok, true);
  const wav = Buffer.from(r.data.audio_base64, "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24000, "24 kHz");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data chunk = all PCM bytes");
  assert.equal(wav.length, 44 + pcm.length);
  const stt = calls.find(c => c.url.endsWith("/audio/transcriptions"));
  assert.equal(stt.body.input_audio.format, "m4a");
  assert.equal(stt.body.language, "ru");
  const chat = calls.find(c => c.url.endsWith("/chat/completions"));
  const prompt = chat.body.messages[0].content[0].text;
  assert.match(prompt, /Reply language: Russian/);
  assert.match(prompt, /jawline: 88\/100/);
  assert.match(prompt, /User said: How do I debloat/);
  const tts = calls.find(c => c.url.endsWith("/audio/speech"));
  assert.equal(tts.body.model, "google/gemini-3.8-flash-lite-tts");
  assert.equal(tts.body.response_format, "pcm");
  assert.equal(tts.body.voice, "Charon");
  assert.match(tts.body.instructions, /по-русски/);
  assert.equal(chat.body.model, "google/gemini-2.5-flash-lite");
  ok("free mode: audio -> transcript -> answer -> Gemini TTS PCM wrapped as playable WAV");
}

// 3b. voice follows the app's Male/Female setting; VOICE_LLM_MODEL swaps the brain only for voice
{
  calls.length = 0;
  env.VOICE_LLM_MODEL = "anthropic/claude-haiku-5.5";
  const r = await post("/api/voice-chat", { user_id: "u1", lang: "en", text: "skin tips?", voice_gender: "female" });
  delete env.VOICE_LLM_MODEL;
  assert.equal(r.data.tts_ok, true);
  assert.equal(calls.find(c => c.url.endsWith("/audio/speech")).body.voice, "Kore");
  const chat = calls.find(c => c.url.endsWith("/chat/completions")).body;
  assert.equal(chat.model, "anthropic/claude-haiku-5.5");
  assert.ok(!chat.provider.order, "no Google provider order for a non-Google model");
  assert.equal(chat.provider.data_collection, "deny");
  ok("female voice -> Kore; VOICE_LLM_MODEL override keeps data_collection deny");
}

// 4. transcribe_only does not call the LLM or TTS and does not use quota
{
  calls.length = 0;
  const r = await post("/api/voice-chat", { user_id: "u1", lang: "en", audio_base64: fakeAudio, audio_format: "audio/webm", transcribe_only: true });
  assert.equal(r.data.transcript, sttText);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/audio/transcriptions"));
  ok("transcribe_only calls STT only");
}

// 5. silence / empty audio
{
  sttText = "";
  const r = await post("/api/voice-chat", { user_id: "u1", lang: "en", audio_base64: fakeAudio, audio_format: "audio/mp4" });
  assert.equal(r.data.empty, true);
  sttText = "How do I debloat my face before tomorrow?";
  const tiny = await post("/api/voice-chat", { user_id: "u1", lang: "en", audio_base64: "AAAA", audio_format: "audio/mp4" });
  assert.equal(tiny.data.empty, true);
  ok("empty transcript and tiny audio return empty:true without answering");
}

// 6. function buttons, navigation tag is stripped from speech and returned as action
{
  calls.length = 0;
  chatReply = "You did one of four exercises so far. Next up is Masseter and Jaw Release, want to start it? [[go:exercises]]";
  const r = await post("/api/voice-chat", {
    user_id: "u1", lang: "en", function: "today",
    context: { today: { exercises_done: 1, exercises_total: 4, next_exercise: "Masseter and Jaw Release", water_glasses: 3, water_goal: 8 } },
  });
  assert.equal(r.data.action, "exercises");
  assert.ok(!r.data.answer.includes("[["));
  const tts = calls.find(c => c.url.endsWith("/audio/speech"));
  assert.ok(!tts.body.input.includes("[["));
  const prompt = calls.find(c => c.url.endsWith("/chat/completions")).body.messages[0].content[0].text;
  assert.match(prompt, /exercises done 1 of 4/);
  assert.match(prompt, /water 3 of 8 glasses/);
  ok("function: today uses day data, tag stripped, action returned");
}

// 7. exercise coaching gets the exercise steps
{
  calls.length = 0;
  chatReply = "Let's do Cheekbone Lift. Place your palms by your nose and glide up toward the temples. Timer starts now, thirty seconds.";
  const r = await post("/api/voice-chat", {
    user_id: "u1", lang: "en", function: "exercise",
    exercise: { id: "cheek_lift", name: "Cheekbone Depuff & Lift", area: "CHEEKBONES", seconds: 30, desc: "Upward glides.", steps: ["Place palms flat along cheeks.", "Glide upward."] },
  });
  assert.equal(r.data.ok, true);
  const prompt = calls.find(c => c.url.endsWith("/chat/completions")).body.messages[0].content[0].text;
  assert.match(prompt, /Cheekbone Depuff/);
  assert.match(prompt, /timer starts now for 30 seconds/);
  ok("function: exercise passes exercise name, steps and duration");
}

// 8. voice fallback: bad voice -> next voice; missing model -> next model; payment error -> text only
{
  ttsMode = "fail-voice";
  calls.length = 0;
  let r = await post("/api/voice-chat", { user_id: "u1", lang: "en", text: "tips for skin?" });
  assert.equal(r.data.tts_ok, true);
  const voices = calls.filter(c => c.url.endsWith("/audio/speech")).map(c => c.body.voice);
  assert.deepEqual(voices, ["Charon", "Orus"]);

  ttsMode = "fail-model";
  calls.length = 0;
  r = await post("/api/voice-chat", { user_id: "u1", lang: "en", text: "tips for skin?" });
  assert.equal(r.data.tts_ok, true);
  const models = calls.filter(c => c.url.endsWith("/audio/speech")).map(c => c.body.model);
  assert.deepEqual(models, ["google/gemini-3.8-flash-lite-tts", "google/gemini-3.8-flash-tts"], "404 skips the other voices of that model");

  ttsMode = "fail-auth";
  r = await post("/api/voice-chat", { user_id: "u1", lang: "en", text: "tips for skin?" });
  assert.equal(r.status, 200);
  assert.equal(r.data.tts_ok, false);
  assert.equal(r.data.audio_base64, null);
  assert.ok(r.data.answer.length > 10);
  ttsMode = "ok";
  ok("TTS: bad voice -> next voice, missing model -> next model, payment failure -> text answer");
}

// 9. daily limit
{
  kv.clear();
  setPremium("u2", true);
  let last;
  for (let i = 0; i < 41; i++) last = await post("/api/voice-chat", { user_id: "u2", lang: "en", text: "hi there" });
  assert.equal(last.status, 429);
  assert.equal(last.data.error, "daily_limit");
  ok("41st voice turn in a day is rejected with 429");
}

// 10. streaming: one request does STT -> answer -> parallel sentence audio, NDJSON in order
async function postStream(body) {
  const req = new Request("https://x.test/api/voice-chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  const type = res.headers.get("Content-Type") || "";
  return { status: res.status, type, events: type.includes("ndjson") ? text.trim().split("\n").map(l => JSON.parse(l)) : [JSON.parse(text)] };
}
{
  kv.clear();
  setPremium("u3", true);
  calls.length = 0;
  chatReply = "Good morning. You are on a five day streak and your score went from seventy eight to eighty four. Today the focus is skin, so drink two glasses of water before your first coffee. After breakfast do the cheek depuff for thirty seconds, slow and gentle. Skip salty snacks after seven so you wake up less puffy. Finish the plan tonight to keep the streak alive. [[go:daily]]";
  const r = await postStream({ user_id: "u3", lang: "en", stream: true, audio_base64: fakeAudio, audio_format: "audio/mp4" });
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/x-ndjson/);
  const types = r.events.map(e => e.type);
  assert.equal(types[0], "transcript");
  assert.equal(r.events[0].text, sttText);
  assert.equal(types[1], "answer");
  assert.equal(r.events[1].action, "daily");
  assert.ok(!r.events[1].answer.includes("[["));
  const audio = r.events.filter(e => e.type === "audio");
  assert.equal(audio.length, 3);
  assert.deepEqual(audio.map(e => e.index), [0, 1, 2]);
  assert.ok(audio.every(e => e.count === 3 && e.audio_format === "wav" && e.audio_base64.length > 100));
  assert.equal(types[types.length - 1], "done");
  assert.equal(r.events[types.length - 1].tts_ok, true);
  const inputs = calls.filter(c => c.url.endsWith("/audio/speech")).map(c => c.body.input);
  assert.equal(inputs.length, 3);
  assert.ok(inputs[0].length < inputs.join(" ").length / 2, "first segment is the short one");
  assert.equal(inputs.join(" "), r.events[1].answer, "segments cover the whole answer, nothing lost");
  assert.equal(calls.filter(c => c.url.endsWith("/audio/transcriptions")).length, 1);
  ok("stream: one request, transcript -> answer -> 3 ordered audio segments -> done");
}

// 11. streaming: TTS failure still delivers the answer text; silence never opens a stream or uses quota
{
  kv.clear();
  setPremium("u3", true);
  ttsMode = "fail-auth";
  let r = await postStream({ user_id: "u3", lang: "en", stream: true, text: "tips for skin?" });
  const done = r.events.find(e => e.type === "done");
  assert.ok(r.events.find(e => e.type === "answer").answer.length > 10);
  assert.equal(r.events.filter(e => e.type === "audio").length, 0);
  assert.equal(done.tts_ok, false);
  ttsMode = "ok";
  sttText = "";
  r = await postStream({ user_id: "u3", lang: "en", stream: true, audio_base64: fakeAudio, audio_format: "audio/mp4" });
  assert.equal(r.events[0].empty, true);
  sttText = "How do I debloat my face before tomorrow?";
  const usageKey = [...kv.keys()].find(k => k.includes("voice") && k.includes("u3"));
  assert.ok(usageKey, "usage key written");
  assert.equal(kv.get(usageKey), "1", "only the answered turn counted, silence is free");
  ok("stream: TTS failure keeps the text, silence returns empty:true as plain JSON");
}

// 12. daily brief uses real progress data and never invents numbers
{
  calls.length = 0;
  chatReply = "Good evening. Five days in a row, nice. Finish the last two tasks tonight to keep it. [[go:daily]]";
  const r = await post("/api/voice-chat", {
    user_id: "u3", lang: "ru", function: "brief",
    context: { score: 84, metrics: { skin: 70 }, progress: { streak: 5, plan_done: 4, plan_total: 6, streak_at_risk: true, scans: 3, first_score: 78, last_score: 84, days_since_scan: 8, local_hour: 20 } },
  });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.action, "daily");
  const prompt = calls.find(c => c.url.endsWith("/chat/completions")).body.messages[0].content[0].text;
  assert.match(prompt, /Daily brief/);
  assert.match(prompt, /never invent numbers/);
  assert.match(prompt, /streak 5 days/);
  assert.match(prompt, /daily plan 4 of 6 done/);
  assert.match(prompt, /streak ends tonight/);
  assert.match(prompt, /score went from 78 to 84/);
  assert.match(prompt, /last scan 8 days ago/);
  assert.match(prompt, /local time 20:00/);
  assert.match(prompt, /Reply language: Russian/);
  ok("function: brief gets streak, plan, score trend, re-scan and time of day");
}

// 13. short answers stay one segment; segments never split a single long sentence
{
  kv.clear();
  setPremium("u4", true);
  calls.length = 0;
  chatReply = "Drink two glasses of water now and skip salty snacks tonight.";
  const r = await postStream({ user_id: "u4", lang: "en", stream: true, text: "quick tip?" });
  assert.equal(r.events.filter(e => e.type === "audio").length, 1);
  assert.equal(calls.filter(c => c.url.endsWith("/audio/speech")).length, 1);
  ok("stream: one-sentence answer is voiced in a single request");
}

// 14. legacy route: still returns answer + audio, limited per IP, no user id needed
{
  kv.clear();
  const r = await post("/api/voice-consult", { topic: "jawline", lang: "en", score: 84, metrics: { jawline: 88 } }, { "CF-Connecting-IP": "1.2.3.4" });
  assert.equal(r.data.ok, true);
  assert.ok(r.data.audio_base64);
  assert.equal(r.data.format, "wav");
  let last;
  for (let i = 0; i < 12; i++) last = await post("/api/voice-consult", { topic: "skin" }, { "CF-Connecting-IP": "1.2.3.4" });
  assert.equal(last.status, 429);
  ok("legacy /api/voice-consult returns real audio and is IP limited");
}

// 15. looksmaxxing chips: every new intent is accepted and gets its own task
{
  kv.clear();
  setPremium("u5", true);
  chatReply = "Your jawline sits at sixty two, body fat is the first lever. [[go:exercises]]";
  const ctx = {
    score: 71, gender: "male", face_shape: "oval",
    metrics: { jawline: 62, cheekbones: 68, eye_area: 74, skin: 58, face_shape: 70, symmetry: 80, hair: 66 },
  };
  const expect = {
    fixfirst: /Fix first/, jawline: /mewing honestly/, debloat: /lymphatic drainage/,
    eyes: /canthal tilt and orbital bone are hardmaxxing/, skin: /retinoid/, hair: /face shape/,
  };
  for (const [fn, re] of Object.entries(expect)) {
    calls.length = 0;
    const r = await post("/api/voice-chat", { user_id: "u5", lang: "en", function: fn, context: ctx });
    assert.equal(r.status, 200, fn);
    assert.equal(r.data.ok, true, fn);
    const prompt = calls.find(c => c.url.endsWith("/chat/completions")).body.messages[0].content[0].text;
    assert.match(prompt, new RegExp("Task: .*" + re.source), fn + " task text");
    assert.match(prompt, /Overall face score: 71\/100/, fn);
    assert.match(prompt, /Gender: male/, fn);
    assert.match(prompt, /Face shape: oval/, fn);
    assert.match(prompt, /Key scan metrics: jawline 62\/100, cheekbones 68\/100, eyes 74\/100, skin 58\/100, face shape 70\/100/, fn);
  }
  // Old chips from earlier app builds still work.
  for (const fn of ["brief", "priority", "today", "meal", "exercise"]) {
    calls.length = 0;
    await post("/api/voice-chat", { user_id: "u5", lang: "en", function: fn, context: ctx });
    const prompt = calls.find(c => c.url.endsWith("/chat/completions")).body.messages[0].content[0].text;
    assert.match(prompt, /Task: /, fn + " still a function");
  }
  // Unknown function falls back to free mode instead of an empty task.
  const bad = await post("/api/voice-chat", { user_id: "u5", lang: "en", function: "bonesmash" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "nothing_to_answer");
  ok("6 looksmaxxing intents + 5 legacy intents, full scan metrics in context");
}

// 16. persona: looksmaxxing expert, honest mewing, hard bans, no blanket mewing ban
{
  calls.length = 0;
  await post("/api/voice-chat", { user_id: "u5", lang: "en", text: "should I try bonesmashing?" });
  const prompt = calls.find(c => c.url.endsWith("/chat/completions")).body.messages[0].content[0].text;
  assert.match(prompt, /looksmaxxing expert/);
  assert.match(prompt, /Softmaxxing is what the user can change: body fat, water retention and bloating, lymphatic drainage, neck and tongue posture, skin, haircut/);
  assert.match(prompt, /Hardmaxxing is bone/);
  assert.match(prompt, /Mewing means resting the whole tongue on the palate/);
  assert.match(prompt, /does not visibly reshape adult bone/);
  for (const banned of ["bonesmashing", "steroids", "DNP", "starvation", "extreme fasting"]) {
    assert.match(prompt, new RegExp("Hard bans:.*" + banned), banned + " is banned");
  }
  assert.doesNotMatch(prompt, /Never recommend mewing/);
  assert.doesNotMatch(prompt, /face-improvement app/);
  const src = readFileSync(resolve(here, "../workers/api/src/worker.js"), "utf8");
  const jawPlan = src.match(/"jawline-plan": `([^`]*)`/)[1];
  assert.doesNotMatch(jawPlan, /Never recommend mewing/);
  assert.match(jawPlan, /bonesmashing/);
  ok("persona: softmaxx/hardmaxx split, honest mewing, bonesmashing/PEDs/DNP/starvation banned");
}

// 17. AI failures carry a specific error code, as JSON and as a stream event
{
  chatMode = "busy";
  let r = await post("/api/voice-chat", { user_id: "u5", lang: "en", text: "hi" });
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "ai_busy");
  const s = await postStream({ user_id: "u5", lang: "en", stream: true, function: "jawline" });
  const err = s.events.find(e => e.type === "error");
  assert.ok(err, "stream sends an error event");
  assert.equal(err.error, "ai_busy");
  assert.match(err.reason, /rate limited/);
  assert.ok(!s.events.some(e => e.type === "answer"));
  chatMode = "timeout";
  r = await post("/api/voice-chat", { user_id: "u5", lang: "en", text: "hi" });
  assert.equal(r.data.error, "ai_timeout");
  chatMode = "ok";
  ok("LLM rate limit -> ai_busy, timeout -> ai_timeout, stream {type:error, reason}");
}

// 18. client: six looksmaxxing chips, error event handled, text never wiped, clear messages
{
  const web = readFileSync(resolve(here, "../web/index.html"), "utf8");
  const ios = readFileSync(resolve(here, "../ios/App/App/public/index.html"), "utf8");
  assert.ok(web === ios, "web/index.html and ios/App/App/public/index.html are identical");
  const chips = web.slice(web.indexOf('<div class="mv-chips" id="mvChips">'));
  const fns = [...chips.slice(0, chips.indexOf("</div>")).matchAll(/data-fn="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(fns, ["fixfirst", "jawline", "debloat", "eyes", "skin", "hair"]);
  assert.match(chips, /class="mv-chip mv-chip-primary" data-fn="fixfirst"/, "Fix first is the highlighted chip");
  const mvTxt = web.slice(web.indexOf("const MV_TXT = {"), web.indexOf("const mvLang = "));
  for (const k of ["fixfirst", "jawline", "debloat", "eyes", "skin", "hair"]) {
    assert.equal((mvTxt.match(new RegExp("\\n\\s+" + k + ': "', "g")) || []).length, 1, k + " label, English only");
  }
  // The app ships for the US / global market: no Russian UI, no language switch.
  assert.ok(!/[\u0400-\u04FF]/.test(web), "no Cyrillic text anywhere in the client");
  assert.ok(!/setMoglyLanguage\('ru'\)|moglyLangBtnRu/.test(web), "no language picker");
  assert.match(web, /const mvLang = \(\) => "en";/);
  assert.ok(!web.includes("Something went wrong. Please try again."), "no single generic error");
  assert.match(web, /ev\.type === "error"/, "stream error event handled");
  assert.match(web, /streamErr \? streamErr\.error/, "error reason drives the message");
  for (const k of ["errOffline", "errNetwork", "errTimeout", "errBusy", "errServer", "errStt", "errTooLong", "cutOff"]) {
    assert.equal((mvTxt.match(new RegExp(k + ': "', "g")) || []).length, 1, k + " in English");
  }
  assert.match(web, /case "ai_busy": return mvT\("errBusy"\)/);
  assert.match(web, /if \(!answer\) \{ local\(e && e\.mvKind\); return; \}/, "network drop before the answer -> device answers");
  assert.match(web, /The full answer text stays on screen whatever happens to the audio/);
  assert.match(web, /mvNote\(cut \? mvT\("cutOff"\) : mvT\("noVoice"\)\)/, "TTS failure / cut keeps text and only notes the status");
  assert.match(web, /ctx\.face_shape = shape\.trim\(\)/);
  assert.match(web, /ctx\.gender = /);
  ok("client: 6 chips (Fix first primary), error events, kept text on drop, specific messages, web == ios");
}

// 19. offline-first: a dead /api/voice-chat (404 in prod while the worker deploy is broken),
//     5xx, timeout or offline never shows an error; the device answers and speaks.
{
  const web = readFileSync(resolve(here, "../web/index.html"), "utf8");
  // Failure routing
  assert.match(web, /\/\/ 404 \(worker not deployed\), 5xx, daily_limit, bad JSON: the device answers\.\n\s+if \(!r\.data \|\| !r\.data\.ok\) \{\n\s+return \{ local:/);
  assert.match(web, /if \(fail\.local\) \{ local\(fail\.local\); return; \}/);
  assert.match(web, /if \(!answer\) \{ local\(streamErr \? streamErr\.error/);
  assert.match(web, /if \(myTurn === mvTurn\) mvLocalTurn\(fn, myTurn, "", extra\);/, "chip exception -> device answer");
  assert.match(web, /timer = setTimeout\(\(\) => \{ timedOut = true; controller\.abort\(\); \}, 15000\);/, "dead server gives up in 15 s");
  // Server answer without audio is read by the device voice
  assert.match(web, /if \(mvSpeakLocal\(answer, myTurn, onEnd\)\) return;/);
  assert.match(web, /new SpeechSynthesisUtterance\(parts\[i\+\+\]\)/);
  assert.match(web, /me\.utt = u;/, "utterance kept alive (WebKit GC)");
  assert.match(web, /mvSynthPending = \{ text, onEnd \}/, "blocked autoplay keeps the answer for the next tap");
  // Scan -> result -> 2 s -> debrief, on both scan paths, not on history reopen
  const sched = (web.match(/window\.moglyScheduleScanDebrief\(\);/g) || []).length;
  assert.equal(sched, 2, "debrief scheduled after both fresh-scan paths");
  assert.match(web, /mvRunFunction\("scan"\);\n\s+\}, 2000\);/, "debrief fires exactly 2 s after results");
  const openHist = web.slice(web.indexOf("window.openHistoryScan = function"), web.indexOf("window.openHistoryScan = function") + 900);
  assert.ok(!openHist.includes("moglyScheduleScanDebrief"), "history reopen does not talk");
  assert.match(web, /function mvGuestBlocked\(\)/, "free debrief, premium chips");

  // Run the on-device brain for real with stubbed context.
  const src = web.slice(web.indexOf("  function mvLocalFace() {"), web.indexOf("  // ----- on-device voice"));
  const shapeSrc = web.slice(web.indexOf("const MOGLY_FACE_SHAPES = {"), web.indexOf("window.moglyFaceShapeFor = moglyFaceShapeFor;"));
  const build = (lang, ctx) => new Function("ctxObj", "langCode", `
    var _currentLang = langCode;
    ${shapeSrc}
    const mvLang = () => langCode;
    const mvT = (k) => k;
    const mvContext = () => ctxObj;
    ${src}
    return { mvLocalAnswer, mvIntentFromText };
  `)(ctx, lang);
  const ctx = { score: 71, gender: "male", metrics: { jawline: 62, cheekbones: 68, eyes: 74, skin: 58, symmetry: 80 },
    today: { exercises_done: 1, exercises_total: 4, next_exercise: "Masseter Release", water_glasses: 3, water_goal: 8 },
    progress: { streak: 5, scans: 2, first_score: 66, last_score: 71, days_since_scan: 9, local_hour: 20 } };
  const en = build("en", ctx);
  const fixEn = en.mvLocalAnswer("fixfirst", "");
  assert.match(fixEn.answer, /Overall you're at 71/);
  assert.match(fixEn.answer, /Fix this first: your skin/, "lowest metric (skin 58) is the first fix");
  assert.match(fixEn.answer, /retinoid/);
  assert.equal(fixEn.action, "daily");
  const scanEn = en.mvLocalAnswer("scan", "");
  assert.match(scanEn.answer, /Your scan is in\. 71 out of 100/);
  assert.match(scanEn.answer, /strongest feature is your eye area at 74/);
  assert.match(scanEn.answer, /Face shape reads as diamond/, "jaw 62 vs cheekbones 68 -> diamond");
  assert.match(scanEn.answer, /tongue on the palate/);
  assert.match(en.mvLocalAnswer("jawline", "").answer, /won't reshape adult bone/, "honest mewing");
  assert.match(en.mvLocalAnswer("jawline", "").answer, /no bonesmashing/);
  assert.match(en.mvLocalAnswer("eyes", "").answer, /Canthal tilt and orbital bone are hardmaxxing/);
  assert.match(en.mvLocalAnswer("debloat", "").answer, /lymphatic drainage/);
  assert.match(en.mvLocalAnswer("hair", "").answer, /Diamond means the cheekbones are the widest point/);
  assert.match(en.mvLocalAnswer("today", "").answer, /Good evening\. Tonight decides tomorrow's face: salt down.*You're on a 5 day streak.*1 of 4 done.*Masseter Release.*3 of 8 glasses.*66 to 71.*9 days ago/);
  // Daily brief adapts to the time of day (morning debloat ritual).
  const morning = build("en", Object.assign({}, ctx, { progress: Object.assign({}, ctx.progress, { local_hour: 8 }) }));
  assert.match(morning.mvLocalAnswer("brief", "").answer, /Good morning\. Two-minute ritual first: sixty seconds of cold water.*tongue flat on the palate/);
  // Scan audit: change vs. the previous scan, biggest movers named.
  const delta = build("en", Object.assign({}, ctx, { progress: Object.assign({}, ctx.progress, { scan_delta: { days: 7, overall: 3, areas: { jawline: 4, skin: -1, eyes: 0 } } }) }));
  assert.match(delta.mvLocalAnswer("scan", "").answer, /That's up 3 in 7 days\. The work is showing\. Biggest moves: jawline up 4, skin down 1\./);
  assert.match(en.mvLocalAnswer("", "should I try bonesmashing?").answer, /I won't coach bonesmashing, steroids, DNP or starvation/);
  assert.equal(en.mvIntentFromText("how do I get rid of puffy face"), "debloat");
  assert.equal(en.mvIntentFromText("what haircut suits me"), "hair");
  for (const fn of ["fixfirst", "jawline", "debloat", "eyes", "skin", "hair", "scan", "brief", "priority", "today", "meal", "exercise"]) {
    for (const b of [en, morning, delta]) {
      const a = b.mvLocalAnswer(fn, "").answer;
      assert.ok(a.length > 40 && !/undefined|null|NaN/.test(a), fn + " answer is clean: " + a.slice(0, 60));
    }
  }
  const empty = build("en", { metrics: {} });
  assert.match(empty.mvLocalAnswer("fixfirst", "").answer, /I don't have your scan yet/);
  assert.equal(empty.mvLocalAnswer("scan", "").action, "scan");
  ok("offline-first: 404/5xx/timeout -> on-device looksmax answer (English), time-of-day brief, scan delta audit, spoken via speechSynthesis, scan debrief at +2 s");
}

console.log(`\nvoice-chat audit: ${passed} checks passed`);
