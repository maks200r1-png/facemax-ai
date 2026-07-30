const PREMIUM_DAYS_FULL = 30;
const PREMIUM_DAYS_STARTER = 14;
const PREMIUM_MS_FULL = PREMIUM_DAYS_FULL * 24 * 60 * 60 * 1000;
const PREMIUM_MS_STARTER = PREMIUM_DAYS_STARTER * 24 * 60 * 60 * 1000;
// Back-compat
const PREMIUM_DAYS = PREMIUM_DAYS_FULL;
const PREMIUM_MS = PREMIUM_MS_FULL;


function normalizePlan(raw) {
  return String(raw || "").toLowerCase() === "starter" ? "starter" : "full";
}
function planDurationMs(plan) {
  return normalizePlan(plan) === "starter" ? PREMIUM_MS_STARTER : PREMIUM_MS_FULL;
}

const PREMIUM_ENTITLEMENT_ID = "premium";
const REVENUECAT_API_BASE = "https://api.revenuecat.com/v1";
// RevenueCat officially allows the read-only GET /v1/subscribers endpoint with
// the app-specific public SDK key. Keep a public-key fallback so purchases can
// be mirrored immediately even when no new Cloudflare secret was provisioned.
const REVENUECAT_IOS_PUBLIC_API_KEY = "appl_najSElZgKcUrHaOrJuCQfcFbXpg";
const LIFETIME_PREMIUM_UNTIL = new Date("2099-12-31T00:00:00Z").getTime();

// Store products that are allowed to unlock the `premium` entitlement.
// Product IDs are matched exactly — substring/plan guessing must never grant
// access for an unrelated RevenueCat product.
const APPLE_PRODUCT_MAP = {
  "com.facemaxai.app.weekly":   { plan: "weekly",   isSubscription: true  },
  "com.facemaxai.app.monthly":  { plan: "monthly",  isSubscription: true  },
  "com.facemaxai.app.yearly":   { plan: "yearly",   isSubscription: true  },
  "com.facemaxai.app.lifetime": { plan: "lifetime", isSubscription: false },
};

function planFromProductId(productId) {
  return APPLE_PRODUCT_MAP[String(productId || "")]?.plan || null;
}

function timestampMs(raw) {
  if (raw == null || raw === "") return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Admin-Secret",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function requireAiEmoji(value, field = "emoji") {
  const emoji = String(value || "").trim();
  // The AI must provide the visual marker itself. Never invent a client/server
  // fallback, because that would make an AI-generated card look personalised
  // when its sticker was actually chosen by hardcoded keyword rules.
  if (!emoji || emoji.length > 16 || !/\p{Extended_Pictographic}/u.test(emoji) || /[A-Za-z0-9]/.test(emoji)) {
    throw new Error(`${field} must contain one AI-selected emoji`);
  }
  return emoji;
}

function cleanUrl(raw) {
  let url = String(raw || "").trim().replace(/\s+/g, "");
  if (!url) return "";
  if (!url.startsWith("https://") && !url.startsWith("http://")) url = "https://" + url;
  if (url.startsWith("http://")) url = "https://" + url.replace(/^http:\/\//, "");
  return url;
}

function premiumKey(userId) { return "premium:" + String(userId); }
function revenueCatLinkKey(userId) { return "rc-link:" + String(userId); }
function revenueCatOwnerKey(revenueCatAppUserId) { return "rc-owner:" + String(revenueCatAppUserId); }
function reportKey(userId) { return "report:" + String(userId); }
function scanCountKey(userId) { return "scancount:" + String(userId); }

const FREE_SCAN_LIMIT = 3;
const DAILY_SCAN_LIMIT = 50;

function dailyScanKey(userId, localDate) {
  // Use client-supplied local date (YYYY-MM-DD) so the day resets at local midnight.
  // Fall back to UTC only if client didn't send it.
  const d = (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate))
    ? localDate
    : new Date().toISOString().slice(0, 10);
  return "dailyscans:" + String(userId) + ":" + d;
}

async function checkAndIncrementDailyLimit(env, userId, localDate) {
  if (!env.PREMIUM_KV || !userId) return { allowed: true };
  const key = dailyScanKey(userId, localDate);
  let used = 0;
  try {
    const raw = await env.PREMIUM_KV.get(key);
    if (raw) used = Math.max(0, parseInt(raw, 10) || 0);
  } catch {}
  if (used >= DAILY_SCAN_LIMIT) {
    return { allowed: false, used, limit: DAILY_SCAN_LIMIT };
  }
  // Increment, TTL = 26 hours (covers timezone drift)
  try {
    await env.PREMIUM_KV.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  } catch {}
  return { allowed: true, used: used + 1, limit: DAILY_SCAN_LIMIT };
}

function nowPlusPremium() { return Date.now() + PREMIUM_MS_FULL; }
function nowPlusPlan(plan) { return Date.now() + planDurationMs(plan); }

function getUserIdFromRequest(url, body = {}) {
  return body.user_id || body.userId ||
    url.searchParams.get("user_id") || url.searchParams.get("email") || null;
}

function sanitizeUserId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(s)) return null;
  return s;
}

function sanitizeRevenueCatUserId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s || s.length > 100 || s.includes("/")) return null;
  // Supports both custom IDs and RevenueCat anonymous IDs such as
  // $RCAnonymousID:xxxxxxxx while rejecting control characters.
  if (!/^[a-zA-Z0-9.$:_-]+$/.test(s)) return null;
  return s;
}


async function savePremium(env, userId, until = nowPlusPremium(), source = "unknown") {
  if (!env.PREMIUM_KV) throw new Error("PREMIUM_KV binding is missing");
  if (!userId) throw new Error("user_id is missing");
  const data = {
    user_id: String(userId), active: true, premium: true,
    premium_until: until, source, updated_at: Date.now(),
  };
  await env.PREMIUM_KV.put(premiumKey(userId), JSON.stringify(data));
  return until;
}

async function readScanCount(env, userId) {
  if (!env.PREMIUM_KV) return { ok: false, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, error: "PREMIUM_KV missing" };
  if (!userId) return { ok: false, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, error: "user_id missing" };
  let used = 0;
  try {
    const raw = await env.PREMIUM_KV.get(scanCountKey(userId));
    if (raw) {
      const parsed = JSON.parse(raw);
      used = Math.max(0, Number(parsed.used || 0));
    }
  } catch {}
  return { ok: true, user_id: String(userId), used, limit: FREE_SCAN_LIMIT, remaining: Math.max(0, FREE_SCAN_LIMIT - used) };
}
async function scanCountGet(request, env) {
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, {}));
  if (!userId) return json({ ok: false, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, error: "user_id required" }, 400);
  // Premium users effectively have unlimited budget — surface that to the client.
  const prem = await readPremium(env, userId);
  if (prem.active) return json({ ok: true, user_id: userId, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, premium: true });
  return json(await readScanCount(env, userId));
}
async function scanCountIncrement(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, body));
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  // Premium users don't get counted.
  const prem = await readPremium(env, userId);
  if (prem.active) return json({ ok: true, user_id: userId, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, premium: true });
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);
  const cur = await readScanCount(env, userId);
  const used = (cur.used || 0) + 1;
  const payload = { user_id: String(userId), used, updated_at: Date.now() };
  try { await env.PREMIUM_KV.put(scanCountKey(userId), JSON.stringify(payload)); } catch {}
  return json({ ok: true, user_id: String(userId), used, limit: FREE_SCAN_LIMIT, remaining: Math.max(0, FREE_SCAN_LIMIT - used) });
}

function revenueCatPremiumFromPayload(payload) {
  const entitlement = payload && payload.subscriber && payload.subscriber.entitlements
    ? payload.subscriber.entitlements[PREMIUM_ENTITLEMENT_ID]
    : null;
  if (!entitlement || typeof entitlement !== "object") {
    return { ok: true, active: false, reason: "premium_entitlement_missing" };
  }

  const productId = String(entitlement.product_identifier || "");
  const mapping = APPLE_PRODUCT_MAP[productId];
  if (!mapping) {
    return { ok: true, active: false, reason: "unknown_product_id", product_id: productId || null };
  }

  if (!mapping.isSubscription) {
    // RevenueCat represents a non-consumable/lifetime entitlement with no
    // expiration date. It is accepted only for the exact known lifetime SKU.
    if (entitlement.expires_date == null) {
      return {
        ok: true,
        active: true,
        plan: mapping.plan,
        product_id: productId,
        premium_until: LIFETIME_PREMIUM_UNTIL,
      };
    }
    const lifetimeExpiry = timestampMs(entitlement.expires_date);
    if (lifetimeExpiry > Date.now()) {
      return { ok: true, active: true, plan: mapping.plan, product_id: productId, premium_until: lifetimeExpiry };
    }
    return { ok: true, active: false, reason: "lifetime_entitlement_expired", product_id: productId };
  }

  // During a configured billing grace period RevenueCat still considers the
  // entitlement active. Use the exact later timestamp supplied by RevenueCat;
  // never fabricate `now + plan duration`.
  const expiresAt = timestampMs(entitlement.expires_date);
  const graceEndsAt = timestampMs(entitlement.grace_period_expires_date);
  const premiumUntil = Math.max(expiresAt, graceEndsAt);
  if (!premiumUntil || premiumUntil <= Date.now()) {
    return {
      ok: true,
      active: false,
      reason: "subscription_expired",
      product_id: productId,
      premium_until: premiumUntil || null,
    };
  }

  return {
    ok: true,
    active: true,
    plan: mapping.plan,
    product_id: productId,
    premium_until: premiumUntil,
  };
}

async function fetchRevenueCatPremium(env, appUserId) {
  const apiKeys = [...new Set([
    String(env.REVENUECAT_SECRET_API_KEY || "").trim(),
    String(env.REVENUECAT_PUBLIC_API_KEY || "").trim(),
    String(REVENUECAT_IOS_PUBLIC_API_KEY || "").trim(),
  ].filter(Boolean))];
  if (!apiKeys.length) {
    return { ok: false, status: 503, error: "revenuecat_api_key_not_configured" };
  }
  const safeUserId = sanitizeRevenueCatUserId(appUserId);
  if (!safeUserId) return { ok: false, status: 400, error: "invalid_revenuecat_app_user_id" };

  let lastFailure = null;
  for (let keyIndex = 0; keyIndex < apiKeys.length; keyIndex++) {
    const apiKey = apiKeys[keyIndex];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(REVENUECAT_API_BASE + "/subscribers/" + encodeURIComponent(safeUserId), {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      if (response.ok) {
        return { ...revenueCatPremiumFromPayload(payload), revenuecat_app_user_id: safeUserId };
      }
      lastFailure = {
        ok: false,
        status: response.status,
        error: "revenuecat_lookup_failed",
        detail: payload?.message || payload?.error || text.slice(0, 200) || null,
      };
      // A stale/wrong optional secret must not block the known public read-only
      // key. Retry authentication failures with the next configured key.
      if ((response.status === 401 || response.status === 403) && keyIndex + 1 < apiKeys.length) {
        continue;
      }
      return lastFailure;
    } catch (e) {
      const timedOut = e && e.name === "AbortError";
      lastFailure = {
        ok: false,
        status: 503,
        error: timedOut ? "revenuecat_lookup_timeout" : "revenuecat_lookup_error",
        detail: String(e?.message || e),
      };
      if (keyIndex + 1 < apiKeys.length) continue;
      return lastFailure;
    } finally {
      clearTimeout(timeout);
    }
  }
  return lastFailure || { ok: false, status: 503, error: "revenuecat_lookup_error" };
}

async function reconcileRevenueCatPremium(env, userId, revenueCatAppUserId = userId) {
  const safeUserId = sanitizeUserId(userId);
  const safeRevenueCatId = sanitizeRevenueCatUserId(revenueCatAppUserId);
  if (!safeUserId || !safeRevenueCatId) return { ok: false, status: 400, error: "invalid_user_id" };
  if (!env.PREMIUM_KV) return { ok: false, status: 500, error: "PREMIUM_KV missing" };

  // RevenueCat may still be operating under the install ID that was active when
  // its SDK was configured, while FaceMax later switches to Sign in with Apple.
  // Bind that RevenueCat customer to one local account once an active entitlement
  // is independently verified. The reverse owner record blocks reuse elsewhere.
  const existingLink = await env.PREMIUM_KV.get(revenueCatLinkKey(safeUserId));
  const existingOwner = await env.PREMIUM_KV.get(revenueCatOwnerKey(safeRevenueCatId));
  if (existingLink && existingLink !== safeRevenueCatId) {
    return { ok: false, status: 409, error: "revenuecat_link_mismatch" };
  }
  if (existingOwner && existingOwner !== safeUserId) {
    return { ok: false, status: 409, error: "revenuecat_customer_already_linked" };
  }

  const status = await fetchRevenueCatPremium(env, safeRevenueCatId);
  if (!status.ok) return status;

  if (status.active) {
    if (!existingLink) await env.PREMIUM_KV.put(revenueCatLinkKey(safeUserId), safeRevenueCatId);
    if (!existingOwner) await env.PREMIUM_KV.put(revenueCatOwnerKey(safeRevenueCatId), safeUserId);
    await savePremium(env, safeUserId, status.premium_until, "revenuecat-verified:" + status.plan);
  } else {
    // Only an already-linked RevenueCat customer (or the same ID) may clear a
    // local grant. An arbitrary inactive ID must not be able to revoke access.
    if (safeRevenueCatId === safeUserId || existingLink === safeRevenueCatId) {
      await savePremium(env, safeUserId, Date.now() - 1000, "revenuecat-verified-inactive");
    }
  }
  return { ...status, user_id: safeUserId, revenuecat_app_user_id: safeRevenueCatId };
}

async function revenueCatWebhook(request, env) {
  // RevenueCat's Authorization header is optional in its dashboard. When a
  // secret is configured we enforce it; when it is absent, the webhook still
  // cannot grant/revoke by itself because every state change is re-read from
  // RevenueCat's GET /subscribers endpoint below.
  const expected = String(env.REVENUECAT_WEBHOOK_AUTH || "").trim();
  const auth = String(request.headers.get("Authorization") || "").trim();
  if (expected && auth !== expected) return json({ ok: false, error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const event = body && body.event;
  if (!event) return json({ ok: false, error: "No event" }, 400);

  const type = String(event.type || "").toUpperCase();
  const productId = String(event.product_id || "");
  const entitlementIds = Array.isArray(event.entitlement_ids)
    ? event.entitlement_ids.map(String)
    : (event.entitlement_id ? [String(event.entitlement_id)] : []);
  const isPremiumEvent = entitlementIds.length
    ? entitlementIds.includes(PREMIUM_ENTITLEMENT_ID)
    : !!APPLE_PRODUCT_MAP[productId];

  // Test/analytics-only events never alter access.
  if (type === "TEST" || type === "SUBSCRIBER_ALIAS") {
    return json({ ok: true, action: "ignored", type });
  }

  // Cancellation and billing failure do not necessarily end access. The user
  // retains entitlement until RevenueCat emits EXPIRATION (or until the exact
  // entitlement timestamp expires), including during a configured grace period.
  if (type === "CANCELLATION" || type === "BILLING_ISSUE") {
    return json({ ok: true, action: "retained_until_expiration", type });
  }

  const ids = [
    event.app_user_id,
    event.original_app_user_id,
    ...(Array.isArray(event.aliases) ? event.aliases : []),
    ...(Array.isArray(event.transferred_to) ? event.transferred_to : []),
    ...(Array.isArray(event.transferred_from) ? event.transferred_from : []),
  ].map(sanitizeUserId).filter(Boolean);
  const allIds = [...new Set(ids)];

  const REVOKE = new Set(["EXPIRATION", "REFUND"]);
  const RECONCILE = new Set([
    "INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION",
    "SUBSCRIPTION_EXTENDED", "NON_RENEWING_PURCHASE",
    "TEMPORARY_ENTITLEMENT_GRANT", "REFUND_REVERSED", "TRANSFER",
  ]);

  if (REVOKE.has(type)) {
    if (!isPremiumEvent) {
      return json({ ok: true, action: "ignored_non_premium", type, product_id: productId || null });
    }
    if (!allIds.length) return json({ ok: true, action: "ignored_no_valid_user", type });
    const results = [];
    for (const uid of allIds) {
      const result = await reconcileRevenueCatPremium(env, uid, uid);
      results.push({ user_id: uid, active: !!result.active, error: result.error || null });
      if (!result.ok && result.status >= 500) {
        return json({ ok: false, error: result.error, type, results }, result.status || 503);
      }
    }
    return json({ ok: true, action: "reconciled", type, results });
  }

  if (RECONCILE.has(type)) {
    if (type !== "TRANSFER" && !isPremiumEvent) {
      return json({ ok: true, action: "ignored_non_premium", type, product_id: productId || null });
    }
    if (!allIds.length) return json({ ok: true, action: "ignored_no_valid_user", type });

    const results = [];
    for (const uid of allIds) {
      const result = await reconcileRevenueCatPremium(env, uid, uid);
      results.push({ user_id: uid, active: !!result.active, error: result.error || null });
      if (!result.ok && result.status >= 500) {
        // RevenueCat retries non-2xx webhooks, so surface temporary verification
        // failures instead of acknowledging a grant we could not verify.
        return json({ ok: false, error: result.error, type, results }, result.status || 503);
      }
    }
    return json({ ok: true, action: "reconciled", type, results });
  }

  return json({ ok: true, action: "ignored", type });
}

async function deleteAccount(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, body));
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);
  const keys = [premiumKey(userId), reportKey(userId), scanCountKey(userId)];
  await Promise.all(keys.map((k) => env.PREMIUM_KV.delete(k).catch(() => {})));
  return json({ ok: true, user_id: String(userId), deleted: keys });
}

