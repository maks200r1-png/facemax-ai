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
let ttsMode = "ok"; // ok | fail-voice | fail-model | fail-auth
let sttText = "How do I debloat my face before tomorrow?";

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

console.log(`\nvoice-chat audit: ${passed} checks passed`);
