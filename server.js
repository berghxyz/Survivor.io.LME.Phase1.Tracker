// Zero-dependency web server for the LME Phase 1 tracker.
//
//   node server.js            ->  http://127.0.0.1:8787
//
// Static pages come from public/, scores live in data/birds.db (node:sqlite),
// uploaded screenshots are kept under data/uploads/phase1/<week>/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './lib/db.js';
import { currentWeekKey, isWeekKey, weekLabel } from './lib/week.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 25 * 1024 * 1024; // screenshots are a couple of MB each

const store = createStore({ root: ROOT });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? MIME['.json'] : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const sendJson = (res, status, object) => send(res, status, object, { 'Content-Type': MIME['.json'] });

function notFound(res, what = 'Not found') {
  sendJson(res, 404, { error: `${what}. Check the address or see GET /api.` });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error(`Request larger than ${MAX_BODY / 1048576} MB.`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body must be valid JSON.'), { status: 400 });
  }
}

function requireWeek(paramValue) {
  const week = decodeURIComponent(paramValue);
  if (!isWeekKey(week)) {
    throw Object.assign(new Error(`"${week}" is not a week key. Use the form 2026-W44.`), { status: 400 });
  }
  return week;
}

// ---------------------------------------------------------------- API routes

function apiWeeks(res, url) {
  const weeks = store.weeksWithScores().map((w) => ({
    ...w,
    label: weekLabel(w.week),
    is_current: w.week === currentWeekKey(),
  }));
  const current = currentWeekKey();
  return sendJson(res, 200, {
    current: { week: current, label: weekLabel(current), has_data: store.weekExists(current) },
    weeks,
    glory_count: store.gloryCount(),
  });
}

function apiWeekDetail(res, week) {
  if (!store.weekExists(week)) {
    return sendJson(res, 404, { error: `No scores recorded for ${weekLabel(week)} yet.`, week });
  }
  const stats = store.weekStats(week);
  return sendJson(res, 200, { ...stats, uploads: store.listUploads(week) });
}

async function apiSaveScores(res, week, req) {
  const body = await readJson(req);
  const result = store.saveScores(week, body.rows ?? []);
  if (result.error) return sendJson(res, 400, result);
  return sendJson(res, 200, { ...result, stats: store.weekStats(week) });
}

/**
 * Screenshot upload. The raw image bytes are the body and the original name
 * travels in the query string, which keeps the browser side to one fetch()
 * call and saves us a multipart parser.
 */
async function apiUploadScreenshot(res, week, req, url) {
  const raw = await readBody(req);
  if (!raw.length) return sendJson(res, 400, { error: 'Empty upload.' });

  const requested = String(url.searchParams.get('name') || 'screenshot.png');
  const safe = path.basename(requested).replace(/[^\w.\-()\p{L} ]+/gu, '_').slice(0, 120) || 'screenshot.png';
  const ext = path.extname(safe).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
    return sendJson(res, 400, { error: 'Only .png and .jpg screenshots are accepted.' });
  }

  const dir = path.join(store.uploadDir, week);
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, safe);
  if (fs.existsSync(target)) {
    target = path.join(dir, `${path.basename(safe, ext)}-${Date.now()}${ext}`);
  }
  fs.writeFileSync(target, raw);

  const relative = path.relative(store.dataDir, target).split(path.sep).join('/');
  const saved = store.addUpload(week, safe, relative, Number(url.searchParams.get('rows') || 0));
  return sendJson(res, 201, {
    id: saved.id,
    filename: saved.filename,
    url: `/uploads/${relative}`,
    bytes: raw.length,
  });
}

function apiPlayers(res) {
  return sendJson(res, 200, { roles: store.roles, glory_count: store.gloryCount(), players: store.listPlayers() });
}

async function apiAddPlayer(res, req) {
  const { name, role } = await readJson(req);
  const result = store.addPlayer(name, role ?? 'member');
  if (result.error) return sendJson(res, result.player ? 409 : 400, result);
  return sendJson(res, 201, result);
}

async function apiUpdatePlayer(res, id, req) {
  const { name, role } = await readJson(req);
  const result = store.updatePlayer(Number(id), { name, role });
  if (result.error) return sendJson(res, 400, result);
  return sendJson(res, 200, result);
}

async function apiMergePlayers(res, id, req) {
  const { into } = await readJson(req);
  const result = store.mergePlayers(Number(id), Number(into));
  if (result.error) return sendJson(res, 400, result);
  return sendJson(res, 200, result);
}

function apiDeletePlayer(res, id) {
  const result = store.deletePlayer(Number(id));
  if (result.error) return sendJson(res, 404, result);
  return sendJson(res, 200, result);
}

async function apiSuggest(res, req) {
  const { names } = await readJson(req);
  if (!Array.isArray(names)) return sendJson(res, 400, { error: 'Expected { names: ["..."] }.' });
  return sendJson(res, 200, { suggestions: store.suggestPlayers(names.map((name) => ({ name }))) });
}

async function apiGlory(res, week, req) {
  const { count } = await readJson(req);
  const result = store.applyGlory(week, count ?? store.gloryCount());
  if (result.error) return sendJson(res, 400, result);
  return sendJson(res, 200, { ...result, stats: store.weekStats(week) });
}

function apiSettings(res) {
  return sendJson(res, 200, { glory_count: store.gloryCount(), roles: store.roles });
}

// ----------------------------------------------------------- static content

function serveFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res, 'File not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/**
 * lib/week.js is framework-free ESM, so the browser can use the very same
 * ISO-week maths as the server instead of a second copy that can drift.
 */
const SHARED_MODULES = { '/js/week.js': path.join(ROOT, 'lib', 'week.js') };

function serveStatic(res, url) {
  if (SHARED_MODULES[url.pathname]) return serveFile(res, SHARED_MODULES[url.pathname]);
  const root = url.pathname.startsWith('/uploads/') ? store.dataDir : PUBLIC_DIR;
  const relative = url.pathname.replace(/^\/uploads\//, '').replace(/^\/+/, '');
  const target = path.resolve(root, `./${relative}`);
  if (!target.startsWith(path.resolve(root))) return notFound(res, 'Outside the served directory');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return fs.existsSync(target) ? serveFile(res, target) : serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  return serveFile(res, target);
}

// ----------------------------------------------------------------- dispatch

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const id = (s) => decodeURIComponent(s);

  try {
    if (!p.startsWith('/api/')) {
      return req.method === 'GET' || req.method === 'HEAD'
        ? serveStatic(res, url)
        : sendJson(res, 405, { error: 'Use GET for static files.' });
    }

    // /api/...
    if (p === '/api' || p === '/api/') {
      return sendJson(res, 200, {
        name: 'birds LME Phase 1 tracker',
        week: currentWeekKey(),
        week_label: weekLabel(currentWeekKey()),
        endpoints: [
          'GET  /api/weeks',
          'GET  /api/weeks/:week',
          'POST /api/weeks/:week/scores        { rows: [{ name, score, player_id? }] }',
          'POST /api/weeks/:week/uploads?name=file.png   (raw image bytes)',
          'POST /api/weeks/:week/glory         { count }',
          'GET  /api/weeks/:week/export.csv',
          'GET  /api/players',
          'POST /api/players                   { name, role }',
          'PATCH /api/players/:id              { name?, role? }',
          'POST /api/players/:id/merge         { into }',
          'DELETE /api/players/:id',
          'POST /api/suggest                   { names: [..] }',
          'GET  /api/settings',
        ],
      });
    }

    if (p === '/api/weeks' && req.method === 'GET') return apiWeeks(res, url);
    if (p === '/api/players' && req.method === 'GET') return apiPlayers(res);
    if (p === '/api/players' && req.method === 'POST') return await apiAddPlayer(res, req);
    if (p === '/api/suggest' && req.method === 'POST') return await apiSuggest(res, req);
    if (p === '/api/settings' && req.method === 'GET') return apiSettings(res);

    if (p === '/api/glory-count' && req.method === 'PUT') {
      const { count } = await readJson(req);
      store.setSetting('glory_count', Math.max(0, Number(count) || 0));
      return sendJson(res, 200, { glory_count: store.gloryCount() });
    }

    let m;
    if ((m = /^\/api\/weeks\/([^/]+)$/.exec(p))) {
      const week = requireWeek(m[1]);
      if (req.method === 'GET') return apiWeekDetail(res, week);
      if (req.method === 'DELETE') return sendJson(res, 200, store.deleteWeek(week));
      return sendJson(res, 405, { error: 'Use GET or DELETE on a week.' });
    }

    if ((m = /^\/api\/weeks\/([^/]+)\/scores$/.exec(p)) && req.method === 'POST') {
      return await apiSaveScores(res, requireWeek(m[1]), req);
    }

    if ((m = /^\/api\/weeks\/([^/]+)\/uploads$/.exec(p)) && req.method === 'POST') {
      return await apiUploadScreenshot(res, requireWeek(m[1]), req, url);
    }

    if ((m = /^\/api\/weeks\/([^/]+)\/glory$/.exec(p)) && req.method === 'POST') {
      return await apiGlory(res, requireWeek(m[1]), req);
    }

    if ((m = /^\/api\/weeks\/([^/]+)\/export\.csv$/.exec(p)) && req.method === 'GET') {
      const week = requireWeek(m[1]);
      if (!store.weekExists(week)) return notFound(res, `No scores for ${week}`);
      const { players, label } = store.weekStats(week);
      const lines = ['rank,name,role,score,previous,gain,gain_percent'];
      for (const row of players) {
        const name = `"${row.name.replaceAll('"', '""')}"`;
        lines.push([row.rank, name, row.role, row.score, row.prev_score ?? '', row.gain,
          row.gain_pct === null ? '' : row.gain_pct.toFixed(2)].join(','));
      }
      return send(res, 200, lines.join('\n'), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="birds-${week}.csv"`,
        'X-Week-Label': label,
      });
    }

    if ((m = /^\/api\/players\/(\d+)\/merge$/.exec(p)) && req.method === 'POST') {
      return await apiMergePlayers(res, m[1], req);
    }
    if ((m = /^\/api\/players\/(\d+)$/.exec(p))) {
      if (req.method === 'PATCH') return await apiUpdatePlayer(res, m[1], req);
      if (req.method === 'DELETE') return apiDeletePlayer(res, m[1]);
      return sendJson(res, 405, { error: 'Use PATCH or DELETE on a player.' });
    }

    return notFound(res, `Unknown API route ${req.method} ${p}`);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    return sendJson(res, status, { error: err.message || 'Unexpected server error.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`birds — LME Phase 1 tracker`);
  console.log(`  open    http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  data    ${store.dataDir}`);
  console.log(`  this week  ${currentWeekKey()} · ${weekLabel(currentWeekKey())}`);
});