async function readPremium(env, userId) {
  if (!env.PREMIUM_KV) return { active: false, premium: false, error: "PREMIUM_KV missing" };
  if (!userId) return { active: false, premium: false, error: "user_id missing" };
  const raw = await env.PREMIUM_KV.get(premiumKey(userId));
  if (!raw) return { active: false, premium: false, user_id: String(userId), premium_until: null };
  try {
    const data = JSON.parse(raw);
    const until = Number(data.premium_until || data.premium_до || 0);
    const active = until > Date.now();
    return { active, premium: active, user_id: String(userId), premium_until: until, source: data.source || null };
  } catch {
    return { active: false, premium: false, user_id: String(userId), error: "bad premium json" };
  }
}


// ==================== REFERRALS ====================

const REFERRAL_FRIENDS_NEEDED = 3;
const REFERRAL_REWARD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days premium reward

// Anti-abuse: only Apple Sign-In verified accounts can participate. Anonymous
// client-generated IDs (facemax_uid, stored in localStorage) reset trivially —
// clearing storage or reinstalling mints a brand-new one — so allowing them
// here would let one person "invite" themselves repeatedly. appleSignIn()
// always issues IDs as "apple_" + Apple's stable `sub` claim, which survives
// reinstalls and requires a real, distinct Apple ID to change.
function isVerifiedReferralUser(userId) {
  return typeof userId === "string" && userId.startsWith("apple_");
}

function referralCodeKey(userId) { return "refcode:" + String(userId); }       // code -> owner lookup
function referralOwnerKey(userId) { return "refowner:" + String(userId); }     // owner -> code + stats
function referralRedeemedKey(userId) { return "refredeemed:" + String(userId); } // friend -> already redeemed?

// Short code drawn from a CSPRNG (crypto.getRandomValues), not Math.random —
// codes are user-facing and guessing one lets a stranger redeem against an
// owner without ever seeing their share link, so they need real entropy.
// userId is folded in only to vary the salt across retries for the same user.
function generateReferralCode(userId, salt) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const randomPart = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = String(userId) + ":" + String(salt) + ":" + randomPart;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(6, "0").slice(0, 6);
}

// Get or create this user's referral code + stats record.
async function getOrCreateReferralOwner(env, userId) {
  const raw = await env.PREMIUM_KV.get(referralOwnerKey(userId));
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }

  // Create a fresh code, retrying on collision. With a 6-char base36 code
  // (36^6 ≈ 2.2B combinations) collisions are rare, but at scale they will
  // happen eventually, so this must not silently give up — it throws
  // instead of ever handing out a code that might collide.
  const MAX_CODE_ATTEMPTS = 10;
  let code = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const candidate = generateReferralCode(userId, attempt);
    const existingOwner = await env.PREMIUM_KV.get(referralCodeKey(candidate));
    if (!existingOwner) { code = candidate; break; }
  }
  if (!code) throw new Error("referral_code_generation_exhausted");

  const record = {
    user_id: String(userId),
    code,
    redeemed_count: 0,
    rewards_granted: 0,
    friends: [], // list of friend user_ids who successfully redeemed
    created_at: Date.now(),
  };

  // Reserve the code first, then the owner record. If a concurrent request
  // for the same brand-new user raced us here, re-read the owner record
  // after writing — if one now exists and it isn't ours, someone else's
  // call won; return their record instead of leaving two owner records
  // pointing at two different codes for the same user.
  await env.PREMIUM_KV.put(referralCodeKey(code), String(userId));
  const raceCheck = await env.PREMIUM_KV.get(referralOwnerKey(userId));
  if (raceCheck) {
    try {
      const existing = JSON.parse(raceCheck);
      if (existing && existing.code && existing.code !== code) {
        // Someone else's concurrent call already created the real record.
        // Release the code we reserved so it doesn't sit orphaned.
        await env.PREMIUM_KV.delete(referralCodeKey(code));
        return existing;
      }
    } catch {}
  }
  await env.PREMIUM_KV.put(referralOwnerKey(userId), JSON.stringify(record));
  return record;
}

async function referralCodeGet(request, env) {
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, {}));
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);
  if (!isVerifiedReferralUser(userId)) {
    return json({ ok: false, error: "sign_in_required", message: "Sign in with Apple to get your invite code" }, 403);
  }
  let owner;
  try {
    owner = await getOrCreateReferralOwner(env, userId);
  } catch (err) {
    return json({ ok: false, error: "code_generation_failed", detail: String(err.message || err) }, 500);
  }
  return json({
    ok: true,
    user_id: userId,
    code: owner.code,
    redeemed_count: owner.redeemed_count,
    friends_needed: REFERRAL_FRIENDS_NEEDED,
  });
}

async function referralRedeem(request, env) {
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);
  let body = {};
  try { body = await request.json(); } catch {}
  const url = new URL(request.url);
  const friendId = sanitizeUserId(getUserIdFromRequest(url, body));
  const code = String(body.code || url.searchParams.get("code") || "").trim().toUpperCase();

  if (!friendId) return json({ ok: false, error: "user_id required" }, 400);
  if (!code) return json({ ok: false, error: "code required" }, 400);
  if (!isVerifiedReferralUser(friendId)) {
    // Anonymous (pre-Apple-Sign-In) IDs reset for free on every reinstall /
    // storage clear, so redemption is only allowed once the friend has a
    // stable, real Apple ID — this is the main anti-farming control.
    return json({ ok: false, error: "sign_in_required", message: "Sign in with Apple first to redeem a code" }, 403);
  }

  // Has this user (the friend) already redeemed any code? One redemption per
  // account, ever — prevents a single new install farming multiple codes.
  const alreadyRaw = await env.PREMIUM_KV.get(referralRedeemedKey(friendId));
  if (alreadyRaw) {
    return json({ ok: false, error: "already_redeemed" }, 409);
  }

  const ownerId = await env.PREMIUM_KV.get(referralCodeKey(code));
  if (!ownerId) return json({ ok: false, error: "invalid_code" }, 404);
  if (String(ownerId) === String(friendId)) {
    return json({ ok: false, error: "cannot_redeem_own_code" }, 400);
  }

  // Claim this friend's redemption slot FIRST, before touching the owner
  // record. KV has no native compare-and-swap, so we can't lock the owner
  // record itself — but we *can* make the friend-side claim race-safe by
  // re-reading it right after writing and confirming we're the one who
  // wrote it. Two truly simultaneous requests from the same friendId are
  // vanishingly rare (same account, same instant) but this closes that gap
  // rather than assuming it away.
  const claimToken = friendId + ":" + Date.now() + ":" + Math.random().toString(36).slice(2);
  await env.PREMIUM_KV.put(referralRedeemedKey(friendId), JSON.stringify({
    owner_id: String(ownerId), code, redeemed_at: Date.now(), claim_token: claimToken,
  }));
  const verifyClaim = await env.PREMIUM_KV.get(referralRedeemedKey(friendId));
  let claimed;
  try { claimed = JSON.parse(verifyClaim); } catch { claimed = null; }
  if (!claimed || claimed.claim_token !== claimToken) {
    // Another concurrent request won the write race for this friendId.
    return json({ ok: false, error: "already_redeemed" }, 409);
  }

  // Read-modify-write the owner record with a bounded retry loop: if another
  // redemption for the SAME owner lands between our read and our write, our
  // write would silently clobber theirs (KV has no CAS). Re-reading and
  // retrying closes that window in all but a genuine last-instant collision,
  // which is far better than the previous single read-then-write.
  let owner = null;
  let rewardGranted = false;
  let premiumUntil = null;
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ownerRaw = await env.PREMIUM_KV.get(referralOwnerKey(ownerId));
    try { owner = JSON.parse(ownerRaw); } catch { owner = null; }
    if (!owner) {
      // Owner record vanished between code lookup and here — refund the
      // friend's claim so they aren't permanently locked out for nothing.
      await env.PREMIUM_KV.delete(referralRedeemedKey(friendId));
      return json({ ok: false, error: "owner_record_missing" }, 500);
    }

    const countBefore = owner.redeemed_count || 0;
    owner.redeemed_count = countBefore + 1;
    owner.friends = Array.isArray(owner.friends) ? owner.friends : [];
    owner.friends.push(String(friendId));

    rewardGranted = false;
    premiumUntil = null;
    // Grant a reward every time the owner racks up another full set of
    // REFERRAL_FRIENDS_NEEDED redemptions (3, 6, 9, ...).
    if (owner.redeemed_count % REFERRAL_FRIENDS_NEEDED === 0) {
      owner.rewards_granted = (owner.rewards_granted || 0) + 1;
      const existingPremium = await readPremium(env, ownerId);
      const base = existingPremium.active ? existingPremium.premium_until : Date.now();
      premiumUntil = await savePremium(env, ownerId, base + REFERRAL_REWARD_MS, "referral_reward");
      rewardGranted = true;
    }

    await env.PREMIUM_KV.put(referralOwnerKey(ownerId), JSON.stringify(owner));

    // Verify our write actually stuck as the latest value (nothing else
    // overwrote it in between our read and our put). If it did get
    // clobbered, retry the whole read-modify-write from a fresh read.
    const checkRaw = await env.PREMIUM_KV.get(referralOwnerKey(ownerId));
    let check;
    try { check = JSON.parse(checkRaw); } catch { check = null; }
    const checkFriends = check && Array.isArray(check.friends) ? check.friends : [];
    const weAreLatest = check && check.redeemed_count === owner.redeemed_count
      && checkFriends[checkFriends.length - 1] === String(friendId);
    if (weAreLatest) break;
    if (attempt === MAX_ATTEMPTS - 1) {
      // Exhausted retries under heavy concurrent load on this exact owner.
      // The friend's claim is already committed (they won't be double-
      // charged), but we can't confidently report the owner's new count.
      // Surface success without over-claiming reward state.
      break;
    }
  }

  return json({
    ok: true,
    friend_id: friendId,
    owner_id: String(ownerId),
    owner_redeemed_count: owner.redeemed_count,
    reward_granted: rewardGranted,
    premium_until: premiumUntil,
  });
}

async function referralStatus(request, env) {
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, {}));
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);
  if (!isVerifiedReferralUser(userId)) {
    return json({ ok: false, error: "sign_in_required", message: "Sign in with Apple to see your invite progress" }, 403);
  }
  let owner;
  try {
    owner = await getOrCreateReferralOwner(env, userId);
  } catch (err) {
    return json({ ok: false, error: "code_generation_failed", detail: String(err.message || err) }, 500);
  }
  const inThisCycle = owner.redeemed_count % REFERRAL_FRIENDS_NEEDED;
  return json({
    ok: true,
    user_id: userId,
    code: owner.code,
    redeemed_count: owner.redeemed_count,
    rewards_granted: owner.rewards_granted || 0,
    friends_needed: REFERRAL_FRIENDS_NEEDED,
    progress_in_current_cycle: inThisCycle,
    remaining_for_next_reward: (REFERRAL_FRIENDS_NEEDED - inThisCycle) % REFERRAL_FRIENDS_NEEDED || REFERRAL_FRIENDS_NEEDED,
    friends: owner.friends || [],
  });
}

// ==================== APPLE STOREKIT ====================


/// Decode the payload of a JWS *without* verifying the signature. Kept for
/// callers that have already verified the signature separately (or as a
/// last-resort fallback, see verifyAndDecodeAppleJWS below).
function decodeAppleJWSPayload(jws) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw new Error("invalid_jws_format");
  const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
  const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(decoded);
}

function decodeJWSHeader(jws) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw new Error("invalid_jws_format");
  const padded = parts[0] + "===".slice((parts[0].length + 3) % 4);
  const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(decoded);
}

function b64urlToBytes(b64url) {
  const padded = b64url + "===".slice((b64url.length + 3) % 4);
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- Minimal DER reader, just enough to pull apart X.509 certs ----
function derTLV(buf, offset) {
  const tag = buf[offset];
  const lenByte = buf[offset + 1];
  let length, lenBytes;
  if (lenByte & 0x80) {
    const numBytes = lenByte & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 2 + i];
    lenBytes = 1 + numBytes;
  } else {
    length = lenByte;
    lenBytes = 1;
  }
  const contentStart = offset + 1 + lenBytes;
  const contentEnd = contentStart + length;
  return { tag, start: offset, contentStart, contentEnd, end: contentEnd };
}
function derChildren(buf, start, end) {
  const out = [];
  let o = start;
  while (o < end) {
    const t = derTLV(buf, o);
    out.push(t);
    o = t.end;
  }
  return out;
}

// Convert a DER-encoded ECDSA signature (SEQUENCE of two INTEGERs) into the
// fixed-length raw r||s format that WebCrypto's ECDSA verify expects.
function derEcdsaSigToRaw(der, sizeBytes = 32) {
  const top = derTLV(der, 0);
  const [rTlv, sTlv] = derChildren(der, top.contentStart, top.contentEnd);
  const toFixed = (tlv) => {
    let bytes = der.slice(tlv.contentStart, tlv.contentEnd);
    while (bytes.length > sizeBytes && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes.length > sizeBytes) throw new Error("integer_too_large");
    const out = new Uint8Array(sizeBytes);
    out.set(bytes, sizeBytes - bytes.length);
    return out;
  };
  const r = toFixed(rTlv), s = toFixed(sTlv);
  const raw = new Uint8Array(sizeBytes * 2);
  raw.set(r, 0); raw.set(s, sizeBytes);
  return raw;
}

// Parse a DER X.509 certificate into the pieces we need to (a) verify it was
// signed by the next cert up the chain, and (b) use its public key.
function parseX509(der) {
  const cert = derTLV(der, 0);
  const [tbs, , sigVal] = derChildren(der, cert.contentStart, cert.contentEnd);
  const tbsBytes = der.slice(tbs.start, tbs.end);
  // signatureValue is a BIT STRING; first content byte = unused-bit count (0).
  const sigDer = der.slice(sigVal.contentStart + 1, sigVal.contentEnd);
  const tbsChildren = derChildren(der, tbs.contentStart, tbs.contentEnd);
  const hasVersionTag = tbsChildren[0] && tbsChildren[0].tag === 0xa0;
  const spkiTlv = tbsChildren[hasVersionTag ? 6 : 5];
  const spkiBytes = der.slice(spkiTlv.start, spkiTlv.end);
  return { tbsBytes, signatureDer: sigDer, spkiBytes };
}

async function importP256PublicKey(spkiBytes) {
  return crypto.subtle.importKey("spki", spkiBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

// Verify the x5c certificate chain embedded in a JWS header against a pinned
// Apple root certificate, and return the leaf's public CryptoKey on success.
// trustedRootB64 must be the *DER* bytes of Apple's "Apple Root CA - G3"
// certificate, base64-encoded (set via the APPLE_ROOT_CA_B64 secret/var).
async function verifyX5cChain(x5cBase64List, trustedRootB64) {
  if (!Array.isArray(x5cBase64List) || x5cBase64List.length < 2) {
    throw new Error("x5c_missing_or_too_short");
  }
  const certsDer = x5cBase64List.map(b64ToBytes);
  const parsed = certsDer.map(parseX509);

  // Each cert (except the last we have) must be signed by the next one up.
  for (let i = 0; i < parsed.length - 1; i++) {
    const issuerKey = await importP256PublicKey(parsed[i + 1].spkiBytes);
    const rawSig = derEcdsaSigToRaw(parsed[i].signatureDer);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, issuerKey, rawSig, parsed[i].tbsBytes
    );
    if (!ok) throw new Error("chain_signature_invalid_at_" + i);
  }

  // Pin the top of the chain to Apple's real root, byte-for-byte.
  if (!trustedRootB64) throw new Error("apple_root_ca_not_configured");
  const trustedRootDer = b64ToBytes(trustedRootB64);
  const lastDer = certsDer[certsDer.length - 1];
  const lastIsRoot = lastDer.length === trustedRootDer.length &&
    lastDer.every((b, i) => b === trustedRootDer[i]);
  if (!lastIsRoot) {
    // Chain didn't include the root itself (common — Apple often sends only
    // leaf+intermediate). Verify the last cert we *do* have was signed by
    // the pinned root before trusting it.
    const rootParsed = parseX509(trustedRootDer);
    const rootKey = await importP256PublicKey(rootParsed.spkiBytes);
    const lastParsed = parsed[parsed.length - 1];
    const rawSig = derEcdsaSigToRaw(lastParsed.signatureDer);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, rootKey, rawSig, lastParsed.tbsBytes
    );
    if (!ok) throw new Error("chain_does_not_root_at_apple");
  }

  return importP256PublicKey(parsed[0].spkiBytes); // leaf's public key
}

