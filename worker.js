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
    db.prepare('CREATE TABLE IF NOT EXISTS guard (k TEXT PRIMARY KEY, fails INTEGER NOT NULL, since INTEGER NOT NULL, until INTEGER NOT NULL)')
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
async function api(request, env, path) {
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
    return json({ results, ...(await snapshot(db, role)) });
  }
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

async function safeApi(request, env, path) {
  const spare = request.method === 'POST' ? request.clone() : request;
  try {
    return await api(request, env, path);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/no such table/i.test(msg)) {           // database was emptied: recreate and try once more
      ready = false;
      try { return await api(spare, env, path); } catch (e2) { return json({ error: 'server', detail: String(e2 && e2.message || e2).slice(0, 200) }, 500); }
    }
    return json({ error: 'server', detail: msg.slice(0, 200) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return safeApi(request, env, url.pathname.slice(5).replace(/\/+$/, ''));
    if (url.pathname === '/' || url.pathname === '/index.html') return Response.redirect(url.origin + HOME + url.search + url.hash, 302);
    return env.ASSETS.fetch(request);
  }
};
