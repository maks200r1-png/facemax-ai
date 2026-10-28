#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(tmpdir(), "mogly-raw-screens");
mkdirSync(outDir, { recursive: true });

const chrome = process.env.CHROME || "google-chrome";
// Standard iPhone 16/17 Pro screen ratio: 390 x 844 pt @ 3x = 1170 x 2532 px
const W = 390, H = 844, SCALE = 3;

const SCENES = [
  { id: "scan_result", file: "screen_scan_result.png" },
  { id: "voice_mentor", file: "screen_voice_mentor.png" },
  { id: "daily_exercises", file: "screen_daily_exercises.png" },
  { id: "rescan_compare", file: "screen_rescan_compare.png" },
  { id: "home_dashboard", file: "screen_home_dashboard.png" },
];

const SEED = String.raw`<style>
*,*::before,*::after{transition:none!important}
html, body { background: #000000 !important; }
</style><script>
(function(){
  var scene = (location.hash || "").slice(1);
  window.__refScene = scene;
  var ls = localStorage;
  ls.clear();
  ls.setItem("facemax_onboarding_complete_v1", "1");
  ls.setItem("facemax_gender", "male");
  ls.setItem("mogly_voice_gender", "male");
  ls.setItem("facemax_premium", "1");
  ls.setItem("mogly_is_pro", "1");
  ls.setItem("mogly_streak_count", "7");
  ls.setItem("facemax_daily_streak", "7");

  var day = 86400000, now = Date.now();
  function key(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
  var realIds = ["cheek_lift","jaw_release","neck_tighten","eye_depuff"];
  var log = {};
  [1,2,3,4,5,6,7].forEach(function(n){ log[key(new Date(now - n*day))] = realIds.slice(); });
  ls.setItem("facemax_exercise_log", JSON.stringify(log));

  var m1 = { jawline: 68, cheekbones: 70, eye_area: 72, skin: 64, symmetry: 76, face_shape: 71, hair: 68 };
  var m7 = { jawline: 82, cheekbones: 86, eye_area: 80, skin: 84, symmetry: 89, face_shape: 85, hair: 82 };
  var hist = [
    { date: now - 3600000, score: 82, potential: 94, metrics: m7, thumb: "assets/hero_male.jpg", face_shape: "oval" },
    { date: now - 7*day - 3600000, score: 72, potential: 94, metrics: m1, thumb: "assets/hero_male.jpg", face_shape: "oval" }
  ];
  ls.setItem("facemax_history", JSON.stringify(hist));
  window.requestAnimationFrame = function(cb){ return setTimeout(function(){ cb(performance.now()); }, 16); };
})();
</script>`;

