#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const outDir = "/home/mint/Desktop/appstore_screenshots";
mkdirSync(outDir, { recursive: true });

const chrome = process.env.CHROME || "google-chrome";
const W = 1290, H = 2796;

const SLIDES = [
  {
    file: "01_ai_face_scan.png",
    raw: "/tmp/mogly-raw-screens/screen_scan_result.png",
    badge: "⚡ AI FACIAL BIOMETRICS",
    title: "AI FACE SCAN & SCORE",
    subhead: "Instant objective rating & glow-up potential"
  },
  {
    file: "02_voice_mentor.png",
    raw: "/tmp/mogly-raw-screens/screen_voice_mentor.png",
    badge: "🎙️ REAL-TIME VOICE MENTOR",
    title: "TALK WITH YOUR AI MENTOR",
    subhead: "Live voice guidance for your face structure"
  },
  {
    file: "03_daily_workouts.png",
    raw: "/tmp/mogly-raw-screens/screen_daily_exercises.png",
    badge: "🔥 30-DAY GLOW-UP RITUAL",
    title: "DAILY 3-MIN JAWLINE ROUTINE",
    subhead: "Target masseter tone, cheekbones & debloat"
  },
  {
    file: "04_before_after.png",
    raw: "/tmp/mogly-raw-screens/screen_rescan_compare.png",
    badge: "📈 PROVEN TRANSFORMATION",
    title: "MEASURABLE BEFORE & AFTER",
    subhead: "Track verified metric improvements Day 1 to Day 7"
  },
  {
    file: "05_glowup_plan.png",
    raw: "/tmp/mogly-raw-screens/screen_home_dashboard.png",
    badge: "🎯 CUSTOM PROTOCOL",
    title: "YOUR PERSONALIZED GLOW-UP",
    subhead: "Daily action blueprint to maximize aesthetics"
  }
];

