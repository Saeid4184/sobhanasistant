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
function push(body, dev) {
  const chg = (body.changes && typeof body.changes === "object") ? body.changes : {};
  const tbs = Array.isArray(body.tombs) ? body.tombs : [];
  let nr = 0, nd = 0, c, i, arr, r, u, ex, tb, key, store;

  for (c in chg) {
    arr = chg[c];
    if (!Array.isArray(arr) || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(c)) continue;
    store = db.cols[c] || (db.cols[c] = {});
    for (i = 0; i < arr.length; i++) {
      r = arr[i];
      if (!r || typeof r !== "object" || !r.id) continue;
      u = +r.u || 0;
      tb = db.tombs[tkey(c, r.id)];
      if (tb && (+tb.u || 0) >= u) continue;          // بعد از این تغییر حذف شده: زنده نشود
      ex = store[r.id];
      if (ex && (+ex.u || 0) >= u) continue;          // نسخه‌ی سرور تازه‌تر یا همان است
      db.seq++;
      store[r.id] = Object.assign({}, r, { _s: db.seq, _d: dev });
      nr++;
    }
  }

  for (i = 0; i < tbs.length; i++) {
    tb = tbs[i];
    if (!tb || !tb.c || !tb.id) continue;
    u = +tb.u || 0; key = tkey(tb.c, tb.id);
    store = db.cols[tb.c];
    ex = store && store[tb.id];
    if (ex && (+ex.u || 0) > u) continue;             // بعد از حذف دوباره ساخته شده
    if (ex) delete store[tb.id];
    const old = db.tombs[key];
    if (old && (+old.u || 0) >= u) continue;
    db.seq++;
    db.tombs[key] = { c: tb.c, id: tb.id, u: u, _s: db.seq, _d: dev };
    nd++;
  }

  if (nr || nd) saveSoon();
  return { recs: nr, dels: nd };
}

/* ---------- تغییرات برای این دستگاه ---------- */
function pull(cursor, limit, dev) {
  const items = [];
  let c, id, r, k, tb;
  for (c in db.cols) {
    const store = db.cols[c];
    for (id in store) {
      r = store[id];
      if ((+r._s || 0) > cursor && r._d !== dev) items.push({ s: +r._s, kind: "r", col: c, rec: r });
    }
  }
  for (k in db.tombs) {
    tb = db.tombs[k];
    if ((+tb._s || 0) > cursor && tb._d !== dev) items.push({ s: +tb._s, kind: "d", tb: tb });
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
    const c = count();
    return json(200, {
      ok: true, token: !!APP, records: c.recs, tombs: c.tombs,
      seq: db.seq, devices: devices(), file: FILE
    });
  }

  if (!APP) return json(503, { ok: false, error: "APP_TOKEN روی سرور تنظیم نشده است؛ سرویس داده نمی‌دهد." });
  if (req.headers["x-app-token"] !== APP) return json(401, { ok: false, error: "رمز اپ نامعتبر" });

  if (u.pathname === "/sync/stats") {
    const out = {}; let c;
    for (c in db.cols) out[c] = Object.keys(db.cols[c]).length;
    return json(200, { ok: true, seq: db.seq, cols: out, tombs: Object.keys(db.tombs).length, devices: devices() });
  }

  if (u.pathname === "/sync/export") {
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
    const inn = push(body, dev);
    const out = pull(cursor, limit, dev);
    seen(dev);
    if (inn.recs || inn.dels || out.count)
      log("دستگاه", dev, "← گرفت", inn.recs + "+" + inn.dels, "— داد", out.count, out.more ? "(ادامه دارد)" : "");
    return json(200, Object.assign({ ok: true, got: inn }, out));
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
prune(); setInterval(prune, 12 * 3600e3);
srv.listen(PORT, () => log("سرویس همگام‌سازی روی پورت", PORT, "— داده در", FILE));

["SIGTERM", "SIGINT"].forEach(s => process.on(s, () => {
  log("خاموش می‌شود؛ ذخیره‌ی داده...");
  try { flush(); } catch (e) { }
  process.exit(0);
}));
process.on("uncaughtException", e => { log("خطای غیرمنتظره:", e && e.message); try { flush(); } catch (x) { } });