async function verifyJWSSignatureWithKey(jws, publicKey) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw new Error("invalid_jws_format");
  const signingInput = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const sigRaw = b64urlToBytes(parts[2]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sigRaw, signingInput);
}

// The one function callers should use: verifies the JWS was actually signed
// by Apple (chain-of-trust to the pinned root) before returning its payload.
// Throws if signature verification fails or can't be performed. If
// APPLE_ROOT_CA_B64 isn't configured yet, this throws too — callers must not
// silently fall back to trusting an unverified payload for real money flows.
async function verifyAndDecodeAppleJWS(jws, env) {
  const header = decodeJWSHeader(jws);
  const x5c = header.x5c;
  if (!x5c) throw new Error("jws_missing_x5c");
  const leafKey = await verifyX5cChain(x5c, String(env.APPLE_ROOT_CA_B64 || "").trim());
  const sigOk = await verifyJWSSignatureWithKey(jws, leafKey);
  if (!sigOk) throw new Error("jws_signature_invalid");
  return decodeAppleJWSPayload(jws);
}

// ==================== APPLE ID TOKEN VERIFICATION (Sign in with Apple) ====================
//
// Verifies the identity_token JWT that Sign in with Apple hands the client is
// actually signed by Apple, instead of just trusting the decoded payload.
// Without this, anyone can POST a hand-crafted JWT with iss=appleid.apple.com
// and any `sub` they like, and the server would mint them a fully "verified"
// apple_* account — defeating the anti-abuse checks the referral system
// relies on (isVerifiedReferralUser()).
//
// Flow: fetch Apple's JWKS, find the key matching the JWT header's `kid`,
// import it as an RSA public key, verify the RS256 signature over the JWT's
// signing input, then check iss/aud/exp on the (now-trusted) payload.

const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_JWKS_CACHE_KEY = "apple_jwks_cache_v1";
const APPLE_JWKS_CACHE_MS = 6 * 60 * 60 * 1000; // Apple rotates keys rarely; 6h cache is safe

// Fetch Apple's JWKS, cached in KV so we're not round-tripping to Apple on
// every sign-in. Falls back to a live fetch if KV is unavailable or empty.
async function getAppleJWKS(env) {
  if (env.PREMIUM_KV) {
    try {
      const cachedRaw = await env.PREMIUM_KV.get(APPLE_JWKS_CACHE_KEY);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (cached.fetched_at && Date.now() - cached.fetched_at < APPLE_JWKS_CACHE_MS) {
          return cached.keys;
        }
      }
    } catch {}
  }

  // Explicit timeout: without this, a stalled/slow connection to Apple here
  // blocks the whole /api/auth/apple response, which in turn hangs the
  // client's Sign in with Apple screen forever (the client fetch has its
  // own timeout now too, but failing fast on the server side is what
  // actually lets the worker recover and serve the next request cleanly).
  const controller = new AbortController();
  const jwksTimeout = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(APPLE_JWKS_URL, { signal: controller.signal });
  } catch (err) {
    throw new Error("apple_jwks_fetch_timeout_or_error: " + (err && err.message || err));
  } finally {
    clearTimeout(jwksTimeout);
  }
  if (!res.ok) throw new Error("apple_jwks_fetch_failed_" + res.status);
  const data = await res.json();
  const keys = Array.isArray(data.keys) ? data.keys : [];

  if (env.PREMIUM_KV) {
    try {
      await env.PREMIUM_KV.put(APPLE_JWKS_CACHE_KEY, JSON.stringify({ keys, fetched_at: Date.now() }));
    } catch {}
  }
  return keys;
}

// Import an RSA JWK (Apple's keys are RS256) as a Web Crypto public key.
async function importRsaJwk(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

// Verifies an Apple identity_token's RS256 signature via Apple's published
// JWKS, then validates standard claims. Returns the trusted payload, or
// throws on any failure — callers must never fall back to an unverified
// decode for anything security-relevant (auth, referral eligibility).
async function verifyAppleIdentityToken(identityToken, env, expectedAudiences) {
  const parts = String(identityToken || "").split(".");
  if (parts.length !== 3) throw new Error("invalid_jwt_format");
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    throw new Error("invalid_jwt_encoding");
  }

  if (header.alg !== "RS256") throw new Error("unsupported_jwt_alg_" + header.alg);
  if (!header.kid) throw new Error("jwt_missing_kid");

  // Look up the matching key, refreshing the cache once if it's not found
  // (covers the case where Apple rotated keys since our last cache fetch).
  let keys = await getAppleJWKS(env);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    if (env.PREMIUM_KV) {
      try { await env.PREMIUM_KV.delete(APPLE_JWKS_CACHE_KEY); } catch {}
    }
    keys = await getAppleJWKS(env);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("apple_signing_key_not_found");

  const publicKey = await importRsaJwk(jwk);
  const signingInput = new TextEncoder().encode(headerB64 + "." + payloadB64);
  const signature = b64urlToBytes(sigB64);
  const sigOk = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" }, publicKey, signature, signingInput
  );
  if (!sigOk) throw new Error("jwt_signature_invalid");

  // Standard claim checks, now that we trust the payload came from Apple.
  if (payload.iss !== "https://appleid.apple.com") throw new Error("invalid_issuer");
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) throw new Error("token_expired");
  if (Array.isArray(expectedAudiences) && expectedAudiences.length > 0) {
    const aud = payload.aud;
    const audMatches = expectedAudiences.includes(aud);
    if (!audMatches) throw new Error("invalid_audience");
  }
  if (!payload.sub) throw new Error("missing_sub");

  return payload;
}

const APPLE_BUNDLE_ID_DEFAULT = "ai.facemax.app";

async function verifyAppleReceipt(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, body));
  if (!userId) return json({ ok: false, error: "user_id is missing or invalid" }, 400);

  const jws = String(body.transaction_jws || body.jws || "").trim();
  if (!jws) {
    // Purchase/restore sync: the app sends only its current App User ID. The
    // worker independently reads the `premium` entitlement from RevenueCat
    // using a server-only secret key. Client-supplied product IDs, dates and
    // bundled "shared secrets" are deliberately ignored.
    const revenueCatAppUserId = sanitizeRevenueCatUserId(body.revenuecat_app_user_id || body.revenueCatAppUserId || userId);
    const result = await reconcileRevenueCatPremium(env, userId, revenueCatAppUserId);
    if (!result.ok) return json({ ok: false, error: result.error, detail: result.detail || null }, result.status || 503);
    if (!result.active) {
      return json({
        ok: false,
        active: false,
        premium: false,
        error: "no_active_premium_entitlement",
        user_id: userId,
        product_id: result.product_id || null,
        premium_until: result.premium_until || null,
      }, 402);
    }
    return json({
      ok: true,
      active: true,
      premium: true,
      user_id: userId,
      plan: result.plan,
      productId: result.product_id,
      premium_until: result.premium_until,
      expires_iso: new Date(result.premium_until).toISOString(),
      source: "revenuecat-server-verified",
    });
  }

  let payload;
  try {
    payload = await verifyAndDecodeAppleJWS(jws, env);
  } catch (e) {
    return json({ ok: false, error: "jws_verify_failed", detail: String(e && e.message || e) }, 400);
  }

  const expectedBundleId = String(env.APPLE_BUNDLE_ID || APPLE_BUNDLE_ID_DEFAULT).trim();
  if (payload.bundleId && payload.bundleId !== expectedBundleId) {
    return json({
      ok: false,
      error: "bundle_id_mismatch",
      expected: expectedBundleId,
      got: payload.bundleId,
    }, 400);
  }

  const transactionUserId = sanitizeUserId(payload.appAccountToken || null);
  if (!transactionUserId || transactionUserId !== userId) {
    return json({ ok: false, error: "app_account_token_mismatch" }, 400);
  }

  const productId = String(payload.productId || "");
  const mapping = APPLE_PRODUCT_MAP[productId];
  if (!mapping) {
    return json({ ok: false, error: "unknown_product_id", productId }, 400);
  }

  const now = Date.now();
  let until;
  if (mapping.isSubscription) {
    const expires = Number(payload.expiresDate || 0);
    if (!expires) {
      return json({ ok: false, error: "missing_expires_date", payload }, 400);
    }
    if (expires < now) {
      return json({ ok: false, error: "transaction_expired", expires_iso: new Date(expires).toISOString() }, 400);
    }
    until = expires;
  } else {
    // Lifetime: park entitlement at a far-future timestamp (year 2099).
    until = LIFETIME_PREMIUM_UNTIL;
  }

  await savePremium(env, userId, until, "apple-storekit:" + mapping.plan);

  return json({
    ok: true,
    active: true,
    premium: true,
    user_id: String(userId),
    plan: mapping.plan,
    productId,
    premium_until: until,
    expires_iso: new Date(until).toISOString(),
    source: "apple-storekit",
  });
}

// ==================== APPLE SERVER NOTIFICATIONS (S2S) ====================

/// Apple sends signedPayload (a JWS) to this endpoint for every renewal,
/// expiry, refund, etc. Both the outer notification and nested transaction
/// JWS values are verified against Apple's certificate chain before use.
///
/// Notification types handled:
///   EXPIRED / GRACE_PERIOD_EXPIRED / REVOKED / REFUND — revoke access
///   DID_FAIL_TO_RENEW / billing retry                  — keep exact existing expiry
///   DID_RENEW / SUBSCRIBED / OFFER_REDEEMED            — use Apple's exact expiresDate
///   PRICE_INCREASE_CONSENT / TEST / others             — acknowledge only
async function appleServerNotification(request, env) {
  const body = await request.json().catch(() => ({}));
  const signedPayload = String(body.signedPayload || "").trim();
  if (!signedPayload) return json({ ok: false, error: "signedPayload_missing" }, 400);

  let notification;
  try {
    notification = await verifyAndDecodeAppleJWS(signedPayload, env);
  } catch (e) {
    return json({ ok: false, error: "notification_verify_failed", detail: String(e && e.message || e) }, 400);
  }

  const notifType = String(notification.notificationType || "").toUpperCase();
  const subtype   = String(notification.subtype || "").toUpperCase();
  const data = notification.data || {};

  let transactionPayload = null;
  if (data.signedTransactionInfo) {
    try { transactionPayload = await verifyAndDecodeAppleJWS(data.signedTransactionInfo, env); } catch (_) {}
  }
  let renewalPayload = null;
  if (data.signedRenewalInfo) {
    try { renewalPayload = await verifyAndDecodeAppleJWS(data.signedRenewalInfo, env); } catch (_) {}
  }

  const productId = transactionPayload?.productId || null;
  const originalTransactionId = transactionPayload?.originalTransactionId || null;
  const productMapping = APPLE_PRODUCT_MAP[String(productId || "")] || null;

  // A valid Apple-signed notification for another app/product must not alter
  // FaceMax access. Check the exact bundle and exact premium product IDs.
  const expectedBundleId = String(env.APPLE_BUNDLE_ID || APPLE_BUNDLE_ID_DEFAULT).trim();
  const observedBundleId = String(transactionPayload?.bundleId || data.bundleId || "").trim();
  if (observedBundleId && observedBundleId !== expectedBundleId) {
    return json({ ok: false, error: "bundle_id_mismatch", expected: expectedBundleId, got: observedBundleId }, 400);
  }

  // Resolve appAccountToken → our user_id.
  // Apple puts the RevenueCat / our app-supplied UUID in appAccountToken.
  const appAccountToken = transactionPayload?.appAccountToken || null;
  const userId = appAccountToken ? sanitizeUserId(appAccountToken) : null;

  // --- Revoke events (cancel, expire, refund) ---
  const REVOKE_TYPES = new Set([
    "EXPIRED", "GRACE_PERIOD_EXPIRED", "REVOKED", "REFUND",
  ]);

  // --- Renewal / new subscription events ---
  const RENEW_TYPES = new Set([
    "DID_RENEW", "SUBSCRIBED", "OFFER_REDEEMED", "DID_CHANGE_RENEWAL_STATUS",
  ]);

  let action = "noop";

  if (userId && productMapping && REVOKE_TYPES.has(notifType)) {
    // Immediately expire premium on server so /api/premium-status reflects reality.
    try {
      await savePremium(env, userId, Date.now() - 1, "apple-s2s-revoke:" + notifType.toLowerCase());
    } catch (_) {}
    action = "revoked";
  } else if (userId && productMapping && RENEW_TYPES.has(notifType)) {
    const expiresDate = Number(transactionPayload?.expiresDate || renewalPayload?.renewalDate || 0);
    if (expiresDate > Date.now()) {
      try {
        const source = "apple-s2s-renew:" + productMapping.plan;
        await savePremium(env, userId, expiresDate, source);
      } catch (_) {}
      action = "renewed";
    }
  }

  return json({
    ok: true,
    received: true,
    action,
    notification_type: notifType,
    subtype,
    productId,
    originalTransactionId,
    userId: userId || null,
  });
}

// ==================== AI BACKEND / REPORTS ====================
//
// The only AI backend is OpenRouter, pinned to `google/gemini-2.5-flash-lite`
// and routed exclusively to Google Vertex AI in the EU (`google-vertex/eu`).
// All AI-labelled features fail closed: when the model is unavailable or its
// response is invalid, the Worker returns an explicit error and never substitutes
// prewritten scores, plans, meals, food analyses or advice.
//
// To configure OpenRouter:
//   wrangler secret put OPENROUTER_API_KEY
//   (or set it in the Cloudflare dashboard — Workers → facemax-api →
//    Settings → Variables → Secret)
//

// Build the structured prompt used by the report flow.
// When MediaPipe metrics are provided we anchor the report to those
// numbers and explicitly tell the model NOT to fabricate visual
// observations beyond what the metrics say. Even with raw images the
// schema is identical so the client never has to branch.
function buildReportPrompt(body) {
  const faceShape = body && body.face_shape ? String(body.face_shape) : null;
  const suppliedMetrics = (body && body.metrics && typeof body.metrics === "object") ? body.metrics : {};
  const metrics = {};
  for (const [key, value] of Object.entries(suppliedMetrics)) {
    const n = Number(value);
    if (Number.isFinite(n)) metrics[key] = Math.max(0, Math.min(100, Math.round(n)));
  }
  const overall = Number(body && (body.overall_score ?? body.score));
  const userContext = {
    gender: String(body?.gender || "").toLowerCase().startsWith("f") ? "female" : "male",
    overall_score: Number.isFinite(overall) ? Math.max(0, Math.min(100, Math.round(overall))) : null,
    face_shape: faceShape,
    metrics,
  };
  return `
You are FaceMax AI, a facial analysis assistant for a beauty and wellness app.
The iOS client runs MediaPipe FaceLandmarker on-device to extract 478 facial
landmarks, computes per-feature sub-scores (symmetry, jawline, cheekbones,
eyes, lips, nose, harmony, skin) and a weighted overall score, and sends ONLY
those numbers to you — not the user's photo. Build the textual report from
those numbers alone.

Rules:
- Do not mention Gemini, OpenAI, MediaPipe, fallback, the model, the API or any technical details.
- Do not give medical diagnoses.
- Do not promise bone-structure changes.
- Give a practical looksmax / glow-up breakdown grounded in the per-metric scores.
- Scores in your output should be plausible relative to the provided metrics (do not invent values that contradict them by more than ~5 points).
- key_points MUST contain EXACTLY 3 or 4 entries. Each entry MUST be in the format "Problem | Fix" (with the pipe character). The Problem references a specific metric or visible aspect; the Fix is a concrete, actionable instruction (e.g. an exercise, product, habit, or visit to a specialist). NO water, NO generic motivational language. Lookmaxxing-style brutal honesty.
- Do NOT include any 7-day plan, daily schedule, or week-by-week breakdown. The user does not want one.
- Do NOT include an archetype field — it is calculated server-side from the score.

App context (input metrics):
${JSON.stringify(userContext)}

Return strictly JSON:
{
  "overall_score": number,
  
  "photo_check": "1 short sentence about how to take a better selfie",
  "summary": "1 short overall conclusion",
  "fastest_upgrade": {"title":"short","text":"1 short explanation"},
  "scores": {
    "jawline": number,
    "skin": number,
    "hair": number,
    "eye_area": number,
    "lips": number,
    "nose": number,
    "face_shape": number,
    "photo_angle": number,
    "symmetry": number,
    "cheekbones": number,
    "harmony": number,
    "improvement_potential": number
  },
  "strengths": [
    {"title":"strength","text":"short"},
    {"title":"strength","text":"short"},
    {"title":"strength","text":"short"}
  ],
  "weak_points": [
    {"title":"area to improve","text":"short"},
    {"title":"area to improve","text":"short"},
    {"title":"area to improve","text":"short"}
  ],
  "haircut": "concrete hair advice",
  "jawline": "concrete advice for visual jawline",
  "skin": "concrete skin advice",
  "photo_angle": "concrete light / angle / background advice",
  "key_points": [
    "Problem | Fix",
    "Problem | Fix",
    "Problem | Fix",
    "Problem | Fix"
  ]
}`;
}

