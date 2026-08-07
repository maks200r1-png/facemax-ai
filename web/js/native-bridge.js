/* FaceMax AI — native bridge.
 *
 * Loaded by both the web (facemaxaiapp.com) and the iOS Capacitor wrapper.
 * Exposes a thin `window.facemax` API that the main app uses to:
 *   - Detect the runtime (web vs native iOS).
 *   - Pick a photo (camera or library) via the best available picker.
 *   - Trigger haptics on key buttons.
 *   - Drive subscription purchases (RevenueCat on native, web purchases disabled).
 *
 * The web frontend should never crash if native plugins are missing — every
 * native path falls back to the existing web behavior.
 */

(function () {
  "use strict";

  const facemax = (window.facemax = window.facemax || {});
  facemax.native = false;
  facemax.platform = "web";
  facemax.bundleId = "ai.facemax.app";

  function detect() {
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) {
      facemax.native = true;
      facemax.platform = (typeof cap.getPlatform === "function") ? cap.getPlatform() : "ios";
    }
    document.documentElement.classList.toggle("fm-native", facemax.native);
    document.documentElement.classList.add("fm-platform-" + facemax.platform);
  }

  // -------------------- Haptics --------------------

  facemax.haptic = function (style) {
    try {
      const Haptics = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (Haptics && facemax.native) {
        if (style === "selection") return Haptics.selectionStart();
        const styleEnum = { light: "LIGHT", medium: "MEDIUM", heavy: "HEAVY" }[style] || "LIGHT";
        return Haptics.impact({ style: styleEnum });
      }
      if (navigator.vibrate) navigator.vibrate(style === "heavy" ? 25 : style === "medium" ? 15 : 8);
    } catch (e) { /* ignore */ }
  };

  function bindHaptics() {
    document.addEventListener("click", function (e) {
      const btn = e.target.closest("button, .btn, .nav, .tool, .meal-tab");
      if (!btn) return;
      const style = btn.classList.contains("btn-pay") || btn.classList.contains("btn-pay-starter")
        ? "medium"
        : btn.classList.contains("nav") ? "light" : "light";
      facemax.haptic(style);
    }, { passive: true });
  }

  // -------------------- Photo picker --------------------

  // Wait up to maxMs for a named Capacitor plugin to register on the bridge.
  // Bridge registration is async and can lag 200-2000 ms after DOMContentLoaded.
  function _waitForPlugin(name, maxMs) {
    return new Promise(function (resolve) {
      var elapsed = 0;
      var interval = 100;
      function check() {
        var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name];
        if (p) { resolve(p); return; }
        elapsed += interval;
        if (elapsed >= maxMs) { resolve(null); return; }
        setTimeout(check, interval);
      }
      check();
    });
  }

  // Returns a Promise<string|null> with a data URL or null on cancel.
  facemax.pickPhoto = async function (opts) {
    opts = opts || {};
    const Camera = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
    // Wait up to 5 s for CameraOval to register on the Capacitor bridge.
    // Without this, calling pickPhoto right after app launch races the bridge
    // and CameraOval comes back undefined — falling back to the system iOS camera.
    const CameraOval = (facemax.native && opts.fromCamera && !opts.useSystemCamera)
      ? await _waitForPlugin("CameraOval", 5000)
      : (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CameraOval);

    // Camera capture: use our custom native camera (no system "Retake / Use Photo"
    // confirmation screen — the photo is returned to the app the instant the
    // shutter is tapped).
    // Skipped when opts.useSystemCamera is true — caller explicitly wants the
    // standard iOS camera UI (shutter + Retake/Use Photo) via Capacitor Camera below.
    // CameraOval.open() is deprecated (rejects immediately). Only the embedded
    // startEmbedded/capture/stopEmbedded flow is supported now.
    // For BACK camera (food scan) skip CameraOval entirely and fall through to
    // the Capacitor Camera plugin below which opens the full system camera UI.
    if (CameraOval && facemax.native && opts.fromCamera && !opts.useSystemCamera && opts.direction !== "BACK") {
      if (typeof window.fmLog === "function") window.fmLog("info", "pickPhoto: CameraOval.open() path reached (deprecated) — rejecting and falling back", { direction: opts.direction });
      // CameraOval.open() always rejects — skip it and fall through to system camera
    }

    // fromCamera with BACK direction: use system camera (Capacitor Camera plugin).
    // fromCamera with FRONT direction and no CameraOval: return error (should use embeddedCamera instead).
    if (opts.fromCamera && facemax.native && opts.direction !== "BACK") {
      if (typeof window.fmLog === "function") window.fmLog("error", "pickPhoto: fromCamera=true on native but no embedded camera path taken", { direction: opts.direction, hasCameraOval: !!CameraOval });
      return "__error__";
    }

    // Photo library picker (gallery) OR system camera (for BACK camera food scan).
    if (Camera && facemax.native) {
      const source = opts.fromCamera ? "CAMERA" : (opts.fromLibrary ? "PHOTOS" : "PROMPT");
      if (typeof window.fmLog === "function") window.fmLog("info", "pickPhoto: Camera.getPhoto", {
        source, direction: opts.direction, fromCamera: opts.fromCamera, fromLibrary: opts.fromLibrary,
        hasCamera: !!Camera, cameraKeys: Camera ? Object.keys(Camera) : [],
      });
      try {
        const res = await Camera.getPhoto({
          quality: 97,
          allowEditing: false,
          resultType: "DataUrl",
          source,
          direction: opts.fromCamera ? (opts.direction || "FRONT") : undefined,
          presentationStyle: "fullscreen",
          correctOrientation: true,
          saveToGallery: false,
        });
        if (typeof window.fmLog === "function") window.fmLog("info", "pickPhoto: Camera.getPhoto resolved", {
          hasRes: !!res, hasDataUrl: !!(res && res.dataUrl), urlLen: res && res.dataUrl ? res.dataUrl.length : 0,
        });
        if (!res) return null;
        let url = res.dataUrl || res.base64Data || res.base64String || null;
        if (!url) return null;
        if (!url.startsWith("data:")) url = "data:image/jpeg;base64," + url;
        return url;
      } catch (err) {
        const msg = (err && err.message) || String(err);
        const cancelled = (err && err.userCancelled) ||
          /cancel/i.test(msg) || /dismiss/i.test(msg);
        if (typeof window.fmLog === "function") window.fmLog(cancelled ? "info" : "error", "pickPhoto: Camera.getPhoto threw", {
          cancelled, message: msg, name: err && err.name, code: err && err.code,
        });
        if (cancelled) return null;
        return "__error__";
      }
    }
    if (typeof window.fmLog === "function") window.fmLog("warn", "pickPhoto: no Camera plugin and not native — returning null", { hasCamera: !!Camera, isNative: facemax.native });
    return null; // Web flow handled by the existing <input type="file"> path.
  };

  // -------------------- Embedded oval camera (inline live preview) --------------------
  //
  // Drives the native CameraOval.startEmbedded/updateEmbeddedRect/capture/stopEmbedded
  // API so the live front-camera feed renders directly inside the HTML
  // `#capOval` element (clipped to its oval shape natively), instead of a
  // full-screen native camera controller. On web (non-native), this falls
  // back to a plain getUserMedia stream painted into the same element via
  // a <video> the caller supplies.
  //
  // Usage (see index.html onbOpenCamera / closeFaceScanCamera):
  //   await facemax.embeddedCamera.start(document.getElementById('capOval'), { direction: 'FRONT' });
  //   const dataUrl = await facemax.embeddedCamera.capture();
  //   await facemax.embeddedCamera.stop();
  //
  // start() resolves true if the native (or web fallback) preview is live,
  // false if neither is available (caller should fall back to the system
  // camera / file picker).

  facemax.embeddedCamera = (function () {
    let active = false;
    let ovalEl = null;
    let resizeHandler = null;
    let webStream = null;
    let webVideoEl = null;

    function ovalRect(el) {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }

    async function start(el, opts) {
      opts = opts || {};
      if (typeof window.fmLog === "function") window.fmLog("info", "embeddedCamera.start() called", { hasEl: !!el, opts: opts, native: facemax.native, platform: facemax.platform });
      if (!el) {
        if (typeof window.fmLog === "function") window.fmLog("error", "embeddedCamera.start() aborted: no #capOval element passed in");
        return false;
      }
      ovalEl = el;

      const CameraOval = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CameraOval;
      if (typeof window.fmLog === "function") {
        window.fmLog("info", "CameraOval plugin lookup", {
          hasCapacitor: !!window.Capacitor,
          hasPlugins: !!(window.Capacitor && window.Capacitor.Plugins),
          pluginNames: (window.Capacitor && window.Capacitor.Plugins) ? Object.keys(window.Capacitor.Plugins) : [],
          foundCameraOval: !!CameraOval,
          hasStartEmbedded: !!(CameraOval && typeof CameraOval.startEmbedded === "function"),
        });
      }

      if (facemax.native && CameraOval && typeof CameraOval.startEmbedded === "function") {
        try {
          // cam-live and cam-active are set by onbOpenLiveCamera (index.html) BEFORE
          // calling embeddedCamera.start(), so the background is already transparent
          // when startEmbedded is called. We still do the rAF+80ms pause here so the
          // WebView composites the transparent background before the native preview layer
          // is inserted behind it.
          await new Promise(function(r) { requestAnimationFrame(function() { setTimeout(r, 80); }); });
          const rect = ovalRect(el);
          if (typeof window.fmLog === "function") window.fmLog("info", "calling CameraOval.startEmbedded()", rect);
          await CameraOval.startEmbedded({
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            direction: opts.direction || "FRONT",
            shape: opts.shape || "OVAL",
            adaptiveZoom: opts.adaptiveZoom !== false,
          });
          if (typeof window.fmLog === "function") window.fmLog("info", "CameraOval.startEmbedded() resolved OK");
          active = true;

          // Keep the native preview glued to the oval if it moves (resize,
          // orientation change, keyboard show/hide, scroll within a flex layout).
          resizeHandler = function () {
            if (!active || !ovalEl) return;
            const r = ovalRect(ovalEl);
            CameraOval.updateEmbeddedRect({ x: r.x, y: r.y, width: r.width, height: r.height }).catch(function(){});
          };
          window.addEventListener("resize", resizeHandler);
          window.addEventListener("orientationchange", resizeHandler);
          // Re-sync a couple times right after start in case layout (fonts,
          // images) shifts the oval slightly once everything settles.
          setTimeout(resizeHandler, 150);
          setTimeout(resizeHandler, 500);
          return true;
        } catch (err) {
          active = false;
          // cam-live / cam-active rollback is the caller's responsibility
          // (onbOpenLiveCamera checks ok===false and removes both classes).
          if (typeof window.fmLog === "function") {
            window.fmLog("error", "CameraOval.startEmbedded() THREW / rejected:", {
              message: err && err.message,
              code: err && err.code,
              errorMessage: err && err.errorMessage,
              raw: (function(){ try { return JSON.stringify(err); } catch(_) { return String(err); } })(),
            });
          }
          return false;
        }
      }

      if (typeof window.fmLog === "function") {
        window.fmLog("warn", "Native CameraOval path NOT taken — falling through to web getUserMedia (or failing entirely)", {
          isNative: facemax.native, hasCameraOvalPlugin: !!CameraOval,
        });
      }

      // Web fallback: plain getUserMedia painted as a <video> behind the
      // oval's example/shot images (which the caller should hide via the
      // same .cam-live CSS class).
      if (!facemax.native && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          let stream;
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: (opts.direction === "BACK") ? "environment" : "user", width: { ideal: 1280 }, height: { ideal: 960 } },
              audio: false,
            });
          } catch (_) {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          }
          webStream = stream;
          let video = el.querySelector("video.cap-oval-live-video");
          if (!video) {
            video = document.createElement("video");
            video.className = "cap-oval-live-video";
            video.setAttribute("playsinline", "");
            video.setAttribute("autoplay", "");
            video.muted = true;
            video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:" + ((opts.direction === "BACK") ? "none" : "scaleX(-1)") + ";";
            el.insertBefore(video, el.firstChild);
          }
          video.srcObject = stream;
          try { await video.play(); } catch (_) {}
          webVideoEl = video;
          el.classList.add("cam-live");
          active = true;
          return true;
        } catch (err) {
          active = false;
          if (typeof window.fmLog === "function") window.fmLog("error", "Web getUserMedia fallback failed:", err && err.message);
          return false;
        }
      }

      if (typeof window.fmLog === "function") window.fmLog("error", "embeddedCamera.start() returning FALSE — no native plugin and no web getUserMedia available");
      return false;
    }

    async function capture() {
      const CameraOval = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CameraOval;
      if (facemax.native && CameraOval && typeof CameraOval.capture === "function") {
        try {
          // quality: 88 and maxSize: 1800 reduce the bridge payload from ~8MB to ~500KB,
          // cutting capture latency from 4–8s to under 1s on most devices.
          const res = await CameraOval.capture({ quality: 88, maxSize: 1800 });
          let url = res && res.dataUrl;
          if (!url) {
            if (typeof window.fmLog === "function") window.fmLog("error", "CameraOval.capture() resolved with no dataUrl", res);
            return null;
          }
          if (!url.startsWith("data:")) url = "data:image/jpeg;base64," + url;
          if (typeof window.fmLog === "function") window.fmLog("info", "CameraOval.capture() OK, dataUrl length:", url.length);
          return url;
        } catch (err) {
          if (typeof window.fmLog === "function") window.fmLog("error", "CameraOval.capture() THREW:", err && (err.message || JSON.stringify(err)));
          return "__error__";
        }
      }
      if (webVideoEl && webVideoEl.videoWidth) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = webVideoEl.videoWidth;
          canvas.height = webVideoEl.videoHeight;
          const ctx = canvas.getContext("2d");
          // Mirror back so the saved photo matches reality (the preview itself
          // is mirrored via CSS transform for a natural "looking in a mirror" feel).
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(webVideoEl, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/jpeg", 0.92);
        } catch (err) {
          if (typeof window.fmLog === "function") window.fmLog("error", "Web canvas capture failed:", err && err.message);
          return "__error__";
        }
      }
      if (typeof window.fmLog === "function") window.fmLog("error", "embeddedCamera.capture() found no active native or web video source");
      return null;
    }

    async function stop() {
      active = false;
      if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
        window.removeEventListener("orientationchange", resizeHandler);
        resizeHandler = null;
      }
      if (ovalEl) ovalEl.classList.remove("cam-live");

      const CameraOval = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CameraOval;
      if (facemax.native && CameraOval && typeof CameraOval.stopEmbedded === "function") {
        try { await CameraOval.stopEmbedded(); } catch (_) {}
      }
      if (webStream) {
        try { webStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        webStream = null;
      }
      if (webVideoEl) {
        try { webVideoEl.srcObject = null; } catch (_) {}
        webVideoEl = null;
      }
      ovalEl = null;
    }

    function isActive() { return active; }

    return { start: start, capture: capture, stop: stop, isActive: isActive };
  })();

  // -------------------- Save to Photos --------------------

  // Saves a base64 PNG/JPEG to the device photo library.
  // Uses the Filesystem plugin to write to DOCUMENTS then Share to trigger
  // the system save dialog — the only reliable cross-iOS-version approach
  // with @capacitor/filesystem v7 (directory:"PHOTOS" was removed).
  facemax.saveToPhotos = async function (base64Data, filename) {
    filename = filename || ("facemax-" + Date.now() + ".png");
    const Filesystem = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
    const SharePlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
    if (!Filesystem || !facemax.native) return { ok: false, error: "not_native" };

    try {
      // 1. Write to DATA/Documents (CACHE is sometimes not readable by the
      //    Share extension's sandbox, which silently breaks "Save Image").
      const writeResult = await Filesystem.writeFile({
        path: filename,
        data: base64Data,
        directory: "DATA",
      });
      let uri = writeResult && writeResult.uri;
      if (!uri) return { ok: false, error: "write_failed" };

      // Normalise to a file:// URI — some Capacitor versions return a bare
      // path without scheme, which Share/iOS can't resolve.
      if (!/^[a-z]+:\/\//i.test(uri)) uri = "file://" + uri;

      // 2. Use Share plugin to show "Save Image" in the iOS share sheet
      //    The user taps "Save Image" — this is the standard iOS pattern and
      //    requires no Photos permission prompt at all (iOS 14+).
      if (SharePlugin) {
        await SharePlugin.share({
          url: uri,
          dialogTitle: "Save to Photos",
        });
        return { ok: true };
      }
      return { ok: false, error: "share_unavailable" };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (/cancel/i.test(msg) || /dismiss/i.test(msg)) return { ok: false, error: "cancelled" };
      return { ok: false, error: msg };
    }
  };

  // -------------------- Subscriptions (RevenueCat on native) --------------------

  // Mapping between our backend plan names and Apple product IDs.
  facemax.products = {
    weekly:   { appleId: "com.facemaxai.app.weekly",   plan: "starter",  entitlement: "premium" },
    monthly:  { appleId: "com.facemaxai.app.monthly",  plan: "full",     entitlement: "premium" },
    yearly:   { appleId: "com.facemaxai.app.yearly",   plan: "yearly",   entitlement: "premium" },
    lifetime: { appleId: "com.facemaxai.app.lifetime", plan: "lifetime", entitlement: "premium" },
  };

  let purchasesReady = null;
  let _rcConfiguredUserId = null;

  async function initRevenueCat(userId) {
    if (!facemax.native) return false;
    // Capacitor registers native plugins asynchronously. A paid feature can be
    // tapped immediately after launch, before the Purchases bridge exists. The
    // old code treated that short startup race as "no subscription", fell back
    // to the stale backend mirror and showed a paywall. A later face scan then
    // checked again after the plugin had registered, found the active Sandbox /
    // TestFlight entitlement and synced its newer expiration — making it look as
    // if uploading a photo had renewed Premium. Wait for the native bridge here
    // so every paid entry point gets the same RevenueCat answer.
    let Purchases = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases;
    if (!Purchases) Purchases = await _waitForPlugin("Purchases", 12000);
    if (!Purchases) {
      _lastPriceError = "initRevenueCat(): Purchases plugin was not registered after 12s.";
      return false;
    }

    const needsLogin = userId && _rcConfiguredUserId !== userId;

    // SDK already running and no identity change needed — return existing promise.
    if (purchasesReady && !needsLogin) return purchasesReady;

    if (!purchasesReady) {
      // ── First-time setup: configure the SDK. ──────────────────────────────
      purchasesReady = (async function () {
        const apiKey = window.FACEMAX_REVENUECAT_API_KEY || "";
        if (!apiKey) {
          console.warn("[facemax] RevenueCat API key not configured");
          _lastPriceError = "RevenueCat API key not configured (window.FACEMAX_REVENUECAT_API_KEY is empty).";
          return false;
        }
        // Keep RevenueCat logging quiet in TestFlight/production. VERBOSE can
        // generate a large burst of native logs around StoreKit transaction
        // updates/renewals and adds needless work while the WebView is resuming.
        try { await Purchases.setLogLevel({ level: "WARN" }); } catch (_) {}
        await Purchases.configure({ apiKey, appUserID: userId || null });
        _rcConfiguredUserId = userId || null;
        // ── Warmup: fetch offerings immediately after configure() so the SDK
        // network stack, auth token and offering cache are all primed BEFORE
        // the user taps "Buy". Without this, the very first getOfferings() call
        // inside findPackageForProduct() races with SDK initialisation and fails
        // → purchase fails on the first attempt, succeeds on the second (SDK
        // is settled by then). Swallowing errors here is intentional — a failed
        // warmup is non-fatal; findPackageForProduct will retry on demand.
        try { await Purchases.getOfferings(); } catch (_) {}
        return true;
      })();
    } else if (needsLogin) {
      // ── SDK already initialised, userId changed ────────────────────────────
      // FIX: use logIn() instead of calling configure() a second time.
      //
      // Calling configure() again forces the RevenueCat iOS SDK to fully reset
      // (clears offering cache, reinits network stack, re-auths).  The very
      // next getOfferings() call lands during this transitional state → network
      // error.  That is why the FIRST purchase attempt always fails and the
      // second always succeeds (SDK is settled by then).
      //
      // logIn() switches the user identity without tearing down the SDK,
      // so getOfferings() immediately after works on the first try.
      const prevReady = purchasesReady;
      purchasesReady = (async function () {
        const ok = await prevReady;
        if (!ok) return false;
        try {
          await Purchases.logIn({ appUserID: userId });
          _rcConfiguredUserId = userId;
        } catch (e) {
          // logIn failing is non-fatal — the SDK is still running and purchases
          // will complete under the previously-configured identity.
          console.warn("[facemax] RC logIn failed, continuing with existing identity:", e);
        }
        return true;
      })();
    }

    return purchasesReady;
  }

  // Fetch live prices from RevenueCat / StoreKit and cache them.
  // Returns a map: { weekly, monthly, yearly, lifetime } with priceString from StoreKit.
  // Never falls back to hardcoded prices — Apple requires all prices come from StoreKit.
  // UI elements show "\u2026" until this resolves (set via data-price-plan default text).
  const _emptyPrices = {
    weekly: "\u2026", monthly: "\u2026", yearly: "\u2026", lifetime: "\u2026",
    yearlyPrice: null  // raw numeric price for per-month calculation
  };
  let _cachedPrices = null;
  // --- TEMP DIAGNOSTIC ---------------------------------------------------
  // Holds a human-readable string describing the last reason loadPrices()
  // failed to produce a real price. Read by index.html's renderPrices() to
  // show the actual error on-screen (instead of a silent "…") when there is
  // no Mac/Console available to read device logs. Remove together with the
  // on-screen banner code in index.html once the real cause is found.
  let _lastPriceError = null;
  facemax.getLastPriceError = function () { return _lastPriceError; };
  // ------------------------------------------------------------------------

  // Wait for the Capacitor Purchases plugin to register (it appears on
  // window.Capacitor.Plugins after the native layer finishes bridging, which
  // can be 200–2000 ms after DOMContentLoaded depending on device speed and
  // Capacitor version). Polls every 300 ms, gives up after maxMs milliseconds.
  function _waitForPurchasesPlugin(maxMs) {
    return new Promise(function (resolve) {
      var elapsed = 0;
      var interval = 300;
      function check() {
        var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases;
        if (P) { resolve(P); return; }
        elapsed += interval;
        if (elapsed >= maxMs) { resolve(null); return; }
        setTimeout(check, interval);
      }
      check();
    });
  }

  // Fetch offerings with up to 3 retries + exponential backoff.
  // getOfferings can fail silently on the first call if the RC SDK hasn't
  // fully settled its network stack yet (even after configure() resolves).
  async function _getOfferingsWithRetry(Purchases) {
    var delays = [0, 800, 2000, 4000];
    var lastErr;
    var lastRawResult; // TEMP DIAGNOSTIC: keep the full raw result even when "empty"
    for (var i = 0; i < delays.length; i++) {
      if (delays[i] > 0) {
        await new Promise(function(r) { setTimeout(r, delays[i]); });
      }
      try {
        var result = await Purchases.getOfferings();
        lastRawResult = result;
        // IMPORTANT: Purchases.getOfferings() resolves directly to a
        // PurchasesOfferings object — i.e. `result.current` / `result.all`,
        // NOT `result.offerings.current`. (Confirmed against the official
        // RevenueCat Capacitor docs/examples, which use
        // `(await Purchases.getOfferings()).current` directly.) The previous
        // code read `result.offerings.current`, which is always undefined,
        // so this branch never returned successfully even when RC/StoreKit
        // had already delivered real priced packages in `result.current`.
        if (result && result.current) return result;
        // TEMP DIAGNOSTIC: include the full raw "all" map + counts so we can see
        // whether RC has ANY offerings/packages at all, and whether `all` has data
        // even though `current` is null (a different RC dashboard misconfiguration
        // than "no products fetched from App Store Connect").
        var allKeys = result && result.all ? Object.keys(result.all) : [];
        var raw;
        try { raw = JSON.stringify(result); } catch (_) { raw = String(result); }
        lastErr = new Error(
          "empty offerings (current=null). all-offerings keys=[" + allKeys.join(", ") + "]. " +
          "raw=" + (raw && raw.length > 600 ? raw.slice(0, 600) + "…(truncated)" : raw)
        );
      } catch (e) {
        // Real exception from the native layer — surface its full shape (code,
        // message, userInfo) instead of just e.message, since RC/StoreKit errors
        // (e.g. CONFIGURATION_ERROR / code 23) carry the useful detail in userInfo.
        var detail;
        try { detail = JSON.stringify(e); } catch (_) { detail = String(e); }
        lastErr = new Error("getOfferings() threw: " + (e && e.message) + " | full=" + detail);
      }
    }
    if (lastRawResult) {
      try { lastErr.message += " | last raw result=" + JSON.stringify(lastRawResult).slice(0, 400); } catch (_) {}
    }
    throw lastErr || new Error("getOfferings failed after retries");
  }

  facemax.loadPrices = async function (userId) {
    if (_cachedPrices) return _cachedPrices;
    // On web (non-native) StoreKit is unavailable — keep showing "…" so no
    // hardcoded price is ever displayed. Prices only render in the native app.
    if (!facemax.native) { return Object.assign({}, _emptyPrices); }
    try {
      // Wait up to 12 s for the Purchases plugin to register before giving up.
      // Capacitor 7 bridge registration can take longer than v6 on first launch
      // and on older devices. 6 s was sometimes too short.
      const pluginReady = await _waitForPurchasesPlugin(12000);
      if (!pluginReady) {
        // Log all registered plugins to aid debugging when this fires.
        const registered = window.Capacitor && window.Capacitor.Plugins
          ? Object.keys(window.Capacitor.Plugins) : [];
        const msg = "Purchases plugin not registered after 12s. Registered plugins: [" + registered.join(", ") + "]";
        console.warn("[facemax] loadPrices: " + msg);
        _lastPriceError = msg;
        return Object.assign({}, _emptyPrices);
      }
      const ready = await initRevenueCat(userId);
      if (!ready) {
        _lastPriceError = "initRevenueCat() returned false (RC configure()/logIn() did not complete — see console for the underlying error).";
        return Object.assign({}, _emptyPrices);
      }
      const Purchases = window.Capacitor.Plugins.Purchases;
      // Use retry wrapper — getOfferings() can silently return empty on first
      // launch while StoreKit fetches products in the background.
      // NOTE: the resolved value IS the PurchasesOfferings object itself
      // (has .current / .all directly) — it is NOT wrapped in another
      // `{ offerings: ... }` layer. See the comment in _getOfferingsWithRetry.
      const offerings = await _getOfferingsWithRetry(Purchases);
      const current = offerings && offerings.current;
      // The RevenueCat Capacitor SDK has returned `current` in two different
      // shapes depending on version/platform:
      //   (a) { availablePackages: [ {...}, {...} ] }            — array form
      //   (b) { weekly: {...}, monthly: {...}, yearly: {...} }   — keyed-by-package-id form
      // Normalize both into a flat array of package objects so the rest of
      // this function doesn't care which shape we got.
      let packages = [];
      if (current) {
        if (Array.isArray(current.availablePackages)) {
          packages = current.availablePackages;
        } else {
          // Keyed form: every own-enumerable value that looks like a package
          // (has a .product) is a package. This also tolerates a mix where
          // `availablePackages` exists alongside keyed packages.
          if (Array.isArray(current.availablePackages)) packages = packages.concat(current.availablePackages);
          for (const key in current) {
            if (key === "availablePackages") continue;
            const val = current[key];
            if (val && typeof val === "object" && val.product) packages.push(val);
          }
        }
      }
      const map = Object.assign({}, _emptyPrices);
      for (const pkg of packages) {
        const price = pkg.product && pkg.product.priceString;
        if (!price) continue;
        const priceNum = pkg.product && (pkg.product.price != null ? Number(pkg.product.price) : null);
        // Primary signal: the Apple product identifier (e.g. "com.facemaxai.app.weekly").
        // Fallback signal: the package's own key in `current` (e.g. "weekly"/"$rc_weekly"),
        // in case identifier ever comes back truncated/missing — belt and suspenders.
        const id = (((pkg.product.identifier || pkg.product.productIdentifier) || "") +
                    " " + (pkg.identifier || pkg.packageIdentifier || "")).toLowerCase();
        if (id.includes("weekly"))   map.weekly   = price;
        if (id.includes("monthly"))  map.monthly  = price;
        if (id.includes("yearly") || id.includes("annual")) { map.yearly = price; if (priceNum) map.yearlyPrice = priceNum; }
        if (id.includes("lifetime")) map.lifetime = price;
      }
      // Only cache when we got at least one real price — never cache a full
      // "…" map, so a subsequent call (e.g. when paywall re-opens) retries.
      const hasRealPrice = Object.values(map).some(function(v) { return v !== "…"; });
      if (hasRealPrice) {
        _cachedPrices = map;
        _lastPriceError = null;
      } else {
        _lastPriceError = "getOfferings() succeeded but produced 0 usable packages. current offering packages found: " +
          packages.length + ". Package ids seen: [" +
          packages.map(function(p){ return (p.product && (p.product.identifier || p.product.productIdentifier)) || "?"; }).join(", ") + "]";
      }
    } catch (e) {
      const msg = (e && (e.message || e.userInfo && JSON.stringify(e.userInfo))) || String(e);
      console.warn("[facemax] loadPrices failed, prices will remain as '…':", e);
      _lastPriceError = "Exception in loadPrices(): " + msg;
      // Do NOT cache on failure — allow retry on next call.
    }
    return _cachedPrices || Object.assign({}, _emptyPrices);
  };

  // Pull the entitlement expiration as epoch-ms, tolerating the different field
  // names RevenueCat has used across SDK versions (ISO string vs. millis number).
  function entitlementExpirationMs(entitlement) {
    if (!entitlement) return 0;
    const raw = entitlement.expirationDateMillis != null
      ? entitlement.expirationDateMillis
      : (entitlement.expirationDate != null ? entitlement.expirationDate : entitlement.expiresDate);
    if (raw == null) return 0;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : 0;
  }



  function entitlementProductId(entitlement) {
    return String(entitlement && (entitlement.productIdentifier || entitlement.productId) || "");
  }

  function isKnownPremiumProduct(productId) {
    if (!productId) return false;
    return Object.values(facemax.products || {}).some(function (product) {
      return product && product.appleId === productId && product.entitlement === "premium";
    });
  }

  // Return only the explicitly configured `premium` entitlement and validate
  // that its StoreKit product and expiration are current. Historical entries
  // from entitlements.all, unrelated entitlements, and stale SDK data must
  // never unlock the app. Restore Purchases only re-syncs ownership; it does
  // not create a new subscription period.
  function activeEntitlementFromCustomerInfo(customerInfo, preferredId) {
    const active = customerInfo && customerInfo.entitlements && customerInfo.entitlements.active;
    if (!active || typeof active !== "object") return null;
    const entitlementId = preferredId || "premium";
    const entitlement = active[entitlementId] || null;
    if (!entitlement) return null;

    const productId = entitlementProductId(entitlement);
    if (!isKnownPremiumProduct(productId)) return null;

    const expiresAt = entitlementExpirationMs(entitlement);
    const lifetimeProduct = facemax.products && facemax.products.lifetime && facemax.products.lifetime.appleId;
    if (productId === lifetimeProduct && !expiresAt) return entitlement;
    if (!expiresAt || expiresAt <= Date.now()) return null;
    return entitlement;
  }

  // RevenueCat can occasionally return CustomerInfo before its entitlement map
  // has refreshed. Retry getCustomerInfo briefly, but never manufacture access.
  async function waitForActiveEntitlement(Purchases, initialCustomerInfo, preferredId) {
    let customerInfo = initialCustomerInfo || null;
    let entitlement = activeEntitlementFromCustomerInfo(customerInfo, preferredId);
    if (entitlement) return { customerInfo, entitlement };

    const delays = [250, 700, 1500];
    for (const delay of delays) {
      await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const result = await Purchases.getCustomerInfo();
        customerInfo = (result && result.customerInfo) || result || customerInfo;
        entitlement = activeEntitlementFromCustomerInfo(customerInfo, preferredId);
        if (entitlement) return { customerInfo, entitlement };
      } catch (_) { /* retry */ }
    }
    return { customerInfo, entitlement: null };
  }

  async function currentRevenueCatAppUserId(Purchases, fallback) {
    try {
      if (Purchases && typeof Purchases.getAppUserID === "function") {
        const result = await Purchases.getAppUserID();
        const appUserID = result && result.appUserID;
        if (appUserID) return String(appUserID);
      }
    } catch (_) {}
    return fallback || null;
  }

  // Source of truth for native UI gating. The backend mirror is needed for API
  // endpoints, but the on-device RevenueCat entitlement decides whether the
  // paywall should be visible.
  facemax.getSubscriptionStatus = async function (userId) {
    if (!facemax.native) return { ok: false, error: "not_native" };
    const ready = await initRevenueCat(userId);
    if (!ready) return { ok: false, error: "revenuecat_unavailable" };
    try {
      const Purchases = window.Capacitor.Plugins.Purchases;
      const result = await Purchases.getCustomerInfo();
      const customerInfo = (result && result.customerInfo) || result || null;
      const entitlement = activeEntitlementFromCustomerInfo(customerInfo, "premium");
      const revenueCatAppUserId = await currentRevenueCatAppUserId(
        Purchases,
        userId || (customerInfo && customerInfo.originalAppUserId) || null
      );
      return {
        ok: true,
        active: !!entitlement,
        premium_until: entitlementExpirationMs(entitlement) || null,
        product_id: entitlement && (entitlement.productIdentifier || entitlement.productId) || null,
        revenuecat_app_user_id: revenueCatAppUserId,
      };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };

  // Locate the RevenueCat package that wraps a given App Store product id,
  // scanning the current offering first and then every other offering.
  async function findPackageForProduct(Purchases, appleId) {
    try {
      // getOfferings() resolves directly to the PurchasesOfferings object
      // (.current / .all on it directly) — no `{ offerings }` wrapper.
      const offerings = await Purchases.getOfferings();
      function packagesOf(off) {
        if (!off) return [];
        if (Array.isArray(off.availablePackages)) return off.availablePackages;
        // Keyed-by-package-id form: { weekly: {...}, monthly: {...}, ... }
        const out = [];
        for (const key in off) {
          if (key === "availablePackages") continue;
          const val = off[key];
          if (val && typeof val === "object" && val.product) out.push(val);
        }
        return out;
      }
      let pkgs = packagesOf(offerings && offerings.current);
      if (offerings && offerings.all) {
        for (const key of Object.keys(offerings.all)) {
          pkgs = pkgs.concat(packagesOf(offerings.all[key]));
        }
      }
      return pkgs.find(p => {
        const pid = (p.product && (p.product.identifier || p.product.productIdentifier)) || "";
        return pid === appleId;
      }) || null;
    } catch (e) {
      return null;
    }
  }

  // Ask the backend to reconcile the current App User ID directly with
  // RevenueCat. The client sends no secret, product, or expiration timestamp:
  // only RevenueCat's server response may grant or extend backend access.
  // Retries cover the short propagation delay immediately after StoreKit.
  async function syncServerPremium(userId, rcAppUserId) {
    if (!userId) return false;
    const apiBase = (window.API_BASE || "https://facemax-api.voou96329.workers.dev");
    // First attempt fires immediately, then exponential backoff: 1s, 2s, 4s, 6s, 8s.
    // Handles flaky mobile connections where the first few requests drop silently.
    const delays = [0, 1000, 2000, 4000, 6000, 8000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000); // 8s per request timeout
        try {
          const res = await fetch(apiBase + "/api/apple-receipt-verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user_id: userId, revenuecat_app_user_id: rcAppUserId || userId }),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) {
            if (window.fmLog) window.fmLog("info", `syncServerPremium attempt ${attempt} OK (status ${res.status})`);
            return true;
          }
          // A verified inactive RevenueCat entitlement is returned as 402 after
          // the worker has already cleared stale backend access. Treat that as
          // a successful reconciliation instead of retrying for ~20 seconds.
          if (res.status === 402) {
            let inactiveBody = null;
            try { inactiveBody = await res.clone().json(); } catch (_) {}
            if (inactiveBody && inactiveBody.error === "no_active_premium_entitlement") {
              if (window.fmLog) window.fmLog("info", `syncServerPremium attempt ${attempt} confirmed inactive`);
              return true;
            }
          }
          // Non-network error (4xx/5xx) — still retry, server may be warming up.
          // Surface the actual status/body so a missing server-only RevenueCat
          // key or backend configuration problem does not fail silently.
          if (window.fmLog) {
            let bodyText = "";
            try { bodyText = await res.clone().text(); } catch (_) {}
            window.fmLog("error", `syncServerPremium attempt ${attempt} FAILED status=${res.status} body=${bodyText.slice(0, 300)}`);
          }
        } catch (fetchErr) {
          clearTimeout(timeout);
          if (window.fmLog) window.fmLog("error", `syncServerPremium attempt ${attempt} network error: ${fetchErr && fetchErr.message}`);
          // Network error or timeout — retry
        }
      } catch (e) { /* retry */ }
    }
    if (window.fmLog) window.fmLog("error", "syncServerPremium: all retries exhausted, giving up for userId=" + userId);
    return false;
  }

  // Fire-and-forget wrapper: kicks off the server sync in the background
  // without blocking the purchase return value.  The actual implementation
  // (syncServerPremium) retries several times on failure; any remaining error is
  // silently swallowed here — the RevenueCat webhook is the authoritative path.
  //
  // The promise is stored so callers that need to sequence after the sync
  // (e.g. handlePurchase before it returns to quizCheckout) can await it
  // via facemax.awaitServerSync() without paying a cost on the happy path —
  // the sync is already in flight; we're just joining it.
  let _lastSyncPromise = null;
  function syncServerPremiumBackground(userId, rcAppUserId) {
    _lastSyncPromise = syncServerPremium(userId, rcAppUserId).catch(() => false);
  }

  // Expose so index.html handlePurchase can trigger a fresh sync on network retry
  facemax._triggerSync = syncServerPremiumBackground;

  // Returns a promise that resolves when the most-recent server sync finishes
  // (true = confirmed, false = exhausted retries / error).  Resolves instantly
  // if no sync is in flight.  Used by handlePurchase to close the race window
  // between purchase confirmation and the first /api/full-report call.
  facemax.awaitServerSync = function () {
    return _lastSyncPromise || Promise.resolve(false);
  };

  // Buy a product and confirm with our backend.
  // Returns { ok, premium_until, server_synced, error }.
  facemax.purchase = async function (planName, userId) {
    if (!facemax.native) return { ok: false, error: "not_native" };
    const product = facemax.products[planName];
    if (!product) return { ok: false, error: "unknown_plan" };

    const ready = await initRevenueCat(userId);
    if (!ready) return { ok: false, error: "revenuecat_unavailable" };

    const Purchases = window.Capacitor.Plugins.Purchases;
    try {
      // RevenueCat Capacitor v11 removed `purchaseProduct`. Buy via the
      // configured offering package, falling back to a direct store product.
      let customerInfo;
      const pkg = await findPackageForProduct(Purchases, product.appleId);
      if (pkg) {
        ({ customerInfo } = await Purchases.purchasePackage({ aPackage: pkg }));
      } else {
        const { products } = await Purchases.getProducts({ productIdentifiers: [product.appleId] });
        const storeProduct = products && products[0];
        if (!storeProduct) return { ok: false, error: "product_unavailable" };
        ({ customerInfo } = await Purchases.purchaseStoreProduct({ product: storeProduct }));
      }
      // A successful StoreKit sheet is not enough by itself: only an active
      // RevenueCat entitlement unlocks the app. Briefly refresh CustomerInfo to
      // cover propagation delay, then fail closed instead of granting fake access.
      const verified = await waitForActiveEntitlement(Purchases, customerInfo, product.entitlement);
      customerInfo = verified.customerInfo || customerInfo;
      const entitlement = verified.entitlement;
      if (!entitlement) return { ok: false, error: "entitlement_inactive" };

      const premiumUntil = entitlementExpirationMs(entitlement);
      const revenueCatAppUserId = await currentRevenueCatAppUserId(Purchases, userId);
      // Mirror the exact RevenueCat customer that owns the active entitlement.
      // This matters when the SDK was configured before Sign in with Apple and
      // still uses the install ID rather than the app's current local user ID.
      syncServerPremiumBackground(userId, revenueCatAppUserId);

      return {
        ok: true,
        premium_until: premiumUntil,
        source: "revenuecat",
        server_synced: false,
        revenuecat_app_user_id: revenueCatAppUserId,
      };
    } catch (err) {
      const code = err && err.code;
      if ((err && err.userCancelled) || code === "PURCHASE_CANCELLED") return { ok: false, error: "cancelled" };
      const msg = (err && err.message) || String(err);
      // StoreKit/sandbox "already purchased": the user already owns the product
      // (common when re-testing). Don't dead-end on the paywall — restore so the
      // active entitlement is picked up and the server gets synced.
      if (code === "PRODUCT_ALREADY_PURCHASED" || /already.*(purchas|own|subscrib)/i.test(msg)) {
        try {
          const r = await facemax.restorePurchases(userId);
          if (r && r.ok) return r;
        } catch (e) { /* fall through to error */ }
      }
      return { ok: false, error: msg };
    }
  };

  facemax.restorePurchases = async function (userId) {
    if (!facemax.native) return { ok: false, error: "not_native" };
    const ready = await initRevenueCat(userId);
    if (!ready) return { ok: false, error: "revenuecat_unavailable" };
    const Purchases = window.Capacitor.Plugins.Purchases;
    try {
      const result = await Purchases.restorePurchases();
      let customerInfo = (result && result.customerInfo) || result || null;
      const verified = await waitForActiveEntitlement(Purchases, customerInfo, "premium");
      customerInfo = verified.customerInfo || customerInfo;
      const entitlement = verified.entitlement;

      // Never unlock from entitlements.all. That collection includes expired
      // trials and old subscriptions; Restore only re-syncs ownership history.
      // Still reconcile the backend so any stale premium timestamp from an old
      // build is cleared after RevenueCat confirms there is no active access.
      const revenueCatAppUserId = await currentRevenueCatAppUserId(Purchases, userId);
      if (!entitlement) {
        syncServerPremiumBackground(userId, revenueCatAppUserId);
        return { ok: false, error: "nothing_to_restore" };
      }

      const premiumUntil = entitlementExpirationMs(entitlement);
      syncServerPremiumBackground(userId, revenueCatAppUserId);
      return {
        ok: true,
        premium_until: premiumUntil,
        server_synced: false,
        revenuecat_app_user_id: revenueCatAppUserId,
      };
    } catch (err) {
      return { ok: false, error: err && err.message || String(err) };
    }
  };

  // -------------------- Local Notifications --------------------
  //
  // Schedules retention / re-engagement reminders via Capacitor
  // LocalNotifications on iOS. Falls back to no-op on the web build.
  //
  // We expose a tiny wrapper so the main app never has to touch the plugin
  // surface directly. All scheduled notification IDs live in a numeric
  // namespace (1000-1999) so they can be cancelled wholesale on opt-out.

  const NOTIF_ID = {
    DAILY: 1001,
    RESCAN_7D: 1002,
    STREAK: 1004,
    PAYWALL_RETURN: 1005,
    EVENING: 1006,
    WINBACK_3D: 1007,
    WINBACK_7D: 1008,
    WINBACK_14D: 1009,
    DEGRADE_1D: 1010,
    DEGRADE_3D: 1011,
    DEGRADE_7D: 1012,
  };

  function notifPlugin() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  }

  facemax.notif = {
    ids: NOTIF_ID,

    isAvailable() {
      return !!(facemax.native && notifPlugin());
    },

    async getPermission() {
      const p = notifPlugin();
      if (!p || !facemax.native) return { display: "denied" };
      try { return await p.checkPermissions(); }
      catch (e) { return { display: "denied" }; }
    },

    async requestPermission() {
      const p = notifPlugin();
      if (!p || !facemax.native) return { display: "denied" };
      try {
        const cur = await p.checkPermissions();
        if (cur && cur.display === "granted") return cur;
        return await p.requestPermissions();
      } catch (e) {
        return { display: "denied" };
      }
    },

    async cancelAll() {
      const p = notifPlugin();
      if (!p || !facemax.native) return;
      try {
        const pending = await p.getPending();
        const ids = (pending && pending.notifications || []).map(n => ({ id: n.id }));
        if (ids.length) await p.cancel({ notifications: ids });
      } catch (e) { /* ignore */ }
    },

    async cancel(id) {
      const p = notifPlugin();
      if (!p || !facemax.native) return;
      try { await p.cancel({ notifications: [{ id }] }); }
      catch (e) { /* ignore */ }
    },

    // Schedule a notification at a specific Date. Cancels any prior with same id.
    async scheduleAt({ id, at, title, body, extra }) {
      const p = notifPlugin();
      if (!p || !facemax.native) return false;
      if (!(at instanceof Date) || at.getTime() <= Date.now() + 5000) return false;
      try {
        await this.cancel(id);
        await p.schedule({
          notifications: [{
            id,
            title: String(title || "FaceMax AI"),
            body: String(body || ""),
            schedule: { at, allowWhileIdle: true },
            sound: "default",
            smallIcon: "ic_stat_icon",
            extra: (extra && typeof extra === "object") ? extra : undefined,
          }],
        });
        return true;
      } catch (e) { return false; }
    },

    // Schedule a notification that repeats every day at the given local hour/minute.
    async scheduleDaily({ id, hour, minute, title, body, extra }) {
      const p = notifPlugin();
      if (!p || !facemax.native) return false;
      try {
        await this.cancel(id);
        await p.schedule({
          notifications: [{
            id,
            title: String(title || "FaceMax AI"),
            body: String(body || ""),
            schedule: {
              on: { hour: Number(hour), minute: Number(minute) },
              allowWhileIdle: true,
              repeats: true,
            },
            sound: "default",
            smallIcon: "ic_stat_icon",
            extra: (extra && typeof extra === "object") ? extra : undefined,
          }],
        });
        return true;
      } catch (e) { return false; }
    },

    async getDelivered() {
      const p = notifPlugin();
      if (!p || !facemax.native || typeof p.getDeliveredNotifications !== "function") return [];
      try {
        const res = await p.getDeliveredNotifications();
        return (res && Array.isArray(res.notifications)) ? res.notifications : [];
      } catch (e) { return []; }
    },

    async bindEvents() {
      if (this._eventsBound) return true;
      const p = notifPlugin();
      if (!p || !facemax.native || typeof p.addListener !== "function") return false;
      try {
        this._eventsBound = true;
        await p.addListener("localNotificationReceived", function (notification) {
          try { window.dispatchEvent(new CustomEvent("facemax:local-notification", { detail: { kind:"received", notification } })); } catch (_) {}
        });
        await p.addListener("localNotificationActionPerformed", function (action) {
          try { window.dispatchEvent(new CustomEvent("facemax:local-notification", { detail: { kind:"action", action, notification: action && action.notification } })); } catch (_) {}
        });
        return true;
      } catch (e) {
        this._eventsBound = false;
        return false;
      }
    },
  };

  // -------------------- In-App Review --------------------

  facemax.requestReview = async function () {
    if (!facemax.native) return;
    try {
      const { RateApp } = await import(
        "@capacitor-community/rate-app"
      ).catch(() => ({}));
      if (RateApp && typeof RateApp.requestReview === "function") {
        await RateApp.requestReview();
      }
    } catch (e) { /* ignore */ }
  };

  // -------------------- Status bar / safe area --------------------

  async function styleStatusBar() {
    try {
      const StatusBar = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
      if (StatusBar && facemax.native) {
        // Keep the status bar overlaying the WebView so our dark background
        // shows through — but the safe-area-inset-top CSS env() variable will
        // correctly push content down. We just need to set the icon colour.
        try { await StatusBar.setOverlaysWebView({ overlay: true }); } catch (_) {}
        await StatusBar.setStyle({ style: "DARK" });
        try { await StatusBar.setBackgroundColor({ color: "#100A14" }); } catch (_) {}
      }
    } catch (e) { /* ignore */ }
  }

  // -------------------- Boot --------------------

  function boot() {
    detect();
    bindHaptics();
    styleStatusBar();
    // Capacitor plugin registration can lag behind DOMContentLoaded. Bind the
    // local-notification receive/action listeners only after native detection,
    // then retry briefly until LocalNotifications appears on the bridge.
    if (facemax.native) {
      (function bindNotifEventsWhenReady(attempt) {
        Promise.resolve(facemax.notif.bindEvents()).then(function(ok){
          if (!ok && attempt < 24) setTimeout(function(){ bindNotifEventsWhenReady(attempt + 1); }, 250);
        }).catch(function(){
          if (attempt < 24) setTimeout(function(){ bindNotifEventsWhenReady(attempt + 1); }, 250);
        });
      })(0);
    }
    // Diagnostic: log native detection + registered Capacitor plugins after
    // a short delay so the bridge has time to register them all.
    if (facemax.native) {
      setTimeout(function () {
        var plugins = window.Capacitor && window.Capacitor.Plugins
          ? Object.keys(window.Capacitor.Plugins) : [];
        var hasPurchases = plugins.indexOf("Purchases") !== -1;
        console.log("[facemax] boot — platform:", facemax.platform,
          "| Purchases plugin registered:", hasPurchases,
          "| all plugins:", plugins.join(", "));
        if (!hasPurchases) {
          console.warn("[facemax] Purchases plugin missing — prices will show '…'. " +
            "Check @revenuecat/purchases-capacitor pod is installed (pod install) and " +
            "that RevenueCatUI pod is NOT accidentally excluded.");
        }
      }, 2000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