const SCENE = String.raw`<script>
window.addEventListener("load", function(){ setTimeout(function(){
  var scene = window.__refScene;
  var $ = function(id){ return document.getElementById(id); };

  var hide = function(){
    document.querySelectorAll(".toast, #toast, .gate, #gate, .mogly-debrief-orb, .modal.active, .sheet.active, .notif-prompt")
      .forEach(function(n){ if (!n.closest("#mvOverlay") && !n.closest("#mrOverlay")) n.style.display = "none"; });
  };

  try { loadHistory(); } catch (e) {}

  if (scene === "scan_result") {
    try {
      openHistoryScan(0);
      var sc = $("resultOverallScore");
      if (sc) sc.textContent = "82";
      var pot = $("resultPotentialScore");
      if (pot) pot.textContent = "94";
    } catch (e) {}
    hide();
  } else if (scene === "voice_mentor") {
    try {
      openScreen("home");
      var ov = $("mvOverlay");
      if (ov) {
        ov.classList.add("active");
        ov.style.opacity = "1";
        ov.style.visibility = "visible";
      }
      mvSetState("speaking");
      mvShow(
        "How do I sharpen my jawline and debloat fast?",
        "Keep your tongue sealed against your palate to tone the submental muscles. To flush excess fluid quickly, complete today's 3-minute lymphatic routine."
      );
      if (typeof mvKick === "function") mvKick();
    } catch (e) {}
    hide();
  } else if (scene === "daily_exercises") {
    try {
      openExercisesNow();
      var streakEl = document.querySelector(".ex-streak-head-txt");
      if (streakEl) streakEl.textContent = "7-day streak · Day 7 check-in";
    } catch (e) {}
    hide();
  } else if (scene === "rescan_compare") {
    try {
      openScreen("compare");
      renderCompareList();
      comparePicks = [1, 0];
      updateCompareUI();
      if ($("compareSub")) $("compareSub").style.display = "none";
      if ($("compareList")) $("compareList").style.display = "none";
      if ($("cmpDateA")) $("cmpDateA").textContent = "Day 1 (Baseline)";
      if ($("cmpDateB")) $("cmpDateB").textContent = "Day 7 (Check-in)";

      var a = scanHistory[1].metrics, b = scanHistory[0].metrics;
      var rows = [
        ["Jawline definition", "jawline", "+14", "#30D158"],
        ["Cheekbone prominence", "cheekbones", "+16", "#30D158"],
        ["Facial symmetry", "symmetry", "+13", "#30D158"],
        ["Skin quality & tone", "skin", "+20", "#30D158"]
      ].map(function(p){
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid rgba(255,255,255,.08)">' +
          '<span style="font-size:15px;font-weight:600;color:#fff">' + p[0] + '</span>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
          '<span style="font-size:14px;color:rgba(255,255,255,.55)">' + a[p[1]] + ' → <b style="color:#fff">' + b[p[1]] + '</b></span>' +
          '<span style="font-size:15px;font-weight:800;color:' + p[3] + ';background:rgba(48,209,88,.12);padding:2px 8px;border-radius:6px">' + p[2] + '</span>' +
          '</div></div>';
      }).join("");

      var note = $("cmpNote");
      if (note) {
        note.insertAdjacentHTML("beforebegin",
          '<div style="margin:16px 0;padding:12px 18px 6px;border-radius:24px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);backdrop-filter:blur(20px)">' +
          '<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#00F2FE;margin-bottom:6px">Verified Aesthetic Delta</div>' + rows + '</div>');
      }
    } catch (e) {}
    hide();
  } else if (scene === "home_dashboard") {
    try {
      openScreen("home");
      if (typeof window.moglyRenderRitualStatus === "function") window.moglyRenderRitualStatus();
      if (typeof renderHomeStats === "function") renderHomeStats();
      if (typeof renderHomeHistory === "function") renderHomeHistory();
      var streakCount = document.getElementById("moglyStreakCount");
      if (streakCount) streakCount.textContent = "7";
      if (typeof mvKick === "function") mvKick();
    } catch (e) {}
    hide();
  }

  document.title = "ready:" + scene;
}, 2600); });
</script>`;

const tmp = mkdtempSync(join(tmpdir(), "mogly-screens-"));
try {
  cpSync(join(root, "web"), tmp, { recursive: true });
  const html = readFileSync(join(tmp, "index.html"), "utf8");
  const headAt = html.indexOf("<head>");
  const withSeed = html.slice(0, headAt + 6) + SEED + html.slice(headAt + 6);
  const bodyEnd = withSeed.lastIndexOf("</body>");
  const page = withSeed.slice(0, bodyEnd) + SCENE + withSeed.slice(bodyEnd);
  writeFileSync(join(tmp, "capture.html"), page);

  for (const s of SCENES) {
    const target = join(outDir, s.file);
    if (existsSync(target)) rmSync(target);
    execFileSync(chrome, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
      "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      `--user-data-dir=${join(tmp, "profile-" + s.id)}`,
      `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`,
      "--virtual-time-budget=6500", `--screenshot=${target}`,
      `file://${join(tmp, "capture.html")}#${s.id}`,
    ], { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });
    console.log("Captured:", target);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
