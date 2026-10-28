import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const worker = (await import(resolve(here, "../workers/api/src/worker.js"))).default;

console.log("=== Testing SSE Audio Stream with Realistic Network Delays ===");

// 1. Helper to create a delayed SSE stream simulating OpenRouter
function createDelayedSseResponse(chunks, delayMs = 40) {
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  const ev = (o) => "data: " + JSON.stringify(o) + "\n\n";

  let i = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (i === 0) {
        controller.enqueue(new TextEncoder().encode(ev({ choices: [{ delta: { role: "assistant" } }] })));
        i++;
        return;
      }
      if (i <= chunks.length) {
        await new Promise(r => setTimeout(r, delayMs));
        const chunk = chunks[i - 1];
        controller.enqueue(new TextEncoder().encode(
          ev({ choices: [{ delta: { audio: { data: b64(chunk), transcript: `part_${i}` } } }] })
        ));
        i++;
        return;
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    }
  });

  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// 2. Prepare mock audio chunks (3 chunks of 1600 bytes = 4800 bytes total)
const chunk1 = new Uint8Array(1600).fill(11);
const chunk2 = new Uint8Array(1600).fill(22);
const chunk3 = new Uint8Array(1600).fill(33);
const expectedTotal = 4800;

const delayedRes = createDelayedSseResponse([chunk1, chunk2, chunk3], 50);

// Inspect worker module to test readSseAudio directly or via mock
// We can test via worker fetch or by importing worker internals
const src = (await import("node:fs")).readFileSync(resolve(here, "../workers/api/src/worker.js"), "utf8");

// Extract readSseAudio function from worker source for isolated testing
const readSseAudioMatch = src.match(/async function readSseAudio\(res[\s\S]*?\n\}/);
assert.ok(readSseAudioMatch, "readSseAudio found in worker.js");

const fnCode = readSseAudioMatch[0];
const readSseAudio = new Function("return " + fnCode)();

// Test 1: Verify multi-chunk stream over 150ms delay completes fully with default timeout
console.log("Test 1: Reading 3 delayed chunks (50ms interval) with default timeout (28000ms)...");
const start = performance.now();
const pcm = await readSseAudio(delayedRes, 28000);
const elapsed = performance.now() - start;

assert.equal(pcm.length, expectedTotal, `Expected ${expectedTotal} bytes, got ${pcm.length}`);
assert.equal(pcm.transcript, "part_1part_2part_3", `Expected assembled transcript, got ${pcm.transcript}`);
assert.ok(elapsed >= 140, `Stream should take at least 150ms, took ${elapsed.toFixed(1)}ms`);
console.log(`  PASSED: 4800 bytes collected across 3 delayed chunks in ${elapsed.toFixed(1)}ms without cutoff!`);

// Test 2: Verify that premature timeout (e.g. 30ms when chunks arrive at 100ms) is handled
console.log("Test 2: Verifying timeout behavior with deliberate low timeout (30ms vs 100ms chunk)...");
const stalledRes = createDelayedSseResponse([chunk1, chunk2], 100);
try {
  await readSseAudio(stalledRes, 30);
  assert.fail("Should have timed out");
} catch (e) {
  assert.equal(e.message, "sse_audio_timeout", "Correctly threw sse_audio_timeout when stalled");
  console.log("  PASSED: Correctly threw sse_audio_timeout on genuine stall.");
}

// Test 3: Verify partial audio recovery if stalled after first chunk
console.log("Test 3: Partial audio recovery if stream hangs after delivering first chunk...");
const partialRes = createDelayedSseResponse([chunk1, chunk2], 60);
// Wait 60ms for chunk1, but timeout at 90ms before chunk2 arrives at 120ms
const partialPcm = await readSseAudio(partialRes, 90);
assert.equal(partialPcm.length, 1600, `Expected partial 1600 bytes, got ${partialPcm.length}`);
console.log(`  PASSED: Saved ${partialPcm.length} bytes of audio even when stream hung on chunk 2!`);

console.log("\nALL SSE STREAM TESTS PASSED 100%!");
