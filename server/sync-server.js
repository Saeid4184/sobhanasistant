#!/usr/bin/env node
/* سرویس همگام‌سازی — دستیار سبحان بتن
   گوشی و ویندوز را رکورد به رکورد یکی می‌کند. داده‌ها روی سرور خودت می‌مانند.

   این سرویس پشتیبان‌گیری نیست: چیزی را جایگزین نمی‌کند، ادغام می‌کند.
   هر رکورد یک مهر زمانی (u) دارد؛ اگر همان رکورد روی دو دستگاه عوض شود،
   نسخه‌ی جدیدتر می‌ماند. حذف هم به دستگاه دیگر منتقل می‌شود.

   راه‌اندازی:
     /opt/sobhan/sync-server.js  با فایل تنظیمات /opt/sobhan/sync.env
     APP_TOKEN اجباری است؛ بدون آن سرویس هیچ درخواستی را جواب نمی‌دهد،
     چون نشانی باز به معنی دسترسی آزاد به همه‌ی داده‌های کارگاه است.

   محدودسازی هر کاربر (اختیاری ولی توصیه‌شده وقتی هر نفر گوشی خودش را دارد):
     فایل /opt/sobhan/sync-users.json را از خود اپ بگیر
     (پنل کاربران ← «فایل دسترسی سرور») و کنار سرویس بگذار.
     از آن پس هر دستگاه با توکن اختصاصی خودش وصل می‌شود و سرویس فقط
     داده‌ی مجاز همان کاربر را به او می‌دهد و فقط همان را از او می‌پذیرد.
     اگر این فایل نباشد، سرویس مثل قبل با APP_TOKEN و دسترسی کامل کار می‌کند.

   نشانی‌ها:
     POST /sync          ادغام و دریافت تغییرات (هدر x-app-token)
     GET  /sync/health   وضعیت سرویس (بدون رمز)
     GET  /sync/stats    تعداد رکورد هر مجموعه (با رمز)
     GET  /sync/export   خروجی کامل داده‌ها برای پشتیبان (با رمز)
*/
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");

const APP = process.env.APP_TOKEN || "";
const PORT = +(process.env.PORT || 8788);
const DIR = process.env.DIR || "/opt/sobhan";
const FILE = process.env.DATA_FILE || path.join(DIR, "sync-data.json");
const TOMB_DAYS = +(process.env.TOMB_DAYS || 180);   // بیشتر از ۱۲۰ روزِ سمت اپ
const MAX_BODY = +(process.env.MAX_BODY_MB || 32) * 1024 * 1024;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const tkey = (c, id) => c + "\u0000" + id;

/* ---------- فایل دسترسی کاربران ---------- */
/* مجموعه‌هایی که کاربر محدود برای کار کردن لازم دارد. بیش از این به او داده نمی‌شود. */
const OWN_COLS = { sheets: 1, machines: 1, contacts: 1, users: 1, norms: 1, trips: 1, fuel: 1, stops: 1, log: 1, scores: 1, opprod: 1, faults: 1 };
const USERS_FILE = process.env.USERS_FILE || path.join(DIR, "sync-users.json");
let acl = null, aclAt = 0;

function loadAcl() {
  try {
    const st = fs.statSync(USERS_FILE);
    if (acl && st.mtimeMs === aclAt) return acl;
    const j = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    const by = {};
    (j.users || []).forEach(u => {
      if (!u || !u.token) return;
      by[String(u.token)] = {
        uid: String(u.uid || ""), name: String(u.name || ""), role: String(u.role || ""),
        cid: String(u.cid || ""), full: !!u.full, own: !!u.own, w: u.w !== false,
        secs: Array.isArray(u.secs) ? u.secs.map(String) : null,
        mach: Array.isArray(u.mach) ? u.mach.map(String) : []
      };
    });
    acl = { by: by, n: Object.keys(by).length };
    aclAt = st.mtimeMs;
    log("فایل دسترسی خوانده شد:", acl.n, "کاربر");
    return acl;
  } catch (e) {
    if (e.code !== "ENOENT") log("فایل دسترسی خوانده نشد:", e.message);
    acl = null; aclAt = 0;
    return null;
  }
}

/* دسترسی این درخواست: یا کاربرِ فایل دسترسی، یا APP_TOKEN با دسترسی کامل */
function who(req) {
  const t = req.headers["x-app-token"] || "";
  const a = loadAcl();
  if (a && a.by[t]) return a.by[t];
  if (t && t === APP) return { uid: "", name: "APP_TOKEN", role: "admin", full: true, own: false, w: true, secs: null, mach: [] };
  return null;
}

