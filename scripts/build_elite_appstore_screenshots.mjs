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
    pill: "★ #1 AI FACIAL AUDIT",
    title: 'SCAN YOUR FACE.<br><span class="accent">GET YOUR RATING.</span>',
    subhead: "Instant objective rating & aesthetic potential score",
    callouts: [
      { pos: "top: 610px; left: 60px;", icon: "★", label: "OVERALL SCORE", val: "82", color: "#00F2FE" },
      { pos: "top: 610px; right: 60px;", icon: "⚡", label: "POTENTIAL", val: "94", color: "#FFD60A" },
      { pos: "bottom: 110px; left: 50%; transform: translateX(-50%);", icon: "✔", label: "JAWLINE DEFINITION", val: "SHARP · 84/100", color: "#30D158", wide: true }
    ]
  },
  {
    file: "02_voice_mentor.png",
    raw: "/tmp/mogly-raw-screens/screen_voice_mentor.png",
    pill: "🎙️ REAL-TIME AI MENTOR",
    title: 'TALK WITH YOUR<br><span class="accent">LOOKSMAX COACH</span>',
    subhead: "Interactive voice guidance tailored to your face structure",
    callouts: [
      { pos: "top: 610px; left: 60px;", icon: "●", label: "VOICE MENTOR", val: "LIVE", color: "#FF453A" },
      { pos: "top: 610px; right: 60px;", icon: "⚡", label: "RESPONSE", val: "0ms", color: "#00F2FE" },
      { pos: "bottom: 110px; left: 50%; transform: translateX(-50%);", icon: "💬", label: "MOGLY", val: "“Seal your tongue to engage the jawline.”", color: "#FFFFFF", wide: true, quote: true }
    ]
  },
  {
    file: "03_daily_workouts.png",
    raw: "/tmp/mogly-raw-screens/screen_daily_exercises.png",
    pill: "🔥 30-DAY GLOW-UP RITUAL",
    title: 'DAILY 3-MINUTE<br><span class="accent">JAWLINE ROUTINES</span>',
    subhead: "Target masseter tone, cheekbones & flush morning puff",
    callouts: [
      { pos: "top: 610px; left: 60px;", icon: "🔥", label: "DAILY STREAK", val: "7 DAYS", color: "#FF9F0A" },
      { pos: "top: 610px; right: 60px;", icon: "⏱️", label: "DURATION", val: "3 MIN", color: "#00F2FE" },
      { pos: "bottom: 110px; left: 50%; transform: translateX(-50%);", icon: "✔", label: "TODAY'S TARGET", val: "CHEEKBONES & JAWLINE LOCKED", color: "#30D158", wide: true }
    ]
  },
  {
    file: "04_before_after.png",
    raw: "/tmp/mogly-raw-screens/screen_rescan_compare.png",
    pill: "📈 VERIFIED PROGRESS",
    title: 'MEASURABLE<br><span class="accent">BEFORE & AFTER</span>',
    subhead: "Track proven facial transformation from Day 1 to Day 7",
    callouts: [
      { pos: "top: 610px; left: 60px;", icon: "📅", label: "RESCAN AUDIT", val: "DAY 1 → 7", color: "#00F2FE" },
      { pos: "top: 610px; right: 60px;", icon: "📈", label: "JAWLINE", val: "+14 PTS", color: "#30D158" },
      { pos: "bottom: 110px; left: 50%; transform: translateX(-50%);", icon: "✔", label: "VERIFIED DELTA", val: "+16 CHEEKBONES · -24% PUFF", color: "#30D158", wide: true }
    ]
  },
  {
    file: "05_glowup_plan.png",
    raw: "/tmp/mogly-raw-screens/screen_home_dashboard.png",
    pill: "🎯 CUSTOM PROTOCOL",
    title: 'YOUR PERSONAL<br><span class="accent">GLOW-UP PLAN</span>',
    subhead: "Step-by-step daily blueprint to reach your 94 potential",
    callouts: [
      { pos: "top: 610px; left: 60px;", icon: "🎯", label: "FOCUS ZONE", val: "JAWLINE", color: "#00F2FE" },
      { pos: "top: 610px; right: 60px;", icon: "★", label: "TARGET", val: "94 SCORE", color: "#FFD60A" },
      { pos: "bottom: 110px; left: 50%; transform: translateX(-50%);", icon: "✔", label: "DAILY DISCIPLINE", val: "4 HABITS CHECKED TODAY", color: "#30D158", wide: true }
    ]
  }
];