// Validate the complete AI report and trim key_points to 3-4 entries.
// Invalid or incomplete model output is rejected instead of being backfilled.
function normalizeReport(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI report is not an object");
  }
  const scores = parsed.scores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    throw new Error("AI report scores are missing");
  }

  const requiredScoreKeys = [
    "jawline", "skin", "hair", "eye_area", "lips", "nose",
    "face_shape", "photo_angle", "symmetry", "cheekbones",
    "harmony", "improvement_potential",
  ];
  const cleanScore = (value, name) => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`AI report score ${name} is invalid`);
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  parsed.overall_score = cleanScore(parsed.overall_score, "overall_score");
  const cleanedScores = {};
  for (const key of requiredScoreKeys) cleanedScores[key] = cleanScore(scores[key], key);
  parsed.scores = cleanedScores;

  const requireText = (value, name) => {
    const text = String(value || "").trim();
    if (!text) throw new Error(`AI report field ${name} is missing`);
    return text;
  };
  parsed.photo_check = requireText(parsed.photo_check, "photo_check");
  parsed.summary = requireText(parsed.summary, "summary");
  parsed.haircut = requireText(parsed.haircut, "haircut");
  parsed.jawline = requireText(parsed.jawline, "jawline");
  parsed.skin = requireText(parsed.skin, "skin");
  parsed.photo_angle = requireText(parsed.photo_angle, "photo_angle");

  if (!parsed.fastest_upgrade || typeof parsed.fastest_upgrade !== "object") {
    throw new Error("AI report fastest_upgrade is missing");
  }
  parsed.fastest_upgrade = {
    title: requireText(parsed.fastest_upgrade.title, "fastest_upgrade.title"),
    text: requireText(parsed.fastest_upgrade.text, "fastest_upgrade.text"),
  };

  const cleanCards = (value, name) => {
    if (!Array.isArray(value) || value.length < 3) throw new Error(`AI report ${name} is incomplete`);
    return value.slice(0, 3).map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`AI report ${name}[${index}] is invalid`);
      return {
        title: requireText(item.title, `${name}[${index}].title`),
        text: requireText(item.text, `${name}[${index}].text`),
      };
    });
  };
  parsed.strengths = cleanCards(parsed.strengths, "strengths");
  parsed.weak_points = cleanCards(parsed.weak_points, "weak_points");

  if (!Array.isArray(parsed.key_points) || parsed.key_points.length < 3) {
    throw new Error("AI report key_points are incomplete");
  }
  parsed.key_points = parsed.key_points.slice(0, 4).map((item, index) => {
    const text = requireText(item, `key_points[${index}]`);
    if (!text.includes("|")) throw new Error(`AI report key_points[${index}] has invalid format`);
    return text;
  });

  if ("seven_day_plan" in parsed) delete parsed.seven_day_plan;
  return parsed;
}


// ---------------------------------------------------------------------------
// OpenRouter is the ONLY AI gateway. Every AI request is pinned to
// `google/gemini-2.5-flash-lite` and routed ONLY through Google Vertex AI in
// the EU (`google-vertex/eu`). Provider fallbacks are deliberately disabled:
// if that exact endpoint is unavailable, the request fails closed rather than
// being processed in another provider or region.
// Structured-output callers can provide a JSON schema; response healing only
// repairs JSON syntax and does not change provider routing. Every upstream
// fetch is bounded by a timeout and retries remain on the same Vertex EU
// endpoint.
// `prompt` is the text part; `images` is an array of data-URL strings.
// Returns { ok, status, text, reason?, detail?, request_id? }.
//   Configure: wrangler secret put OPENROUTER_API_KEY
async function callOpenRouter(env, prompt, images, opts = {}) {
  const key = String(env.OPENROUTER_API_KEY || "").trim();
  if (!key) return { ok: false, status: 0, text: "", reason: "OPENROUTER_API_KEY missing", detail: null };

  const content = [{ type: "text", text: String(prompt || "") }];
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img) content.push({ type: "image_url", image_url: { url: img } });
    }
  }

  const temperature = opts.temperature != null ? opts.temperature : 0.35;
  const provider = {
    // Privacy contract: Google Vertex AI EU only. Do not route to any other
    // provider or region, even as a fallback.
    order: ["google-vertex/eu"],
    allow_fallbacks: false,
    data_collection: "deny",
  };
  if (opts.responseFormat) provider.require_parameters = true;

  const payloadObj = {
    model: "google/gemini-2.5-flash-lite",
    provider,
    temperature,
    max_tokens: Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : (content.length > 1 ? 4096 : 3072),
    stream: false,
    messages: [{ role: "user", content }],
  };
  if (opts.top_p != null) payloadObj.top_p = opts.top_p;
  if (opts.seed != null) payloadObj.seed = opts.seed;
  if (opts.responseFormat) {
    payloadObj.response_format = opts.responseFormat;
    payloadObj.plugins = [{ id: "response-healing" }];
  }

  const payload = JSON.stringify(payloadObj);
  const tries = Math.max(1, Math.min(3, Number(opts.tries) || 2));
  const timeoutMs = Math.max(8000, Math.min(60000, Number(opts.timeoutMs) || (content.length > 1 ? 35000 : 30000)));
  const endpointBase = String(env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const endpoint = endpointBase + "/chat/completions";

  let status = 0;
  let detail = null;
  let requestId = null;
  let lastReason = "OpenRouter error";

  for (let attempt = 0; attempt < tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key,
          "HTTP-Referer": "https://facemaxaiapp.com",
          "X-Title": "FaceMax AI",
        },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      status = res.status;
      requestId = res.headers.get("x-request-id") || res.headers.get("cf-ray") || null;
      const raw = await res.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
      const txt = data?.choices?.[0]?.message?.content;
      if (res.ok && typeof txt === "string" && txt.trim().length > 10) {
        return { ok: true, status, text: txt, request_id: requestId };
      }

      detail = data?.error?.message
        || (data?.error?.metadata?.raw ? String(data.error.metadata.raw).slice(0, 300) : null)
        || (raw ? raw.slice(0, 300) : null);
      lastReason = status === 429 ? "OpenRouter rate limited"
        : status === 408 ? "OpenRouter timeout"
        : status === 502 ? "OpenRouter provider error"
        : status === 503 ? "OpenRouter provider unavailable"
        : status === 402 ? "OpenRouter credits unavailable"
        : "OpenRouter error";

      // Configuration/auth/payment errors will not recover by immediately retrying.
      if ([400, 401, 402, 403, 404, 413, 422].includes(status)) break;

      if (attempt < tries - 1) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(5000, retryAfter * 1000)
          : 900 + attempt * 1100 + Math.floor(Math.random() * 500);
        await new Promise(r => setTimeout(r, waitMs));
      }
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e && (e.name === "AbortError" || /aborted|timeout/i.test(String(e.message || e)));
      detail = e?.message || String(e);
      lastReason = timedOut ? "OpenRouter request timed out" : "OpenRouter network error";
      if (attempt < tries - 1) {
        await new Promise(r => setTimeout(r, 900 + attempt * 1100 + Math.floor(Math.random() * 500)));
      }
    }
  }

  return { ok: false, status, text: "", reason: lastReason, detail, request_id: requestId };
}