/* آیا این رکورد در دسترس این کاربر است؟ */
function allowed(u, col, r) {
  if (!u || u.full) return true;
  if (!r || typeof r !== "object") return false;
  if (u.own) {
    if (!OWN_COLS[col]) return false;
    if (col === "users") return String(r.id || "") === u.uid;
    if (String(r.by || "") === u.uid) return true;
    if (col === "contacts") return String(r.id || "") === u.cid;
    if (col === "machines") return u.mach.indexOf(String(r.id || "")) >= 0;
    const mid = String(r.machineId || "");
    if (mid && u.mach.indexOf(mid) >= 0) return true;
    if (String(r.contactId || "") === u.cid && u.cid) return true;
    return false;
  }
  if (u.secs) {
    if (col === "users") return String(r.id || "") === u.uid;
    if (col === "contacts" || col === "norms") return true;
    if (col === "machines") return u.mach.indexOf(String(r.id || "")) >= 0;
    const sec = String(r.sec || "");
    if (sec) return u.secs.indexOf(sec) >= 0;
    const mid = String(r.machineId || "");
    if (mid) return u.mach.indexOf(mid) >= 0;      /* رکورد دستگاهی که بخشش را نمی‌بیند */
    return false;                                   /* رکورد بی‌نشانه: به کاربر محدود داده نمی‌شود */
  }
  return true;
}

/* ---------- خواندن و نوشتن فایل داده ---------- */
fs.mkdirSync(DIR, { recursive: true });

let db = { v: 1, seq: 0, cols: {}, tombs: {} };
try {
  const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (j && typeof j === "object") {
    db.seq = +j.seq || 0;
    db.cols = (j.cols && typeof j.cols === "object") ? j.cols : {};
    db.tombs = (j.tombs && typeof j.tombs === "object") ? j.tombs : {};
  }
  log("داده بارگذاری شد:", count().recs, "رکورد، seq =", db.seq);
} catch (e) {
  if (e.code === "ENOENT") log("فایل داده نیست؛ از صفر شروع می‌شود:", FILE);
  else log("فایل داده خوانده نشد (" + e.message + ") — از صفر شروع می‌شود. فایل قبلی دست‌نخورده می‌ماند.");
}

let saveT = null, dirty = false;
function saveSoon() { dirty = true; if (saveT) return; saveT = setTimeout(flush, 400); }
function flush() {
  clearTimeout(saveT); saveT = null;
  if (!dirty) return;
  dirty = false;
  const tmp = FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);                       // جایگزینی اتمیک: فایل نیمه‌کاره نمی‌ماند
  } catch (e) { dirty = true; log("ذخیره نشد:", e.message); return; }
  backup();
}

/* یک کپی در روز، کنار فایل اصلی */
function backup() {
  try {
    const bak = FILE + ".bak", st = fs.existsSync(bak) ? fs.statSync(bak) : null;
    if (st && Date.now() - st.mtimeMs < 20 * 3600e3) return;
    fs.copyFileSync(FILE, bak);
  } catch (e) { }
}

function count() {
  let recs = 0, c;
  for (c in db.cols) recs += Object.keys(db.cols[c]).length;
  return { recs: recs, tombs: Object.keys(db.tombs).length };
}

/* ---------- پاک کردن سنگ‌قبرهای بسیار قدیمی ---------- */
function prune() {
  const lim = Date.now() - TOMB_DAYS * 864e5;
  let n = 0, k;
  for (k in db.tombs) if ((+db.tombs[k].u || 0) < lim) { delete db.tombs[k]; n++; }
  if (n) { saveSoon(); log("سنگ‌قبر قدیمی پاک شد:", n); }
}

