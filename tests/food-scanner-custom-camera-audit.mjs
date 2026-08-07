import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const webPath = path.join(root, 'web/index.html');
const iosPath = path.join(root, 'ios/App/App/public/index.html');
const bridgePath = path.join(root, 'web/js/native-bridge.js');
const iosBridgePath = path.join(root, 'ios/App/App/public/js/native-bridge.js');
const swiftPath = path.join(root, 'ios/App/App/CameraOvalPlugin.swift');
const plistPath = path.join(root, 'ios/App/App/Info.plist');

const web = await fs.readFile(webPath, 'utf8');
const ios = await fs.readFile(iosPath, 'utf8');
const bridge = await fs.readFile(bridgePath, 'utf8');
const iosBridge = await fs.readFile(iosBridgePath, 'utf8');
const swift = await fs.readFile(swiftPath, 'utf8');
const plist = await fs.readFile(plistPath, 'utf8');

assert.equal(web, ios, 'web/index.html and bundled iOS index.html must match');
assert.equal(bridge, iosBridge, 'native bridge source and bundled iOS bridge must match');

const openStart = web.indexOf('async function openLiveCamera(){');
const openEnd = web.indexOf('\nfunction showLiveCameraFallback', openStart);
assert.ok(openStart >= 0 && openEnd > openStart, 'openLiveCamera function must exist');
const openFn = web.slice(openStart, openEnd);
assert.match(openFn, /embeddedCamera\.start\(overlay/);
assert.match(openFn, /direction:\s*"BACK"/);
assert.match(openFn, /shape:\s*"RECT"/);
assert.match(openFn, /adaptiveZoom:\s*false/);
assert.doesNotMatch(openFn, /pickPhoto\(\{\s*fromCamera:\s*true,\s*direction:\s*"BACK"/,
  'Food Scanner native path must not open the system iOS camera');

const snapStart = web.indexOf('async function snapLiveCamera(){');
const snapEnd = web.indexOf('\n// ---------- Face Scan Camera', snapStart);
assert.ok(snapStart >= 0 && snapEnd > snapStart, 'snapLiveCamera function must exist');
const snapFn = web.slice(snapStart, snapEnd);
assert.match(snapFn, /embeddedCamera\.capture\(\)/);
assert.match(snapFn, /foodScanPreviewBlock/);
assert.doesNotMatch(snapFn, /runFoodScan\(/,
  'Taking a photo must not automatically start Food Scanner AI analysis');

assert.match(web, /#liveCamera\.native-food-camera\{background:transparent!important\}/);
assert.match(web, /html\.food-camera-active \.bottom\{visibility:hidden!important/);
assert.match(bridge, /shape:\s*opts\.shape \|\| "OVAL"/);
assert.match(bridge, /adaptiveZoom:\s*opts\.adaptiveZoom !== false/);

assert.match(swift, /private\(set\) var previewShape: String = "OVAL"/);
assert.match(swift, /previewShape == "RECT"/);
assert.match(swift, /existing\.cameraPosition != position/);
assert.match(swift, /existing\.stop\(hideOnly: false\)/);
assert.match(swift, /let position: AVCaptureDevice\.Position = \(direction == "BACK"\) \? \.back : \.front/);
assert.match(swift, /if self\.adaptiveZoomEnabled && self\.previewShape != "RECT"/);
assert.match(plist, /capture selfies and meal photos/);

console.log('PASS: Food Scanner uses full-screen custom rear camera, returns photo to preview, and does not auto-scan');
