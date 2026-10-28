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
let ttsMode = "ok"; // ok | fail-auth | fail-server | no-audio
let sttText = "How do I debloat my face before tomorrow?";
let chatMode = "ok"; // ok | busy | timeout

const pcm = new Uint8Array(4800).fill(3); // 0.1 s of 24 kHz 16-bit mono

// gpt-audio-mini over OpenRouter: chat completions with modalities + stream:true,
// audio arrives as base64 pcm16 deltas in the SSE stream.
function sseAudio(bytes) {
  const half = bytes.length / 2;
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  const ev = (o) => "data: " + JSON.stringify(o) + "\n\n";
  const text = ev({ choices: [{ delta: { role: "assistant" } }] })
    + ev({ choices: [{ delta: { audio: { data: b64(bytes.subarray(0, half)), transcript: "x" } } }] })
    + ev({ choices: [{ delta: { audio: { data: b64(bytes.subarray(half)) } } }] })
    + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
// Speech calls are the chat completions that ask for audio output.
const isTts = (c) => c.url.endsWith("/chat/completions") && !!(c.body && c.body.modalities);
const isLlm = (c) => c.url.endsWith("/chat/completions") && !(c.body && c.body.modalities);
const ttsInput = (c) => c.body.messages.find(m => m.role === "user").content;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, body });
  if (u.endsWith("/audio/transcriptions")) {
    return new Response(JSON.stringify({ text: sttText }), { status: 200 });
  }
  if (u.endsWith("/chat/completions") && body.modalities) {
    if (ttsMode === "fail-auth") return new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 });
    if (ttsMode === "fail-server") return new Response(JSON.stringify({ error: { message: "upstream" } }), { status: 500 });
    if (ttsMode === "no-audio") return sseAudio(new Uint8Array(0));
    return sseAudio(pcm);
  }
  if (u.endsWith("/chat/completions")) {
    if (chatMode === "busy") return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    if (chatMode === "timeout") return new Response(JSON.stringify({ error: { message: "timeout" } }), { status: 408 });
    return new Response(JSON.stringify({ choices: [{ message: { content: chatReply } }] }), { status: 200 });
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
// Whole prompt (system + history + user turn) as one string, for content checks.
const msgText = (m) => typeof m.content === "string" ? m.content : m.content.map(c => c.text || "").join("\n");
const promptOf = (body) => body.messages.map(msgText).join("\n");
let passed = 0;
const ok = (name) => { passed++; console.log("  ok -", name); };

// 1. premium required
{
  const r = await post("/api/voice-chat", { user_id: "u1", text: "hi", lang: "en" });
  assert.equal(r.status, 402);
  assert.equal(r.data.error, "premium_required");
  ok("non-premium user gets 402");
}

// 1b. native StoreKit subscriber the KV mirror does not know yet: the client claim is honoured
{
  const r = await post("/api/voice-chat", { user_id: "u_native", text: "hi", lang: "en", premium: true, stream: false });
  assert.notEqual(r.status, 402, "premium:true is not bounced to the robot fallback");
  const r2 = await post("/api/voice-chat", { user_id: "u_native2", text: "hi", lang: "en", is_premium: true, stream: false });
  assert.notEqual(r2.status, 402, "is_premium:true accepted too");
  const r3 = await post("/api/voice-chat", { user_id: "u_native3", text: "hi", lang: "en", premium: "true" });
  assert.equal(r3.status, 402, "only a strict boolean counts");
  ok("client-confirmed native subscription gets the server voice (no 402)");
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
  const chat = calls.find(isLlm);
  const prompt = promptOf(chat.body);
  assert.match(prompt, /Reply language: Russian/);
  assert.match(prompt, /jawline: 88\/100/);
  // The user's words are their own user message, never spliced into the system instructions.
  const msgs = chat.body.messages;
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /Reply language: Russian/);
  assert.ok(!msgs[0].content.includes("How do I debloat"), "user text is not in the system prompt");
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, "user");
  assert.equal(msgText(last), "How do I debloat my face before tomorrow?");
  assert.deepEqual(msgs.slice(1, -1), [{ role: "user", content: "hello" }], "past turns keep their own roles");
  const ttsCalls = calls.filter(isTts);
  assert.equal(ttsCalls.length, 1);
  const tts = ttsCalls[0];
  assert.equal(tts.body.model, "openai/gpt-audio-mini");
  assert.deepEqual(tts.body.modalities, ["text", "audio"]);
  assert.equal(tts.body.stream, true, "OpenRouter only returns audio when streaming");
  assert.deepEqual(tts.body.audio, { voice: "onyx", format: "pcm16" });
  assert.match(tts.body.messages[0].content, /brutal, no-nonsense looksmax coach/);
  assert.match(tts.body.messages[0].content, /in Russian/);
  assert.equal(ttsInput(tts), r.data.answer, "speaks exactly the answer");
  assert.ok(!calls.some(c => c.url.endsWith("/audio/speech")), "no Gemini /audio/speech call");
  assert.equal(chat.body.model, "google/gemini-2.5-flash-lite");
  ok("free mode: audio -> transcript -> answer -> OpenAI Onyx (gpt-audio-mini SSE pcm16) wrapped as playable WAV");
}

