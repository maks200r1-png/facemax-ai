import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const chrome = process.env.CHROME || "google-chrome";
const W = 390, H = 844, SCALE = 3;

const tmp = mkdtempSync(join(tmpdir(), "mogly-ref-"));
const srcDir = process.cwd();
cpSync(join(srcDir, "web"), tmp, { recursive: true });

// Inject script to open Exercises screen and set realistic state
const SEED = `<style>*,*::before,*::after{transition:none!important}</style><script>
(function(){
  var ls = localStorage;
  ls.clear();
  ls.setItem("facemax_onboarding_complete_v1", "1");
  ls.setItem("facemax_gender", "male");
  ls.setItem("mogly_voice_gender", "male");
  var day = 86400000, now = Date.now();
  function key(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
  var ids = ["cheek_lift","masseter_release","thumbpulling","under_chin"];
  var log = {};
  // 3 completed days
  [1, 2, 3].forEach(function(n){ log[key(new Date(now - n*day))] = ids.slice(); });
  // Today: 2 of 4 exercises done
  log[key(new Date(now))] = ids.slice(0, 2);
  ls.setItem("facemax_exercise_log", JSON.stringify(log));
  var voiceLog = {};
  voiceLog[key(new Date(now))] = { ts: now };
  ls.setItem("mogly_voice_mission_log", JSON.stringify(voiceLog));
  ls.setItem("facemax_history", JSON.stringify([{ date: now - 3*day, score: 76, face_shape: "oval" }]));
})();
</script>`;

const SCENE = `<script>
window.addEventListener("load", function(){
  setTimeout(function(){
    try {
      openExercisesNow();
      renderExerciseWeekTracker();
    } catch(e) {}
    document.querySelectorAll(".toast, #toast, .gate, #gate, .mogly-debrief-orb, .modal.active, .sheet.active, .notif-prompt")
      .forEach(function(n){ n.style.display = "none"; });
  }, 1000);
});
</script>`;

let html = readFileSync(join(tmp, "index.html"), "utf8");
html = html.replace("<head>", "<head>\n" + SEED);
html = html.replace("</body>", SCENE + "\n</body>");
writeFileSync(join(tmp, "index.html"), html, "utf8");

const outPng = "/home/mint/Desktop/mogly_new_streak_render.png";
const url = "file://" + join(tmp, "index.html");

const args = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  `--window-size=${W},${H}`,
  `--force-device-scale-factor=${SCALE}`,
  "--hide-scrollbars",
  "--virtual-time-budget=4000",
  `--screenshot=${outPng}`,
  url
];

console.log("Rendering screenshot with chrome...");
execFileSync(chrome, args, { stdio: "inherit" });
console.log("Rendered:", outPng);
rmSync(tmp, { recursive: true, force: true });
