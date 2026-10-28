#!/usr/bin/env node
// Renders reference screenshots of the new Mogly screens from the REAL app
// (web/index.html) in headless Chrome at iPhone 13/14 size (390x844 pt @3x =
// 1170x2532 px). Each scene seeds localStorage (streak, scans) before the app
// boots, then opens the screen through the app's own functions.
//
//   node scripts/render_new_screen_references.mjs [outDir]   (default ~/Desktop)
//
// Scenes:
//   home_streak         Home, status line "🔥 3-day streak · Day 7 check-in in 4 days"
//   home_day_done       Home, green "✓ Day 3 done" state
//   voice_ritual        Hands-free ritual overlay mid-exercise (timer, cue, steps)
//                       + PROPOSED countdown ring around the sphere (not shipped)
//   rescan_comparison   Compare Scans, Day 1 vs Day 7 + PROPOSED per-metric deltas (not shipped)
//
// Needs google-chrome (or CHROME=/path/to/chrome). No npm dependencies.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] || join(homedir(), "Desktop"));
const chrome = process.env.CHROME || "google-chrome";
const W = 390, H = 844, SCALE = 3;

const SCENES = [
  { id: "home_streak", file: "mogly_ref_home_streak.png" },
  { id: "home_day_done", file: "mogly_ref_home_day_done.png" },
  { id: "voice_ritual", file: "mogly_ref_voice_ritual.png" },
  { id: "rescan_comparison", file: "mogly_ref_rescan_comparison.png" },
];

// Runs first in <head>, before any app script: seeds the state for the scene.
// Headless virtual time never finishes CSS transitions: show the end state.
const SEED = String.raw`<style>*,*::before,*::after{transition:none!important}</style><script>
(function(){
  var scene = (location.hash || "").slice(1);
  window.__refScene = scene;
  var ls = localStorage;
  ls.clear();
  ls.setItem("facemax_onboarding_complete_v1", "1");
  ls.setItem("facemax_gender", "male");
  ls.setItem("mogly_voice_gender", "male");
  var day = 86400000, now = Date.now();
  function key(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
  var ids = ["cheek_lift","jaw_release","neck_tighten","eye_depuff"]; // replaced by real ids after boot if they differ
  window.__refSeedLog = function(realIds){
    var log = {};
    var done = scene === "home_day_done" ? [0,1,2] : scene === "voice_ritual" ? [1,2,3,4,5] : [1,2,3];
    done.forEach(function(n){ log[key(new Date(now - n*day))] = realIds.slice(); });
    if (scene === "voice_ritual") log[key(new Date(now))] = realIds.slice(0, 1);
    ls.setItem("facemax_exercise_log", JSON.stringify(log));
  };
  var m1 = { jawline: 62, cheekbones: 68, eye_area: 71, skin: 58, symmetry: 80, face_shape: 70, hair: 66 };
  var m7 = { jawline: 67, cheekbones: 72, eye_area: 74, skin: 64, symmetry: 80, face_shape: 72, hair: 68 };
  var hist = [];
  if (scene === "rescan_comparison") {
    hist = [
      { date: now - 3600000, score: 79, metrics: m7, thumb: "assets/hero_male.jpg", face_shape: "oval" },
      { date: now - 6*day - 3600000, score: 74, metrics: m1, thumb: "assets/hero_male.jpg", face_shape: "oval" },
    ];
  } else if (scene !== "voice_ritual") {
    hist = [{ date: now - 3*day, score: 74, metrics: m1, face_shape: "oval" }];
  }
  ls.setItem("facemax_history", JSON.stringify(hist));
  // Screenshots never fire rAF reliably; keep the app from waiting on it.
  window.requestAnimationFrame = function(cb){ return setTimeout(function(){ cb(performance.now()); }, 16); };
})();
</script>`;