// 3b. voice follows the app's Male/Female setting; VOICE_LLM_MODEL swaps the brain only for voice
{
  calls.length = 0;
  env.VOICE_LLM_MODEL = "anthropic/claude-haiku-5.5";
  const r = await post("/api/voice-chat", { user_id: "u1", lang: "en", text: "skin tips?", voice_gender: "female" });
  delete env.VOICE_LLM_MODEL;
  assert.equal(r.data.tts_ok, true);
  const tts = calls.find(isTts).body;
  assert.equal(tts.audio.voice, "nova");
  assert.equal(tts.model, "openai/gpt-audio-mini");
  assert.match(tts.messages[0].content, /aesthetic beauty advisor and looksmax stylist/);
  const chat = calls.find(isLlm).body;
  assert.equal(chat.model, "anthropic/claude-haiku-5.5");
  assert.ok(!chat.provider.order, "no Google provider order for a non-Google model");
  assert.equal(chat.provider.data_collection, "deny");
  assert.match(promptOf(chat), /elite female aesthetic mentor/);
  assert.match(promptOf(chat), /Darling, no candidate is fixing/);
  assert.match(promptOf(chat), /Strictly NO masculine slang/);
  ok("female voice -> OpenAI Nova + female aesthetic mentor persona; VOICE_LLM_MODEL override keeps data_collection deny");
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
  const tts = calls.find(isTts);
  assert.ok(!ttsInput(tts).includes("[["));
  const prompt = promptOf(calls.find(isLlm).body);
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
  const prompt = promptOf(calls.find(c => c.url.endsWith("/chat/completions")).body);
  assert.match(prompt, /Cheekbone Depuff/);
  assert.match(prompt, /timer starts now for 30 seconds/);
  ok("function: exercise passes exercise name, steps and duration");
}

