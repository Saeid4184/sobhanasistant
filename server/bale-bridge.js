#!/usr/bin/env node
/* پل بله ← دستیار سبحان بتن
   عکس‌های مستندات مقاطع پمپ را که رانندگان در گروه بله می‌فرستند جمع می‌کند و
   به اپ می‌دهد تا در فایل عملکرد هر پمپ بایگانی شود.

   راه‌اندازی:
     ۱) در بله یک ربات بساز (BotFather بله) و توکنش را بردار.
     ۲) ربات را به گروه رانندگان پمپ اضافه کن و ادمینش کن تا همه‌ی پیام‌ها را ببیند.
     ۳) این فایل را روی سرور ایران بگذار (بله از خارج در دسترس نیست):
        /opt/sobhan/bale-bridge.js  با فایل تنظیمات /opt/sobhan/bale.env
     ۴) BALE_TOKEN و APP_TOKEN را در bale.env بنویس و سرویس را با systemd بالا بیاور.

   نکته‌ی مهم: ربات فقط پیام‌هایی را می‌بیند که بعد از اضافه شدنش فرستاده شده‌اند.
   عکس‌های قبلی را باید در گروه فوروارد کنید یا دستی در اپ بارگذاری کنید.
*/
"use strict";
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path");

const TOKEN = process.env.BALE_TOKEN || "";
const APP = process.env.APP_TOKEN || "";
const PORT = +(process.env.PORT || 8790);
const DIR = process.env.DIR || "/opt/sobhan/bale";
const ONLY_CHAT = process.env.CHAT_ID || "";          // اگر پر باشد فقط همان گروه خوانده می‌شود
const API = "https://tapi.bale.ai/bot" + TOKEN;
const FILE = "https://tapi.bale.ai/file/bot" + TOKEN;
const META = path.join(DIR, "docs.json");
const STATE = path.join(DIR, "state.json");

fs.mkdirSync(path.join(DIR, "files"), { recursive: true });
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const save = (f, v) => fs.writeFileSync(f, JSON.stringify(v));
let docs = load(META, []);
let state = load(STATE, { offset: 0 });
const log = (...a) => console.log(new Date().toISOString(), ...a);

function get(url, raw) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: 45000 }, r => {
      if (r.statusCode >= 400) { r.resume(); return rej(new Error("HTTP " + r.statusCode)); }
      const buf = []; r.on("data", c => buf.push(c));
      r.on("end", () => { const b = Buffer.concat(buf);
        if (raw) return res(b);
        try { res(JSON.parse(b.toString("utf8"))); } catch (e) { rej(new Error("پاسخ نامعتبر از بله")); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", rej);
  });
}

/* بزرگ‌ترین اندازه‌ی عکس، یا سندی که عکس است */
function pickFile(m) {
  if (Array.isArray(m.photo) && m.photo.length) {
    const p = [...m.photo].sort((a, b) => (a.file_size || a.width || 0) - (b.file_size || b.width || 0)).pop();
    return { id: p.file_id, uid: p.file_unique_id || p.file_id, w: p.width || 0, h: p.height || 0, size: p.file_size || 0, kind: "photo" };
  }
  const d = m.document;
  if (d && /image\/(jpeg|png|webp)/i.test(d.mime_type || "")) return { id: d.file_id, uid: d.file_unique_id || d.file_id, w: 0, h: 0, size: d.file_size || 0, kind: "document", name: d.file_name || "" };
  return null;
}

async function pull() {
  if (!TOKEN) return;
  let j;
  try { j = await get(`${API}/getUpdates?offset=${state.offset}&limit=50&allowed_updates=["message"]`); }
  catch (e) { log("getUpdates:", e.message); return; }
  if (!j || !j.ok || !Array.isArray(j.result)) { log("getUpdates پاسخ نامناسب"); return; }
  let n = 0;
  for (const u of j.result) {
    state.offset = Math.max(state.offset, (u.update_id || 0) + 1);
    const m = u.message || u.edited_message; if (!m) continue;
    const chat = m.chat || {}, chatId = String(chat.id || "");
    if (ONLY_CHAT && chatId !== String(ONLY_CHAT)) continue;
    const f = pickFile(m); if (!f) continue;
    if (docs.some(d => d.uid === f.uid)) continue;
    let p;
    try { p = await get(`${API}/getFile?file_id=${encodeURIComponent(f.id)}`); }
    catch (e) { log("getFile:", e.message); continue; }
    const fp = p && p.result && p.result.file_path;
    if (!fp) { log("file_path نیامد"); continue; }
    let bytes;
    try { bytes = await get(`${FILE}/${fp}`, true); }
    catch (e) { log("download:", e.message); continue; }
    const ext = (path.extname(fp) || ".jpg").slice(0, 5);
    const rel = path.join("files", f.uid + ext);
    fs.writeFileSync(path.join(DIR, rel), bytes);
    docs.push({ uid: f.uid, ts: (m.date || Math.floor(Date.now() / 1e3)) * 1000, chat: chatId,
      chatTitle: chat.title || chat.username || "", from: [(m.from || {}).first_name, (m.from || {}).last_name].filter(Boolean).join(" ") || String((m.from || {}).id || ""),
      caption: String(m.caption || m.text || "").slice(0, 600), kind: f.kind, name: f.name || "", w: f.w, h: f.h, size: bytes.length, rel });
    n++;
  }
  if (n) { docs = docs.slice(-5000); save(META, docs); }
  save(STATE, state);
  if (n) log("دریافت شد:", n, "فایل");
}

const okTok = req => !APP || req.headers["x-app-token"] === APP;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), H = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  if (req.method === "OPTIONS") { res.writeHead(204, H); return res.end(); }
  const json = (code, o) => { res.writeHead(code, Object.assign({ "content-type": "application/json; charset=utf-8" }, H)); res.end(JSON.stringify(o)); };
  if (u.pathname === "/bale/health") return json(200, { ok: true, token: !!TOKEN, docs: docs.length, offset: state.offset, chat: ONLY_CHAT || "همه‌ی گروه‌ها" });
  if (!okTok(req)) return json(401, { ok: false, error: "توکن اپ نامعتبر" });
  if (u.pathname === "/bale/docs") {
    const since = +u.searchParams.get("since") || 0, lim = Math.min(200, +u.searchParams.get("limit") || 60);
    const L = docs.filter(d => d.ts > since).sort((a, b) => a.ts - b.ts).slice(0, lim)
      .map(d => ({ uid: d.uid, ts: d.ts, from: d.from, caption: d.caption, chatTitle: d.chatTitle, kind: d.kind, name: d.name, w: d.w, h: d.h, size: d.size }));
    return json(200, { ok: true, docs: L, total: docs.length });
  }
  if (u.pathname.startsWith("/bale/file/")) {
    const uid = decodeURIComponent(u.pathname.slice("/bale/file/".length)), d = docs.find(x => x.uid === uid);
    if (!d) return json(404, { ok: false, error: "پیدا نشد" });
    let b; try { b = fs.readFileSync(path.join(DIR, d.rel)); } catch (e) { return json(410, { ok: false, error: "فایل روی سرور نیست" }); }
    res.writeHead(200, Object.assign({ "content-type": /\.png$/i.test(d.rel) ? "image/png" : "image/jpeg", "content-length": b.length, "cache-control": "max-age=86400" }, H));
    return res.end(b);
  }
  json(404, { ok: false, error: "نشانی نامعتبر" });
}).listen(PORT, () => log("پل بله روی پورت", PORT, "— فایل‌ها در", DIR));

pull(); setInterval(pull, +(process.env.POLL_SEC || 60) * 1000);