function generateHTML(slide) {
  const b64 = readFileSync(slide.raw).toString("base64");
  const dataUri = `data:image/png;base64,${b64}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1290px;
    height: 2796px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Montserrat", system-ui, sans-serif;
    user-select: none;
    -webkit-user-select: none;
    background: #030814;
  }

  .canvas {
    position: relative;
    width: 1290px;
    height: 2796px;
    overflow: hidden;
    /* Rich Luxury Blue / Electric Cyan Gradient & Aura */
    background:
      radial-gradient(circle at 50% 26%, rgba(0, 140, 255, 0.42) 0%, rgba(0, 70, 220, 0.22) 35%, rgba(0, 180, 255, 0.08) 55%, transparent 75%),
      radial-gradient(ellipse at 50% 0%, rgba(0, 220, 255, 0.28) 0%, transparent 60%),
      radial-gradient(circle at 50% 100%, rgba(0, 100, 255, 0.16) 0%, transparent 50%),
      linear-gradient(180deg, #020712 0%, #030D22 35%, #020713 100%);
  }

  /* Subtle ambient lighting mesh */
  .canvas::before {
    content: "";
    position: absolute;
    top: -150px;
    left: 50%;
    transform: translateX(-50%);
    width: 1100px;
    height: 900px;
    background: radial-gradient(ellipse at center, rgba(0, 194, 255, 0.24) 0%, rgba(0, 110, 255, 0.12) 40%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
    z-index: 1;
  }

  /* Top Typography Header */
  .header {
    position: relative;
    z-index: 10;
    width: 100%;
    padding: 135px 60px 40px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 28px;
    border-radius: 999px;
    background: rgba(0, 242, 254, 0.12);
    border: 1px solid rgba(0, 242, 254, 0.38);
    box-shadow: 0 4px 24px rgba(0, 242, 254, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.35);
    color: #00F2FE;
    font-size: 24px;
    font-weight: 850;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 24px;
    text-shadow: 0 0 16px rgba(0, 242, 254, 0.6);
  }

  .title {
    font-size: 82px;
    font-weight: 900;
    letter-spacing: -0.04em;
    line-height: 1.04;
    color: #FFFFFF;
    text-shadow: 0 6px 36px rgba(0, 0, 0, 0.7), 0 0 40px rgba(0, 160, 255, 0.35);
    margin: 0;
    max-width: 1100px;
  }

  .subhead {
    font-size: 33px;
    font-weight: 550;
    letter-spacing: -0.015em;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.82);
    text-shadow: 0 3px 18px rgba(0, 0, 0, 0.6);
    margin-top: 18px;
    max-width: 980px;
  }

  /* iPhone 17 Frame Container */
  .device-wrap {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    top: 550px;
    width: 1040px;
    height: 2300px;
    z-index: 5;
  }

  /* Side buttons */
  .btn-silent {
    position: absolute;
    left: -6px;
    top: 240px;
    width: 6px;
    height: 54px;
    background: #3a3b42;
    border-radius: 4px 0 0 4px;
  }
  .btn-vol-up {
    position: absolute;
    left: -6px;
    top: 330px;
    width: 6px;
    height: 100px;
    background: #3a3b42;
    border-radius: 4px 0 0 4px;
  }
  .btn-vol-down {
    position: absolute;
    left: -6px;
    top: 450px;
    width: 6px;
    height: 100px;
    background: #3a3b42;
    border-radius: 4px 0 0 4px;
  }
  .btn-power {
    position: absolute;
    right: -6px;
    top: 380px;
    width: 6px;
    height: 150px;
    background: #3a3b42;
    border-radius: 0 4px 4px 0;
  }

  /* Outer Titanium Body */
  .device-body {
    position: relative;
    width: 1040px;
    height: 2300px;
    background: #14151b;
    border-radius: 72px;
    border: 5px solid #2e303a;
    box-shadow:
      0 40px 140px rgba(0, 0, 0, 0.95),
      0 0 110px rgba(0, 140, 255, 0.38),
      inset 0 0 0 2px rgba(255, 255, 255, 0.18),
      inset 0 0 24px rgba(0, 160, 255, 0.15);
    overflow: hidden;
    padding: 13px;
  }

  /* Screen Frame */
  .screen-frame {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 58px;
    overflow: hidden;
    background: #000000;
    box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.12);
  }

  /* Real Screenshot inside the phone */
  .app-screen {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
    display: block;
  }

  /* Apple Dynamic Island */
  .dynamic-island {
    position: absolute;
    top: 22px;
    left: 50%;
    transform: translateX(-50%);
    width: 256px;
    height: 66px;
    border-radius: 36px;
    background: #000000;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 20px;
    z-index: 50;
  }

  .camera-lens {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, #18223c 0%, #060912 70%);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: inset 0 0 4px rgba(0, 140, 255, 0.4);
    position: relative;
  }
  .camera-lens::after {
    content: "";
    position: absolute;
    top: 4px;
    left: 5px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.55);
  }

  /* Status Bar Time & Icons */
  .status-time {
    position: absolute;
    top: 32px;
    left: 64px;
    font-size: 27px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #FFFFFF;
    z-index: 50;
  }

  .status-icons {
    position: absolute;
    top: 32px;
    right: 64px;
    display: flex;
    align-items: center;
    gap: 12px;
    z-index: 50;
  }
  .status-icons svg {
    fill: #FFFFFF;
    width: 26px;
    height: 26px;
  }

  /* Glass Glare / Specular Sheen */
  .glass-sheen {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 40;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.03) 24%, transparent 50%);
  }

  /* Bottom edge gloss */
  .bottom-aura {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 380px;
    background: linear-gradient(0deg, rgba(3, 10, 24, 0.95) 0%, transparent 100%);
    z-index: 20;
    pointer-events: none;
  }
</style>
</head>
<body>
<div class="canvas">
  <div class="header">
    <div class="badge">${slide.badge}</div>
    <h1 class="title">${slide.title}</h1>
    <p class="subhead">${slide.subhead}</p>
  </div>

  <div class="device-wrap">
    <div class="btn-silent"></div>
    <div class="btn-vol-up"></div>
    <div class="btn-vol-down"></div>
    <div class="btn-power"></div>

    <div class="device-body">
      <div class="screen-frame">
        <div class="status-time">9:41</div>
        <div class="dynamic-island">
          <div class="camera-lens"></div>
        </div>
        <div class="status-icons">
          <svg viewBox="0 0 24 24"><path d="M12 3c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L4.35 19.4c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l1.9-1.9C9.28 19.58 10.59 20 12 20c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 15c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg>
          <svg viewBox="0 0 24 24"><path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z"/></svg>
        </div>
        <img class="app-screen" src="${dataUri}" alt="Mogly App Screen">
        <div class="glass-sheen"></div>
      </div>
    </div>
  </div>

  <div class="bottom-aura"></div>
</div>
</body>
</html>`;
}

const tmp = join(tmpdir(), "appstore-build");
mkdirSync(tmp, { recursive: true });

try {
  for (const s of SLIDES) {
    const html = generateHTML(s);
    const htmlPath = join(tmp, s.file.replace(".png", ".html"));
    writeFileSync(htmlPath, html);

    const outPath = join(outDir, s.file);
    if (existsSync(outPath)) rmSync(outPath);

    console.log(`Rendering ${s.file} at ${W}x${H}...`);
    execFileSync(chrome, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
      "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      `--window-size=${W},${H}`,
      "--virtual-time-budget=4000",
      `--screenshot=${outPath}`,
      `file://${htmlPath}`
    ], { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });

    console.log(`Done: ${outPath}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("All App Store screenshots rendered successfully in:", outDir);
