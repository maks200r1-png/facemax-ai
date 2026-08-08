import fs from 'node:fs';

const html = fs.readFileSync('web/index.html','utf8');
const bridge = fs.readFileSync('web/js/native-bridge.js','utf8');
const iosHtml = fs.readFileSync('ios/App/App/public/index.html','utf8');
const iosBridge = fs.readFileSync('ios/App/App/public/js/native-bridge.js','utf8');
function ok(cond, msg){ if(!cond){ console.error('FAIL:',msg); process.exit(1); } }
ok(html === iosHtml, 'web/index.html must match iOS public/index.html');
ok(bridge === iosBridge, 'web native bridge must match iOS public native bridge');
ok(html.includes('id="homeNotifBadge"'), 'Home bell badge missing');
ok(html.includes('id="profileNotifBadge"'), 'Profile bell badge missing');
ok(html.includes('section id="notifications"'), 'Notifications screen missing');
ok(html.includes('facemax_notification_inbox_v1'), 'Persistent inbox storage missing');
ok(html.includes('fmInboxSyncDelivered'), 'Delivered notification sync missing');
ok(html.includes('facemax:local-notification'), 'Native notification event listener missing');
ok(html.includes('return v.sort((a,b)=>(Number(b && b.ts)||0)-(Number(a && a.ts)||0));'), 'Inbox must load newest-first');
ok(html.includes('items.sort((a,b)=>(Number(b.ts)||0)-(Number(a.ts)||0));'), 'Inbox additions must remain newest-first');
ok(!html.includes('notif-inbox-note'), 'Obsolete inbox footer note must be removed');
ok(html.includes('extra: { route:"glowupHub", inboxType:"streak" }'), 'Streak route metadata missing');
ok(html.includes('extra: { route:"upload", inboxType:"scan" }'), 'Re-scan route metadata missing');
ok(bridge.includes('getDeliveredNotifications'), 'Bridge delivered-notifications API missing');
ok(bridge.includes('localNotificationActionPerformed'), 'Bridge notification action listener missing');
ok(bridge.includes('localNotificationReceived'), 'Bridge foreground receive listener missing');
ok(bridge.includes('extra: (extra && typeof extra === "object") ? extra : undefined'), 'Native notification extra payload missing');
ok(/APP_MARKETING_VERSION:\s*"1\.8"/.test(fs.readFileSync('.github/workflows/ios-build.yml','utf8')), 'CI marketing version must stay 1.8');
ok(/ENV\.fetch\("APP_MARKETING_VERSION",\s*"1\.8"\)/.test(fs.readFileSync('ios/App/fastlane/Fastfile','utf8')), 'Fastfile default marketing version must stay 1.8');
console.log('PASS: notification inbox, badges, iOS delivered sync and deep-link routing audit');