// Extract the FIRST complete, balance-matched JSON object from a string,
// ignoring any trailing content. The model occasionally appends a second copy
// of the JSON (or trailing prose) after the report, which made a naive
// firstBrace..lastBrace slice produce invalid multi-object text and throw
// "Unexpected non-whitespace character after JSON". Scanning brace depth while
// respecting string literals/escapes returns just the first object.
function extractFirstJsonObject(s) {
  const str = String(s || "");
  const start = str.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

// Face report (text or vision). Routes through OpenRouter; the historic name
// is kept so call sites / logs stay stable across the Gemini→OpenRouter swap.
async function callGemini(env, body) {
  if (!String(env.OPENROUTER_API_KEY || "").trim()) {
    return { ok: false, failed: true, source: "error", reason: "OPENROUTER_API_KEY missing", status: 503 };
  }

  try {
    // OpenRouter takes images as data-URL strings (image_url parts), so the
    // validator just confirms the data URL is well formed and returns it.
    // Also normalise raw base64 strings (no data: prefix) that iOS Capacitor
    // Camera sometimes returns — add the jpeg prefix so they pass validation.
    function imgPart(dataUrl) {
      let s = String(dataUrl || "");
      // Normalise raw base64 (no data: prefix) — iOS Camera can return these
      if (s.length > 100 && !s.startsWith("data:") && /^[A-Za-z0-9+/]/.test(s)) {
        s = "data:image/jpeg;base64," + s;
      }
      return /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.test(s) ? s : null;
    }

    const images = [];
    const main = imgPart(body.image);
    if (main) images.push(main);


    // When no images are provided (iOS metrics-only flow), use the shared
    // buildReportPrompt that anchors the report on MediaPipe numbers. The
    // vision prompt below carries an explicit per-feature scoring rubric and
    // calibration so scores are honest, deterministic and self-explained.
    const _scanGender = String(body.gender || "").toLowerCase().startsWith("f") ? "female" : "male";
    const _genderNote = _scanGender === "female"
      ? "The subject is a woman. Evaluate her facial features using standards appropriate for women."
      : "The subject is a man. Evaluate his facial features using standards appropriate for men.";

    const prompt = images.length > 0 ? `
You are FaceMax AI, a facial analysis assistant for a beauty and wellness app.
Analyze exactly the attached photo. Write in English. Return only valid JSON without markdown.

CRITICAL FIRST CHECK — before anything else, look at the photo and ask: does it clearly show a real human face with both eyes, a nose and a mouth visible?
If the image does NOT contain a clear human face (e.g. it is a landscape, animal, food, object, body without a face, text, or any non-face image), you MUST return ONLY this JSON and nothing else:
{"no_face": true, "reason": "No human face detected in the photo"}

Only if a clear human face IS present, continue with the full analysis below.

${_genderNote}
Rules:
- Do not mention Gemini, MediaPipe, fallback, the model, the API or any technical details.
- Do not give medical diagnoses.
- Do not promise bone-structure changes.
- Give a practical looksmax / glow-up breakdown of the photo.
- Scores must be plausible and vary depending on the photo. Each of the six visible features (jawline, cheekbones, eye_area, lips, nose, skin) MUST get its own distinct score based on what you actually see — do not output identical or near-identical numbers across them.
- If the photo is poor quality, reflect that in photo_check and photo_angle.
- key_points MUST contain EXACTLY 3 or 4 entries. Each entry MUST be in the format "Problem | Fix" (with the pipe character). Specific, honest and actionable. NO water, NO motivational fluff.
- Do NOT include any 7-day plan, daily schedule, or week-by-week breakdown.
- Do NOT include an archetype field — it is calculated server-side from the score.

Scoring calibration (follow strictly):
- Rate this face HONESTLY and OBJECTIVELY. Do not inflate or deflate — score exactly what you see.
- Score only the attached current photo. Do not use account history, prior results, or earlier metrics. The same photo scanned repeatedly must receive the same score.
- Use the full 0-100 range. A truly average adult face with no notable strengths or weaknesses = 50-55. Slightly above average = 56-65. Good-looking with clear strengths = 66-75. Genuinely attractive, well-proportioned = 76-85. Exceptional, model-tier = 86-95. Below 50 for visible aesthetic problems; below 35 for severe ones.
- overall_score must be consistent with the sub-scores: a weighted average of what you actually rated, not pushed higher or lower artificially.

Per-feature scoring rubric (apply these definitions when you set the sub-scores):
- jawline: grade the visible definition of the lower face. Look at how clearly the mandible line runs from ear to chin, the gonial (jaw) angle, chin projection, and how much soft submental / under-chin fat ("double chin") blurs the line. A crisp, well-separated jaw with a clean neck-to-jaw transition and little under-chin fat scores high (80+). A soft, rounded or fat-obscured jaw scores in the 50s-60s. Account for the camera angle: a downward tilt or a smile can flatten a good jaw, so do not over-penalize a clearly decent jaw shot from a bad angle.
- skin: grade clarity and condition of the skin. Look at tone evenness, active blemishes / acne and acne scarring, visible pore size and surface texture, oiliness or shine, redness or irritation, and under-eye dark circles or puffiness. Clear, even, smooth skin with small pores scores high (80+); active breakouts, rough texture, strong redness or heavy dark circles score in the 50s-60s. Do not confuse lighting glare or compression artifacts with real skin problems.

Explain the score: the "jawline" and "skin" output fields MUST EACH begin with ONE short, specific sentence that names what in THIS photo drove that sub-score (which of the rubric factors above you actually saw - e.g. jaw sharpness vs. under-chin softness, or clear tone vs. visible breakouts / dark circles), and only AFTER that sentence give the concrete improvement advice. Never give generic advice that ignores what the photo shows.

Return strictly JSON:
{
  "overall_score": number,
  
  "photo_check": "1 short sentence",
  "summary": "1 short overall conclusion",
  "fastest_upgrade": {"title":"short","text":"1 short explanation"},
  "scores": {
    "jawline": number,
    "skin": number,
    "hair": number,
    "eye_area": number,
    "lips": number,
    "nose": number,
    "face_shape": number,
    "photo_angle": number,
    "symmetry": number,
    "cheekbones": number,
    "harmony": number,
    "improvement_potential": number
  },
  "strengths": [
    {"title":"strength","text":"short"},
    {"title":"strength","text":"short"},
    {"title":"strength","text":"short"}
  ],
  "weak_points": [
    {"title":"area to improve","text":"short"},
    {"title":"area to improve","text":"short"},
    {"title":"area to improve","text":"short"}
  ],
  "haircut": "concrete hair advice",
  "jawline": "concrete advice for visual jawline",
  "skin": "concrete skin advice",
  "photo_angle": "concrete light / angle / background advice",
  "key_points": [
    "Problem | Fix",
    "Problem | Fix",
    "Problem | Fix",
    "Problem | Fix"
  ]
}` : buildReportPrompt(body);

    // Low temperature here (vs. the default 0.45) — this call produces the
    // numeric face scores themselves. High temperature made the same photo
    // yield noticeably different scores on repeat scans, which undermines
    // trust ("why did my score change, I didn't do anything"). Temperature 0
    // plus a pinned low top_p and fixed seed remove essentially all sampling
    // randomness for a given photo+prompt, while still letting the score
    // differ across genuinely different photos.
    // (The glow-up PLAN prompt elsewhere intentionally keeps a higher
    // temperature — variety across days is desirable there.)
    const result = await callOpenRouter(env, prompt, images, { tries: 3, temperature: 0, top_p: 0, seed: 42 });
    if (!result.ok || !result.text) {
      // Hard failure — surface it so the client can show a real error / retry.
      return {
        ok: false,
        failed: true,
        source: "error",
        reason: result.reason || "OpenRouter error",
        status: result.status,
        details: result.detail || null
      };
    }

    let txt = String(result.text).trim();
    if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    txt = extractFirstJsonObject(txt) || txt;

    const parsed = JSON.parse(txt);
    // Gemini detected no human face in the photo
    if (parsed.no_face === true) {
      return { ok: false, failed: true, source: "no_face", no_face: true, reason: parsed.reason || "No human face detected in the photo" };
    }
    return { ok: true, source: "openrouter", data: normalizeReport(parsed) };
  } catch (e) {
    return { ok: false, failed: true, source: "error", reason: e?.message || String(e), status: 502 };
  }
}

/* Cheap server-side face validator. Used by the iOS app as a hard
 * fallback in case MediaPipe FaceLandmarker has false-positived a
 * non-face photo (flowers, pets, screenshots). Costs ~1/100th of a
 * full report — single short Gemini call returning yes/no JSON.
 * Fails-CLOSED on every uncertainty (App Store Guideline 5.1.1 / 4.0 makes
 * a misleading score on a non-face photo a hard reject). If we don't know,
 * we say no face. */
async function faceCheck(request, env) {
  const body = await request.json().catch(() => ({}));
  const image = String(body.image || "");
  const key = String(env.OPENROUTER_API_KEY || "").trim();
  if (!image) return json({ ok: false, error: "image required" }, 400);
  if (!key) return json({ ok: false, error: "ai_unavailable", source: "error", reason: "OPENROUTER_API_KEY missing" }, 503);

  function imgPart(dataUrl) {
    let s = String(dataUrl || "");
    if (s.length > 100 && !s.startsWith("data:") && /^[A-Za-z0-9+/]/.test(s)) {
      s = "data:image/jpeg;base64," + s;
    }
    return /^data:(.+?);base64,(.+)$/.test(s) ? s : null;
  }
  const part = imgPart(image);
  if (!part) return json({ ok: true, has_face: false, source: "bad_image" });

  const prompt =
    "You are an extremely strict face-presence detector for a beauty-analysis app. " +
    "Return has_face=true ONLY if the image clearly shows at least one real HUMAN FACE, " +
    "with BOTH eyes, a nose and a mouth visible, taking up a meaningful portion of the frame, " +
    "and oriented roughly toward the camera (front or near-front, up to ~45° tilt). " +
    "Return has_face=false for ANY of the following: " +
    "flowers, plants, leaves, food, animals (cats/dogs/etc.), birds, insects, " +
    "landscapes, buildings, vehicles, objects, toys, dolls, mannequins, statues, paintings, " +
    "cartoon/anime/illustrated characters, AI-generated non-photo art, " +
    "text, screenshots, UI mockups, abstract art, patterns, fabric, textures, " +
    "empty rooms, body shots without face, distant figures where the face is tiny, " +
    "profile (side) shots where one eye is hidden, photos where the face is heavily occluded " +
    "by hands/masks/sunglasses covering both eyes, or any image you are not 100% sure contains a clear human face. " +
    "When in doubt, return has_face=false. Reply with strict JSON only.";

  try {
    const result = await callOpenRouter(env, prompt, [part], { tries: 3 });
    if (!result.ok) return json({ ok: false, error: "ai_unavailable", source: "error", status: result.status, reason: result.reason || "OpenRouter error" }, 503);
    let parsed = {};
    try { parsed = JSON.parse(result.text || ""); } catch {}
    if (typeof parsed.has_face !== "boolean") return json({ ok: false, error: "invalid_ai_response", source: "error" }, 502);
    return json({ ok: true, has_face: parsed.has_face, reason: parsed.reason || null, source: "openrouter" });
  } catch (e) {
    // Fail closed with an explicit AI error; do not disguise infrastructure
    // failure as a confident "no face" classification.
    return json({ ok: false, error: "ai_unavailable", source: "error", reason: e?.message || String(e) }, 503);
  }
}

async function fullReport(request, env) {
  const body = await request.json().catch(() => ({}));
  // Premium-gate: the AI face analysis is a paid feature.
  const userId = sanitizeUserId(body.user_id || body.userId || body.email);
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  const p = await readPremium(env, userId);
  if (!p.active) return json({ ok: false, error: "premium_required", premium: false }, 402);
  const daily = await checkAndIncrementDailyLimit(env, userId, body.local_date);
  if (!daily.allowed) return json({ ok: false, error: "daily_limit_reached", limit: DAILY_SCAN_LIMIT, message: "You've reached your 50 scans/day limit. Try again tomorrow." }, 429);
  // Build a fresh allow-listed input for the analysis. Even if an outdated
  // client submits history fields, extra photos, old metrics or a prior result,
  // they are discarded here and never reach the vision prompt.
  const isVisualScan = body.visual_scan === true && typeof body.image === "string" && body.image.length > 0;
  const scanInput = isVisualScan
    ? {
        // New Face Scan: current photo + current calibration only.
        image: body.image,
        gender: body.gender || null,
        visual_scan: true,
      }
    : {
        // Existing metrics-only text-report flow: keep only the current result.
        image: typeof body.image === "string" ? body.image : "",
        gender: body.gender || null,
        face_shape: body.face_shape || null,
        score: body.score,
        metrics: (body.metrics && typeof body.metrics === "object") ? body.metrics : {},
        mediapipe: body.mediapipe === true,
        visual_scan: false,
      };
  const result = await callGemini(env, scanInput);
  // Surface a real failure instead of returning a generic fallback score — a
  // misleading score on a failed analysis is an App Store hard-reject risk.
  if (result.ok === false || result.failed) {
    if (result.no_face) {
      return json({ ok: false, error: "no_face", reason: result.reason || "No human face detected. Please upload a clear photo of your face." }, 422);
    }
    return json({ ok: false, error: "analysis_failed", source: result.source || "error", reason: result.reason || null, status: result.status || 0, details: result.details || null }, 503);
  }
  if (env.PREMIUM_KV && userId) await env.PREMIUM_KV.put(reportKey(userId), JSON.stringify({ report: result.data, source: result.source, updated_at: Date.now() }));
  return json(result);
}

async function simpleTool(request, env, type) {
  const body = await request.json().catch(() => ({}));
  const userId = sanitizeUserId(body.user_id || body.userId || body.email);
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  const p = await readPremium(env, userId);
  if (!p.active) return json({ ok: false, error: "premium_required", premium: false }, 402);

  const meta = {
    "dating-photo": { title: "Profile photo", role: "portrait and dating-profile photo coach" },
    "haircut-guide": { title: "Haircut", role: "face-shape-aware haircut and grooming coach" },
    "skin-plan": { title: "Skin", role: "looksmaxxing skin coach" },
    "jawline-plan": { title: "Jawline", role: "looksmaxxing jawline coach" },
  }[type];
  if (!meta) return json({ ok: false, error: "unsupported_tool" }, 400);
  if (!String(env.OPENROUTER_API_KEY || "").trim()) {
    return json({ ok: false, error: "ai_unavailable", reason: "OPENROUTER_API_KEY missing" }, 503);
  }

  const scoreHint = Number.isFinite(Number(body.score))
    ? Math.max(0, Math.min(100, Math.round(Number(body.score))))
    : null;
  const faceShapeHint = body.face_shape ? String(body.face_shape) : null;
  const gender = String(body.gender || "").toLowerCase().startsWith("f") ? "female" : "male";
  const metrics = (body.metrics && typeof body.metrics === "object") ? body.metrics : {};
  const metricLines = Object.entries(metrics)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([key, value]) => `${key}: ${Math.round(Number(value))}/100`)
    .join("\n");

  const typeRules = {
    "skin-plan": `Build a concrete skin-improvement plan. Prioritize the actual skin and eye-area scores. Cover AM, PM, lifestyle and nutrition. Do not diagnose disease or prescribe medication.`,
    "jawline-plan": `Build a concrete jawline-definition plan. Be honest that bone structure cannot be changed. Prioritize bloating, body composition, posture, grooming and safe muscle-tone work according to the scores. Never recommend mewing or jaw trainers.`,
    "haircut-guide": `Recommend a practical haircut and grooming direction for the stated face shape and scores. Avoid generic claims and explain why each step suits this user.`,
    "dating-photo": `Build a practical profile-photo improvement plan using the stated scores and face shape. Cover lighting, camera height, posture, expression, background and grooming.`,
  }[type];

  const prompt = `You are FaceMax AI, a ${meta.role}.
Create ONE personalised plan from the user's current data.
Gender: ${gender}
Overall score: ${scoreHint ?? "unknown"}
Face shape: ${faceShapeHint ?? "unknown"}
Current metrics:\n${metricLines || "not provided"}

${typeRules}

Return ONLY valid JSON, no markdown:
{"title":"${meta.title}","text":"2-3 concise sentences referencing the user's actual data","steps":["6 short, specific, prioritized actions"]}

Rules:
- The output must be specific to the supplied values, not a generic template.
- Return exactly 6 non-empty steps.
- Do not mention the model, API, prompt or technical details.
- Do not invent medical diagnoses.
- Do not include placeholders.`;

  try {
    const result = await callOpenRouter(env, prompt, [], { tries: 3, temperature: 0.55 });
    if (!result.ok || !result.text) {
      return json({ ok: false, error: "ai_unavailable", reason: result.reason || "OpenRouter error", status: result.status || 0 }, 503);
    }
    const txt = extractFirstJsonObject(result.text) || String(result.text).trim();
    const parsed = JSON.parse(txt);
    const text = String(parsed?.text || "").trim();
    const steps = Array.isArray(parsed?.steps)
      ? parsed.steps.map(step => String(step || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    if (!text || steps.length !== 6) {
      return json({ ok: false, error: "invalid_ai_response", reason: "AI tool response was incomplete" }, 502);
    }
    return json({ ok: true, source: "openrouter", data: { title: meta.title, text, steps }, input: body });
  } catch (e) {
    return json({ ok: false, error: "invalid_ai_response", reason: e?.message || String(e) }, 502);
  }
}

// ==================== FOOD SCAN (DePuff-style) ====================
//
// Snap-a-meal endpoint. Sends the image to the configured OpenRouter model
// with a strict JSON schema describing the meal's bloating impact. Invalid or
// unavailable AI output is rejected; no generic meal analysis is substituted.

function normalizeFoodScan(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Food scan response is not an object");
  }
  const detected = String(parsed.detected || "").trim();
  const noFood = !detected
    || detected.toLowerCase().includes("no meal")
    || detected.toLowerCase() === "unknown";
  if (noFood) {
    return {
      detected: "No meal detected",
      bloat_score: 0,
      bloat_label: "Low",
      calories_est: 0,
      sodium_level: "low",
      sugar_level: "low",
      processed_level: "low",
      dairy_level: "low",
      alcohol_level: "low",
      summary: "",
      why: "",
      key_ingredients: [],
      swaps: [],
      best_time: null,
      tip: "",
    };
  }

  const requireText = (value, name) => {
    const text = String(value || "").trim();
    if (!text) throw new Error(`Food scan field ${name} is missing`);
    return text;
  };
  const numberInRange = (value, name, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Food scan field ${name} is invalid`);
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const level = (value, name) => {
    const clean = String(value || "").toLowerCase().trim();
    if (!["low", "medium", "high"].includes(clean)) throw new Error(`Food scan field ${name} is invalid`);
    return clean;
  };

  const bloatScore = numberInRange(parsed.bloat_score, "bloat_score", 0, 100);
  const bloatLabel = bloatScore <= 30 ? "Low" : bloatScore <= 55 ? "Moderate" : bloatScore <= 75 ? "High" : "Severe";
  const ingredients = Array.isArray(parsed.key_ingredients)
    ? parsed.key_ingredients.slice(0, 3).map((item, index) => {
        if (!item || typeof item !== "object") throw new Error(`Food scan key_ingredients[${index}] is invalid`);
        return {
          name: requireText(item.name, `key_ingredients[${index}].name`),
          impact: level(item.impact, `key_ingredients[${index}].impact`),
          note: requireText(item.note, `key_ingredients[${index}].note`),
        };
      })
    : [];
  if (ingredients.length !== 3) throw new Error("Food scan key_ingredients must contain exactly 3 items");

  const swaps = Array.isArray(parsed.swaps)
    ? parsed.swaps.slice(0, 3).map((item, index) => {
        if (!item || typeof item !== "object") throw new Error(`Food scan swaps[${index}] is invalid`);
        return {
          e: requireAiEmoji(item.e, `swaps[${index}].e`),
          name: requireText(item.name, `swaps[${index}].name`),
          benefit: requireText(item.benefit, `swaps[${index}].benefit`),
        };
      })
    : [];
  if (swaps.length !== 3) throw new Error("Food scan swaps must contain exactly 3 items");

  const bestTime = parsed.best_time;
  if (!bestTime || typeof bestTime !== "object") throw new Error("Food scan best_time is missing");
  const validSlots = ["Morning", "Midday", "Evening", "Night"];
  const rawBestSlots = Array.isArray(bestTime.slots)
    ? bestTime.slots
    : (bestTime.slot === "Any time" ? validSlots : (bestTime.slot ? [bestTime.slot] : []));
  const bestSlots = [...new Set(rawBestSlots.map(value => requireText(value, "best_time.slots[]")))]
    .filter(slot => validSlots.includes(slot));
  if (bestSlots.length < 1 || bestSlots.length > 4) {
    throw new Error("Food scan best_time.slots must contain 1 to 4 valid time periods");
  }

  const caloriesEst = numberInRange(parsed.calories_est, "calories_est", 0, 10000);
  const sodiumLevel = level(parsed.sodium_level, "sodium_level");
  const sugarLevel = level(parsed.sugar_level, "sugar_level");
  const processedLevel = level(parsed.processed_level, "processed_level");
  const dairyLevel = level(parsed.dairy_level, "dairy_level");
  const alcoholLevel = level(parsed.alcohol_level, "alcohol_level");
  const summary = requireText(parsed.summary, "summary");
  const why = requireText(parsed.why, "why");

  // Cross-check packaged sweet drinks so the model cannot silently confuse
  // "per 100 ml" with the whole can or assume a regular energy drink is a
  // zero-sugar variant. Genuine Zero/Diet/Sugar-Free products remain valid.
  const calorieContext = [
    detected, summary, why,
    ...ingredients.flatMap(item => [item.name, item.note]),
  ].join(" ").toLowerCase();
  const isEnergyOrSoftDrink = /\b(energy drink|cola|soda|soft drink)\b/.test(calorieContext);
  const explicitlyLowCalorieVariant = /\b(zero(?:[- ]?sugar)?|sugar[- ]?free|no[- ]?sugar|diet|zero[- ]?calorie|low[- ]?calorie)\b/.test(calorieContext);
  if (isEnergyOrSoftDrink && caloriesEst <= 25 && !explicitlyLowCalorieVariant) {
    throw new Error("Food scan calories are inconsistent with a regular packaged drink");
  }
  if (isEnergyOrSoftDrink && (sugarLevel === "medium" || sugarLevel === "high") && caloriesEst < 40) {
    throw new Error("Food scan calories conflict with the reported sugar level");
  }

  return {
    detected,
    bloat_score: bloatScore,
    bloat_label: bloatLabel,
    calories_est: caloriesEst,
    sodium_level: sodiumLevel,
    sugar_level: sugarLevel,
    processed_level: processedLevel,
    dairy_level: dairyLevel,
    alcohol_level: alcoholLevel,
    summary,
    why,
    key_ingredients: ingredients,
    swaps,
    // Keep `slot` for compatibility with already-released clients; the new
    // client reads `slots` and highlights exactly the periods selected by AI.
    best_time: { slots: bestSlots, slot: bestSlots[0], reason: requireText(bestTime.reason, "best_time.reason") },
    tip: requireText(parsed.tip, "tip"),
  };
}

async function callGeminiFoodScan(env, body) {
  if (!String(env.OPENROUTER_API_KEY || "").trim()) return { ok: false, source: "error", reason: "OPENROUTER_API_KEY missing", status: 503 };

  function imgPart(dataUrl) {
    const s = String(dataUrl || "");
    return /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.test(s) ? s : null;
  }

  const main = imgPart(body.image);
  if (!main) return { ok: false, source: "error", reason: "image missing or malformed", status: 400 };

  const prompt = `
You are FaceMax AI, a premium app analysing how a meal affects next-morning facial bloating.
Look at exactly the attached photo. Write in English. Return only valid JSON without markdown.

CRITICAL FIRST CHECK — before anything else, ask yourself: does this photo clearly show actual food or drink that a person would consume?
Food/drink includes: meals, dishes, snacks, beverages, raw ingredients, packaged food products.
NOT food includes: people, faces, selfies, animals, pets, plants (non-edible), landscapes, objects, screenshots, text, memes, vehicles, buildings, clothing, body parts, or anything not clearly edible.
If you are even slightly unsure whether the image shows food — return the no-food response below.

If the image does NOT clearly show food or drink, return ONLY this exact JSON and nothing else:
{"detected":"No meal detected","bloat_score":0,"bloat_label":"Low","calories_est":0,"sodium_level":"low","sugar_level":"low","processed_level":"low","dairy_level":"low","alcohol_level":"low","summary":"","why":"","key_ingredients":[],"swaps":[],"best_time":null,"tip":""}

Only if food IS clearly present, continue with the full analysis below.

Rules:
- Do not mention Gemini, the model, or any technical details.
- Do not give medical diagnoses or warnings.
- Be specific to what you see in the photo, not generic.
- bloat_score is 0..100 where 0 is no bloating impact and 100 is severe.
- bloat_label must match the score: 0-30 "Low", 31-55 "Moderate", 56-75 "High", 76-100 "Severe".
- All level fields must be one of: "low", "medium", "high".
- key_ingredients: 3 items, each with name, impact ("low"|"medium"|"high") and a concise one-sentence note. Keep each name short and each note under about 120 characters so it fits cleanly on a phone screen.
- swaps: exactly 3 concrete, actionable swaps. Choose one matching emoji/sticker for each swap. Each swap must include its own honest, non-numeric benefit; never invent percentages.
- best_time: freely choose any 1, 2, 3, or all 4 genuinely suitable periods from "Morning", "Midday", "Evening", and "Night". Select all four when the item is reasonably suitable at any time. The UI will highlight exactly the periods you return and dim the rest. Base the choice on this exact food or drink, its visible sugar, sodium, processing, portion size, digestion load, and likely next-morning puffiness. Do not force a restriction when none is justified.
- calories_est: estimate the TOTAL calories in the entire visible portion or entire visible can/bottle, never calories per 100 ml and never calories for only one serving when the whole container is shown. Identify the exact product variant and package size when possible. If a nutrition label is readable, calculate the total for the visible container. For energy drinks, cola and soda, distinguish regular from Zero/Diet/Sugar-Free using visible wording. A total of 0-25 kcal is plausible only when a low-calorie variant is visibly confirmed; if no Zero/Diet/Sugar-Free wording is visible, do not silently assume it. When the exact variant is unclear, use the most defensible estimate for the visible package and keep the meal name explicit about the uncertainty.

Return strictly JSON:
{
  "detected": "short name of the meal; for packaged drinks include the visible size and variant when possible",
  "bloat_score": number,
  "bloat_label": "Low" | "Moderate" | "High" | "Severe",
  "calories_est": number,
  "sodium_level": "low" | "medium" | "high",
  "sugar_level": "low" | "medium" | "high",
  "processed_level": "low" | "medium" | "high",
  "dairy_level": "low" | "medium" | "high",
  "alcohol_level": "low" | "medium" | "high",
  "summary": "1 short sentence summarising the meal's bloating impact",
  "why": "1-2 sentence explanation of which components in this specific meal drive the score",
  "key_ingredients": [
    {"name":"","impact":"low|medium|high","note":"short"},
    {"name":"","impact":"low|medium|high","note":"short"},
    {"name":"","impact":"low|medium|high","note":"short"}
  ],
  "swaps": [
    {"e":"single AI-selected emoji","name":"concrete swap","benefit":"short honest benefit"},
    {"e":"single AI-selected emoji","name":"concrete swap","benefit":"short honest benefit"},
    {"e":"single AI-selected emoji","name":"concrete swap","benefit":"short honest benefit"}
  ],
  "best_time": {"slots":["Morning","Midday","Evening","Night"],"reason":"one short reason specific to this meal and the selected periods"},
  "tip": "1 short tactical tip for tonight to reduce morning puffiness"
}`;

  let lastError = null;
  for (let contentAttempt = 0; contentAttempt < 2; contentAttempt++) {
    const attemptPrompt = contentAttempt === 0 ? prompt : `${prompt}

CORRECTION FOR THIS RETRY:
Reinspect the image and fix all numeric/semantic inconsistencies. For a packaged drink, identify the whole visible container size and whether Zero, Diet, Sugar-Free or No Sugar is visibly confirmed. calories_est must be the total for the whole visible can or bottle, not per 100 ml. Do not return 0-25 kcal for a regular energy drink, cola or soda.`;
    const result = await callOpenRouter(env, attemptPrompt, [main], { tries: 2, timeoutMs: 32000, maxTokens: 2600, temperature: 0.2 });
    if (!result.ok || !result.text) {
      return { ok: false, source: "error", reason: result.reason || "OpenRouter error", status: result.status || 503, details: result.detail || null };
    }
    try {
      // The model occasionally wraps the JSON in markdown fences or adds a
      // trailing sentence — extract just the first balanced JSON object.
      const jsonText = extractFirstJsonObject(result.text) || result.text;
      const parsed = normalizeFoodScan(JSON.parse(jsonText));
      return { ok: true, source: "openrouter", data: parsed };
    } catch (e) {
      lastError = e;
    }
  }
  return { ok: false, source: "error", reason: lastError?.message || "Food scan response failed validation", status: 502 };
}

async function foodScan(request, env) {
  const body = await request.json().catch(() => ({}));
  // Premium-gate: only paying users can use AI food scan.
  const userId = sanitizeUserId(body.user_id || body.userId);
  if (userId) {
    const p = await readPremium(env, userId);
    if (!p.active) return json({ ok: false, error: "premium_required", premium: false }, 402);
    const daily = await checkAndIncrementDailyLimit(env, userId, body.local_date);
    if (!daily.allowed) return json({ ok: false, error: "daily_limit_reached", limit: DAILY_SCAN_LIMIT, message: "You've reached your 50 scans/day limit. Try again tomorrow." }, 429);
  } else {
    return json({ ok: false, error: "user_id required" }, 400);
  }
  const result = await callGeminiFoodScan(env, body);
  if (!result.ok) {
    const status = result.status === 400 ? 400 : (result.status === 422 ? 422 : 503);
    return json({ ok: false, error: status === 400 ? "invalid_image" : "analysis_failed", source: result.source || "error", reason: result.reason || null, details: result.details || null }, status);
  }
  return json(result);
}

// ==================== GLOW UP PLAN (AI-generated, per-scan) ====================
//
// Generates a truly personalised daily Glow Up plan from the user's scan metrics.
// Uses the same OpenRouter → Gemini 2.5 Flash Lite pipeline as fullReport.
// Returns a JSON object the front-end renders directly in the Glow Up Hub.
//
// POST /api/glow-plan
// Body: { user_id, metrics: { skin, jawline, eyes, cheekbones, symmetry, harmony,
//          eye_area, lips, nose, face_shape, hair, improvement_potential },
//         overall_score, face_shape, archetype, gender, weakest_area }


const GLOW_PLAN_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "facemax_glow_plan",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: { type: "string", minLength: 1 },
        motivation: { type: "string", minLength: 1 },
        steps: {
          type: "array",
          minItems: 6,
          maxItems: 6,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              e: { type: "string", minLength: 1, maxLength: 16 },
              label: { type: "string", minLength: 1 },
              sub: { type: "string", minLength: 1 },
              area: {
                type: "string",
                enum: ["depuff", "water_retention", "face_fat", "skin", "jawline", "eyes", "cheekbones", "symmetry", "harmony", "nutrition", "sleep", "overall"]
              }
            },
            required: ["e", "label", "sub", "area"]
          }
        },
        chips: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string", minLength: 1 },
              score: { type: "number", minimum: 0, maximum: 100 },
              note: { type: "string", minLength: 1 }
            },
            required: ["label", "score", "note"]
          }
        },
        food_tip: { type: "string", minLength: 1 },
        face_tip: { type: "string", minLength: 1 },
        skin_tip: { anyOf: [{ type: "string" }, { type: "null" }] }
      },
      required: ["focus", "motivation", "steps", "chips", "food_tip", "face_tip", "skin_tip"]
    }
  }
};

const MEAL_PLAN_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "facemax_meal_plan",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          description: "One concise sentence describing the overall dietary direction."
        },
        meals: {
          type: "object",
          additionalProperties: false,
          description: "A complete typical day with breakfast, lunch, dinner and one or two snacks.",
          properties: {
            morning: {
              type: "object",
              additionalProperties: false,
              properties: {
                e: { type: "string", minLength: 1, maxLength: 16, description: "One food-matching emoji selected by the model." },
                n: { type: "string", minLength: 1, description: "Specific breakfast dish name." },
                items: { type: "string", minLength: 1, description: "Two or three ingredients or sides." },
                d: { type: "string", minLength: 1, description: "Why this meal fits the user's goal, under 22 words." }
              },
              required: ["e", "n", "items", "d"]
            },
            midday: {
              type: "object",
              additionalProperties: false,
              properties: {
                e: { type: "string", minLength: 1, maxLength: 16, description: "One food-matching emoji selected by the model." },
                n: { type: "string", minLength: 1, description: "Specific lunch dish name." },
                items: { type: "string", minLength: 1, description: "Two or three ingredients or sides." },
                d: { type: "string", minLength: 1, description: "Why this meal fits the user's goal, under 22 words." }
              },
              required: ["e", "n", "items", "d"]
            },
            evening: {
              type: "object",
              additionalProperties: false,
              properties: {
                e: { type: "string", minLength: 1, maxLength: 16, description: "One food-matching emoji selected by the model." },
                n: { type: "string", minLength: 1, description: "Specific dinner dish name." },
                items: { type: "string", minLength: 1, description: "Two or three ingredients or sides." },
                d: { type: "string", minLength: 1, description: "Why this meal fits the user's goal, under 22 words." }
              },
              required: ["e", "n", "items", "d"]
            },
            snacks: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  e: { type: "string", minLength: 1, maxLength: 16, description: "One food-matching emoji selected by the model." },
                  n: { type: "string", minLength: 1, description: "Specific snack name." },
                  items: { type: "string", minLength: 1, description: "One or two supporting items." },
                  d: { type: "string", minLength: 1, description: "Why this snack fits the user's goal, under 22 words." }
                },
                required: ["e", "n", "items", "d"]
              }
            }
          },
          required: ["morning", "midday", "evening", "snacks"]
        },
        eat: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              section: { type: "string", minLength: 1 },
              items: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    e: { type: "string", minLength: 1, maxLength: 16, description: "One food-matching emoji selected by the model." },
                    n: { type: "string", minLength: 1 },
                    d: { type: "string", minLength: 1 }
                  },
                  required: ["e", "n", "d"]
                }
              }
            },
            required: ["section", "items"]
          }
        },
        avoid: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              section: { type: "string", minLength: 1 },
              items: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    e: { type: "string", minLength: 1, maxLength: 16, description: "One food-matching emoji selected by the model." },
                    n: { type: "string", minLength: 1 },
                    d: { type: "string", minLength: 1 }
                  },
                  required: ["e", "n", "d"]
                }
              }
            },
            required: ["section", "items"]
          }
        }
      },
      required: ["summary", "meals", "eat", "avoid"]
    }
  }
};

async function glowPlan(request, env) {
  const body = await request.json().catch(() => ({}));
  // Premium-gate: glow plan is a paid feature.
  const userId = sanitizeUserId(body.user_id || body.userId);
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  const p = await readPremium(env, userId);
  if (!p.active) return json({ ok: false, error: "premium_required", premium: false }, 402);

  const m = (body.metrics && typeof body.metrics === "object") ? body.metrics : {};
  const overall = Math.max(0, Math.min(100, Math.round(Number(body.overall_score || body.score) || 0)));
  const gender = String(body.gender || "").toLowerCase().startsWith("f") ? "female" : "male";
  const archetype = body.archetype ? String(body.archetype) : null;
  const faceShape = body.face_shape ? String(body.face_shape) : null;

  // Enriched context from client
  const streak = Math.max(0, Math.round(Number(body.streak) || 0));
  const weekDone = Array.isArray(body.week_done) ? body.week_done : [];
  const prevMetrics = (body.prev_metrics && typeof body.prev_metrics === "object") ? body.prev_metrics : null;
  const scoreDelta = isFinite(Number(body.score_delta)) ? Math.round(Number(body.score_delta)) : null;
  const tasksDoneYesterday = isFinite(Number(body.tasks_completed_yesterday)) ? Math.round(Number(body.tasks_completed_yesterday)) : null;
  const timeOfDay = ["morning","afternoon","evening"].includes(body.time_of_day) ? body.time_of_day : "morning";
  const rawProfile = (body.profile && typeof body.profile === "object") ? body.profile : {};
  const profile = {
    age: rawProfile.age ? String(rawProfile.age).slice(0, 20) : null,
    goal: rawProfile.goal ? String(rawProfile.goal).slice(0, 40) : null,
    concerns: Array.isArray(rawProfile.concerns) ? rawProfile.concerns.map(v => String(v).slice(0, 40)).slice(0, 8) : [],
    routine: rawProfile.routine ? String(rawProfile.routine).slice(0, 40) : null,
    commitment_minutes: rawProfile.commitment_minutes ? String(rawProfile.commitment_minutes).slice(0, 10) : null,
    reason: rawProfile.reason ? String(rawProfile.reason).slice(0, 40) : null,
  };

  // Validate and extract thumbnail for vision context
  const thumbRaw = String(body.thumb || "");
  const thumb = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{100,}$/.test(thumbRaw)
    ? thumbRaw
    : null;

  // Build score context string for the prompt — sorted weakest first so AI sees priorities immediately
  const metricEntries = Object.entries(m)
    .filter(([, v]) => isFinite(Number(v)))
    .map(([k, v]) => [k, Math.round(Number(v))])
    .sort(([, a], [, b]) => a - b);
  const scoreLines = metricEntries.map(([k, v]) => `  ${k}: ${v}`).join("\n");

  // Build metric delta string if we have previous scan data
  let deltaLines = "";
  if (prevMetrics) {
    const deltas = metricEntries
      .map(([k, v]) => {
        const prev = Number(prevMetrics[k]);
        if (!isFinite(prev)) return null;
        const diff = v - Math.round(prev);
        return diff !== 0 ? `  ${k}: ${diff > 0 ? "+" : ""}${diff} (now ${v})` : null;
      })
      .filter(Boolean);
    if (deltas.length) deltaLines = "\nMetric changes since last scan:\n" + deltas.join("\n");
  }

  // Identify the weakest metric cluster for targeted focus
  const weakMetrics = metricEntries.filter(([, v]) => v < 65).map(([k]) => k);
  const lowestMetric = metricEntries[0] ? metricEntries[0][0] : null;

  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });

  const prompt = `You are FaceMax AI — a brutally honest but supportive looksmaxxing coach.
Today is ${today}, ${timeOfDay}.
${thumb ? "An image of the user's face is attached. Use it alongside the numeric scores below — look for visible signs of puffiness, skin condition, asymmetry, or under-eye issues that numbers may understate.\n" : ""}
FACE SCAN RESULTS (sorted weakest → strongest, 0–100):
${scoreLines || "  (no individual metrics provided)"}
Overall score: ${overall || "unknown"}
${faceShape ? `Face shape: ${faceShape}` : ""}
${archetype ? `Archetype: ${archetype}` : ""}
Gender: ${gender}
${deltaLines}
${weakMetrics.length ? `\nWeakest areas (score < 65): ${weakMetrics.join(", ")}` : ""}
${lowestMetric ? `Lowest single metric: ${lowestMetric}` : ""}
${scoreDelta !== null ? `\nOverall score change since last scan: ${scoreDelta > 0 ? "+" : ""}${scoreDelta} pts` : ""}
${streak > 0 ? `Streak: ${streak} day${streak === 1 ? "" : "s"} in a row` : ""}
${tasksDoneYesterday !== null ? `Yesterday's plan completion: ${tasksDoneYesterday}%` : ""}
${profile.age ? `Age range: ${profile.age}` : ""}
${profile.goal ? `User's stated primary goal: ${profile.goal}` : ""}
${profile.concerns.length ? `User's stated concerns: ${profile.concerns.join(", ")}` : ""}
${profile.routine ? `Current self-care routine level: ${profile.routine}` : ""}
${profile.commitment_minutes ? `Available daily time: ${profile.commitment_minutes} minutes` : ""}
${profile.reason ? `Reason for starting: ${profile.reason}` : ""}

VARIETY DIRECTIVE:
- Select today's approach only from the user's current weakest metrics, visible photo context, recent score changes and completion history. Do not rotate through a prewritten day-of-week topic list.
- The 6 steps must not all be the same generic actions. Use a varied set of safe actions only when each one is justified by this user's data.
- Include a nutrition-specific step only when nutrition plausibly addresses the current weakest area; otherwise use a more relevant action.

DIAGNOSTIC GUIDANCE:
- Use the lowest current metrics, visible photo context, questionnaire goals/constraints, changes since the previous scan and completion history to infer the most likely high-impact focus.
- Do not treat a score as a diagnosis. Distinguish likely temporary factors (sleep, puffiness, lighting, grooming) from stable structural traits.
- Prefer specific, low-risk actions that match the actual data. Do not force every plan into the same hydration, sodium, massage, posture and sleep template.
- Do not prescribe supplements, exact dosages, medication, extreme calorie deficits or medical testing.
- When the data is insufficient, state the uncertainty inside the wording of the action rather than inventing a cause.

TIME OF DAY AWARENESS:
- morning: prioritise steps the user can do RIGHT NOW before leaving — cold rinse, ice compress, drainage massage, hydration, SPF
- afternoon: mid-day resets — posture check, hydration top-up, nutrition audit for the day
- evening: wind-down and repair — skincare routine, sodium cutoff, sleep prep, no screens

PROGRESSION AWARENESS:
${scoreDelta !== null && scoreDelta < -2 ? `Score dropped ${Math.abs(scoreDelta)} pts since last scan — be direct about what likely caused it and what to fix today specifically.` : ""}
${scoreDelta !== null && scoreDelta > 2 ? `Score improved +${scoreDelta} pts since last scan — acknowledge the win, reinforce what's working, push further.` : ""}
${tasksDoneYesterday !== null && tasksDoneYesterday < 50 ? `User only completed ${tasksDoneYesterday}% of yesterday's tasks — today's plan should feel achievable, not overwhelming. Prioritise highest-ROI steps.` : ""}
${tasksDoneYesterday !== null && tasksDoneYesterday >= 80 ? `User crushed ${tasksDoneYesterday}% of yesterday's tasks — they're consistent. Slightly increase challenge or specificity today.` : ""}
${streak >= 7 ? `7+ day streak — this user is serious. Give them an advanced or compound step, not just basics.` : ""}

Your task: generate ONE hyper-personalised Glow Up plan for TODAY.
Look at ALL metrics. The plan must address the actual root cause shown by the scores — not generic advice.

FORBIDDEN: never suggest mewing — the app has a dedicated exercises section for that.
gua sha IS allowed and encouraged as a specific technique (direction matters: always drain toward lymph nodes).

Use independent reasoning from the supplied data. Do not copy a canned example plan or reuse a fixed sequence of actions.

Output rules:
- focus: 4–6 words — name the SPECIFIC issue (e.g. "De-puff & drain fluid" not "Jawline work", "Under-eye recovery" not "Eye area")
- motivation: 1 punchy sentence. If score dropped → call it out by name and pts. If improved → celebrate it. Reference their actual lowest metric.
- steps: exactly 6 steps. Order by impact, highest-ROI first. Do not default to the same actions every time. Pick only actions justified by today's lowest metrics and context. At least 2 steps should be specific rather than generic, using safe food, exercise, grooming, breathing or skincare techniques where relevant.
  - e: exactly one emoji/sticker selected by you to match this exact action. Choose it independently from the wording and do not repeat an emoji across the 6 steps.
  - label: 5–8 words, specific action
  - sub: max 8 words explaining why this action fits the user
  - area: root issue — one of: depuff | water_retention | face_fat | skin | jawline | eyes | cheekbones | symmetry | harmony | nutrition | sleep | overall
- chips: exactly 3. Pick the 3 lowest-scoring metrics. Each chip:
  - label: metric name
  - score: their actual score number
  - note: 1 ultra-short specific action justified by that metric and the rest of the user context
- food_tip: 1 sentence tied directly to the weakest area. Start with emoji. Be specific (name the food/ingredient, not just "eat healthy").
- face_tip: 1 sentence technique for today's specific issue. Start with emoji. Name the exact technique (gua sha direction, cold spoon duration, drainage pathway).
- skin_tip: 1 sentence skincare step — only include if skin score < 75, otherwise null. Start with emoji.

Return ONLY valid JSON, no markdown fences:
{
  "focus": "string",
  "motivation": "string",
  "steps": [
    { "e": "single emoji", "label": "string", "sub": "string", "area": "string" },
    { "e": "single emoji", "label": "string", "sub": "string", "area": "string" },
    { "e": "single emoji", "label": "string", "sub": "string", "area": "string" },
    { "e": "single emoji", "label": "string", "sub": "string", "area": "string" },
    { "e": "single emoji", "label": "string", "sub": "string", "area": "string" },
    { "e": "single emoji", "label": "string", "sub": "string", "area": "string" }
  ],
  "chips": [
    { "label": "string", "score": number, "note": "string" },
    { "label": "string", "score": number, "note": "string" },
    { "label": "string", "score": number, "note": "string" }
  ],
  "food_tip": "string",
  "face_tip": "string",
  "skin_tip": "string or null"
}`;

  if (!String(env.OPENROUTER_API_KEY || "").trim()) {
    return json({ ok: false, error: "ai_unavailable", reason: "OPENROUTER_API_KEY missing" }, 503);
  }

  try {
    // Include thumbnail if available — the vision model sees the actual face
    // alongside the numeric metrics, improving plan accuracy and personalisation.
    const images = thumb ? [thumb] : [];
    const result = await callOpenRouter(env, prompt, images, { tries: 2, timeoutMs: 32000, maxTokens: 2200, temperature: 0.35, responseFormat: GLOW_PLAN_RESPONSE_FORMAT });
    if (!result.ok || !result.text) {
      return json({ ok: false, error: "ai_unavailable", reason: result.reason || "OpenRouter error", status: result.status || 0 }, 503);
    }

    const txt = extractFirstJsonObject(result.text);
    if (!txt) return json({ ok: false, error: "invalid_ai_response", reason: "Glow plan JSON missing" }, 502);
    const parsed = JSON.parse(txt);

    const allowedAreas = new Set(["depuff", "water_retention", "face_fat", "skin", "jawline", "eyes", "cheekbones", "symmetry", "harmony", "nutrition", "sleep", "overall"]);
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.slice(0, 6).map((st, index) => {
          const e = requireAiEmoji(st?.e, `steps[${index}].e`);
          const label = String(st?.label || "").trim();
          const sub = String(st?.sub || "").trim();
          const area = String(st?.area || "").trim();
          if (!label || !sub || !allowedAreas.has(area)) throw new Error(`Invalid glow step ${index + 1}`);
          return { e, label, sub, area };
        })
      : [];
    if (steps.length !== 6) throw new Error("Glow plan must contain exactly 6 steps");

    const chips = Array.isArray(parsed.chips)
      ? parsed.chips.slice(0, 3).map((c, index) => {
          const label = String(c?.label || "").trim();
          const note = String(c?.note || "").trim();
          const score = Number(c?.score);
          if (!label || !note || !Number.isFinite(score)) throw new Error(`Invalid glow chip ${index + 1}`);
          return { label, score: Math.max(0, Math.min(100, Math.round(score))), note };
        })
      : [];
    if (chips.length !== 3) throw new Error("Glow plan must contain exactly 3 metric chips");

    const focus = String(parsed.focus || "").trim();
    const motivation = String(parsed.motivation || "").trim();
    const foodTip = String(parsed.food_tip || "").trim();
    const faceTip = String(parsed.face_tip || "").trim();
    if (!focus || !motivation || !foodTip || !faceTip) throw new Error("Glow plan text fields are incomplete");

    return json({
      ok: true,
      source: "openrouter",
      data: {
        focus,
        steps,
        chips,
        food_tip: foodTip,
        face_tip: faceTip,
        skin_tip: parsed.skin_tip == null ? null : String(parsed.skin_tip).trim() || null,
        motivation,
      },
    });
  } catch (e) {
    return json({ ok: false, error: "invalid_ai_response", reason: e?.message || String(e) }, 502);
  }
}

// ==================== MEAL PLAN (AI-generated, one-time per user) ====================
//
// Unlike Glow Up Plan (regenerated daily), the Meal Plan is generated ONCE from
// a short user profile (stats + goal + restrictions) and persists until the
// user explicitly asks to regenerate it. Stored in PREMIUM_KV under mealPlanKey.
//
// GET  /api/meal-plan?user_id=         → returns saved plan, or { ok:true, exists:false }
// POST /api/meal-plan                  → body: { user_id, profile: {...} } generates + saves a new plan

const MEAL_PLAN_SCHEMA_VERSION = 3;
const MEAL_PLAN_BUILD = "meal-plan-v3-current-app-compatible";
const MEAL_PLAN_COPY_LIMITS = Object.freeze({
  summary: { chars: 88, words: 14, sentence: true },
  mealName: { chars: 38, words: 7 },
  mealItems: { chars: 56, words: 9 },
  mealReason: { chars: 64, words: 11, sentence: true },
  sectionTitle: { chars: 28, words: 5 },
  guideName: { chars: 32, words: 6 },
  guideReason: { chars: 60, words: 10, sentence: true },
});

function mealPlanKey(userId) { return "mealplan:" + String(userId); }

function compactMealPlanText(value, field, limits) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${field} is missing`);
  text = text.replace(/…|\.{3,}/gu, ".").replace(/\s+([,.;:!?])/g, "$1").trim();
  const maxChars = Number(limits?.chars) || 9999;
  const maxWords = Number(limits?.words) || 9999;
  const sentence = !!limits?.sentence;
  const fits = candidate => Array.from(candidate).length <= maxChars && candidate.split(/\s+/).filter(Boolean).length <= maxWords;

  let candidate = text;
  if (sentence) {
    const firstSentence = text.match(/^.*?[.!?](?:["')\]]|$)/u)?.[0]?.trim();
    if (firstSentence && fits(firstSentence)) candidate = firstSentence;
  }
  if (!fits(candidate)) {
    const clean = candidate.replace(/[.!?]+["')\]]?$/u, "").trim();
    const kept = [];
    for (const word of clean.split(/\s+/).filter(Boolean)) {
      if (kept.length >= maxWords) break;
      const core = [...kept, word].join(" ").replace(/[,:;\-]+$/u, "");
      const probe = sentence ? core + "." : core;
      if (Array.from(probe).length > maxChars) break;
      kept.push(word);
    }
    if (!kept.length) throw new Error(`${field} cannot fit the phone card`);
    candidate = kept.join(" ").replace(/[,:;\-]+$/u, "");
  }
  if (sentence) candidate = candidate.replace(/[.!?]+["')\]]?$/u, "").trim() + ".";
  candidate = candidate.replace(/…|\.{3,}/gu, ".").replace(/\s+([,.;:!?])/g, "$1").trim();
  if (!fits(candidate)) throw new Error(`${field} cannot fit the phone card`);
  return candidate;
}

function mealPlanEmojiKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\uFE0F/g, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\s+/g, "")
    .trim();
}

function mealPlanEmojiValues(plan) {
  return [
    ...(Array.isArray(plan?.meals) ? plan.meals.map(item => item?.e) : []),
    ...(Array.isArray(plan?.eat) ? plan.eat.flatMap(section => (section?.items || []).map(item => item?.e)) : []),
    ...(Array.isArray(plan?.avoid) ? plan.avoid.flatMap(section => (section?.items || []).map(item => item?.e)) : []),
  ].map(value => String(value || "").trim()).filter(Boolean);
}

function mealPlanHasDuplicateEmojis(plan) {
  const values = mealPlanEmojiValues(plan).map(mealPlanEmojiKey).filter(Boolean);
  return new Set(values).size !== values.length;
}

function compactMealPlan(plan) {
  plan.summary = compactMealPlanText(plan.summary, "summary", MEAL_PLAN_COPY_LIMITS.summary);
  plan.meals.forEach((item, index) => {
    item.n = compactMealPlanText(item.n, `meals[${index}].n`, MEAL_PLAN_COPY_LIMITS.mealName);
    item.items = compactMealPlanText(item.items, `meals[${index}].items`, MEAL_PLAN_COPY_LIMITS.mealItems);
    item.d = compactMealPlanText(item.d, `meals[${index}].d`, MEAL_PLAN_COPY_LIMITS.mealReason);
  });
  for (const field of ["eat", "avoid"]) {
    plan[field].forEach((section, sectionIndex) => {
      section.section = compactMealPlanText(section.section, `${field}[${sectionIndex}].section`, MEAL_PLAN_COPY_LIMITS.sectionTitle);
      section.items.forEach((item, itemIndex) => {
        item.n = compactMealPlanText(item.n, `${field}[${sectionIndex}].items[${itemIndex}].n`, MEAL_PLAN_COPY_LIMITS.guideName);
        item.d = compactMealPlanText(item.d, `${field}[${sectionIndex}].items[${itemIndex}].d`, MEAL_PLAN_COPY_LIMITS.guideReason);
      });
    });
  }
  return plan;
}

function isStoredFullDayMealPlan(plan) {
  try {
    if (!plan || !String(plan.summary || "").trim() || !Array.isArray(plan.meals)) return false;
    if (plan.meals.length < 4 || plan.meals.length > 5) return false;
    if (!plan.meals.every((it, index) => {
      requireAiEmoji(it?.e, `stored.meals[${index}].e`);
      return String(it?.n || "").trim() && String(it?.items || "").trim() && String(it?.d || "").trim();
    })) return false;
    const slots = plan.meals.map(it => String(it?.slot || "").trim());
    if (slots.filter(x => x === "Morning").length !== 1) return false;
    if (slots.filter(x => x === "Midday").length !== 1) return false;
    if (slots.filter(x => x === "Evening").length !== 1) return false;
    const snackCount = slots.filter(x => x === "Snack").length;
    if (snackCount < 1 || snackCount > 2 || !slots.every(x => ["Morning", "Midday", "Evening", "Snack"].includes(x))) return false;
    const validSections = (arr, field) => Array.isArray(arr) && arr.length === 2 && arr.every((sec, secIndex) => {
      if (!String(sec?.section || "").trim() || !Array.isArray(sec?.items) || sec.items.length !== 3) return false;
      return sec.items.every((it, itemIndex) => {
        requireAiEmoji(it?.e, `stored.${field}[${secIndex}].items[${itemIndex}].e`);
        return String(it?.n || "").trim() && String(it?.d || "").trim();
      });
    });
    return validSections(plan.eat, "eat") && validSections(plan.avoid, "avoid");
  } catch {
    return false;
  }
}

async function mealPlanGet(request, env) {
  const url = new URL(request.url);
  const userId = sanitizeUserId(url.searchParams.get("user_id"));
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  const p = await readPremium(env, userId);
  if (!p.active) return json({ ok: false, error: "premium_required", premium: false }, 402);
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);
  const raw = await env.PREMIUM_KV.get(mealPlanKey(userId));
  if (!raw) return json({ ok: true, exists: false, schema_version: MEAL_PLAN_SCHEMA_VERSION });
  try {
    const saved = JSON.parse(raw);
    if (!saved || saved.source !== "openrouter" || saved.schema_version !== MEAL_PLAN_SCHEMA_VERSION || !isStoredFullDayMealPlan(saved.plan)) {
      try { await env.PREMIUM_KV.delete(mealPlanKey(userId)); } catch {}
      return json({ ok: true, exists: false, schema_version: MEAL_PLAN_SCHEMA_VERSION });
    }
    return json({ ok: true, exists: true, plan: saved.plan, profile: saved.profile, source: "openrouter", schema_version: MEAL_PLAN_SCHEMA_VERSION, updated_at: saved.updated_at });
  } catch {
    return json({ ok: true, exists: false, schema_version: MEAL_PLAN_SCHEMA_VERSION });
  }
}

async function mealPlanGenerate(request, env) {
  const body = await request.json().catch(() => ({}));
  const userId = sanitizeUserId(body.user_id || body.userId);
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  const premium = await readPremium(env, userId);
  if (!premium.active) return json({ ok: false, error: "premium_required", premium: false }, 402);

  const profileIn = body.profile && typeof body.profile === "object" ? body.profile : {};
  const sexRaw = String(profileIn.sex || "").toLowerCase();
  if (!["m", "male", "f", "female"].includes(sexRaw)) return json({ ok: false, error: "invalid_profile", field: "sex" }, 400);
  const sex = sexRaw.startsWith("f") ? "female" : "male";
  const ageRaw = Number(profileIn.age);
  if (!Number.isFinite(ageRaw) || ageRaw < 13 || ageRaw > 100) return json({ ok: false, error: "invalid_profile", field: "age" }, 400);
  const age = Math.round(ageRaw);
  const heightRaw = Number(profileIn.height_cm);
  const weightRaw = Number(profileIn.weight_kg);
  const heightCm = Number.isFinite(heightRaw) && heightRaw >= 100 && heightRaw <= 230 ? Math.round(heightRaw) : null;
  const weightKg = Number.isFinite(weightRaw) && weightRaw >= 30 && weightRaw <= 250 ? Math.round(weightRaw) : null;
  const allowedActivities = ["sedentary", "light", "moderate", "active", "very_active"];
  const allowedGoals = ["lose_fat", "maintain", "gain_muscle", "skin_focus"];
  if (!allowedActivities.includes(profileIn.activity)) return json({ ok: false, error: "invalid_profile", field: "activity" }, 400);
  if (!allowedGoals.includes(profileIn.goal)) return json({ ok: false, error: "invalid_profile", field: "goal" }, 400);
  const activity = profileIn.activity;
  const goal = profileIn.goal;
  const restrictions = Array.isArray(profileIn.restrictions) ? profileIn.restrictions.filter(v => typeof v === "string").slice(0, 10).map(v => v.trim()).filter(Boolean) : [];
  const dislikes = Array.isArray(profileIn.dislikes) ? profileIn.dislikes.filter(v => typeof v === "string").slice(0, 15).map(v => v.trim()).filter(Boolean) : [];
  const metrics = body.metrics && typeof body.metrics === "object" ? body.metrics : {};
  const weakMetrics = Object.entries(metrics).filter(([, value]) => Number.isFinite(Number(value)) && Number(value) < 70).map(([key, value]) => `${key} (${Math.round(Number(value))})`);
  const profile = { sex, age, height_cm: heightCm, weight_kg: weightKg, activity, goal, restrictions, dislikes };

  if (!String(env.OPENROUTER_API_KEY || "").trim()) return json({ ok: false, error: "ai_unavailable", reason: "OPENROUTER_API_KEY missing" }, 503);
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);

  let previousPlan = null;
  try {
    const previousRaw = await env.PREMIUM_KV.get(mealPlanKey(userId));
    const previousRecord = previousRaw ? JSON.parse(previousRaw) : null;
    if (previousRecord?.source === "openrouter" && isStoredFullDayMealPlan(previousRecord.plan)) previousPlan = previousRecord.plan;
  } catch {}

  const activityLabel = {
    sedentary: "sedentary, desk job, little exercise",
    light: "light activity, exercises 1-3x/week",
    moderate: "moderate activity, exercises 3-5x/week",
    active: "active, exercises 6-7x/week",
    very_active: "very active, trains twice daily or has a physical job",
  }[activity];
  const goalLabel = {
    lose_fat: "lose fat and stay full",
    maintain: "maintain current weight and body composition",
    gain_muscle: "gain muscle with practical protein-rich meals",
    skin_focus: "support skin quality and reduce facial puffiness through diet",
  }[goal];
  const previousNames = previousPlan ? previousPlan.meals.map(item => item.n).filter(Boolean) : [];
  const previousEmojis = previousPlan ? mealPlanEmojiValues(previousPlan) : [];

  const prompt = `You are a pragmatic nutrition coach inside FaceMax. Create one personalised, repeatable full-day meal plan in English.

USER PROFILE
Sex: ${sex}
Age: ${age}
Height: ${heightCm ? heightCm + " cm" : "not provided"}
Weight: ${weightKg ? weightKg + " kg" : "not provided"}
Activity: ${activityLabel}
Goal: ${goalLabel}
Dietary restrictions: ${restrictions.length ? restrictions.join(", ") : "none"}
Disliked foods: ${dislikes.length ? dislikes.join(", ") : "none"}
${weakMetrics.length ? "Lower face-scan metrics diet may support: " + weakMetrics.join(", ") : ""}
${previousNames.length ? "Previous meal names to avoid repeating exactly: " + previousNames.join(" | ") : ""}
${previousEmojis.length ? "Use a visibly different sticker mix where appropriate. Previous stickers: " + previousEmojis.join(" ") : ""}

REQUIRED CLIENT-COMPATIBLE STRUCTURE
- Exactly one Morning card, one Midday card and one Evening card.
- One or two Snack cards.
- Exactly two Eat sections and two Limit sections, with exactly three items per section.
- This exact structure is required by the currently installed iOS app.

CONTENT RULES
- You choose every dish, ingredient, recommendation and emoji from the user's profile.
- Respect every restriction, allergy and disliked food.
- Use real practical dishes, not generic labels.
- Choose a different matching emoji for every visible card or item whenever possible. Do not use one sticker repeatedly.
- Summary: one complete sentence, maximum 14 words.
- Dish name: maximum 7 words.
- Ingredients: maximum 9 words.
- Meal explanation: one complete sentence, maximum 11 words.
- Eat/Limit item explanation: one complete sentence, maximum 10 words.
- Never write ... or ….
- Do not give calorie targets, macro grams, supplements, medical claims or extreme dieting advice.
- Return only the JSON required by the schema.`;

  const containsWholeTerm = (haystack, term) => {
    const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z])${escape(String(term).toLowerCase())}([^a-z]|$)`, "i").test(haystack);
  };
  function validateRestrictions(plan) {
    const recommended = [
      ...plan.meals.flatMap(meal => [meal.n, meal.items]),
      ...plan.eat.flatMap(section => section.items.map(item => item.n)),
    ].join(" | ").toLowerCase();
    const forbidden = {
      vegetarian: ["chicken", "beef", "pork", "lamb", "turkey", "fish", "salmon", "tuna", "shrimp", "prawn", "crab", "lobster", "bacon", "ham"],
      vegan: ["chicken", "beef", "pork", "lamb", "turkey", "fish", "salmon", "tuna", "shrimp", "prawn", "crab", "lobster", "bacon", "ham", "egg", "eggs", "cheese", "yogurt", "yoghurt", "whey", "ghee", "honey", "dairy"],
      halal: ["pork", "bacon", "ham", "alcohol", "wine", "beer", "liquor"],
      lactose_free: ["cheese", "yogurt", "yoghurt", "whey", "ghee", "dairy", "ice cream"],
      gluten_free: ["wheat", "barley", "rye", "couscous", "regular bread", "regular pasta", "wheat flour"],
      no_alcohol: ["alcohol", "wine", "beer", "liquor", "cocktail"],
      nut_allergy: ["almond", "peanut", "cashew", "walnut", "pecan", "hazelnut", "pistachio", "nut butter", "mixed nuts"],
      shellfish_allergy: ["shrimp", "prawn", "crab", "lobster", "mussel", "clam", "oyster", "scallop", "shellfish"],
    };
    for (const restriction of restrictions) {
      const found = (forbidden[restriction] || []).find(term => containsWholeTerm(recommended, term));
      if (found) throw new Error(`Meal plan violates ${restriction}: ${found}`);
    }
    for (const dislike of dislikes) if (dislike.length >= 3 && containsWholeTerm(recommended, dislike)) throw new Error(`Meal plan includes disliked food: ${dislike}`);
  }

  function sanitizeMealCard(value, field) {
    if (!value || typeof value !== "object") throw new Error(`${field} is missing`);
    const card = {
      e: requireAiEmoji(value.e, `${field}.e`),
      n: String(value.n || "").trim(),
      items: String(value.items || "").trim(),
      d: String(value.d || "").trim(),
    };
    if (!card.n || !card.items || !card.d) throw new Error(`${field} is incomplete`);
    return card;
  }
  function sanitizeMeals(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("meals object is missing");
    const snacks = Array.isArray(value.snacks) ? value.snacks : [];
    if (snacks.length < 1 || snacks.length > 2) throw new Error("meals.snacks must contain one or two snacks");
    return [
      { slot: "Morning", ...sanitizeMealCard(value.morning, "meals.morning") },
      { slot: "Midday", ...sanitizeMealCard(value.midday, "meals.midday") },
      { slot: "Evening", ...sanitizeMealCard(value.evening, "meals.evening") },
      ...snacks.map((item, index) => ({ slot: "Snack", ...sanitizeMealCard(item, `meals.snacks[${index}]`) })),
    ];
  }
  function sanitizeSections(value, field) {
    if (!Array.isArray(value) || value.length !== 2) throw new Error(`${field} needs exactly two sections`);
    return value.map((section, sectionIndex) => {
      if (!section || typeof section !== "object" || !Array.isArray(section.items) || section.items.length !== 3) throw new Error(`${field}[${sectionIndex}] is incomplete`);
      const sectionName = String(section.section || "").trim();
      if (!sectionName) throw new Error(`${field}[${sectionIndex}].section is missing`);
      return {
        section: sectionName,
        items: section.items.map((item, itemIndex) => {
          const clean = {
            e: requireAiEmoji(item?.e, `${field}[${sectionIndex}].items[${itemIndex}].e`),
            n: String(item?.n || "").trim(),
            d: String(item?.d || "").trim(),
          };
          if (!clean.n || !clean.d) throw new Error(`${field}[${sectionIndex}].items[${itemIndex}] is incomplete`);
          return clean;
        }),
      };
    });
  }

  let lastReason = "Meal plan response was incomplete";
  let lastRequestId = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptPrompt = attempt === 0 ? prompt : `${prompt}\n\nYour previous response was rejected because: ${lastReason}. Return a fresh complete plan in the exact required structure.`;
    const result = await callOpenRouter(env, attemptPrompt, [], {
      tries: 1,
      timeoutMs: 42000,
      maxTokens: 4096,
      temperature: previousPlan ? 0.68 : 0.55,
      responseFormat: MEAL_PLAN_RESPONSE_FORMAT,
    });
    lastRequestId = result.request_id || lastRequestId;
    lastStatus = Number(result.status) || lastStatus;
    if (!result.ok || !result.text) {
      lastReason = result.reason || "OpenRouter error";
      continue;
    }
    try {
      const text = extractFirstJsonObject(result.text);
      if (!text) throw new Error("Meal plan JSON missing");
      const parsed = JSON.parse(text);
      const summary = String(parsed.summary || "").trim();
      if (!summary) throw new Error("Meal plan summary is missing");
      const plan = compactMealPlan({
        summary,
        meals: sanitizeMeals(parsed.meals),
        eat: sanitizeSections(parsed.eat, "eat"),
        avoid: sanitizeSections(parsed.avoid, "avoid"),
      });
      validateRestrictions(plan);
      if (!isStoredFullDayMealPlan(plan)) throw new Error("Meal plan is incompatible with the current iOS app");
      // Duplicate stickers cause one best-effort retry, but never make the
      // second otherwise-valid plan fail. Reliability is more important than
      // rejecting a complete plan because of one emoji.
      if (attempt === 0 && mealPlanHasDuplicateEmojis(plan)) throw new Error("some stickers were repeated; use a different matching emoji for each item");

      const updatedAt = Date.now();
      await env.PREMIUM_KV.put(mealPlanKey(userId), JSON.stringify({ plan, profile, source: "openrouter", schema_version: MEAL_PLAN_SCHEMA_VERSION, updated_at: updatedAt }));
      return json({ ok: true, source: "openrouter", schema_version: MEAL_PLAN_SCHEMA_VERSION, plan, profile, updated_at: updatedAt, request_id: lastRequestId, build: MEAL_PLAN_BUILD });
    } catch (error) {
      lastReason = String(error?.message || error || "Meal plan validation failed").slice(0, 220);
    }
  }

  return json({ ok: false, error: lastStatus ? "invalid_ai_response" : "ai_unavailable", reason: lastReason, upstream_status: lastStatus || null, request_id: lastRequestId, build: MEAL_PLAN_BUILD }, lastStatus ? 502 : 503);
}

// ─── Sign in with Apple ───────────────────────────────────────────────────────
// Verifies Apple identity token, creates/fetches user, returns stable user_id.
// Apple's public keys endpoint used to verify JWT signature.

async function appleSignIn(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const { identity_token, user_id: appleUserId, full_name, email } = body;
  if (!identity_token) return json({ ok: false, error: "identity_token required" }, 400);

  // Verify the token was actually signed by Apple (fetches Apple's JWKS,
  // checks RS256 signature, then iss/exp/aud) before trusting anything in
  // it. This is what makes isVerifiedReferralUser()'s "apple_" prefix
  // actually mean something — see verifyAppleIdentityToken() for details.
  // APPLE_BUNDLE_ID / APPLE_SERVICE_ID env vars are optional extra audience
  // values (native app vs. web "Sign in with Apple" flows use different
  // aud claims); we always accept the default app bundle id too.
  const expectedAudiences = [
    APPLE_BUNDLE_ID_DEFAULT,
    env.APPLE_BUNDLE_ID,
    env.APPLE_SERVICE_ID,
  ].filter(Boolean);

  let payload;
  try {
    payload = await verifyAppleIdentityToken(identity_token, env, expectedAudiences);
  } catch (err) {
    return json({ ok: false, error: "Invalid identity token", detail: String(err.message || err) }, 401);
  }

  // sub comes only from the verified token payload now — verifyAppleIdentityToken()
  // already guarantees it's present, but keep the check for defense in depth.
  // The client-supplied appleUserId (unverified, from the request body) is
  // intentionally never used to determine identity.
  const sub = payload.sub;
  if (!sub) return json({ ok: false, error: "No user identifier in token" }, 400);
  void appleUserId; // kept in the destructure only for logging/back-compat if needed

  // Stable user_id = "apple_" + Apple's sub (never changes)
  const userId = "apple_" + sub.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);

  // Save or update user profile in KV
  const profileKey = "profile:" + userId;
  let profile = {};
  try {
    const existing = await env.PREMIUM_KV.get(profileKey);
    if (existing) profile = JSON.parse(existing);
  } catch {}

  // Only update name/email on first sign in (Apple only sends them once)
  if (!profile.created_at) {
    profile.created_at = Date.now();
    profile.apple_sub = sub;
    if (email && !email.includes("privaterelay")) profile.email = email;
    if (full_name && (full_name.givenName || full_name.familyName)) {
      profile.name = [full_name.givenName, full_name.familyName].filter(Boolean).join(" ");
    }
  }
  profile.last_seen = Date.now();
  profile.user_id = userId;

  try {
    await env.PREMIUM_KV.put(profileKey, JSON.stringify(profile));
  } catch {}

  // Check existing premium under Apple ID
  let premiumData = await readPremium(env, userId);

  // Migrate premium from anonymous user ID if Apple account doesn't have it yet.
  // This covers the case where the user bought a subscription before signing in
  // with Apple — the purchase was saved under their anonymous facemax_uid, but
  // checkPremium() now queries under the apple_* ID and finds nothing.
  if (!premiumData.active) {
    const anonId = sanitizeUserId(body.anon_user_id || null);
    if (anonId && anonId !== userId) {
      const anonPremium = await readPremium(env, anonId);
      if (anonPremium.active && anonPremium.premium_until > Date.now()) {
        await savePremium(env, userId, anonPremium.premium_until, "migrated-from-anon:" + anonId);
        premiumData = await readPremium(env, userId);
      }
    }
  }

  return json({
    ok: true,
    user_id: userId,
    name: profile.name || null,
    email: profile.email || null,
    premium: premiumData.premium || false,
    premium_until: premiumData.premium_until || null,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/" || path === "/health") return json({
        ok: true, app: "FaceMax AI API", message: "Worker backend is running",
        build: MEAL_PLAN_BUILD,
        meal_plan_schema_version: MEAL_PLAN_SCHEMA_VERSION,
        frontend_url_clean: cleanUrl(env.FRONTEND_URL || ""),
        endpoints: [
          "/api/auth/apple (POST)",
          "/api/premium-status?user_id=",
          "/api/scan-count?user_id=",
          "/api/scan-count (POST)",
          "/api/gemini-config-check",
          "/api/glow-plan",
          "/api/meal-plan?user_id= (GET)",
          "/api/meal-plan (POST)",
          "/api/full-report",
          "/api/food-scan",
          "/api/dating-photo",
          "/api/haircut-guide",
          "/api/skin-plan",
          "/api/jawline-plan",
          "/api/apple-receipt-verify",
          "/api/apple-server-notification",
          "/api/referral/code?user_id=",
          "/api/referral/redeem (POST)",
          "/api/referral/status?user_id=",
        ]
      });

      if (path === "/api/auth/apple" && request.method === "POST") return await appleSignIn(request, env);

      if (path === "/api/premium-status") return json(await readPremium(env, sanitizeUserId(getUserIdFromRequest(url, {}))));
      if (path === "/api/scan-count" && request.method === "GET") return await scanCountGet(request, env);
      if (path === "/api/scan-count" && request.method === "POST") return await scanCountIncrement(request, env);
      if (path === "/api/access") return json(await readPremium(env, sanitizeUserId(url.searchParams.get("email"))));
      if (path === "/api/test-grant") {
        // DANGEROUS endpoint: grants premium with no purchase, no proof of
        // anything. Only usable when ADMIN_SECRET is configured server-side
        // AND supplied via X-Admin-Secret — otherwise pretend it doesn't
        // exist, so it isn't discoverable as a free-premium oracle.
        const adminSecret = String(env.ADMIN_SECRET || "").trim();
        const provided = String(request.headers.get("X-Admin-Secret") || "").trim();
        if (!adminSecret || provided !== adminSecret) return json({ ok: false, error: "not_found" }, 404);
        const userId = sanitizeUserId(getUserIdFromRequest(url, {})) || "test-user";
        const until = await savePremium(env, userId, nowPlusPremium(), "test_grant");
        return json({ ok: true, active: true, premium: true, user_id: String(userId), premium_until: until });
      }

      if (path === "/api/payment-success") {
        // Same risk as test-grant above: this must never be reachable
        // without proof of an actual payment. Require ADMIN_SECRET too.
        const adminSecret = String(env.ADMIN_SECRET || "").trim();
        const provided = String(request.headers.get("X-Admin-Secret") || "").trim();
        if (!adminSecret || provided !== adminSecret) return json({ ok: false, error: "not_found" }, 404);
        const userId = sanitizeUserId(getUserIdFromRequest(url, {}));
        if (!userId) return json({ ok: false, error: "user_id required" }, 400);
        const until = await savePremium(env, userId, nowPlusPremium(), "payment_success_redirect");
        return json({ ok: true, active: true, premium: true, user_id: String(userId), premium_until: until, expires_iso: new Date(until).toISOString() });
      }

      if (path === "/api/gemini-config-check") {
        const openrouterPresent = !!String(env.OPENROUTER_API_KEY || "").trim();
        return json({
          ok: true,
          backend: "openrouter",
          openrouter_api_key_present: openrouterPresent,
          model: "google/gemini-2.5-flash-lite",
          provider: "google-vertex/eu",
          region: "EU",
          allow_fallbacks: false,
          data_collection: "deny",
          structured_outputs: true,
          response_healing: true,
          request_timeout_ms: 42000,
          meal_plan_build: MEAL_PLAN_BUILD,
          meal_plan_schema_version: MEAL_PLAN_SCHEMA_VERSION,
          note: openrouterPresent
            ? "OpenRouter key present — all AI calls are restricted to Google Vertex AI EU"
            : "OPENROUTER_API_KEY missing — AI flows fail closed with an explicit error"
        });
      }

      if (path === "/api/glow-plan" && request.method === "POST") return await glowPlan(request, env);
      if (path === "/api/meal-plan" && request.method === "GET") return await mealPlanGet(request, env);
      if (path === "/api/meal-plan" && request.method === "POST") return await mealPlanGenerate(request, env);
      if (path === "/api/face-check" && request.method === "POST") return await faceCheck(request, env);
      if (path === "/api/full-report" && request.method === "POST") return await fullReport(request, env);
      if (path === "/api/food-scan" && request.method === "POST") return await foodScan(request, env);
      if (path === "/api/dating-photo" && request.method === "POST") return await simpleTool(request, env, "dating-photo");
      if (path === "/api/haircut-guide" && request.method === "POST") return await simpleTool(request, env, "haircut-guide");
      if (path === "/api/skin-plan" && request.method === "POST") return await simpleTool(request, env, "skin-plan");
      if (path === "/api/jawline-plan" && request.method === "POST") return await simpleTool(request, env, "jawline-plan");

      if (path === "/api/apple-receipt-verify" && request.method === "POST") return await verifyAppleReceipt(request, env);
      if (path === "/api/apple-server-notification" && request.method === "POST") return await appleServerNotification(request, env);

      if (path === "/api/revenuecat-webhook" && request.method === "POST") return await revenueCatWebhook(request, env);

      if (path === "/api/delete-account" && request.method === "POST") return await deleteAccount(request, env);

      if (path === "/api/referral/code" && request.method === "GET") return await referralCodeGet(request, env);
      if (path === "/api/referral/redeem" && request.method === "POST") return await referralRedeem(request, env);
      if (path === "/api/referral/status" && request.method === "GET") return await referralStatus(request, env);

      return json({ ok: false, error: "Not found", path }, 404);
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e), path }, 500);
    }
  },
};