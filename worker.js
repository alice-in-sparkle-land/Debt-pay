/* Trả dần mỗi ngày · Cloudflare Worker
   Serves /public and a small API with two roles:
     admin  (Mẫn)        -> header X-Pin = secret ADMIN_PIN. Can do everything.
     payer  (anh Trường) -> header X-Key = secret link key (created by the server, shown to admin).
                            Can add payments (always "pending"), edit/delete his own pending ones,
                            add "không trả được hôm nay" notes. Cannot confirm anything.
   Needs: D1 database bound as DB, secret ADMIN_PIN (4-8 digits). Tables are created on first use.

   GET  /api/data?v=<ver>        -> {v, same:true} | {v, role, settings, entries}
   POST /api/op   {ops:[...]}     -> {results:[...], v, role, settings, entries}
   GET  /api/admin/key            -> {key}            (admin)
   POST /api/admin/key            -> {key}  new link, old one stops working (admin)
   POST /api/admin/import {mode:'merge'|'replace', entries:[...], settings?} (admin)
   POST /api/admin/erase          (admin)
   GET  /api/push/key             -> {key}  public key for phone notifications
   POST /api/push/sub {sub}       save this phone's notification address (for its role)
   POST /api/push/unsub {endpoint}
   POST /api/push/test            send a test notification to this phone
   Cron 11:00 UTC (18:00 VN): payer gets a reminder, or a thank-you if he already paid today.
   Admin phones get a notification whenever the payer adds a payment.
*/
const HOME = '/tra-no.html';
const MAX_BODY = 2e6;
const IP_TRIES = 6, IP_LOCK = 15 * 60e3;
const ALL_TRIES = 40, ALL_WIN = 60 * 60e3, ALL_LOCK = 60 * 60e3;
const DEF_SETTINGS = { target: 150000, payer: 'anh Trường', admin: 'Mẫn', start: '' };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