/* ---------- ادغام تغییرات ورودی ---------- */
function push(body, dev, u) {
  const chg = (body.changes && typeof body.changes === "object") ? body.changes : {};
  const tbs = Array.isArray(body.tombs) ? body.tombs : [];
  let nr = 0, nd = 0, skipped = 0, c, i, arr, r, uu, ex, tb, key, store;

  for (c in chg) {
    arr = chg[c];
    if (!Array.isArray(arr) || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(c)) continue;
    store = db.cols[c] || (db.cols[c] = {});
    for (i = 0; i < arr.length; i++) {
      r = arr[i];
      if (!r || typeof r !== "object" || !r.id) continue;
      if (!allowed(u, c, r)) { skipped++; continue; }
      uu = +r.u || 0;
      tb = db.tombs[tkey(c, r.id)];
      if (tb && (+tb.u || 0) >= uu) continue;         // بعد از این تغییر حذف شده: زنده نشود
      ex = store[r.id];
      if (ex && (+ex.u || 0) >= uu) continue;         // نسخه‌ی سرور تازه‌تر یا همان است
      db.seq++;
      store[r.id] = Object.assign({}, r, { _s: db.seq, _d: dev });
      nr++;
    }
  }

  for (i = 0; i < tbs.length; i++) {
    tb = tbs[i];
    if (!tb || !tb.c || !tb.id) continue;
    uu = +tb.u || 0; key = tkey(tb.c, tb.id);
    store = db.cols[tb.c];
    ex = store && store[tb.id];
    /* حذف را فقط از کسی می‌پذیریم که به آن رکورد دسترسی داشته است */
    if (!allowed(u, tb.c, ex || { id: tb.id })) { skipped++; continue; }
    if (ex && (+ex.u || 0) > uu) continue;            // بعد از حذف دوباره ساخته شده
    if (ex) delete store[tb.id];
    const old = db.tombs[key];
    if (old && (+old.u || 0) >= uu) continue;
    db.seq++;
    db.tombs[key] = { c: tb.c, id: tb.id, u: uu, _s: db.seq, _d: dev };
    nd++;
  }

  if (nr || nd) saveSoon();
  return { recs: nr, dels: nd, skipped: skipped };
}

/* ---------- تغییرات برای این دستگاه ---------- */
function pull(cursor, limit, dev, u) {
  const items = [];
  let c, id, r, k, tb;
  for (c in db.cols) {
    const store = db.cols[c];
    for (id in store) {
      r = store[id];
      if ((+r._s || 0) > cursor && r._d !== dev && allowed(u, c, r)) items.push({ s: +r._s, kind: "r", col: c, rec: r });
    }
  }
  for (k in db.tombs) {
    tb = db.tombs[k];
    /* سنگ‌قبر رکوردی که دیگر روی سرور نیست: اگر کاربر محدود است و نمی‌دانیم
       آن رکورد مال او بوده یا نه، با شناسه و مجموعه‌اش سنجیده می‌شود */
    if ((+tb._s || 0) > cursor && tb._d !== dev && (u && !u.full ? allowed(u, tb.c, { id: tb.id, by: u.uid }) : true))
      items.push({ s: +tb._s, kind: "d", tb: tb });
  }
  items.sort((a, b) => a.s - b.s);

  const more = items.length > limit;
  const page = more ? items.slice(0, limit) : items;
  const changes = {}, tombs = [];
  let i, it, o, key;
  for (i = 0; i < page.length; i++) {
    it = page[i];
    if (it.kind === "r") {
      o = {};
      for (key in it.rec) if (key !== "_s" && key !== "_d") o[key] = it.rec[key];
      (changes[it.col] || (changes[it.col] = [])).push(o);
    } else tombs.push({ c: it.tb.c, id: it.tb.id, u: it.tb.u });
  }
  /* صفحه‌ی آخر: نشانگر را تا انتهای تاریخچه جلو می‌بریم تا رکوردهای خودِ این
     دستگاه هر بار دوباره بررسی نشوند. */
  const cur = more ? page[page.length - 1].s : Math.max(cursor, db.seq);
  return { changes: changes, tombs: tombs, count: page.length, cursor: cur, more: more };
}

/* ---------- وب ---------- */
const H = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "x-app-token, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400"
};

