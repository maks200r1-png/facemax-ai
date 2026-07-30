import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const bridgePath = path.join(root, 'web/js/native-bridge.js');
const workerPath = path.join(root, 'workers/api/src/worker.js');
const indexPath = path.join(root, 'web/index.html');

const WEEKLY = 'com.facemaxai.app.weekly';
const MONTHLY = 'com.facemaxai.app.monthly';
const YEARLY = 'com.facemaxai.app.yearly';
const now = Date.now();

function makeClassList() {
  return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
}

async function loadBridge({ restoreInfo, refreshInfo = restoreInfo, fetchOk = true, appUserID = null } = {}) {
  const source = await fs.readFile(bridgePath, 'utf8');
  const fetchCalls = [];
  const Purchases = {
    async configure() {},
    async logIn() {},
    async setLogLevel() {},
    async getOfferings() { return { current: { availablePackages: [] }, all: {} }; },
    async restorePurchases() { return { customerInfo: restoreInfo }; },
    async getCustomerInfo() { return { customerInfo: refreshInfo }; },
    async getAppUserID() { return { appUserID: appUserID || (restoreInfo && restoreInfo.originalAppUserId) || 'user_1' }; },
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    JSON,
    Math,
    Object,
    Promise,
    String,
    Number,
    Array,
    Error,
    AbortController,
    TextEncoder,
    TextDecoder,
    navigator: {},
    location: { href: 'capacitor://localhost' },
    document: {
      readyState: 'complete',
      documentElement: { classList: makeClassList() },
      addEventListener() {},
    },
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });
      return {
        ok: fetchOk,
        status: fetchOk ? 200 : 503,
        clone() { return this; },
        async text() { return fetchOk ? '{"ok":true}' : '{"ok":false}'; },
      };
    },
  };
  context.window = {
    API_BASE: 'https://example.test',
    FACEMAX_REVENUECAT_API_KEY: 'appl_public_test',
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: { Purchases },
    },
  };
  context.window.window = context.window;
  context.window.document = context.document;
  context.window.navigator = context.navigator;
  context.window.location = context.location;
  context.window.fetch = context.fetch;
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;
  context.window.AbortController = AbortController;
  context.Capacitor = context.window.Capacitor;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: bridgePath });
  return { facemax: context.window.facemax, fetchCalls };
}

class MockKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

async function loadWorker() {
  const source = await fs.readFile(workerPath, 'utf8');
  const tempPath = path.join(os.tmpdir(), `facemax-worker-${process.pid}-${Date.now()}.mjs`);
  await fs.writeFile(tempPath, source);
  const mod = await import(pathToFileURL(tempPath).href + `?v=${Date.now()}`);
  return mod.default;
}