// 8. TTS is OpenAI only: any failure is an honest tts_unavailable, never a Gemini fallback
{
  for (const mode of ["fail-auth", "fail-server", "no-audio"]) {
    ttsMode = mode;
    calls.length = 0;
    const r = await post("/api/voice-chat", { user_id: "u1", lang: "en", text: "tips for skin?" });
    assert.equal(r.status, 200, mode);
    assert.equal(r.data.tts_ok, false, mode);
    assert.equal(r.data.tts_error, "tts_unavailable", mode);
    assert.equal(r.data.audio_base64, null, mode);
    assert.ok(r.data.answer.length > 10, mode + ": the text answer survives");
    const tts = calls.filter(isTts);
    assert.equal(tts.length, 1, mode + ": one OpenAI attempt, no retry chain");
    assert.ok(tts.every(c => c.body.model === "openai/gpt-audio-mini"), mode);
    assert.ok(!calls.some(c => c.url.endsWith("/audio/speech")), mode + ": no Gemini TTS fallback");
  }
  ttsMode = "ok";
  const src = readFileSync(resolve(here, "../workers/api/src/worker.js"), "utf8");
  assert.ok(!/VOICE_TTS_CHAIN|pcmRate|gemini-[\w.-]*tts|\/audio\/speech/.test(src), "Gemini TTS chain and helpers purged");
  assert.match(src, /const VOICE_TTS_VOICES = \{ male: "onyx", female: "nova" \};/);
  assert.match(src, /async function readSseAudio\(res\)/);
  assert.match(src, /return \{ ok: false, status: res\.status \|\| 502, reason: "tts_unavailable" \};/);
  ok("TTS: OpenAI only (Onyx / Nova); 402 / 5xx / no audio -> tts_unavailable + text answer, no Gemini fallback");
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
  const r = await postStream({ user_id: "u3", lang: "en", stream: true, audio_base64: fakeAudio, audio_format: "audio/mp4", context: { score: 84 } });
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
  const inputs = calls.filter(isTts).map(ttsInput);
  assert.equal(inputs.length, 3);
  assert.ok(inputs[0].length < inputs.join(" ").length / 2, "first segment is the short one");
  assert.equal(inputs.join(" "), r.events[1].answer, "segments cover the whole answer, nothing lost");
  // Each audio event names the text it speaks, so the app can highlight it while it plays.
  assert.deepEqual(audio.map(e => e.text), inputs, "audio[i].text is exactly what audio i says");
  assert.deepEqual(r.events[1].segments, inputs, "answer event lists the segments up front");
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
  const prompt = promptOf(calls.find(c => c.url.endsWith("/chat/completions")).body);
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
  assert.equal(calls.filter(isTts).length, 1);
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
    const prompt = promptOf(calls.find(c => c.url.endsWith("/chat/completions")).body);
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
    const prompt = promptOf(calls.find(c => c.url.endsWith("/chat/completions")).body);
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
  const prompt = promptOf(calls.find(c => c.url.endsWith("/chat/completions")).body);
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
  // Scope: only looksmaxxing, off-topic is deflected in one line and pivoted to the face.
  assert.match(prompt, /You talk ONLY about looksmaxxing/);
  assert.match(prompt, /politics, news.*coding, weather.*do NOT answer it, not even briefly/);
  assert.match(prompt, /Never sound like a robot refusing/);
  assert.match(prompt, /Listen, no candidate is fixing your jawline/);
  // "Bro" is allowed for men, just not in every sentence.
  assert.match(prompt, /"Bro" is welcome, but at most once per answer and not in every answer/);
  // Numbers: the screen shows them, the voice turns them into meaning; numbers only for progress.
  assert.match(prompt, /Never read out lists of measurements, scores, degrees or percentages/);
  assert.match(prompt, /Say a number out loud only to celebrate progress/);
  assert.doesNotMatch(prompt, /quote their actual numbers/);
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
  assert.match(web, /if \(!answer\) \{ fail\(e && e\.mvKind\); return; \}/, "network drop before the answer -> honest failure + retry");
  assert.match(web, /The full answer text stays on screen whatever happens to the audio/);
  assert.match(web, /mvNote\(cut \? mvT\("cutOff"\) : mvT\("noVoice"\)\)/, "TTS failure / cut keeps text and only notes the status");
  assert.match(web, /ctx\.face_shape = shape\.trim\(\)/);
  assert.match(web, /ctx\.gender = /);
  // Live "where Mogly is now": sentence spans, highlight by segment + playback time, auto-scroll.
  assert.match(web, /span\.className = "mv-sent";/, "answer rendered as sentence spans");
  assert.match(web, /mvQueuePush\(mvBase64ToBytes\(ev\.audio_base64\), ev\.audio_format, ev\.text \|\| ""\)/, "segment text drives the highlight");
  assert.match(web, /\.mv-answer\.mv-karaoke \.mv-sent\.mv-past \{ opacity: 0\.45; \}/, "spoken sentences fade to 0.45");
  assert.match(web, /\.mv-answer\.mv-karaoke \.mv-sent\.mv-now \{ opacity: 1; color: #fff;/, "current sentence bright white");
  assert.match(web, /box\.scrollTo\(\{ top, behavior: reduce \? "auto" : "smooth" \}\)/, "text follows the voice down");
  assert.match(web, /mvRaf = 0;\n\s+mvKaraokeTick\(\);/, "highlight updated every frame while speaking");
  assert.match(web, /if \(\(answer \|\| ""\) === mvShownAnswer\) return;/, "end of stream does not reset the highlight or scroll");
  ok("client: 6 chips (Fix first primary), error events, kept text on drop, specific messages, live sentence highlight + auto-scroll, web == ios");
}

// 19. no canned answers: a dead /api/voice-chat (404 / 5xx / timeout / offline) gets an
//     honest "couldn't reach coach" turn with a retry button, never fake on-device advice.
{
  const web = readFileSync(resolve(here, "../web/index.html"), "utf8");
  for (const name of ["mvLocalAnswer", "mvLocalFace", "mvBand", "mvAreaPlan", "MV_AREA", "MV_AREA_ACTION", "mvHairPlan", "mvIntentFromText", "mvLocalTurn"]) {
    assert.ok(!new RegExp("\\b" + name + "\\b").test(web), name + " removed");
  }
  // Failure routing
  assert.match(web, /\/\/ 404 \(worker not deployed\), 5xx, daily_limit, bad JSON: honest failure\.\n\s+if \(!r\.data \|\| !r\.data\.ok\) \{\n\s+return \{ fail:/);
  assert.match(web, /if \(res\.fail\) \{ fail\(res\.fail\); return; \}/);
  assert.match(web, /if \(!answer\) \{ fail\(streamErr \? streamErr\.error/);
  assert.match(web, /if \(myTurn === mvTurn\) mvFailTurn\(mvT\("coachDown"\), mvT\(fn\)\);/, "chip exception -> honest failure");
  assert.match(web, /coachDown: "Couldn't reach coach\. Check connection and tap to retry\.",/);
  assert.match(web, /function mvFailTurn\(message, heard, canRetry\) \{[\s\S]{0,300}mvSetAction\(canRetry === false \|\| !mvLastAsk \? null : "retry"\);/, "failed turn shows a retry button");
  assert.match(web, /function mvRetryTurn\(\) \{[\s\S]{0,500}mvAsk\(last\.payload, myTurn, last\.said, last\.extra\)/, "retry replays the same request");
  assert.match(web, /mvLastAsk = \{ payload, said, extra \};/);
  assert.match(web, /if \(kind === "retry"\) \{ mvRetryTurn\(\); return; \}/, "action button retries without closing the overlay");
  assert.match(web, /if \(why === "daily_limit"\) \{ mvFailTurn\(mvT\("limit"\), heard, false\); return; \}/, "daily limit is not retried");
  assert.match(web, /timer = setTimeout\(\(\) => \{ timedOut = true; controller\.abort\(\); \}, 15000\);/, "dead server gives up in 15 s");
  // The iOS robot voice is banned: no speechSynthesis anywhere, text only without real audio.
  const ios = readFileSync(resolve(here, "../ios/App/App/public/index.html"), "utf8");
  for (const [name, html] of [["web", web], ["ios", ios]]) {
    assert.ok(!/speechSynthesis\.(speak|getVoices)|new SpeechSynthesisUtterance|AVSpeechSynthesizer/.test(html), name + ": no device speech engine");
    assert.ok(!/mvSpeakLocal|mvPickVoice|mdcUtt/.test(html), name + ": robot helpers removed");
  }
  assert.match(web, /text only, never the robot voice/, "server answer without audio stays text");
  assert.match(web, /premium: mvIsPremium\(\),/, "client tells the worker about the native subscription");
  assert.match(web, /function mdcChime\(notes\)/, "exercise cues are a bell, not speech");
  // Home: no brief pill beside the orb, a tappable caption under it instead
  assert.ok(!/id="mdcBriefChip"|\.mdc-brief-chip\{/.test(web), "brief chip next to the orb removed");
  // The sphere and its caption always open the voice mentor; nothing intercepts the tap.
  assert.match(web, /<button type="button" class="mogly-orb-hint" id="moglyOrbHint" onclick="openMoglyVoiceSheet\(\)">Tap to talk with Mogly<\/button>/);
  assert.match(web, /id="moglyOrbFabBtn" onclick="openMoglyVoiceSheet\(\)"/, "sphere opens the voice mentor");
  assert.ok(!/moglySphereTap/.test(web), "no ritual intercept on the sphere");
  assert.match(web, /#home \.mv-orb-btn\{width:118px;height:118px/, "big Home sphere");
  // Profile voice cards never overflow on a 375 pt screen
  assert.match(web, /\.pf-voice-seg\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(web, /\.pf-voice-opt\{[^}]*min-width:0;overflow:hidden/);
  assert.match(web, /<b>Onyx<\/b><small>Male Coach<\/small>/);
  assert.match(web, /<b>Nova<\/b><small>Female Coach<\/small>/);
  assert.match(web, /window\.toggleCyberChadVoice = function\(\)\{\n  quizHaptic\(\);\n  if \(typeof window\.moglyPlayScanDebrief/, "scan verdict uses the live debrief");
  // Scan -> result -> 3 s -> orb floats up (tap = debrief, swipe/✕ = dismiss), on both scan paths, not on history reopen
  const sched = (web.match(/window\.moglyScheduleScanDebrief\(\);/g) || []).length;
  assert.equal(sched, 2, "debrief scheduled after both fresh-scan paths");
  assert.match(web, /mvDockShow\(\);\n\s+mvHaptic\("light"\);\n\s+\}, 3000\);/, "orb floats up exactly 3 s after results");
  assert.ok(!/moglyScheduleScanDebrief = function\(\) \{[\s\S]{0,400}mvOpenOverlay/.test(web), "results are never covered by an auto-opened overlay");
  assert.match(web, /id="mvScanDock"[\s\S]{0,1400}moglyDismissScanDock\(event\)/, "orb has a ✕ dismiss");
  assert.match(web, /if \(dy > 70 \|\| \(dy > 24 && v > 0\.5\)\) \{ mvHaptic\("light"\); mvDockHide\(true\)/, "swipe down throws the orb off screen");
  assert.match(web, /\["resultImg", "reportImg", "prePayImg", "loadingImg"\]\.forEach[\s\S]{0,120}img\.src = cleanDataUrl/, "Face Scan circle gets the scanned photo");
  const openHist = web.slice(web.indexOf("window.openHistoryScan = function"), web.indexOf("window.openHistoryScan = function") + 900);
  assert.ok(!openHist.includes("moglyScheduleScanDebrief"), "history reopen does not talk");
  assert.match(web, /function mvGuestBlocked\(\)/, "free debrief, premium chips");

  ok("no canned answers: 404/5xx/timeout -> 'Couldn't reach coach' + retry button, no robot voice, scan orb at +3 s (tap = debrief, swipe/✕ = dismiss)");
}

// 20. wake word: "Hey Mogly, ..." reaches the model without the address; just "Mogly" gets a greeting
{
  kv.clear();
  setPremium("u20", true);
  chatReply = "Cut late salt tonight and sleep on your back.";
  // Text model calls only: TTS (gpt-audio-mini) also goes through /chat/completions.
  const llmCalls = () => calls.filter(c => c.url.endsWith("/chat/completions") && !c.body.modalities);
  const userTurn = () => {
    const chat = llmCalls();
    const users = chat[0].body.messages.filter(m => m.role === "user");
    return msgText(users[users.length - 1]);
  };
  const cases = [
    ["Hey Mogly, how do I debloat my face?", "how do I debloat my face?"],
    ["Mogly, what about my jawline?", "what about my jawline?"],
    ["yo mowgli what about my jawline?", "what about my jawline?"],
    ["Hey, Moggli: fix my skin first?", "fix my skin first?"],
    ["Moggy — how's my canthal tilt?", "how's my canthal tilt?"],
    ["ok mogli. which haircut suits me?", "which haircut suits me?"],
    ["Могли, как убрать отёки?", "как убрать отёки?"],
  ];
  for (const [said, clean] of cases) {
    calls.length = 0;
    const r = await post("/api/voice-chat", { user_id: "u20", lang: "en", text: said });
    assert.equal(r.status, 200, said);
    assert.ok(userTurn().includes(clean), said + " -> " + clean);
    assert.ok(!/mog|mowgli|могли/i.test(userTurn().slice(userTurn().indexOf(clean) - 20)), "address removed: " + said);
  }
  // Not an address: left exactly as said.
  for (const said of ["Moglyfication is a myth?", "Hey, how do I debloat?", "Могли бы вы помочь с кожей?"]) {
    calls.length = 0;
    await post("/api/voice-chat", { user_id: "u20", lang: "en", text: said });
    assert.ok(userTurn().includes(said), "kept: " + said);
  }
  // Only the name (spoken, via STT): greeting, no model call, no daily turn spent.
  const usedBefore = [...kv.keys()].filter(k => k.includes("u20")).map(k => kv.get(k)).join("|");
  for (const name of ["Mogly", "Hey Mogly!", "Mowgli?", "Могли."]) {
    calls.length = 0;
    sttText = name;
    const r = await post("/api/voice-chat", { user_id: "u20", lang: "en", audio_base64: fakeAudio, audio_format: "audio/mp4" });
    assert.equal(r.status, 200, name);
    assert.equal(r.data.answer, "I'm listening. What's on your mind — jawline, debloat, or your daily routine?", name);
    assert.equal(r.data.transcript, name, "the transcript shows what was actually said");
    assert.equal(llmCalls().length, 0, "no model call for a bare name");
    assert.equal(r.data.tts_ok, true, "the greeting is spoken");
  }
  const s = await postStream({ user_id: "u20", lang: "en", stream: true, text: "Hey Mogly" });
  assert.deepEqual(s.events.map(e => e.type).slice(0, 1), ["answer"]);
  assert.match(s.events[0].answer, /^I'm listening\./);
  assert.equal(s.events[s.events.length - 1].type, "done");
  assert.equal([...kv.keys()].filter(k => k.includes("u20")).map(k => kv.get(k)).join("|"), usedBefore, "greeting does not count against the daily limit");
  sttText = "How do I debloat my face before tomorrow?";
  ok("wake word: Hey/Yo Mogly, Mowgli, Moggli, Moggy, Mogli, Могли stripped before the model; bare name -> spoken greeting, no quota");
}

// 21. orb tap state machine: double tap, late recorder events and cancels never leave the orb stuck
{
  const web = readFileSync(resolve(here, "../web/index.html"), "utf8");
  const ios = readFileSync(resolve(here, "../ios/App/App/public/index.html"), "utf8");
  assert.ok(web === ios, "web == ios");
  assert.match(web, /onclick="moglyVoiceOrbTap\(\)"/, "tap on the sphere drives the conversation");
  assert.match(web, /if \(mvState !== "idle" \|\| mvMicPending\) return;/, "second tap while the mic opens is ignored");
  assert.match(web, /if \(myTurn !== mvTurn\) \{ try \{ stream\.getTracks\(\)\.forEach\(tr => tr\.stop\(\)\); \} catch \(e\) \{\} return; \}\n\s+mvMicStream = stream;/, "stale start stops only its own stream");
  assert.match(web, /async function mvOnRecorded\(myTurn, mime\) \{\n[^\n]*\n\s+if \(myTurn !== mvTurn\) return;\n\s+mvStopMic\(\);/, "late stop event cannot kill a newer mic");
  assert.match(web, /if \(rec && rec\.mvFinish\) setTimeout\(rec\.mvFinish, 3000\);/, "watchdog: never stuck in thinking");
  const tap = web.slice(web.indexOf("window.moglyVoiceOrbTap = function"), web.indexOf("window.moglyVoiceChip"));
  assert.match(tap, /mvState === "idle" && mvResumeBlocked\(\)/);
  assert.match(tap, /mvState === "listening"\) \{ mvStopListening\(true\); return; \}/);
  assert.match(tap, /mvCancelTurn\(true\);/, "tap while thinking / speaking cancels back to idle");
  const cancel = web.slice(web.indexOf("function mvCancelTurn"), web.indexOf("function mvCloseOverlay"));
  for (const part of ["mvTurn++", "mvAbort.abort()", "mvStopMic()", "mvMicPending = false", "mvStopPlayback()", 'mvSetState("idle")']) {
    assert.ok(cancel.includes(part), "cancel resets " + part);
  }
  ok("orb tap: idle -> listening -> thinking -> speaking -> idle; double tap, late events and cancels never stick");
}

// 22. Siri liquid glass orb (no border stroke), no weekly free trial, no button glow, Scan History never dimmed
{
  const web = readFileSync(resolve(here, "../web/index.html"), "utf8");
  const rule = (sel) => { const i = web.indexOf("\n" + sel + " {"); assert.ok(i >= 0, sel); return web.slice(i, web.indexOf("\n}", i)); };
  const orb = rule(".mv-orb");
  assert.match(orb, /border: none;/);
  assert.match(orb, /overflow: hidden;/);
  assert.match(orb, /isolation: isolate;/);
  const orbCss = web.slice(web.indexOf("\n.mv-orb {"), web.indexOf("/* Voice overlay */"));
  assert.ok(!/border: 1px solid/.test(orbCss), "no wrapping stroke around the orb");
  assert.match(rule(".mv-orb::before"), /backdrop-filter: blur\(28px\) saturate\(190%\);/);
  const canvas = rule(".mv-orb-canvas");
  assert.match(canvas, /mask-image: radial-gradient\(circle at 50% 50%, #000 68%, transparent 100%\);/);
  assert.match(canvas, /mix-blend-mode: screen;/);
  assert.match(canvas, /z-index: 1;/);
  const glass = rule(".mv-orb-glass");
  assert.match(glass, /z-index: 2;/);
  assert.match(glass, /box-shadow: inset 0 1\.5px 3px rgba\(255, 255, 255, 0\.42\), inset 0 -3px 10px rgba\(0, 162, 255, 0\.25\) !important;/);
  assert.ok(!/rgba\(255, 255, 255/.test(glass.replace(/box-shadow:[^;]*;/, "")), "no white fog over the plasma");
  const sheen = rule(".mv-orb-glass::before");
  assert.match(sheen, /radial-gradient\(ellipse at 50% 30%, rgba\(255, 255, 255, 0\.24\)/, "ultra-soft lens sheen");
  assert.ok(!/linear-gradient/.test(sheen), "no opaque painted highlight patch");
  assert.match(rule(".mv-orb-glass::after"), /rgba\(255, 255, 255, 0\.45\) 0%, rgba\(255, 255, 255, 0\) 75%/, "micro pinpoint highlight");
  assert.match(web, /bg\.addColorStop\(0, "rgba\(16, 41, 79, 0\.62\)"\);/, "translucent canvas backing");
  // Weekly charges from day 0: no trial promise anywhere.
  assert.ok(!/free trial|3-day trial|Start 3-Day/i.test(web), "no free trial copy");
  assert.match(web, /cta\.textContent = price \? 'Continue with Weekly \(' \+ price \+ '\)' : 'Continue with Weekly';/);
  // Zero glow on buttons.
  assert.match(web, /\*, \*::before, \*::after \{\n  box-shadow: none !important;\n\}/, "site-wide no-shadow rule kept");
  assert.match(web, /\.btn\.btn-scanface \{[^}]*box-shadow:none !important;/);
  assert.ok(!/class="btn[^"]*"[^>]*style="[^"]*box-shadow:0 /.test(web), "no inline button glow");
  // Scan History is never left dimmed during or after analysis.
  const setBtns = web.slice(web.indexOf('const secondaryBtn = document.getElementById("moglySecondaryBtn");'));
  const sets = setBtns.slice(0, 4000).match(/secondaryBtn\.style\.opacity = "([^"]+)"/g) || [];
  assert.ok(sets.length >= 3 && sets.every(x => x.endsWith('"1"')), "Scan History opacity stays 1");
  ok("Siri liquid glass orb without border stroke, weekly plan has no free trial, no button glow, Scan History never dimmed");
}

// 30-day ritual: fixed phrase whitelist, OpenAI voice per gender, KV-cached, no free text
{
  ttsMode = "ok";
  const before = calls.filter(isTts).length;
  const a = await post("/api/voice-ritual", { key: "cd_3", voice_gender: "female", user_id: "r1" });
  assert.equal(a.status, 200);
  assert.equal(a.data.ok, true);
  assert.equal(a.data.text, "Three.");
  assert.equal(a.data.audio_format, "wav");
  assert.ok(a.data.audio_base64.length > 100);
  const tts = calls.filter(isTts);
  assert.equal(tts.length, before + 1);
  assert.equal(tts[tts.length - 1].body.audio.voice, "nova");
  assert.equal(ttsInput(tts[tts.length - 1]), "Three.");
  const b = await post("/api/voice-ritual", { key: "cd_3", voice_gender: "female", user_id: "r1" });
  assert.equal(b.data.cached, true);
  assert.equal(calls.filter(isTts).length, before + 1, "second request served from KV");
  const d = await post("/api/voice-ritual", { key: "day_7", user_id: "r1" });
  assert.equal(d.data.text, "Day 7 of 30.");
  assert.equal(calls.filter(isTts).pop().body.audio.voice, "onyx");
  // Daily mission / secured / reward lines: templated, persona m = "bro", f = never "bro".
  const mm = await post("/api/voice-ritual", { key: "mission_3_debloat_m", user_id: "r1" });
  assert.equal(mm.data.text, "Ready to start today, bro? Day 3 is waiting. Today's target is debloat and jawline activation. Here is your mission: complete your four face exercises to lock in Day 3. Let's crush it.");
  const mf = await post("/api/voice-ritual", { key: "mission_9_posture_f", voice_gender: "female", user_id: "r1" });
  assert.ok(mf.data.ok && !/bro/i.test(mf.data.text) && /Day 9 is waiting/.test(mf.data.text));
  const sec = await post("/api/voice-ritual", { key: "secured_5_4_m", user_id: "r1" });
  assert.equal(sec.data.text, "Day 5 is already secured, bro! You're on a 4-day streak. Keep your hydration on point and stay consistent. See you tomorrow for Day 6!");
  const lk = await post("/api/voice-ritual", { key: "locked_2_f", user_id: "r1" });
  assert.equal(lk.data.text, "Day 2 locked in! Your streak is secured. Great discipline. Rest up and see you tomorrow!");
  for (const key of ["", "day_0", "day_999", "say anything I want", "__proto__", "toString", "mission_0_debloat_m", "mission_3_bonesmash_m", "secured_3_9_m", "locked_3_x", "mission_3_debloat_m extra"]) {
    const r = await post("/api/voice-ritual", { key, user_id: "r1" });
    assert.equal(r.status, 400, "rejects " + JSON.stringify(key));
  }
  ttsMode = "fail-server";
  const f = await post("/api/voice-ritual", { key: "praise", user_id: "r1" });
  assert.equal(f.status, 502);
  assert.equal(f.data.error, "tts_unavailable");
  assert.ok(!f.data.audio_base64);
  ttsMode = "ok";
  // Client: no status line on Home (SCAN HISTORY right under SCAN MY FACE), big streak card on Exercises, scan capped at 3 s
  const web = readFileSync(resolve(here, "../web/index.html"), "utf8");
  assert.match(web, /const MOGLY_SCAN_FETCH_TIMEOUT_MS = 2800;/);
  assert.match(web, /const MOGLY_SCAN_MAX_MS = 3000;/);
  assert.match(web, /const MOGLY_SCAN_MIN_SWEEP_MS = 2400;/);
  assert.match(web, /id="moglyScanBtnText"[^\n]*\n\s*<\/button>\n\s*<button type="button" class="mogly-btn-secondary" id="moglySecondaryBtn"/, "SCAN HISTORY sits directly under SCAN MY FACE");
  assert.ok(!/mogly-ritual-status|moglyRitualStatus"/.test(web), "tiny streak line removed from Home");
  assert.match(web, /<section id="exercises" class="screen">[\s\S]{0,600}id="exStreakCard"[\s\S]{0,1200}<div id="exercisesList"><\/div>/, "streak card on top of Exercises");
  // The voice leads the day: mission brief on open, the 4th exercise locks the streak, Mogly says it.
  assert.match(web, /if \(mvOpenOverlay\(false\)\) mvMissionBrief\(\);/, "voice sheet opens with today's mission");
  assert.match(web, /startMission: "⚡ Start Today's 4 Exercises"/);
  assert.match(web, /kind === "mission"\) openExercises\(\)/, "mission card opens Exercises");
  assert.match(web, /key: `mission_\$\{st\.day\}_\$\{st\.phase\}_\$\{mvPersonaTag\(\)\}`/);
  assert.match(web, /if \(dayComplete\) moglyRecordDayComplete\(\);/, "4th exercise records the day");
  assert.match(web, /mdcSpeakReward\(`locked_\$\{day\}_\$\{persona\}`, line\)/, "Mogly speaks the reward");
  assert.match(web, /Mogly Brief<\/span><b id="exVoicePillState">/);
  assert.match(web, /Tap to hear today's mission from Mogly/);
  assert.ok(!/protocolStreakCount|PROTOCOL_SINCE_KEY/.test(web), "the 4 exercises alone lock the day");
  assert.match(web, /\.ex-streak-head\{font-size:25px/, "big bold streak headline");
  assert.match(web, /<use href="#exIcoFlame"\/>[\s\S]{0,700}<use href="#exIcoMic"\/>[\s\S]{0,300}<use href="#exIcoBolt"\/>/, "streak card icons are SVG, not emoji (tofu in no-emoji fonts)");
  assert.match(web, /const DAY_LABELS = \["M","T","W","T","F","S","S"\];/);
  assert.ok(!/_makeFaceCrop|tensorflow\/tfjs/.test(web), "no TF.js crop after the scan (froze the result screen)");
  assert.match(web, /st\.completed > 0 && !isLocalPremiumActive\(\)/, "day 1 free, then Premium");
  ok("30-day ritual: whitelisted OpenAI phrases cached in KV, streak card on Exercises, sphere = mentor, 3 s scan cap");
}

// 21. no scan yet: hook + why the face is needed + [[go:scan]]; persona follows the user's gender
{
  kv.clear();
  setPremium("ns1", true);
  chatReply = "A sharp jaw is 70% bloat and posture, but I'm not guessing your angles blind. Three seconds on camera and I'll tell you the truth.";
  for (const fn of ["jawline", "debloat", "skin", "fixfirst"]) {
    calls.length = 0;
    const r = await post("/api/voice-chat", { user_id: "ns1", lang: "en", function: fn, context: { gender: "male", has_scan: false } });
    assert.equal(r.data.ok, true, fn);
    assert.equal(r.data.action, "scan", fn + " -> scan button even without the tag");
    const prompt = promptOf(calls.find(isLlm).body);
    assert.match(prompt, /No scan yet, strict/, fn);
    assert.match(prompt, /End with exactly the tag \[\[go:scan\]\]/, fn);
    assert.match(prompt, /follow the No scan yet rules instead of this task/, fn);
    assert.doesNotMatch(prompt, /Optional navigation/, fn);
  }
  // Free talk without a scan, model tag is parsed as a real action.
  calls.length = 0;
  chatReply = "Skin is half sleep and sunscreen, but I need to see yours first. Three seconds on camera. [[go:scan]]";
  const free = await post("/api/voice-chat", { user_id: "ns1", lang: "en", text: "how do I fix my skin", context: { has_scan: false, gender: "female" } });
  assert.equal(free.data.action, "scan");
  assert.ok(!free.data.answer.includes("[["));
  // Female user -> stylist persona even with the male coach voice picked.
  const fp = promptOf(calls.find(isLlm).body);
  assert.match(fp, /elite female aesthetic mentor/);
  assert.match(fp, /Strictly NO masculine slang/);
  assert.equal(calls.find(isTts).body.audio.voice, "onyx", "voice timbre still follows voice_gender");
  // has_scan:false wins over a stale score; a real scan keeps the normal chip.
  calls.length = 0;
  await post("/api/voice-chat", { user_id: "ns1", lang: "en", function: "jawline", context: { score: 80, has_scan: false } });
  assert.match(promptOf(calls.find(isLlm).body), /No scan yet, strict/);
  calls.length = 0;
  chatReply = "Your jaw is close, debloat first. [[go:exercises]]";
  const scanned = await post("/api/voice-chat", { user_id: "ns1", lang: "en", function: "jawline", context: { score: 80, has_scan: true, gender: "male" } });
  assert.equal(scanned.data.action, "exercises");
  const mp = promptOf(calls.find(isLlm).body);
  assert.doesNotMatch(mp, /No scan yet, strict/);
  assert.doesNotMatch(mp, /Strictly NO masculine slang/);
  // today / meal / exercise / post-scan debrief keep working without a scan.
  for (const fn of ["today", "meal", "scan"]) {
    calls.length = 0;
    await post("/api/voice-chat", { user_id: "ns1", lang: "en", function: fn, context: { has_scan: false } });
    assert.doesNotMatch(promptOf(calls.find(isLlm).body), /No scan yet, strict/, fn);
  }
  // Client: has_scan in context, primary "📷 Take Face Scan" that closes the overlay and starts the scan.
  const web = readFileSync(resolve(here, "../web/index.html"), "utf8");
  assert.match(web, /ctx\.has_scan = /);
  assert.match(web, /openScan: "📷 Take Face Scan"/);
  assert.match(web, /b\.classList\.toggle\("mv-action-scan", kind === "scan"\)/);
  assert.match(web, /mvCloseOverlay\(false\);\n[\s\S]{0,400}else if \(kind === "scan"\) \{ openScreen\("home"\); if \(window\.handleMoglyPrimaryScanClick\) window\.handleMoglyPrimaryScanClick\(\); \}/);
  assert.equal(web, readFileSync(resolve(here, "../ios/App/App/public/index.html"), "utf8"), "web == ios");
  ok("no scan: hook + [[go:scan]] -> 📷 Take Face Scan, persona bound to user gender, bro rotated");
}

console.log(`\nvoice-chat audit: ${passed} checks passed`);