function readBody(req) {
  return new Promise((res, rej) => {
    const buf = []; let n = 0, done = false;
    req.on("data", c => {
      if (done) return;
      n += c.length;
      if (n > MAX_BODY) { done = true; rej(new Error("حجم درخواست بیش از حد مجاز")); req.destroy(); return; }
      buf.push(c);
    });
    req.on("end", () => { if (!done) { done = true; res(Buffer.concat(buf).toString("utf8")); } });
    req.on("error", e => { if (!done) { done = true; rej(e); } });
  });
}

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (code, o) => {
    res.writeHead(code, Object.assign({ "content-type": "application/json; charset=utf-8" }, H));
    res.end(JSON.stringify(o));
  };
  if (req.method === "OPTIONS") { res.writeHead(204, H); return res.end(); }

  if (u.pathname === "/sync/health") {
    const c = count(), a = loadAcl();
    return json(200, {
      ok: true, token: !!APP, records: c.recs, tombs: c.tombs,
      seq: db.seq, devices: devices(), file: FILE,
      scoped: !!a, users: a ? a.n : 0
    });
  }

  const ME = who(req);
  if (!APP && !ME) return json(503, { ok: false, error: "APP_TOKEN روی سرور تنظیم نشده است؛ سرویس داده نمی‌دهد." });
  if (!ME) return json(401, { ok: false, error: "رمز اپ نامعتبر" });

  if (u.pathname === "/sync/stats") {
    if (!ME.full) return json(403, { ok: false, error: "این نشانی فقط برای دسترسی کامل است" });
    const out = {}; let c;
    for (c in db.cols) out[c] = Object.keys(db.cols[c]).length;
    return json(200, { ok: true, seq: db.seq, cols: out, tombs: Object.keys(db.tombs).length, devices: devices() });
  }

  if (u.pathname === "/sync/export") {
    if (!ME.full) return json(403, { ok: false, error: "این نشانی فقط برای دسترسی کامل است" });
    const out = {}; let c, id, k, o;
    for (c in db.cols) {
      out[c] = [];
      for (id in db.cols[c]) {
        o = {};
        for (k in db.cols[c][id]) if (k !== "_s" && k !== "_d") o[k] = db.cols[c][id][k];
        out[c].push(o);
      }
    }
    return json(200, { ok: true, app: "sobhan-beton", date: new Date().toISOString(), seq: db.seq, data: out });
  }

  if (u.pathname === "/sync" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req) || "{}"); }
    catch (e) { return json(400, { ok: false, error: e.message || "بدنه‌ی درخواست نامعتبر" }); }
    if (!body || typeof body !== "object") return json(400, { ok: false, error: "بدنه‌ی درخواست نامعتبر" });

    const dev = String(body.device || "").slice(0, 64) || "?";
    const cursor = Math.max(0, +body.cursor || 0);
    const limit = Math.min(5000, Math.max(1, +body.limit || 1500));
    const inn = ME.w ? push(body, dev, ME) : { recs: 0, dels: 0, skipped: -1 };
    const out = pull(cursor, limit, dev, ME);
    seen(dev + (ME.uid ? "/" + ME.uid : ""));
    if (inn.recs || inn.dels || out.count || inn.skipped > 0)
      log("دستگاه", dev, ME.name ? "(" + ME.name + ")" : "", "← گرفت", inn.recs + "+" + inn.dels,
        inn.skipped > 0 ? "رد شد " + inn.skipped : "", "— داد", out.count, out.more ? "(ادامه دارد)" : "");
    return json(200, Object.assign({ ok: true, got: inn, ro: !ME.w }, out));
  }

  json(404, { ok: false, error: "نشانی نامعتبر" });
});

/* ---------- دستگاه‌های دیده‌شده ---------- */
const DEVF = path.join(DIR, "sync-devices.json");
let devs = {};
try { devs = JSON.parse(fs.readFileSync(DEVF, "utf8")) || {}; } catch (e) { devs = {}; }
let devT = null;
function seen(d) {
  devs[d] = Date.now();
  if (devT) return;
  devT = setTimeout(() => { devT = null; try { fs.writeFileSync(DEVF, JSON.stringify(devs)); } catch (e) { } }, 5000);
}
function devices() {
  const out = []; let d;
  for (d in devs) out.push({ dev: d, at: devs[d] });
  return out.sort((a, b) => b.at - a.at).slice(0, 20);
}

/* ---------- بالا آمدن و خاموش شدن ---------- */
if (!APP) log("هشدار: APP_TOKEN تنظیم نشده — سرویس تا تنظیم آن داده نمی‌دهد.");
{ const a = loadAcl();
  if (a) log("محدودسازی فعال است:", a.n, "کاربر از", USERS_FILE);
  else log("محدودسازی غیرفعال — هر کس APP_TOKEN را داشته باشد همه‌ی داده را می‌گیرد. فایل", USERS_FILE, "را از اپ بگیر."); }
prune(); setInterval(prune, 12 * 3600e3);
srv.listen(PORT, () => log("سرویس همگام‌سازی روی پورت", PORT, "— داده در", FILE));

["SIGTERM", "SIGINT"].forEach(s => process.on(s, () => {
  log("خاموش می‌شود؛ ذخیره‌ی داده...");
  try { flush(); } catch (e) { }
  process.exit(0);
}));
process.on("uncaughtException", e => { log("خطای غیرمنتظره:", e && e.message); try { flush(); } catch (x) { } });