function rcPayload({ product = WEEKLY, expires = new Date(now + 86400000).toISOString(), grace = null, includePremium = true } = {}) {
  return {
    subscriber: {
      entitlements: includePremium ? {
        premium: {
          product_identifier: product,
          expires_date: expires,
          grace_period_expires_date: grace,
          purchase_date: new Date(now - 1000).toISOString(),
        },
      } : {},
    },
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function callWorker(worker, env, pathname, { method = 'GET', body, headers = {} } = {}) {
  const req = new Request('https://worker.test' + pathname, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function testClientRestore() {
  const expired = now - 3600000;
  const future = now + 3 * 86400000;

  {
    const info = { entitlements: { active: {}, all: { premium: { productIdentifier: WEEKLY, expirationDateMillis: expired } } } };
    const { facemax, fetchCalls } = await loadBridge({ restoreInfo: info });
    const result = await facemax.restorePurchases('user_1');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'nothing_to_restore');
    assert.equal(fetchCalls.length, 1, 'inactive restore must reconcile backend, not unlock');
  }

  {
    const info = { entitlements: { active: { other: { productIdentifier: WEEKLY, expirationDateMillis: future } }, all: {} } };
    const { facemax } = await loadBridge({ restoreInfo: info });
    const result = await facemax.restorePurchases('user_1');
    assert.equal(result.error, 'nothing_to_restore', 'unrelated active entitlement must not unlock');
  }

  {
    const info = { entitlements: { active: { premium: { productIdentifier: 'other.app.premium', expirationDateMillis: future } }, all: {} } };
    const { facemax } = await loadBridge({ restoreInfo: info });
    const result = await facemax.restorePurchases('user_1');
    assert.equal(result.error, 'nothing_to_restore', 'unknown product must not unlock premium');
  }

  {
    const info = { entitlements: { active: { premium: { productIdentifier: WEEKLY, expirationDateMillis: expired } }, all: {} } };
    const { facemax } = await loadBridge({ restoreInfo: info });
    const result = await facemax.restorePurchases('user_1');
    assert.equal(result.error, 'nothing_to_restore', 'past expiration in active map must still fail closed');
  }

  {
    const info = { originalAppUserId: '$RCAnonymousID:old', entitlements: { active: { premium: { productIdentifier: YEARLY, expirationDateMillis: future } }, all: {} } };
    const { facemax, fetchCalls } = await loadBridge({ restoreInfo: info, appUserID: '$RCAnonymousID:old' });
    const result = await facemax.restorePurchases('user_1');
    assert.equal(result.ok, true);
    assert.equal(result.premium_until, future);
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0];
    const sent = JSON.parse(call.options.body);
    assert.deepEqual(sent, { user_id: 'user_1', revenuecat_app_user_id: '$RCAnonymousID:old' });
    assert.equal(call.options.headers['X-Client-Sync-Secret'], undefined);
    assert.equal(sent.productId, undefined);
    assert.equal(sent.premium_until, undefined);
  }
}

async function testWorkerSecurity() {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  try {
    const future = now + 5 * 86400000;
    const expired = now - 86400000;

    // No newly-provisioned secret is required: the read-only public iOS key
    // can verify GET /v1/subscribers and mirror the exact RC expiration.
    {
      globalThis.fetch = async (_url, options = {}) => {
        assert.match(String(options.headers.Authorization || ''), /^Bearer appl_/);
        return jsonResponse(rcPayload({ expires: new Date(future).toISOString() }));
      };
      const env = { PREMIUM_KV: new MockKV() };
      const out = await callWorker(worker, env, '/api/apple-receipt-verify', { method: 'POST', body: { user_id: 'user_1', revenuecat_app_user_id: 'user_1' } });
      assert.equal(out.status, 200);
      assert.equal(out.data.premium_until, future);
    }

    // A stale or wrong optional secret falls back to the public read-only key.
    {
      let calls = 0;
      globalThis.fetch = async (_url, options = {}) => {
        calls++;
        const auth = String(options.headers.Authorization || '');
        if (auth.includes('sk_bad')) return jsonResponse({ message: 'invalid key' }, 401);
        return jsonResponse(rcPayload({ expires: new Date(future).toISOString() }));
      };
      const env = { PREMIUM_KV: new MockKV(), REVENUECAT_SECRET_API_KEY: 'sk_bad' };
      const out = await callWorker(worker, env, '/api/apple-receipt-verify', { method: 'POST', body: { user_id: 'fallback_user', revenuecat_app_user_id: 'fallback_user' } });
      assert.equal(out.status, 200);
      assert.equal(calls, 2);
    }

    // Expired RC entitlement wins even if attacker supplies a future date/product.
    {
      globalThis.fetch = async () => jsonResponse(rcPayload({ expires: new Date(expired).toISOString() }));
      const env = { PREMIUM_KV: new MockKV(), REVENUECAT_SECRET_API_KEY: 'sk_test' };
      const out = await callWorker(worker, env, '/api/apple-receipt-verify', {
        method: 'POST',
        body: { user_id: 'user_1', revenuecat_app_user_id: 'user_1', productId: YEARLY, premium_until: now + 365 * 86400000 },
      });
      assert.equal(out.status, 402);
      assert.equal(out.data.error, 'no_active_premium_entitlement');
      const status = await callWorker(worker, env, '/api/premium-status?user_id=user_1');
      assert.equal(status.data.active, false);
    }

    // Active entitlement grants only the exact RevenueCat timestamp.
    {
      globalThis.fetch = async () => jsonResponse(rcPayload({ product: MONTHLY, expires: new Date(future).toISOString() }));
      const env = { PREMIUM_KV: new MockKV(), REVENUECAT_SECRET_API_KEY: 'sk_test' };
      const out = await callWorker(worker, env, '/api/apple-receipt-verify', { method: 'POST', body: { user_id: 'user_2', revenuecat_app_user_id: 'user_2' } });
      assert.equal(out.status, 200);
      assert.equal(out.data.active, true);
      assert.equal(out.data.premium_until, future);
      const status = await callWorker(worker, env, '/api/premium-status?user_id=user_2');
      assert.equal(status.data.premium_until, future);
    }

    // Missing expiration and unknown product cannot manufacture a duration.
    for (const payload of [
      rcPayload({ expires: null }),
      rcPayload({ product: 'other.app.product', expires: new Date(future).toISOString() }),
    ]) {
      globalThis.fetch = async () => jsonResponse(payload);
      const env = { PREMIUM_KV: new MockKV(), REVENUECAT_SECRET_API_KEY: 'sk_test' };
      const out = await callWorker(worker, env, '/api/apple-receipt-verify', { method: 'POST', body: { user_id: 'user_3', revenuecat_app_user_id: 'user_3' } });
      assert.equal(out.status, 402);
      assert.equal(out.data.active, false);
    }

    // A verified RevenueCat customer can be linked to the app's current local
    // account (needed after Sign in with Apple), but cannot be claimed by a
    // second local account afterwards.
    {
      globalThis.fetch = async () => jsonResponse(rcPayload({ expires: new Date(future).toISOString() }));
      const env = { PREMIUM_KV: new MockKV() };
      const first = await callWorker(worker, env, '/api/apple-receipt-verify', { method: 'POST', body: { user_id: 'owner', revenuecat_app_user_id: '$RCAnonymousID:subscriber' } });
      assert.equal(first.status, 200);
      const replay = await callWorker(worker, env, '/api/apple-receipt-verify', { method: 'POST', body: { user_id: 'attacker', revenuecat_app_user_id: '$RCAnonymousID:subscriber' } });
      assert.equal(replay.status, 409);
      assert.equal(replay.data.error, 'revenuecat_customer_already_linked');
    }

    // Webhook auth is enforced when configured; without it, webhook events are
    // still harmless because access is independently re-read from RevenueCat.
    {
      const env = { PREMIUM_KV: new MockKV() };
      const out = await callWorker(worker, env, '/api/revenuecat-webhook', { method: 'POST', body: { event: { type: 'TEST' } } });
      assert.equal(out.status, 200);
      assert.equal(out.data.action, 'ignored');
    }
    {
      const kv = new MockKV();
      const env = { PREMIUM_KV: kv, REVENUECAT_SECRET_API_KEY: 'sk_test', REVENUECAT_WEBHOOK_AUTH: 'Bearer hook-secret' };
      await kv.put('premium:user_4', JSON.stringify({ premium_until: future, source: 'existing' }));
      let fetchCount = 0;
      globalThis.fetch = async () => { fetchCount++; return jsonResponse(rcPayload({ expires: new Date(future).toISOString() })); };

      const cancel = await callWorker(worker, env, '/api/revenuecat-webhook', { method: 'POST', headers: { Authorization: 'Bearer hook-secret' }, body: { event: { type: 'CANCELLATION', app_user_id: 'user_4', product_id: WEEKLY, entitlement_ids: ['premium'] } } });
      assert.equal(cancel.status, 200);
      assert.equal(cancel.data.action, 'retained_until_expiration');
      const afterCancel = await callWorker(worker, env, '/api/premium-status?user_id=user_4');
      assert.equal(afterCancel.data.active, true, 'cancellation must retain access until expiration');
      assert.equal(fetchCount, 0);

      const test = await callWorker(worker, env, '/api/revenuecat-webhook', { method: 'POST', headers: { Authorization: 'Bearer hook-secret' }, body: { event: { type: 'TEST', app_user_id: 'user_4' } } });
      assert.equal(test.data.action, 'ignored');

      globalThis.fetch = async () => jsonResponse(rcPayload({ expires: new Date(expired).toISOString() }));
      const expiration = await callWorker(worker, env, '/api/revenuecat-webhook', { method: 'POST', headers: { Authorization: 'Bearer hook-secret' }, body: { event: { type: 'EXPIRATION', app_user_id: 'user_4', product_id: WEEKLY, entitlement_ids: ['premium'] } } });
      assert.equal(expiration.data.action, 'reconciled');
      const afterExpiration = await callWorker(worker, env, '/api/premium-status?user_id=user_4');
      assert.equal(afterExpiration.data.active, false);

      globalThis.fetch = async () => jsonResponse(rcPayload({ expires: new Date(future).toISOString() }));
      const purchase = await callWorker(worker, env, '/api/revenuecat-webhook', { method: 'POST', headers: { Authorization: 'Bearer hook-secret' }, body: { event: { type: 'INITIAL_PURCHASE', app_user_id: 'user_4', product_id: WEEKLY, entitlement_ids: ['premium'] } } });
      assert.equal(purchase.status, 200);
      assert.equal(purchase.data.action, 'reconciled');
      const afterPurchase = await callWorker(worker, env, '/api/premium-status?user_id=user_4');
      assert.equal(afterPurchase.data.active, true);
      assert.equal(afterPurchase.data.premium_until, future);
    }

    // Every paid server endpoint rejects expired users.
    {
      const env = { PREMIUM_KV: new MockKV() };
      const calls = [
        ['/api/full-report', { method: 'POST', body: { user_id: 'expired_user', image: 'x' } }],
        ['/api/food-scan', { method: 'POST', body: { user_id: 'expired_user', image: 'x' } }],
        ['/api/glow-plan', { method: 'POST', body: { user_id: 'expired_user' } }],
        ['/api/skin-plan', { method: 'POST', body: { user_id: 'expired_user' } }],
        ['/api/jawline-plan', { method: 'POST', body: { user_id: 'expired_user' } }],
        ['/api/dating-photo', { method: 'POST', body: { user_id: 'expired_user' } }],
        ['/api/haircut-guide', { method: 'POST', body: { user_id: 'expired_user' } }],
        ['/api/meal-plan?user_id=expired_user', {}],
        ['/api/meal-plan', { method: 'POST', body: { user_id: 'expired_user', profile: {} } }],
      ];
      for (const [pathname, opts] of calls) {
        const out = await callWorker(worker, env, pathname, opts);
        assert.equal(out.status, 402, `${pathname} must require current premium`);
        assert.equal(out.data.error, 'premium_required');
      }
    }

    // Legacy manual grant endpoints are not usable without a server-only admin secret.
    {
      const env = { PREMIUM_KV: new MockKV() };
      const testGrant = await callWorker(worker, env, '/api/test-grant?user_id=attacker');
      const paymentSuccess = await callWorker(worker, env, '/api/payment-success?user_id=attacker');
      assert.equal(testGrant.status, 404);
      assert.equal(paymentSuccess.status, 404);
      const status = await callWorker(worker, env, '/api/premium-status?user_id=attacker');
      assert.equal(status.data.active, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStaticPaywallAndGates() {
  const html = await fs.readFile(indexPath, 'utf8');
  const bridge = await fs.readFile(bridgePath, 'utf8');
  const worker = await fs.readFile(workerPath, 'utf8');

  const planMatches = [...html.matchAll(/data-internal-plan="(weekly|monthly|yearly)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(planMatches)].sort(), ['monthly', 'weekly', 'yearly']);
  assert.equal((html.match(/data-internal-plan=/g) || []).length, 3, 'internal paywall must contain exactly 3 plan buttons');

  const windowPaidFunctions = [
    'openGlowUpHub', 'openTool', 'openCompare', 'startScan', 'openReport',
    'openDailyHub', 'openFoodScan', 'openCaloriesScreen', 'runFoodScan',
    'openWater', 'openRoutine', 'openExercises', 'openMeals',
  ];
  for (const name of windowPaidFunctions) {
    const start = html.indexOf(`window.${name} = async function`);
    assert.notEqual(start, -1, `${name} must be async and gated`);
    const chunk = html.slice(start, start + 950);
    assert.match(chunk, /ensurePremiumForAction/, `${name} must call the common premium gate`);
  }
  for (const name of ['generateMealPlan', 'startGenderScan']) {
    const start = html.indexOf(`async function ${name}`);
    assert.notEqual(start, -1, `${name} must be async and gated`);
    const chunk = html.slice(start, start + 950);
    assert.match(chunk, /ensurePremiumForAction/, `${name} must call the common premium gate`);
  }

  const quizPaywall = html.match(/<section id="quizPaywall"[\s\S]*?<\/section>/)?.[0] || '';
  assert.equal((quizPaywall.match(/class="qp-plan" data-plan=/g) || []).length, 3, 'quiz paywall must contain exactly 3 plan choices');

  assert.doesNotMatch(bridge, /CLIENT_SYNC_SECRET|X-Client-Sync-Secret/);
  assert.match(bridge, /body:\s*JSON\.stringify\(\{\s*user_id:\s*userId,\s*revenuecat_app_user_id:\s*rcAppUserId\s*\|\|\s*userId\s*\}\)/s);
  assert.doesNotMatch(bridge, /body:\s*JSON\.stringify\(\{[^}]*\b(?:productId|premium_until)\b/s);
  assert.match(worker, /REVENUECAT_PUBLIC_API_KEY/);
  assert.match(bridge, /getAppUserID/);
  assert.doesNotMatch(worker, /nowPlusSubscriptionPlan/);
  assert.match(worker, /productMapping = APPLE_PRODUCT_MAP/);
  assert.match(worker, /bundle_id_mismatch/);

  // The TestFlight startup-race fix must apply before every paid entry point:
  // initRevenueCat waits for the Purchases bridge instead of treating a briefly
  // missing plugin as an inactive subscription and falling back to stale KV.
  assert.match(bridge, /_waitForPlugin\("Purchases",\s*12000\)/);

  // No normal feature action may start a purchase or Restore Purchases by
  // itself. Those calls are reserved for explicit checkout/restore handlers.
  for (const name of [...windowPaidFunctions, 'generateMealPlan', 'startGenderScan']) {
    const patterns = [`window.${name} = async function`, `async function ${name}`];
    const start = patterns.map(p => html.indexOf(p)).find(i => i >= 0);
    const chunk = html.slice(start, start + 2400);
    assert.doesNotMatch(chunk, /facemax\.purchase\s*\(/, `${name} must never initiate a purchase`);
    assert.doesNotMatch(chunk, /restorePurchases\s*\(/, `${name} must never auto-restore purchases`);
    assert.doesNotMatch(chunk, /markPremiumActiveLocally\s*\(/, `${name} must never grant premium locally`);
  }

  // Glow Up Plan used to be the only paid AI flow that treated a server 402 as
  // a generic AI error. It now rechecks RevenueCat, shows the paywall when
  // inactive, and retries only once when the backend mirror is still syncing.
  const glowFetchStart = html.indexOf('async function _fetchAiGlowPlan');
  const glowFetchChunk = html.slice(glowFetchStart, glowFetchStart + 6500);
  assert.match(glowFetchChunk, /res\.status === 402/);
  assert.match(glowFetchChunk, /checkPremium\(false\)/);
  assert.match(glowFetchChunk, /showGate\(/);
  assert.match(glowFetchChunk, /_fetchAiGlowPlan\(last, true\)/);

  // No shipped localStorage/dev override may grant premium, and the legacy
  // arbitrary-user-ID restore path must route to the official StoreKit flow.
  assert.doesNotMatch(html, /FACEMAX_DEV_PREMIUM/);
  assert.doesNotMatch(html, /restoreIdInput/);
  assert.match(html, /window\.restorePurchase\s*=\s*window\.restoreApplePurchases/);
}

await testClientRestore();
await testWorkerSecurity();
await testStaticPaywallAndGates();
console.log('PASS: subscription restore, expiry, webhook, server-gate and 3-plan paywall audit');
