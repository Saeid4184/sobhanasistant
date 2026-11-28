// پل بین کد مشترک www و ویندوز.
// هدف: کد داخل www دست‌نخورده بماند و همان فراخوانی‌های Capacitor اینجا هم کار کند.
//
// قانون این فایل: هر افزونه‌ای که واقعاً پیاده‌سازی شده است معرفی می‌شود و
// بقیه اصلاً وجود ندارند. نسخه‌ی قبلی برای همه‌ی افزونه‌ها یک stub می‌ساخت که
// بی‌صدا {} برمی‌گرداند؛ نتیجه‌اش این بود که saveShare مسیر نیتیو را می‌گرفت،
// Filesystem.writeFile چیزی نمی‌نوشت و Share هم کاری نمی‌کرد، پس هیچ خروجی
// اکسل و HTML و SVG و هیچ پشتیبانی روی ویندوز ذخیره نمی‌شد — بی‌هیچ پیغام خطا.
const { ipcRenderer } = require("electron");

const ok = (v) => Promise.resolve(v);

// --- تبدیل زمان‌بندی Capacitor به لیست ساده‌ی {id, title, body, at} ---
const MS = { day: 86400000, hour: 3600000, minute: 60000, week: 604800000 };
const REPEAT_COUNT = 30; // برای یادآوری‌های تکرارشونده، ۳۰ نوبت آینده ثبت می‌شود

function expand(n) {
  const base = { id: Number(n.id) || Date.now() % 1e6, title: n.title, body: n.body };
  const s = n.schedule || {};
  let at = s.at ? new Date(s.at) : new Date();
  if (s.on && !s.at) {
    const d = new Date();
    if (s.on.hour != null) d.setHours(s.on.hour);
    if (s.on.minute != null) d.setMinutes(s.on.minute);
    d.setSeconds(0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    at = d;
  }
  const step = s.every ? MS[s.every] : null;
  if (!step || !(s.repeats !== false)) return [{ ...base, at: at.toISOString() }];
  const out = [];
  let t = at.getTime();
  while (t < Date.now()) t += step;
  for (let i = 0; i < REPEAT_COUNT; i++) {
    out.push({ ...base, id: base.id * 1000 + i, parent: base.id, at: new Date(t).toISOString() });
    t += step;
  }
  return out;
}

const LocalNotifications = {
  requestPermissions: () => ok({ display: "granted" }),
  checkPermissions: () => ok({ display: "granted" }),
  createChannel: () => ok(),
  deleteChannel: () => ok(),
  listChannels: () => ok({ channels: [] }),
  registerActionTypes: () => ok(),
  schedule: (opts) => {
    const list = [].concat(opts && opts.notifications ? opts.notifications : []).flatMap(expand);
    return ipcRenderer.invoke("notify-schedule", list).then(() => ({ notifications: list }));
  },
  cancel: (opts) => {
    const ids = [].concat(opts && opts.notifications ? opts.notifications : []).flatMap((n) => {
      const base = Number(n.id);
      const all = [base];
      for (let i = 0; i < REPEAT_COUNT; i++) all.push(base * 1000 + i);
      return all;
    });
    return ipcRenderer.invoke("notify-cancel", ids).then(() => undefined);
  },
  removeAllDeliveredNotifications: () => ok(),
  getDeliveredNotifications: () => ok({ notifications: [] }),
  getPending: () => ipcRenderer.invoke("notify-pending").then((n) => ({ notifications: n })),
  addListener: (event, cb) => {
    if (event && event.indexOf("Action") > -1) {
      ipcRenderer.on("notification-click", (_e, n) => cb({ notification: n }));
    }
    return { remove: () => {} };
  },
  removeAllListeners: () => ok(),
};

// روی ویندوز دکمه‌ی برگشت سخت‌افزاری وجود ندارد، ولی خود برنامه به App.addListener
// تکیه می‌کند. یک پیاده‌سازی بی‌اثر ولی درست (با remove) می‌گذاریم تا خطا ندهد.
const App = {
  addListener: () => ({ remove: () => {} }),
  removeAllListeners: () => ok(),
  exitApp: () => ipcRenderer.invoke("app-quit"),
  getInfo: () => ok({ name: "دستیار سبحان بتن", id: "ir.sobhanbeton.app" }),
};

// فقط همین دو افزونه واقعاً کار می‌کنند. بقیه (Filesystem، Share، SmsReader،
// SpeechRecognition، Camera) عمداً معرفی نمی‌شوند تا نگهبان‌های خود برنامه
// («if(!P) return null») کار کنند و کاربر پیغام درست ببیند، نه سکوت.
const Plugins = { LocalNotifications, App };

window.Capacitor = {
  Plugins,
  // false است تا saveShare مسیر دانلود مرورگر را بگیرد؛ آن مسیر در Electron
  // پنجره‌ی ذخیره‌ی ویندوز را باز می‌کند و فایل واقعاً نوشته می‌شود.
  isNativePlatform: () => false,
  isPluginAvailable: (name) => name === "LocalNotifications" || name === "App",
  getPlatform: () => "web",
  convertFileSrc: (u) => u,
};
window.CapacitorPlugins = Plugins;

// پرچم‌ها برای قابلیت‌هایی که بعداً اضافه می‌شوند
window.PLATFORM = "windows";
window.IS_DESKTOP = true;
window.HAS_SMS = false;
window.HAS_CAMERA = false;

// دسترسی به فایل برای پشتیبان‌گیری با پنجره‌ی ویندوز
window.SobhanDesktop = {
  saveFile: (name, text) => ipcRenderer.invoke("save-file", { name, text }),
  // برای فایل‌های دودویی مثل xlsx که رشته نیستند
  saveBytes: (name, bytes) => ipcRenderer.invoke("save-bytes", { name, bytes: Array.from(bytes) }),
  openFile: () => ipcRenderer.invoke("open-file"),
  // بازنشانی رمز ادمین، فقط با تأیید یک پنجره‌ی خود ویندوز
  confirmAdminReset: () => ipcRenderer.invoke("confirm-admin-reset"),
};
