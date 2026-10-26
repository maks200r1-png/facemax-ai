// Audit for the voice rewrite (POST /api/voice-chat and the legacy /api/voice-consult).
// Runs the real worker module against a mocked OpenRouter + KV, no network.
//
//   node tests/voice-chat-audit.mjs

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const worker = (await import(resolve(here, "../workers/api/src/worker.js"))).default;

const calls = [];
let chatReply = "Your jawline is solid at eighty eight. Cut late salt tonight and your face will look sharper tomorrow.";
let ttsMode = "ok"; // ok | fail-voice | fail-auth
let sttText = "How do I debloat my face before tomorrow?";

const mp3 = new Uint8Array(2000).fill(7);

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, body });
  if (u.endsWith("/audio/transcriptions")) {
    return new Response(JSON.stringify({ text: sttText }), { status: 200 });
  }
  if (u.endsWith("/chat/completions")) {
    return new Response(JSON.stringify({ choices: [{ message: { content: chatReply } }] }), { status: 200 });
  }
  if (u.endsWith("/audio/speech")) {
    if (ttsMode === "fail-auth") return new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 });
    if (ttsMode === "fail-voice" && body.voice === "ash") {
      return new Response(JSON.stringify({ error: { message: "unknown voice" } }), { status: 400 });
    }
    return new Response(mp3, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
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
  assert.equal(r.data.audio_format, "mp3");
  assert.equal(r.data.tts_ok, true);
  const stt = calls.find(c => c.url.endsWith("/audio/transcriptions"));
  assert.equal(stt.body.input_audio.format, "m4a");
  assert.equal(stt.body.language, "ru");
  const chat = calls.find(c => c.url.endsWith("/chat/completions"));
  const prompt = chat.body.messages[0].content[0].text;
  assert.match(prompt, /Reply language: Russian/);
  assert.match(prompt, /jawline: 88\/100/);
  assert.match(prompt, /User said: How do I debloat/);
  const tts = calls.find(c => c.url.endsWith("/audio/speech"));
  assert.equal(tts.body.model, "openai/gpt-4o-mini-tts-2025-12-15");
  assert.equal(tts.body.response_format, "mp3");
  ok("free mode: audio -> transcript -> answer -> mp3, correct language and format");
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

// 8. voice fallback: bad voice -> next voice; payment error -> text only, never throws
{
  ttsMode = "fail-voice";
  calls.length = 0;
  let r = await post("/api/voice-chat", { user_id: "u1", lang: "en", text: "tips for skin?" });
  assert.equal(r.data.tts_ok, true);
  const voices = calls.filter(c => c.url.endsWith("/audio/speech")).map(c => c.body.voice);
  assert.deepEqual(voices, ["ash", "alloy"]);

  ttsMode = "fail-auth";
  r = await post("/api/voice-chat", { user_id: "u1", lang: "en", text: "tips for skin?" });
  assert.equal(r.status, 200);
  assert.equal(r.data.tts_ok, false);
  assert.equal(r.data.audio_base64, null);
  assert.ok(r.data.answer.length > 10);
  ttsMode = "ok";
  ok("TTS: bad voice falls back to the next voice; TTS failure still returns the text answer");
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

// 10. legacy route: still returns answer + audio, limited per IP, no user id needed
{
  kv.clear();
  const r = await post("/api/voice-consult", { topic: "jawline", lang: "en", score: 84, metrics: { jawline: 88 } }, { "CF-Connecting-IP": "1.2.3.4" });
  assert.equal(r.data.ok, true);
  assert.ok(r.data.audio_base64);
  assert.equal(r.data.format, "mp3");
  let last;
  for (let i = 0; i < 12; i++) last = await post("/api/voice-consult", { topic: "skin" }, { "CF-Connecting-IP": "1.2.3.4" });
  assert.equal(last.status, 429);
  ok("legacy /api/voice-consult returns real audio and is IP limited");
}

console.log(`\nvoice-chat audit: ${passed} checks passed`);
