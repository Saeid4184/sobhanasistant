/* ============================================================
   tools/patch-android.js
   پوشه android را Capacitor می‌سازد و هر بار بازسازی می‌شود، پس
   تغییرات دستی در آن پاک می‌شود. این اسکریپت بعد از ساخت پوشه،
   فایل‌های android-overlay و مجوزهای لازم را دوباره اعمال می‌کند.

   اجرا:  node tools/patch-android.js
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const PKG = "ir.sobhanbeton.app";
const ROOT = process.cwd();
const APP = path.join(ROOT, "android", "app");
const JAVA = path.join(APP, "src", "main", "java", ...PKG.split("."));
const MAN = path.join(APP, "src", "main", "AndroidManifest.xml");
const OVER = path.join(ROOT, "android-overlay");

if (!fs.existsSync(APP)) { console.error("پوشه android ساخته نشده است."); process.exit(1); }

/* ۱ — کپی کلاس‌های جاوا */
fs.mkdirSync(JAVA, { recursive: true });
for (const f of fs.readdirSync(OVER).filter(x => x.endsWith(".java"))) {
  fs.copyFileSync(path.join(OVER, f), path.join(JAVA, f));
  console.log("کپی شد:", f);
}

/* ۲ — مجوزها و تنظیمات منیفست */
let m = fs.readFileSync(MAN, "utf8");
const perms = [
  "android.permission.READ_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.SCHEDULE_EXACT_ALARM",
  "android.permission.USE_EXACT_ALARM",
  "android.permission.VIBRATE",
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.INTERNET",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.RECEIVE_BOOT_COMPLETED"
];
let add = perms.filter(p => m.indexOf('"' + p + '"') < 0)
  .map(p => '    <uses-permission android:name="' + p + '" />').join("\n");
if (add) {
  m = m.replace("</manifest>", add + "\n</manifest>");
  console.log("مجوزها اضافه شد.");
}

/* ترافیک بدون رمز، چون سرور روی http و IP است */
if (m.indexOf("usesCleartextTraffic") < 0) {
  m = m.replace("<application", '<application android:usesCleartextTraffic="true"');
  console.log("cleartext فعال شد.");
}

/* گیرنده پیامک */
if (m.indexOf("SmsWatcher") < 0) {
  const rec =
    '        <receiver android:name="' + PKG + '.SmsWatcher" android:exported="true"\n' +
    '            android:permission="android.permission.BROADCAST_SMS">\n' +
    '            <intent-filter android:priority="900">\n' +
    '                <action android:name="android.provider.Telephony.SMS_RECEIVED" />\n' +
    '            </intent-filter>\n' +
    '        </receiver>\n';
  m = m.replace("</application>", rec + "    </application>");
  console.log("گیرنده پیامک ثبت شد.");
}

/* پیوند عمیق QR دستگاه‌ها: sobhanbeton://m/<id> */
if (m.indexOf('android:scheme="sobhanbeton"') < 0) {
  const filt =
    '\n            <intent-filter>\n' +
    '                <action android:name="android.intent.action.VIEW" />\n' +
    '                <category android:name="android.intent.category.DEFAULT" />\n' +
    '                <category android:name="android.intent.category.BROWSABLE" />\n' +
    '                <data android:scheme="sobhanbeton" android:host="m" />\n' +
    '            </intent-filter>\n';
  m = m.replace(/(<activity[\s\S]*?MainActivity[\s\S]*?>)/, "$1" + filt);
  console.log("پیوند عمیق اضافه شد.");
}

fs.writeFileSync(MAN, m);
console.log("منیفست به‌روز شد.");