function generateEliteHTML(slide) {
  const b64 = readFileSync(slide.raw).toString("base64");
  const dataUri = `data:image/png;base64,${b64}`;

  const calloutsHTML = slide.callouts.map(c => `
    <div class="callout ${c.wide ? 'callout-wide' : ''}" style="${c.pos}">
      <div class="callout-icon" style="color: ${c.color}; text-shadow: 0 0 12px ${c.color}">${c.icon}</div>
      <div class="callout-text">
        <div class="callout-label">${c.label}</div>
        <div class="callout-val" style="${c.quote ? 'font-size:22px;font-style:italic;' : ''}">${c.val}</div>
      </div>
    </div>
  `).join("");

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
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Montserrat", system-ui, sans-serif;
    user-select: none;
    -webkit-user-select: none;
    background: #020713;
  }

  .canvas {
    position: relative;
    width: 1290px;
    height: 2796px;
    overflow: hidden;
    /* Rich Oceanic Midnight to Radiant Cyan Aura */
    background:
      radial-gradient(circle at 50% 28%, rgba(0, 140, 255, 0.45) 0%, rgba(0, 70, 220, 0.24) 35%, rgba(0, 20, 80, 0.08) 60%, transparent 80%),
      radial-gradient(ellipse at 50% 4%, rgba(0, 242, 254, 0.35) 0%, transparent 52%),
      radial-gradient(circle at 50% 95%, rgba(0, 120, 255, 0.22) 0%, transparent 50%),
      linear-gradient(180deg, #020713 0%, #030F2A 35%, #020612 100%);
  }

  /* Ambient light cone casting down on the device */
  .canvas::before {
    content: "";
    position: absolute;
    top: -100px;
    left: 50%;
    transform: translateX(-50%);
    width: 1200px;
    height: 800px;
    background: radial-gradient(ellipse at center, rgba(0, 220, 255, 0.25) 0%, rgba(0, 100, 255, 0.12) 45%, transparent 70%);
    filter: blur(70px);
    pointer-events: none;
    z-index: 1;
  }

  /* Ambient backlight bloom behind the iPhone */
  .phone-aura {
    position: absolute;
    top: 550px;
    left: 50%;
    transform: translateX(-50%);
    width: 900px;
    height: 1400px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(0, 150, 255, 0.35) 0%, rgba(0, 80, 230, 0.16) 45%, transparent 70%);
    filter: blur(80px);
    z-index: 2;
    pointer-events: none;
  }

  /* Top Typography Header */
  .header {
    position: relative;
    z-index: 10;
    width: 100%;
    padding: 120px 60px 30px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 28px;
    border-radius: 999px;
    background: rgba(0, 242, 254, 0.12);
    border: 1.5px solid rgba(0, 242, 254, 0.45);
    box-shadow: 0 4px 24px rgba(0, 242, 254, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.4);
    color: #00F2FE;
    font-size: 24px;
    font-weight: 850;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 22px;
    text-shadow: 0 0 16px rgba(0, 242, 254, 0.7);
  }

  .title {
    font-size: 88px;
    font-weight: 950;
    letter-spacing: -0.04em;
    line-height: 1.04;
    color: #FFFFFF;
    text-shadow: 0 6px 36px rgba(0, 0, 0, 0.8), 0 0 45px rgba(0, 150, 255, 0.38);
    margin: 0;
    max-width: 1160px;
  }

  .title .accent {
    background: linear-gradient(135deg, #00F2FE 0%, #38E8FF 40%, #0088FF 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-shadow: none;
  }

  .subhead {
    font-size: 34px;
    font-weight: 550;
    letter-spacing: -0.015em;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.82);
    text-shadow: 0 3px 18px rgba(0, 0, 0, 0.7);
    margin-top: 18px;
    max-width: 1020px;
  }

  /* iPhone 17 Frame Container */
  .device-wrap {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    top: 550px;
    width: 950px;
    height: 2320px;
    z-index: 5;
  }

  /* Physical Buttons */
  .btn-silent { position: absolute; left: -6px; top: 220px; width: 6px; height: 50px; background: #383a42; border-radius: 4px 0 0 4px; }
  .btn-vol-up { position: absolute; left: -6px; top: 305px; width: 6px; height: 95px; background: #383a42; border-radius: 4px 0 0 4px; }
  .btn-vol-down { position: absolute; left: -6px; top: 420px; width: 6px; height: 95px; background: #383a42; border-radius: 4px 0 0 4px; }
  .btn-power { position: absolute; right: -6px; top: 350px; width: 6px; height: 140px; background: #383a42; border-radius: 0 4px 4px 0; }

  /* Outer Titanium Chassis */
  .device-body {
    position: relative;
    width: 950px;
    height: 2320px;
    background: #14151c;
    border-radius: 68px;
    border: 5px solid #2d303a;
    box-shadow:
      0 45px 150px rgba(0, 0, 0, 0.95),
      0 0 120px rgba(0, 140, 255, 0.42),
      inset 0 0 0 2px rgba(255, 255, 255, 0.2),
      inset 0 0 28px rgba(0, 170, 255, 0.18);
    overflow: hidden;
    padding: 13px;
  }

  /* Screen Frame */
  .screen-frame {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 56px;
    overflow: hidden;
    background: #000000;
    box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.12);
  }

  /* App Screenshot inside phone */
  .app-screen {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
    display: block;
  }

  /* Dynamic Island */
  .dynamic-island {
    position: absolute;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    width: 240px;
    height: 62px;
    border-radius: 36px;
    background: #000000;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 18px;
    z-index: 50;
  }

  .camera-lens {
    width: 20px;
    height: 20px;
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
    left: 4px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.6);
  }

  /* Status Bar */
  .status-time {
    position: absolute;
    top: 30px;
    left: 58px;
    font-size: 25px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #FFFFFF;
    z-index: 50;
  }

  .status-icons {
    position: absolute;
    top: 30px;
    right: 58px;
    display: flex;
    align-items: center;
    gap: 10px;
    z-index: 50;
  }
  .status-icons svg {
    fill: #FFFFFF;
    width: 24px;
    height: 24px;
  }

  /* Glass Sheen / Reflection */
  .glass-sheen {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 40;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.02) 26%, transparent 52%);
  }

  /* Floating 3D Callout Cards (The Silicon Valley / Cal AI signature) */
  .callout {
    position: absolute;
    z-index: 35;
    background: rgba(10, 18, 34, 0.88);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    border: 1.5px solid rgba(0, 210, 255, 0.42);
    border-radius: 28px;
    padding: 16px 28px;
    box-shadow:
      0 24px 60px rgba(0, 0, 0, 0.85),
      0 0 35px rgba(0, 160, 255, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);
    display: flex;
    align-items: center;
    gap: 16px;
    white-space: nowrap;
  }

  .callout-wide {
    width: 860px;
    justify-content: center;
    padding: 20px 32px;
    border-radius: 32px;
  }

  .callout-icon {
    font-size: 32px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .callout-text {
    display: flex;
    flex-direction: column;
    text-align: left;
  }

  .callout-label {
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.65);
    margin-bottom: 2px;
  }

  .callout-val {
    font-size: 26px;
    font-weight: 900;
    letter-spacing: -0.02em;
    color: #FFFFFF;
  }

  /* Bottom fade */
  .bottom-aura {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 400px;
    background: linear-gradient(0deg, rgba(2, 6, 16, 0.98) 0%, rgba(2, 6, 16, 0.7) 50%, transparent 100%);
    z-index: 20;
    pointer-events: none;
  }
</style>
</head>
<body>
<div class="canvas">
  <div class="header">
    <div class="pill">${slide.pill}</div>
    <h1 class="title">${slide.title}</h1>
    <p class="subhead">${slide.subhead}</p>
  </div>

  <div class="phone-aura"></div>

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

  ${calloutsHTML}

  <div class="bottom-aura"></div>
</div>
</body>
</html>`;
}

const tmp = join(tmpdir(), "elite-appstore-build");
mkdirSync(tmp, { recursive: true });

try {
  for (const s of SLIDES) {
    const html = generateEliteHTML(s);
    const htmlPath = join(tmp, s.file.replace(".png", ".html"));
    writeFileSync(htmlPath, html);

    const outPath = join(outDir, s.file);
    if (existsSync(outPath)) rmSync(outPath);

    console.log(`Rendering Elite ${s.file} at ${W}x${H}...`);
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
console.log("All Elite App Store screenshots rendered successfully in:", outDir);