let ready = false;
async function setup(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, type TEXT NOT NULL, amount INTEGER NOT NULL,
      date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, by TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL)`),
    db.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS guard (k TEXT PRIMARY KEY, fails INTEGER NOT NULL, since INTEGER NOT NULL, until INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, role TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0)')
  ]);
  ready = true;
}

/* ---------- small helpers ---------- */
function sameText(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
async function kvGet(db, k) { const r = await db.prepare('SELECT v FROM kv WHERE k=?').bind(k).first(); return r ? r.v : null; }
const kvSetStmt = (db, k, v) => db.prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v));
async function bump(db) { await db.prepare(`INSERT INTO kv (k,v) VALUES ('ver','1') ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT)`).run(); }
function newKey() {
  const b = new Uint8Array(18); crypto.getRandomValues(b);
  return Array.from(b, x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');
}
const vnToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/* ---------- validation ---------- */
const ID_RE = /^[A-Za-z0-9-]{4,40}$/;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const cleanNote = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
function cleanAmount(a) { const n = Math.round(Number(a)); return Number.isFinite(n) && n >= 1000 && n <= 1e9 ? n : null; }
function cleanSettings(o, base = DEF_SETTINGS) {
  o = o && typeof o === 'object' ? o : {};
  const t = Math.round(Number(o.target));
  return {
    target: Number.isFinite(t) && t >= 1000 && t <= 1e8 ? t : base.target,
    payer: typeof o.payer === 'string' && o.payer.trim() ? cleanNote(o.payer).slice(0, 30) : base.payer,
    admin: typeof o.admin === 'string' && o.admin.trim() ? cleanNote(o.admin).slice(0, 30) : base.admin,
    start: o.start === '' ? '' : isDate(o.start) ? o.start : base.start
  };
}
const TYPES = ['repay', 'advance', 'miss'], STATUSES = ['pending', 'ok', 'rejected'];

/* ---------- auth ---------- */
async function getGuard(db, k) { return (await db.prepare('SELECT fails, since, until FROM guard WHERE k=?').bind(k).first()) || { fails: 0, since: 0, until: 0 }; }
async function putGuard(db, k, g) { await db.prepare('INSERT INTO guard (k,fails,since,until) VALUES (?,?,?,?) ON CONFLICT(k) DO UPDATE SET fails=excluded.fails, since=excluded.since, until=excluded.until').bind(k, g.fails, g.since, g.until).run(); }

async function auth(request, env) {
  const db = env.DB, now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const kIp = 'ip:' + ip.slice(0, 64);
  const [gIp, gAll] = await Promise.all([getGuard(db, kIp), getGuard(db, 'all')]);
  const until = Math.max(gIp.until, gAll.until);
  if (until > now) return { deny: json({ error: 'locked', retryIn: Math.ceil((until - now) / 1000) }, 429) };
  const pin = request.headers.get('X-Pin'), key = request.headers.get('X-Key');
  let role = null;
  if (pin) { if (sameText(pin, String(env.ADMIN_PIN).trim())) role = 'admin'; }
  else if (key) { const real = await kvGet(db, 'payer_key'); if (real && sameText(key, real)) role = 'payer'; }
  if (role) {
    if (gIp.fails) await putGuard(db, kIp, { fails: 0, since: now, until: 0 });
    return { role };
  }
  if (!pin && !key) return { deny: json({ error: 'auth' }, 401) };
  gIp.fails++; if (gIp.fails >= IP_TRIES) { gIp.until = now + IP_LOCK; gIp.fails = 0; }
  if (now - gAll.since > ALL_WIN) { gAll.fails = 0; gAll.since = now; }
  gAll.fails++; if (gAll.fails >= ALL_TRIES) { gAll.until = now + ALL_LOCK; gAll.fails = 0; gAll.since = now; }
  await Promise.all([putGuard(db, kIp, gIp), putGuard(db, 'all', gAll)]);
  if (gIp.until > now) return { deny: json({ error: 'locked', retryIn: Math.ceil(IP_LOCK / 1000) }, 429) };
  return { deny: json({ error: pin ? 'pin' : 'key', triesLeft: IP_TRIES - gIp.fails }, 401) };
}

/* ---------- data ---------- */
async function snapshot(db, role) {
  const [{ results }, s, v] = await Promise.all([
    db.prepare('SELECT id,type,amount,date,note,status,by,reason,created,updated FROM entries ORDER BY date, created').all(),
    kvGet(db, 'settings'), kvGet(db, 'ver')
  ]);
  let settings = DEF_SETTINGS; try { settings = cleanSettings(JSON.parse(s || '{}')); } catch (e) { /* default */ }
  return { v: Number(v || 0), role, settings, entries: results };
}

async function applyOp(db, role, op) {
  if (!op || typeof op !== 'object') return { error: 'bad' };
  const now = Date.now();
  if (op.op === 'settings') {
    if (role !== 'admin') return { error: 'forbidden' };
    let cur = DEF_SETTINGS; try { cur = cleanSettings(JSON.parse(await kvGet(db, 'settings') || '{}')); } catch (e) { /* default */ }
    await kvSetStmt(db, 'settings', JSON.stringify(cleanSettings({ ...cur, ...op.data }, cur))).run();
    return { ok: true };
  }
  const id = String(op.id || '');
  if (!ID_RE.test(id)) return { error: 'bad' };
  const row = await db.prepare('SELECT * FROM entries WHERE id=?').bind(id).first();
  const mine = row && row.by === 'payer';
  const payerMayChange = row && mine && (row.type === 'miss' || row.status !== 'ok');

  if (op.op === 'add') {
    if (row) return { ok: true, dup: true };           // already saved (resent from an offline queue)
    const type = TYPES.includes(op.type) ? op.type : null;
    if (!type) return { error: 'bad' };
    if (role === 'payer' && type === 'advance') return { error: 'forbidden' };
    if (!isDate(op.date)) return { error: 'date' };
    if (op.date > addDays(vnToday(), 1)) return { error: 'future' };
    const amount = type === 'miss' ? 0 : cleanAmount(op.amount);
    if (amount === null) return { error: 'amount' };
    const status = role === 'admin' || type === 'miss' ? 'ok' : 'pending';
    await db.prepare('INSERT INTO entries (id,type,amount,date,note,status,by,reason,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(id, type, amount, op.date, cleanNote(op.note), status, role, '', now, now).run();
    return { ok: true };
  }
  if (!row) return { error: 'gone' };
  if (op.op === 'edit') {
    if (role === 'payer' && !payerMayChange) return { error: 'locked' };
    const date = op.date === undefined ? row.date : op.date;
    if (!isDate(date)) return { error: 'date' };
    if (role === 'payer' && date > addDays(vnToday(), 1)) return { error: 'future' };
    const amount = row.type === 'miss' ? 0 : op.amount === undefined ? row.amount : cleanAmount(op.amount);
    if (amount === null) return { error: 'amount' };
    const note = op.note === undefined ? row.note : cleanNote(op.note);
    // a payer's edit to a rejected payment sends it back for review
    const status = role === 'payer' && row.type !== 'miss' ? 'pending' : row.status;
    await db.prepare('UPDATE entries SET amount=?, date=?, note=?, status=?, reason=?, updated=? WHERE id=?')
      .bind(amount, date, note, status, role === 'payer' ? '' : row.reason, now, id).run();
    return { ok: true };
  }
  if (op.op === 'del') {
    if (role === 'payer' && !payerMayChange) return { error: 'locked' };
    await db.prepare('DELETE FROM entries WHERE id=?').bind(id).run();
    return { ok: true };
  }
  if (op.op === 'status') {
    if (role !== 'admin') return { error: 'forbidden' };
    if (!STATUSES.includes(op.status)) return { error: 'bad' };
    await db.prepare('UPDATE entries SET status=?, reason=?, updated=? WHERE id=?')
      .bind(op.status, op.status === 'rejected' ? cleanNote(op.reason) : '', now, id).run();
    return { ok: true };
  }
  return { error: 'bad' };
}

function cleanImportRow(x) {
  if (!x || typeof x !== 'object' || !ID_RE.test(String(x.id || ''))) return null;
  const type = TYPES.includes(x.type) ? x.type : null;
  if (!type || !isDate(x.date)) return null;
  const amount = type === 'miss' ? 0 : cleanAmount(x.amount);
  if (amount === null) return null;
  const now = Date.now();
  const n = v => { const t = Math.round(Number(v)); return Number.isFinite(t) && t > 0 && t < 4e12 ? t : now; };
  return {
    id: String(x.id), type, amount, date: x.date, note: cleanNote(x.note),
    status: STATUSES.includes(x.status) ? x.status : 'ok', by: x.by === 'payer' ? 'payer' : 'admin',
    reason: cleanNote(x.reason), created: n(x.created), updated: n(x.updated)
  };
}

/* ---------- routing ---------- */
async function api(request, env, path, ctx) {
  if (!env.DB) return json({ error: 'setup', detail: 'Chưa liên kết cơ sở dữ liệu D1 (DB).' }, 500);
  if (!env.ADMIN_PIN || !/^\d{4,8}$/.test(String(env.ADMIN_PIN).trim())) return json({ error: 'setup', detail: 'Chưa đặt ADMIN_PIN (4–8 chữ số).' }, 500);
  await setup(env.DB);
  const db = env.DB;
  const a = await auth(request, env);
  if (a.deny) return a.deny;
  const role = a.role, m = request.method;

  let body = null;
  if (m === 'POST') {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'size' }, 413);
    if (text) { try { body = JSON.parse(text); } catch (e) { return json({ error: 'json' }, 400); } }
  }

  if (path === 'data' && m === 'GET') {
    const since = Number(new URL(request.url).searchParams.get('v'));
    if (Number.isInteger(since) && since > 0) {
      const v = Number(await kvGet(db, 'ver') || 0);
      if (v === since) return json({ v, role, same: true });
    }
    return json(await snapshot(db, role));
  }
  if (path === 'op' && m === 'POST') {
    const ops = body && Array.isArray(body.ops) ? body.ops.slice(0, 200) : null;
    if (!ops) return json({ error: 'body' }, 400);
    const results = [];
    for (const op of ops) results.push(await applyOp(db, role, op));
    if (results.some(r => r.ok && !r.dup)) await bump(db);
    if (role === 'payer') {
      const added = ops.filter((op, i) => results[i].ok && !results[i].dup && op.op === 'add' && op.type === 'repay');
      if (added.length) { const job = notifyAdmins(env, added).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job; }
    }
    return json({ results, ...(await snapshot(db, role)) });
  }
  if (path.startsWith('push/')) return pushApi(db, role, path.slice(5), m, body, env);
  if (path.startsWith('admin/')) {
    if (role !== 'admin') return json({ error: 'forbidden' }, 403);
    const what = path.slice(6);
    if (what === 'key' && m === 'GET') {
      let key = await kvGet(db, 'payer_key');
      if (!key) { key = newKey(); await kvSetStmt(db, 'payer_key', key).run(); }
      return json({ key });
    }
    if (what === 'key' && m === 'POST') {
      const key = newKey(); await kvSetStmt(db, 'payer_key', key).run();
      return json({ key });
    }
    if (what === 'import' && m === 'POST') {
      const rows = body && Array.isArray(body.entries) ? body.entries.slice(0, 20000).map(cleanImportRow).filter(Boolean) : null;
      if (!rows) return json({ error: 'body' }, 400);
      const replace = body.mode === 'replace';
      const stmts = [];
      if (replace) stmts.push(db.prepare('DELETE FROM entries'));
      const ins = db.prepare(`INSERT INTO entries (id,type,amount,date,note,status,by,reason,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO ${replace ? 'NOTHING' : 'UPDATE SET type=excluded.type, amount=excluded.amount, date=excluded.date, note=excluded.note, status=excluded.status, by=excluded.by, reason=excluded.reason, created=excluded.created, updated=excluded.updated WHERE excluded.updated > entries.updated'}`);
      for (const r of rows) stmts.push(ins.bind(r.id, r.type, r.amount, r.date, r.note, r.status, r.by, r.reason, r.created, r.updated));
      if (body.settings && typeof body.settings === 'object') stmts.push(kvSetStmt(db, 'settings', JSON.stringify(cleanSettings(body.settings))));
      for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
      await bump(db);
      return json({ imported: rows.length, ...(await snapshot(db, role)) });
    }
    if (what === 'erase' && m === 'POST') {
      await db.batch([db.prepare('DELETE FROM entries'), db.prepare("DELETE FROM kv WHERE k='settings'")]);
      await bump(db);
      return json(await snapshot(db, role));
    }
  }
  return json({ error: 'not found' }, 404);
}

async function safeApi(request, env, path, ctx) {
  const spare = request.method === 'POST' ? request.clone() : request;
  try {
    return await api(request, env, path, ctx);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/no such table/i.test(msg)) {           // database was emptied: recreate and try once more
      ready = false;
      try { return await api(spare, env, path, ctx); } catch (e2) { return json({ error: 'server', detail: String(e2 && e2.message || e2).slice(0, 200) }, 500); }
    }
    return json({ error: 'server', detail: msg.slice(0, 200) }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return safeApi(request, env, url.pathname.slice(5).replace(/\/+$/, ''), ctx);
    if (url.pathname === '/' || url.pathname === '/index.html') return Response.redirect(url.origin + HOME + url.search + url.hash, 302);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyReminder(env).catch(e => console.log('reminder failed', e && e.message)));
  }
};

/* =====================================================================
   Phone notifications (Web Push). No outside service or extra secret:
   the signing key is created on first use and kept in the database.
   ===================================================================== */
const PUSH_FROM = 'mailto:tra-no@users.noreply.github.com';
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); return Uint8Array.from(b, c => c.charCodeAt(0)); }
const enc = new TextEncoder();
const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }
async function hkdf(salt, ikm, info, len) { const prk = await hmac(salt, ikm); return (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0, len); }

let VAPID = null;
async function vapid(db) {
  if (VAPID) return VAPID;
  let row = await kvGet(db, 'vapid');
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
    await db.prepare("INSERT INTO kv (k,v) VALUES ('vapid',?) ON CONFLICT(k) DO NOTHING").bind(JSON.stringify({ jwk, pub })).run();
    row = await kvGet(db, 'vapid');
  }
  const { jwk, pub } = JSON.parse(row);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  VAPID = { key, pub };
  return VAPID;
}
async function vapidHeader(db, endpoint) {
  const v = await vapid(db);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_FROM })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
}
/* RFC 8291 message encryption (aes128gcm) */
async function encryptPush(sub, text) {
  const ua = unb64u(sub.p256dh), secret = unb64u(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(secret, shared, cat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, cat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(db, sub, msg, ttl) {
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl || 14400), Urgency: 'high', Authorization: await vapidHeader(db, sub.endpoint) },
      body: await encryptPush(sub, JSON.stringify(msg))
    });
    if (r.status === 404 || r.status === 410) { await db.prepare('DELETE FROM subs WHERE endpoint=?').bind(sub.endpoint).run(); return 'gone'; }
    if (!r.ok) { await db.prepare('UPDATE subs SET fails=fails+1 WHERE endpoint=?').bind(sub.endpoint).run(); return 'http ' + r.status; }
    if (sub.fails) await db.prepare('UPDATE subs SET fails=0 WHERE endpoint=?').bind(sub.endpoint).run();
    return 'ok';
  } catch (e) { return 'error ' + (e && e.message); }
}
async function pushTo(db, role, msg, ttl) {
  const { results } = await db.prepare('SELECT * FROM subs WHERE role=? AND fails < 20').bind(role).all();
  return Promise.all(results.map(s => sendPush(db, s, msg, ttl)));
}
async function getSettings(db) { try { return cleanSettings(JSON.parse(await kvGet(db, 'settings') || '{}')); } catch (e) { return DEF_SETTINGS; } }
const vnd = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);

async function notifyAdmins(env, added) {
  const db = env.DB, st = await getSettings(db);
  const total = added.reduce((n, op) => n + (cleanAmount(op.amount) || 0), 0);
  const body = added.length === 1 ? `${capFirst(st.payer)} vừa gửi ${vnd(total)} · chờ ${st.admin} xác nhận` : `${capFirst(st.payer)} vừa gửi ${added.length} khoản · ${vnd(total)} · chờ ${st.admin} xác nhận`;
  return pushTo(db, 'admin', { title: '💰 Có khoản trả mới', body, tag: 'pending' }, 86400);
}
async function dailyReminder(env, today) {
  const db = env.DB;
  await setup(db);
  const st = await getSettings(db);
  today = today || vnToday();
  const { results } = await db.prepare("SELECT date, type, SUM(amount) AS amt FROM entries WHERE status != 'rejected' AND date >= ? GROUP BY date, type").bind(addDays(today, -400)).all();
  const paid = {}, missed = {};
  for (const r of results) { if (r.type === 'repay') paid[r.date] = r.amt; if (r.type === 'miss') missed[r.date] = 1; }
  let msg;
  if (paid[today]) {
    let streak = 0; for (let d = today; paid[d]; d = addDays(d, -1)) streak++;
    msg = { title: 'Hôm nay xong rồi 🎉', body: `Cảm ơn anh! Hôm nay đã gửi ${vnd(paid[today])}` + (streak > 1 ? ` · chuỗi ${streak} ngày 🔥` : ''), tag: 'daily' };
  } else if (missed[today]) {
    return { skipped: 'miss note today' };
  } else {
    msg = { title: 'Trả dần mỗi ngày', body: `Một ngày nỗ lực tuyệt vời, đừng quên ck cho ${st.admin} nha 💪`, tag: 'daily' };
  }
  return { msg, sent: await pushTo(db, 'payer', msg, 4 * 3600) };
}
async function pushApi(db, role, what, m, body, env) {
  const EP = env && env.PUSH_DEV === '1' ? /^https?:\/\/[^\s]{10,900}$/ : /^https:\/\/[^\s]{10,900}$/;   // PUSH_DEV only for local tests
  if (what === 'key' && m === 'GET') return json({ key: (await vapid(db)).pub });
  if (what === 'sub' && m === 'POST') {
    const s = body && body.sub, k = s && s.keys;
    if (!s || typeof s.endpoint !== 'string' || !EP.test(s.endpoint) || !k || !/^[A-Za-z0-9_-]{80,100}$/.test(k.p256dh || '') || !/^[A-Za-z0-9_-]{16,30}$/.test(k.auth || ''))
      return json({ error: 'sub' }, 400);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM subs').first();
    if (n && n.n >= 30) await db.prepare('DELETE FROM subs WHERE endpoint IN (SELECT endpoint FROM subs ORDER BY created LIMIT 1)').run();
    await db.prepare('INSERT INTO subs (endpoint, role, p256dh, auth, created) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET role=excluded.role, p256dh=excluded.p256dh, auth=excluded.auth, fails=0')
      .bind(s.endpoint, role, k.p256dh, k.auth, Date.now()).run();
    return json({ ok: true });
  }
  if (what === 'unsub' && m === 'POST') {
    if (body && typeof body.endpoint === 'string') await db.prepare('DELETE FROM subs WHERE endpoint=?').bind(body.endpoint).run();
    return json({ ok: true });
  }
  if (what === 'test' && m === 'POST') {
    const ep = body && body.endpoint;
    const s = typeof ep === 'string' && await db.prepare('SELECT * FROM subs WHERE endpoint=?').bind(ep).first();
    if (!s) return json({ error: 'nosub' }, 404);
    const msg = role === 'payer'
      ? { title: 'Trả dần mỗi ngày', body: 'Đã bật nhắc nhở ✓ Mỗi ngày lúc 18:00 sẽ có lời nhắc ở đây.', tag: 'test' }
      : { title: 'Trả dần mỗi ngày', body: 'Đã bật thông báo ✓ Sẽ báo ngay khi có khoản trả mới.', tag: 'test' };
    return json({ result: await sendPush(db, s, msg, 600) });
  }
  if (what === 'remind' && m === 'POST' && role === 'admin') return json(await dailyReminder({ DB: db }, body && body.today));
  return json({ error: 'not found' }, 404);
}
