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

/* ۱-ب — آیکون برنامه (لوگوی سبحان بتن)
   Capacitor آیکون پیش‌فرض خودش را می‌گذارد، پس هر بار باید جایگزین شود.
   برای اندروید ۸ به بالا آیکون تطبیقی هم لازم است، وگرنه همان پیش‌فرض
   نمایش داده می‌شود حتی اگر ic_launcher.png عوض شده باشد. */
const ICONS = path.join(OVER, "icons");
const RES = path.join(APP, "src", "main", "res");
if (fs.existsSync(ICONS)) {
  let n = 0;
  for (const d of fs.readdirSync(ICONS)) {
    const from = path.join(ICONS, d), to = path.join(RES, d);
    if (!fs.statSync(from).isDirectory()) continue;
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) { fs.copyFileSync(path.join(from, f), path.join(to, f)); n++; }
  }
  /* آیکون تطبیقی: پس‌زمینه‌ی سفید + لوگو */
  const v26 = path.join(RES, "mipmap-anydpi-v26");
  fs.mkdirSync(v26, { recursive: true });
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@color/ic_launcher_background"/>\n' +
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
    '</adaptive-icon>\n';
  fs.writeFileSync(path.join(v26, "ic_launcher.xml"), xml);
  fs.writeFileSync(path.join(v26, "ic_launcher_round.xml"), xml);
  const vals = path.join(RES, "values");
  fs.mkdirSync(vals, { recursive: true });
  fs.writeFileSync(path.join(vals, "ic_launcher_background.xml"),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n');
  /* پس‌زمینه‌ی تصویری پیش‌فرض Capacitor اگر بماند، بر رنگ بالا مقدم می‌شود */
  for (const d of fs.readdirSync(RES)) {
    const f = path.join(RES, d, "ic_launcher_background.png");
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log("پس‌زمینه‌ی پیش‌فرض حذف شد:", d); }
  }
  console.log("آیکون اعمال شد:", n, "فایل");
} else {
  console.log("پوشه‌ی آیکون نیست؛ آیکون پیش‌فرض Capacitor می‌ماند.");
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
