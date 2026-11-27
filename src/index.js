import PAGE from './page.html';

const db = (env) => env.stagingconnect;

const BASES = ['https://mempool.space', 'https://mempool.emzy.de', 'https://mempool.bitmixlist.org'];
const UA = 'mempool.my.id/1.0';
const STALE_SEC = 120;
const HISTORY_KEEP_SEC = 2 * 86400;
const RATES_TTL = 600;

const ASSET_TABLE = 'siteasset';
const MINER_TABLE = 'miner';
const ASSET_AGE = 604800;
const SITE_DEFAULT = 'mempool.my.id';
const siteName = (env) => {
  const v = String((env && env.SITE_NAME) || '').trim();
  return !v || /blo(c|k)k?lab/i.test(v) ? SITE_DEFAULT : v;
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const JSON_HEADERS = { ...CORS, ...SEC, 'Content-Type': 'application/json; charset=utf-8' };

const json = (data, status, extra) =>
  new Response(JSON.stringify(data), { status: status || 200, headers: { ...JSON_HEADERS, ...(extra || {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) return await res.json();
  } catch (e) {}
  return null;
}

const MIRROR_STAGGER_MS = 900;

function raceBases(path, check) {
  return new Promise((resolve) => {
    let left = BASES.length, done = false;
    const ctrls = [];
    const finish = (v) => {
      if (done) return;
      done = true;
      ctrls.forEach((c) => { try { c.abort(); } catch (e) {} });
      resolve(v);
    };
    BASES.forEach(async (b, i) => {
      let out = null, timer;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      try {
        if (i > 0) await sleep(i * MIRROR_STAGGER_MS);
        if (done) return;
        timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(b + path, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain' }, signal: ctrl.signal });
        if (res.status === 404 || res.status === 400) { finish({ status: res.status }); return; }
        if (res.ok) {
          const body = await res.text();
          if (!check || check(body)) out = { status: 200, body, source: b.replace('https://', '') };
        }
      } catch (e) {
      } finally {
        clearTimeout(timer);
      }
      if (done) return;
      if (out) { finish(out); return; }
      if (--left === 0) finish(null);
    });
  });
}

const isJson = (b) => { try { JSON.parse(b); return true; } catch (e) { return false; } };

async function upJson(path, check) {
  const r = await raceBases(path, (b) => {
    if (!isJson(b)) return false;
    return !check || check(JSON.parse(b));
  });
  return r && r.status === 200 ? { data: JSON.parse(r.body), source: r.source } : null;
}

const ADDR = '(?:bc1[ac-hj-np-z02-9]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})';
const HEX64 = '[a-fA-F0-9]{64}';
const ROUTES = [
  { re: /^\/mempool$/, ttl: 15 },
  { re: /^\/mempool\/recent$/, ttl: 10 },
  { re: /^\/v1\/fees\/mempool-blocks$/, ttl: 15 },
  { re: /^\/v1\/replacements$/, ttl: 15 },
  { re: /^\/v1\/statistics\/2h$/, ttl: 20 },
  { re: /^\/v1\/blocks$/, ttl: 15 },
  { re: /^\/v1\/blocks\/\d{1,7}$/, ttl: 600 },
  { re: new RegExp('^/v1/block/' + HEX64 + '$'), ttl: 3600 },
  { re: new RegExp('^/block/' + HEX64 + '/txs(?:/\\d{1,5})?$'), ttl: 3600 },
  { re: /^\/v1\/difficulty-adjustment$/, ttl: 60 },
  { re: /^\/v1\/mining\/reward-stats\/144$/, ttl: 120 },
  { re: /^\/v1\/mining\/pools\/1w$/, ttl: 300 },
  { re: /^\/v1\/mining\/hashrate\/pools\/1w$/, ttl: 900 },
  { re: /^\/v1\/mining\/hashrate\/3m$/, ttl: 900 },
  { re: /^\/v1\/mining\/blocks\/fees\/1m$/, ttl: 600 },
  { re: /^\/v1\/mining\/blocks\/rewards\/1m$/, ttl: 600 },
  { re: /^\/v1\/mining\/blocks\/fee-rates\/1m$/, ttl: 900 },
  { re: /^\/v1\/mining\/blocks\/sizes-weights\/1m$/, ttl: 900 },
  { re: /^\/v1\/lightning\/statistics\/3m$/, ttl: 900 },
  { re: /^\/v1\/lightning\/statistics\/latest$/, ttl: 600 },
  { re: /^\/v1\/lightning\/nodes\/isp-ranking$/, ttl: 1800 },
  { re: /^\/v1\/lightning\/nodes\/countries$/, ttl: 1800 },
  { re: new RegExp('^/address/' + ADDR + '$'), lookup: true },
  { re: new RegExp('^/address/' + ADDR + '/txs$'), lookup: true },
  { re: new RegExp('^/tx/' + HEX64 + '$'), lookup: true },
  { re: new RegExp('^/block/' + HEX64 + '$'), lookup: true },
  { re: /^\/block-height\/\d{1,7}$/, lookup: true, text: true },
];

const lookupHits = new Map();
function lookupLimited(ip) {
  const now = Date.now();
  const arr = (lookupHits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 30) { lookupHits.set(ip, arr); return true; }
  arr.push(now);
  lookupHits.set(ip, arr);
  if (lookupHits.size > 500) lookupHits.clear();
  return false;
}

const inflight = new Set();
const staleWindow = (ttl) => ttl * 10 + 120;

function served(hit, maxAge, tag) {
  const h = new Headers(hit.headers);
  h.set('Cache-Control', 'public, max-age=' + maxAge);
  h.set('X-Cache', tag);
  return new Response(hit.body, { status: hit.status, headers: h });
}

async function swr(ctx, key, ttl, produce) {
  const cache = caches.default;
  const keep = staleWindow(ttl);
  const store = (res) => {
    const h = new Headers(res.headers);
    h.set('Cache-Control', 'public, max-age=' + keep);
    h.set('X-Cached-At', String(Date.now()));
    return cache.put(key, new Response(res.body, { status: 200, headers: h }));
  };
  const hit = await cache.match(key);
  if (hit) {
    const age = (Date.now() - (Number(hit.headers.get('X-Cached-At')) || 0)) / 1000;
    if (age <= ttl) return served(hit, Math.max(1, Math.ceil(ttl - age)), 'HIT');
    if (age <= keep) {
      if (!inflight.has(key.url)) {
        inflight.add(key.url);
        ctx.waitUntil((async () => {
          try { const r = await produce(); if (r && r.status === 200) await store(r); }
          catch (e) {}
          finally { inflight.delete(key.url); }
        })());
      }
      return served(hit, 5, 'STALE');
    }
  }
  const res = await produce();
  if (res.status === 200) ctx.waitUntil(store(res.clone()));
  return res;
}

async function handleProxy(request, ctx, url) {
  const path = url.pathname.slice('/api/m'.length);
  const rule = ROUTES.find((r) => r.re.test(path));
  if (!rule) return json({ error: 'not_found' }, 404);

  if (rule.lookup) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (lookupLimited(ip)) return json({ error: 'rate_limited' }, 429, { 'Cache-Control': 'no-store' });
  }

  const produce = async () => {
    const r = await raceBases('/api' + path, rule.text ? null : isJson);
    if (r && r.status === 404) return json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' });
    if (!r || r.status !== 200) return json({ error: 'upstream_unavailable' }, 502, { 'Cache-Control': 'no-store' });
    return new Response(r.body, {
      status: 200,
      headers: {
        ...CORS, ...SEC,
        'Content-Type': rule.text ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': rule.ttl ? 'public, max-age=' + rule.ttl : 'no-store',
        'X-Data-Source': r.source,
      },
    });
  };

  if (!rule.ttl) return produce();
  return swr(ctx, new Request(url.origin + '/api/m' + path), rule.ttl, produce);
}

async function fetchFees() {
  const c = (x) => Math.max(0.1, Math.round(Number(x) * 100) / 100);
  const ok = (d) => d && d.fastestFee != null && d.hourFee != null;
  const m = (await upJson('/api/v1/fees/precise', ok)) || (await upJson('/api/v1/fees/recommended', ok));
  if (m) {
    const d = m.data;
    return { fastestFee: c(d.fastestFee), halfHourFee: c(d.halfHourFee), hourFee: c(d.hourFee), economyFee: c(d.economyFee), minimumFee: c(d.minimumFee) };
  }
  const e = await getJson('https://blockstream.info/api/fee-estimates');
  if (e) {
    const fee = (k) => c(e[String(k)] ?? e['1008'] ?? 1);
    return { fastestFee: fee(1), halfHourFee: fee(3), hourFee: fee(6), economyFee: fee(144), minimumFee: fee(1008) };
  }
  return null;
}

async function fetchPrice() {
  const m = await upJson('/api/v1/prices', (d) => d && typeof d.USD === 'number');
  if (m) return m.data.USD;
  const g = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
  return g && g.bitcoin && typeof g.bitcoin.usd === 'number' ? g.bitcoin.usd : null;
}

const SELECT_FEES = 'SELECT fastest, half_hour, hour, economy, minimum, btc_usd, updated_at FROM fees WHERE id = 1';
const UPSERT_FEES =
  'INSERT INTO fees (id, fastest, half_hour, hour, economy, minimum, btc_usd, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET fastest = excluded.fastest, half_hour = excluded.half_hour, hour = excluded.hour, ' +
  'economy = excluded.economy, minimum = excluded.minimum, btc_usd = COALESCE(excluded.btc_usd, fees.btc_usd), updated_at = excluded.updated_at';

async function refreshFees(env) {
  const [fees, price] = await Promise.all([fetchFees(), fetchPrice()]);
  if (!fees) return null;
  const now = Math.floor(Date.now() / 1000);
  try {
    await db(env).prepare(UPSERT_FEES).bind(fees.fastestFee, fees.halfHourFee, fees.hourFee, fees.economyFee, fees.minimumFee, price, now).run();
    await db(env).prepare(
      'INSERT INTO fee_history (fastest, half_hour, hour, economy, minimum, btc_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(fees.fastestFee, fees.halfHourFee, fees.hourFee, fees.economyFee, fees.minimumFee, price, now).run();
  } catch (e) { console.error('simpan fee gagal:', e && e.message); }
  return { fees, price, updatedAt: now };
}

function snapToPayload(r) {
  return {
    fees: { fastestFee: r.fastest, halfHourFee: r.half_hour, hourFee: r.hour, economyFee: r.economy, minimumFee: r.minimum },
    price: r.btc_usd == null ? null : r.btc_usd,
    updatedAt: r.updated_at,
  };
}

async function getFeeData(env) {
  let snap = null;
  try { snap = await db(env).prepare(SELECT_FEES).first(); } catch (e) { console.error('baca fee gagal:', e && e.message); }
  const now = Math.floor(Date.now() / 1000);
  if (snap && now - snap.updated_at <= STALE_SEC) return snapToPayload(snap);
  const fresh = await refreshFees(env);
  if (fresh) {
    if (fresh.price == null && snap) fresh.price = snap.btc_usd;
    return fresh;
  }
  return snap ? snapToPayload(snap) : null;
}

async function handleAll(request, env, ctx, url) {
  return swr(ctx, new Request(url.origin + '/api/all'), 15, async () => {
    const data = await getFeeData(env);
    if (!data) return json({ error: 'upstream_unavailable' }, 502, { 'Cache-Control': 'no-store' });
    return json(data, 200, { 'Cache-Control': 'public, max-age=15' });
  });
}

async function handleHistory(request, env, ctx, url) {
  return swr(ctx, new Request(url.origin + '/api/history'), 600, async () => {
    const since = Math.floor(Date.now() / 1000) - 86400;
    let rows = [];
    try {
      const r = await db(env).prepare(
        'SELECT (created_at / 600) * 600 AS t, AVG(fastest) AS high, AVG(half_hour) AS medium, AVG(hour) AS low, AVG(economy) AS none ' +
        'FROM fee_history WHERE created_at >= ? GROUP BY created_at / 600 ORDER BY t'
      ).bind(since).all();
      rows = (r.results || []).map((x) => ({
        t: x.t, high: Math.round(x.high * 100) / 100, medium: Math.round(x.medium * 100) / 100,
        low: Math.round(x.low * 100) / 100, none: Math.round(x.none * 100) / 100,
      }));
    } catch (e) { console.error('riwayat gagal:', e && e.message); }
    return json({ rows }, 200, { 'Cache-Control': 'public, max-age=600' });
  });
}

async function pruneHistory(env, now) {
  try { await db(env).prepare('DELETE FROM fee_history WHERE created_at < ?').bind(now - HISTORY_KEEP_SEC).run(); } catch (e) {}
}

const RATE_CUR = ['usd', 'idr', 'eur', 'gbp', 'jpy', 'aud', 'cad', 'chf', 'sgd', 'myr', 'thb', 'php', 'vnd', 'inr', 'cny', 'hkd', 'krw', 'twd', 'aed', 'sar', 'try', 'brl', 'mxn', 'rub', 'nzd', 'zar', 'sek', 'nok', 'pln'];

async function getFx() {
  const a = await getJson('https://open.er-api.com/v6/latest/USD');
  if (a && a.rates && typeof a.rates.IDR === 'number') return { fx: a.rates, src: 'open.er-api.com' };
  const b = await getJson('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
  if (b && b.usd && typeof b.usd.idr === 'number') {
    const o = {};
    for (const k in b.usd) o[k.toUpperCase()] = b.usd[k];
    return { fx: o, src: 'currency-api' };
  }
  return null;
}

async function buildRates() {
  const [cbx, cg, ix, mp, fxo] = await Promise.all([
    getJson('https://api.coinbase.com/v2/exchange-rates?currency=BTC'),
    getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=' + RATE_CUR.join(',')),
    getJson('https://indodax.com/api/ticker/btcidr'),
    upJson('/api/v1/prices', (d) => d && typeof d.USD === 'number'),
    getFx(),
  ]);
  const rates = {}, by = {};
  const put = (c, v, s) => { const n = Number(v); if (rates[c] == null && isFinite(n) && n > 0) { rates[c] = n; by[c] = s; } };
  const cb = cbx && cbx.data && cbx.data.rates;
  if (cb) RATE_CUR.forEach((c) => put(c, cb[c.toUpperCase()], 'coinbase'));
  if (cg && cg.bitcoin) RATE_CUR.forEach((c) => put(c, cg.bitcoin[c], 'coingecko'));
  if (ix && ix.ticker) put('idr', ix.ticker.last, 'indodax');
  if (mp) RATE_CUR.forEach((c) => put(c, mp.data[c.toUpperCase()], 'mempool.space'));
  if (rates.usd != null && fxo) RATE_CUR.forEach((c) => { const x = fxo.fx[c.toUpperCase()]; if (typeof x === 'number') put(c, rates.usd * x, fxo.src); });
  if (!Object.keys(rates).length) return null;
  return { rates, by, source: Array.from(new Set(Object.values(by))).join(' + ') };
}

async function refreshRates(env) {
  const o = await buildRates();
  if (!o) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = { rates: o.rates, by: o.by, source: o.source, updatedAt: now };
  try {
    await db(env).prepare(
      'INSERT INTO rates_cache (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at'
    ).bind(JSON.stringify(payload), now).run();
  } catch (e) { console.error('simpan kurs gagal:', e && e.message); }
  return payload;
}

const jparse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };

async function handleRates(request, env, ctx, url) {
  return swr(ctx, new Request(url.origin + '/api/rates'), 60, async () => {
    let row = null;
    try { row = await db(env).prepare('SELECT payload, updated_at FROM rates_cache WHERE id = 1').first(); } catch (e) {}
    const now = Math.floor(Date.now() / 1000);
    let payload = row && now - row.updated_at <= RATES_TTL ? jparse(row.payload, null) : null;
    if (!payload) payload = await refreshRates(env);
    if (!payload && row) payload = jparse(row.payload, null);
    if (!payload) return json({ error: 'rates_unavailable' }, 502, { 'Cache-Control': 'no-store' });
    return json(payload, 200, { 'Cache-Control': 'public, max-age=60' });
  });
}

const memAsset = new Map();
const tblMemo = {};

async function tableName(env, kind, def) {
  if (tblMemo[kind]) return tblMemo[kind];
  let pick = def;
  try {
    const r = await db(env).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const names = (r.results || []).map((x) => x.name);
    const re = kind === 'miner' ? /miner/i : /asset/i;
    pick = names.find((n) => n === def) || names.find((n) => re.test(n)) || def;
  } catch (e) {}
  tblMemo[kind] = '"' + String(pick).replace(/"/g, '""') + '"';
  return tblMemo[kind];
}

function b64bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const LOGO_RETRY = 86400;
const LOGO_MAX = 300000;
const logoMiss = new Map();
const logoJobs = new Map();
const knownPools = { t: 0, set: null };

async function poolKnown(slug) {
  if (!knownPools.set || Date.now() - knownPools.t > 3600000) {
    const r = await upJson('/api/v1/mining/pools/1w', (d) => d && Array.isArray(d.pools));
    if (r) { knownPools.set = new Set(r.data.pools.map((p) => String(p.slug))); knownPools.t = Date.now(); }
  }
  return !!knownPools.set && knownPools.set.has(slug);
}

const validSvg = (t) => t.length > 40 && t.length <= LOGO_MAX && /<svg[\s>]/i.test(t) && !/<script|<foreignObject|\son[a-z]+\s*=|<!doctype html/i.test(t);

async function fetchMinerLogo(env, slug) {
  if (logoJobs.has(slug)) return logoJobs.get(slug);
  const job = (async () => {
    const miss = logoMiss.get(slug);
    if (miss && Date.now() - miss < 3600000) return null;
    const tbl = await tableName(env, 'miner', MINER_TABLE);
    const now = Math.floor(Date.now() / 1000);
    try {
      const tr = await db(env).prepare('SELECT tried_at FROM ' + tbl + ' WHERE slug = ?').bind(slug).first();
      if (tr && tr.tried_at && now - Number(tr.tried_at) < LOGO_RETRY) { logoMiss.set(slug, Date.now()); return null; }
    } catch (e) {}
    if (!(await poolKnown(slug))) return null;
    let svg = null, src = '';
    for (const b of BASES.slice(0, 2)) {
      try {
        const u = b + '/resources/mining-pools/' + slug + '.svg';
        const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'image/svg+xml' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const t = await res.text();
        if (validSvg(t)) { svg = t; src = u; break; }
      } catch (e) {}
    }
    try {
      const del = db(env).prepare('DELETE FROM ' + tbl + ' WHERE slug = ?').bind(slug);
      const ins = db(env).prepare('INSERT INTO ' + tbl + ' (slug, logo, mime, url, tried_at) VALUES (?, ?, ?, ?, ?)')
        .bind(slug, svg ? btoa(unescape(encodeURIComponent(svg))) : '', svg ? 'image/svg+xml' : '', src, now);
      await db(env).batch([del, ins]);
    } catch (e) { console.error('simpan logo miner gagal:', e && e.message); }
    if (!svg) { logoMiss.set(slug, Date.now()); return null; }
    return { t: Date.now(), body: new TextEncoder().encode(svg), mime: 'image/svg+xml' };
  })();
  logoJobs.set(slug, job);
  try { return await job; } finally { logoJobs.delete(slug); }
}

async function loadAsset(env, kind, name) {
  const key = kind + ':' + name;
  const hit = memAsset.get(key);
  if (hit && Date.now() - hit.t < 3600000) return hit;
  let row = null;
  try {
    row = kind === 'miner'
      ? await db(env).prepare('SELECT logo AS d, mime FROM ' + (await tableName(env, 'miner', MINER_TABLE)) + " WHERE slug = ? AND logo IS NOT NULL AND logo != ''").bind(name).first()
      : await db(env).prepare('SELECT data AS d, mime FROM ' + (await tableName(env, 'site', ASSET_TABLE)) + ' WHERE "key" = ?').bind(name).first();
  } catch (e) { console.error('baca aset gagal:', e && e.message); return { error: true }; }
  if (!row || !row.d) {
    if (kind !== 'miner') return null;
    const got = await fetchMinerLogo(env, name);
    if (!got) return null;
    if (memAsset.size > 40) memAsset.clear();
    memAsset.set(key, got);
    return got;
  }
  let body;
  try { body = b64bytes(String(row.d).replace(/\s+/g, '')); } catch (e) { return { error: true }; }
  const mime = /^image\/[a-z0-9.+-]+$/i.test(row.mime || '') ? row.mime : 'application/octet-stream';
  const o = { t: Date.now(), body, mime };
  if (memAsset.size > 40) memAsset.clear();
  memAsset.set(key, o);
  return o;
}

async function handleAsset(request, env, ctx, url) {
  const m = /^\/asset\/(?:(logo|favicon)|miner\/([a-z0-9-]{1,40}))$/.exec(url.pathname);
  if (!m) return json({ error: 'not_found' }, 404);
  const cache = caches.default;
  const ckey = new Request(url.origin + url.pathname);
  const hit = await cache.match(ckey);
  if (hit) return hit;
  const a = await loadAsset(env, m[1] ? 'site' : 'miner', m[1] || m[2]);
  if (a && a.error) return new Response('db error', { status: 500, headers: { ...SEC, 'Cache-Control': 'no-store' } });
  if (!a) return new Response('not found', { status: 404, headers: { ...SEC, 'Cache-Control': 'public, max-age=300' } });
  const res = new Response(a.body, {
    status: 200,
    headers: {
      ...SEC,
      'Content-Type': a.mime,
      'Cache-Control': 'public, max-age=' + ASSET_AGE,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
  ctx.waitUntil(cache.put(ckey, res.clone()));
  return res;
}

async function handleMiners(request, env, ctx, url) {
  return swr(ctx, new Request(url.origin + '/api/miners'), 1800, async () => {
    let slugs = [];
    try {
      const r = await db(env).prepare('SELECT slug FROM ' + (await tableName(env, 'miner', MINER_TABLE)) + " WHERE logo IS NOT NULL AND logo != ''").all();
      slugs = (r.results || []).map((x) => x.slug);
    } catch (e) { console.error('daftar miner gagal:', e && e.message); }
    return json({ slugs }, 200, { 'Cache-Control': 'public, max-age=1800' });
  });
}

const contactHits = new Map();
function contactLimited(ip) {
  const now = Date.now();
  const arr = (contactHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (arr.length >= 3) { contactHits.set(ip, arr); return true; }
  arr.push(now);
  contactHits.set(ip, arr);
  if (contactHits.size > 500) contactHits.clear();
  return false;
}

async function verifyTurnstile(token, ip, secret) {
  if (!token) return false;
  try {
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', token);
    if (ip && ip !== 'unknown') form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return !!(data && data.success === true);
  } catch (e) { return false; }
}

async function handleContact(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'forbidden' }, 403);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
  if (body && body.website) return json({ ok: true });

  const name = String((body && body.name) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  const email = String((body && body.email) || '').trim().slice(0, 200);
  const message = String((body && body.message) || '').trim().slice(0, 2000);
  const token = String((body && body.token) || '');
  if (!name || message.length < 5 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid_input' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (contactLimited(ip)) return json({ error: 'rate_limited' }, 429);

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.TURNSTILE_SECRET) {
    console.error('Konfigurasi belum lengkap (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / TURNSTILE_SECRET)');
    return json({ error: 'not_configured' }, 500);
  }
  if (!(await verifyTurnstile(token, ip, env.TURNSTILE_SECRET))) return json({ error: 'captcha_failed' }, 400);

  const site = siteName(env);
  const text = 'Pesan baru dari ' + site + '\n\nNama : ' + name + '\nEmail: ' + email + '\n\n' + message;
  try {
    const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { console.error('Telegram gagal:', res.status, data && data.description); return json({ error: 'send_failed' }, 502); }
  } catch (e) {
    console.error('Telegram error:', e && e.message);
    return json({ error: 'send_failed' }, 502);
  }
  return json({ ok: true });
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function hostOf(v) {
  let s = String(v || '').trim().toLowerCase();
  if (s.indexOf('https://') === 0) s = s.slice(8); else if (s.indexOf('http://') === 0) s = s.slice(7);
  const i = s.indexOf('/');
  return i >= 0 ? s.slice(0, i) : s;
}

async function bootData(env) {
  try {
    const snap = await Promise.race([db(env).prepare(SELECT_FEES).first(), sleep(400).then(() => null)]);
    if (snap && Math.floor(Date.now() / 1000) - snap.updated_at <= 180) return snapToPayload(snap);
  } catch (e) {}
  return null;
}

function pageResponse(env, boot) {
  const nonce = btoa(String.fromCharCode.apply(null, crypto.getRandomValues(new Uint8Array(16))));
  const name = siteName(env);
  const repo = /^https:\/\/[^\s"'<>]+$/.test(String(env.REPO_URL || '')) ? String(env.REPO_URL) : '';
  const key = String(env.TURNSTILE_SITEKEY || '').replace(/[^A-Za-z0-9_-]/g, '');
  const html = PAGE
    .split('__NONCE__').join(nonce)
    .split('__BOOT__').join(JSON.stringify(boot || null).replace(/</g, '\\u003c'))
    .split('__SITE_NAME__').join(escAttr(name))
    .split('__SITEKEY__').join(key)
    .split('__REPO_LINK__').join(repo ? '<a href="' + escAttr(repo) + '" target="_blank" rel="noopener noreferrer">GitHub</a>' : '');
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'nonce-" + nonce + "' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    'frame-src https://challenges.cloudflare.com',
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': csp,
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Frame-Options': 'DENY',
      ...SEC,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cust = hostOf(env.CUSTDOMAIN), def = hostOf(env.DEFDOMAIN);
    if (cust && def && cust !== def && url.hostname.toLowerCase() === def) {
      return Response.redirect('https://' + cust + url.pathname + url.search, request.method === 'GET' || request.method === 'HEAD' ? 301 : 308);
    }

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\nDisallow: /api/\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
    }

    if (url.pathname.indexOf('/asset/') === 0 && (request.method === 'GET' || request.method === 'HEAD')) return handleAsset(request, env, ctx, url);
    if (url.pathname === '/api/contact') return handleContact(request, env, url);

    if (url.pathname.indexOf('/api/') === 0) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405);
      if (url.pathname.indexOf('/api/m/') === 0) return handleProxy(request, ctx, url);
      if (url.pathname === '/api/all') return handleAll(request, env, ctx, url);
      if (url.pathname === '/api/history') return handleHistory(request, env, ctx, url);
      if (url.pathname === '/api/rates') return handleRates(request, env, ctx, url);
      if (url.pathname === '/api/miners') return handleMiners(request, env, ctx, url);
      return json({ error: 'not_found' }, 404);
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') return pageResponse(env, await bootData(env));
    return json({ error: 'not_found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const min = new Date(event.scheduledTime).getUTCMinutes();
      await refreshFees(env);
      if (min % 5 === 0) await refreshRates(env);
      if (min === 0) await pruneHistory(env, Math.floor(Date.now() / 1000));
    })());
  },
};