// Runs after the app booted: opens the scene through the app's own code.
const SCENE = String.raw`<script>
window.addEventListener("load", function(){ setTimeout(function(){
  var scene = window.__refScene;
  var $ = function(id){ return document.getElementById(id); };
  try { window.__refSeedLog(FACE_EXERCISES.map(function(e){ return e.id; })); } catch (e) {}
  try { loadHistory(); } catch (e) {}
  // Quiet the boot-time popups (debrief orb, toasts, gates) for a clean frame.
  var hide = function(){
    document.querySelectorAll(".toast, #toast, .gate, #gate, .mogly-debrief-orb, .modal.active, .sheet.active, .notif-prompt")
      .forEach(function(n){ if (!n.closest("#mrOverlay")) n.style.display = "none"; });
  };
  if (scene === "home_streak" || scene === "home_day_done") {
    try { openScreen("home"); } catch (e) {}
    try { window.moglyRenderRitualStatus(); } catch (e) {}
    hide();
  } else if (scene === "voice_ritual") {
    try { openScreen("home"); } catch (e) {}
    var ov = $("mrOverlay");
    ov.classList.add("active");
    ov.style.transition = "none";
    var ex = FACE_EXERCISES[1];
    var st = window.moglyRitualState();
    $("mrDay").textContent = "Day " + st.day + " · Debloat";
    $("mrCount").textContent = "18";
    $("mrTitle").textContent = ex.name;
    $("mrCaption").textContent = (ex.cue || ex.desc || "") + ".";
    Array.from($("mrSteps").children).forEach(function(s, i){ s.classList.toggle("is-done", i === 0); s.classList.toggle("is-on", i === 1); });
    try { mvKick(); } catch (e) {}
    // PROPOSED: countdown ring around the sphere (18 of 30 s left). Not in the app yet.
    var orb = $("mrOrb");
    var wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;display:grid;place-items:center;padding:14px";
    orb.parentNode.insertBefore(wrap, orb);
    wrap.appendChild(orb);
    var r = 47, c = 2 * Math.PI * r;
    wrap.insertAdjacentHTML("beforeend",
      '<svg viewBox="0 0 100 100" style="position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg);pointer-events:none">' +
      '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2.2"/>' +
      '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="#0A84FF" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - 18/30)) + '"/></svg>');
    hide();
  } else if (scene === "rescan_comparison") {
    try { premium = true; } catch (e) {}
    try { window.openCompare ? window.openCompare(true) : null; } catch (e) {}
    try { if (!$("compare").classList.contains("active")) openScreen("compare"); renderCompareList(); comparePicks = [1, 0]; updateCompareUI(); } catch (e) {}
    // The Day 7 check-in lands straight on the result: hide the scan picker above it.
    $("compareSub").style.display = "none";
    $("compareList").style.display = "none";
    $("cmpDateA").textContent = "Day 1";
    $("cmpDateB").textContent = "Day 7 check-in";
    // PROPOSED: per-metric deltas under the overall change. Not in the app yet.
    var a = scanHistory[1].metrics, b = scanHistory[0].metrics;
    var rows = [["Jawline","jawline"],["Cheekbones","cheekbones"],["Eye area","eye_area"],["Skin","skin"],["Symmetry","symmetry"]].map(function(p){
      var d = b[p[1]] - a[p[1]];
      var col = d > 0 ? "#30D158" : d < 0 ? "#FF453A" : "rgba(235,235,245,.5)";
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-top:1px solid rgba(255,255,255,.07)">' +
        '<span style="font-size:15px;font-weight:600">' + p[0] + '</span>' +
        '<span style="font-size:15px;font-variant-numeric:tabular-nums;color:rgba(235,235,245,.6)">' + a[p[1]] + ' → <b style="color:#fff">' + b[p[1]] + '</b>' +
        '<b style="display:inline-block;min-width:44px;text-align:right;color:' + col + '">' + (d > 0 ? "+" : "") + d + '</b></span></div>';
    }).join("");
    $("cmpNote").insertAdjacentHTML("beforebegin",
      '<div style="margin:12px 0;padding:6px 16px 4px;border-radius:22px;background:linear-gradient(155deg,rgba(255,255,255,.06),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.08)">' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(235,235,245,.5);padding:8px 0">Day 1 → Day 7</div>' + rows + '</div>');
    hide();
  }
  document.title = "ready:" + scene;
}, 2500); });
</script>`;

const tmp = mkdtempSync(join(tmpdir(), "mogly-ref-"));
try {
  cpSync(join(root, "web"), tmp, { recursive: true });
  const html = readFileSync(join(tmp, "index.html"), "utf8");
  const headAt = html.indexOf("<head>");
  if (headAt < 0) throw new Error("no <head> in web/index.html");
  const withSeed = html.slice(0, headAt + 6) + SEED + html.slice(headAt + 6);
  const bodyEnd = withSeed.lastIndexOf("</body>");
  const page = bodyEnd >= 0 ? withSeed.slice(0, bodyEnd) + SCENE + withSeed.slice(bodyEnd) : withSeed + SCENE;
  writeFileSync(join(tmp, "ref.html"), page);

  for (const s of SCENES) {
    const out = join(outDir, s.file);
    if (existsSync(out)) rmSync(out);
    execFileSync(chrome, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
      "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      `--user-data-dir=${join(tmp, "profile-" + s.id)}`,
      `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`,
      "--virtual-time-budget=6000", `--screenshot=${out}`,
      `file://${join(tmp, "ref.html")}#${s.id}`,
    ], { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });
    if (!existsSync(out)) throw new Error("no screenshot for " + s.id);
    console.log("wrote " + out);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
