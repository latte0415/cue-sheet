// 공연 큐시트 서버 — Node 20 내장 모듈만 사용
//   /            index.html
//   /healthz     Railway 헬스체크 (text)
//   /api/*       프로젝트(공연)별 큐시트 JSON + 음원 파일. README 의 API 표 참고
// 환경변수: PORT, DATA_DIR(기본 ./data), APP_PASSWORD(설정 시 /api 에 X-App-Key 또는 ?key= 필요)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, ID_RE, KEY_RE, invalidShow } = require('./lib/store');

const INDEX = path.join(__dirname, 'index.html');
const JSON_LIMIT = 5 * 1024 * 1024;
const AUDIO_LIMIT = 100 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
function sendJson(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }, headers));
  res.end(body);
}
// 한도를 넘으면 나머지를 버리면서 끝까지 받은 뒤 413 (도중에 끊으면 클라이언트가 응답을 못 받는다)
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', c => { size += c.length; if (size > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(c); });
    req.on('error', reject);
    req.on('end', () => {
      if (over) return reject(new HttpError(413, 'too_large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(new HttpError(400, 'bad_json')); }
    });
  });
}
function digest(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function etagMatch(header, rev) {
  if (!header) return false;
  return header.split(',').map(x => x.trim().replace(/^W\//, '')).some(x => x === '*' || x === `"${rev}"`);
}
// RFC 7233 단일 범위만: bytes=a-b, bytes=a-, bytes=-n. 해석 불가면 null(전체), 범위 밖이면 'bad'
function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'bad'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

function createServer(opts) {
  opts = opts || {};
  const store = new Store(opts.dataDir || process.env.DATA_DIR || './data');
  const password = opts.password !== undefined ? opts.password : (process.env.APP_PASSWORD || '');
  const pwDigest = password ? digest(password) : null;
  const log = opts.log !== undefined ? opts.log : (msg => console.log(msg));
  const ready = store.init();

  function authed(req, query) {
    if (!pwDigest) return true;
    // 헤더는 Latin-1 만 실을 수 있어 프론트가 encodeURIComponent 해서 보낸다 (쿼리는 URLSearchParams 가 디코딩)
    let given = req.headers['x-app-key'];
    if (given) { try { given = decodeURIComponent(given); } catch (e) { /* 원문 그대로 */ } } else given = query.get('key') || '';
    return crypto.timingSafeEqual(digest(given), pwDigest);
  }
  async function needShow(id) {
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad_id');
    const rec = await store.get(id);
    if (!rec) throw new HttpError(404, 'not_found');
    return rec;
  }
  function needKey(k) { if (!KEY_RE.test(k)) throw new HttpError(400, 'bad_file_key'); return k; }
  function checkShow(show) { const why = invalidShow(show); if (why) throw new HttpError(400, 'invalid_show', { message: why }); }

  async function api(req, res, parts, query) {
    const M = req.method;
    // /api/health 는 인증 없이 — 프론트가 서버 존재와 비밀번호 필요 여부를 알기 위해
    if (parts[0] === 'health' && parts.length === 1 && M === 'GET') {
      return sendJson(res, 200, { ok: true, hasPassword: !!pwDigest, showCount: await store.count() });
    }
    if (!authed(req, query)) throw new HttpError(401, 'unauthorized');
    if (parts[0] !== 'shows') throw new HttpError(404, 'not_found');
    const [, id, sub, key, extra] = parts;
    if (extra !== undefined) throw new HttpError(404, 'not_found');

    if (id === undefined) {
      if (M === 'GET') return sendJson(res, 200, await store.list());
      if (M === 'POST') {
        const body = await readJson(req, JSON_LIMIT);
        checkShow(body && body.show);
        return sendJson(res, 201, await store.create(body.show));
      }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad_id');

    if (sub === undefined) {
      if (M === 'GET') {
        const rec = await needShow(id);
        const tag = `"${rec.rev}"`;
        if (etagMatch(req.headers['if-none-match'], rec.rev)) { res.writeHead(304, { ETag: tag }); return res.end(); }
        return sendJson(res, 200, rec, { ETag: tag });
      }
      if (M === 'PUT') {
        const body = await readJson(req, JSON_LIMIT);
        checkShow(body && body.show);
        const r = await store.put(id, body.baseRev, body.show);
        if (!r) throw new HttpError(404, 'not_found');
        if (r.conflict) return sendJson(res, 409, { error: 'conflict', rev: r.conflict.rev, updatedAt: r.conflict.updatedAt, show: r.conflict.show }, { ETag: `"${r.conflict.rev}"` });
        return sendJson(res, 200, r, { ETag: `"${r.rev}"` });
      }
      if (M === 'DELETE') {
        if (!(await store.remove(id))) throw new HttpError(404, 'not_found');
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (sub === 'duplicate' && key === undefined) {
      if (M !== 'POST') throw new HttpError(405, 'method_not_allowed');
      const r = await store.duplicate(id);
      if (!r) throw new HttpError(404, 'not_found');
      return sendJson(res, 201, r);
    }
    if (sub !== 'audio') throw new HttpError(404, 'not_found');
    await needShow(id);

    if (key === undefined) {
      if (M === 'GET') return sendJson(res, 200, await store.audioList(id));
      if (M === 'DELETE') { await store.audioClear(id); return sendJson(res, 200, { ok: true }); }
      throw new HttpError(405, 'method_not_allowed');
    }
    needKey(key);
    if (M === 'PUT') {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!/^audio\/[\w.+-]+$/.test(ct) && ct !== 'application/octet-stream') throw new HttpError(415, 'unsupported_type');
      // 선언 길이가 한도를 넘으면 본문을 기다리지 않고 바로 413 후 연결을 닫는다
      if (Number(req.headers['content-length']) > AUDIO_LIMIT) { res.setHeader('Connection', 'close'); req.on('data', () => {}); throw new HttpError(413, 'too_large'); }
      let name = key;
      try { if (req.headers['x-file-name']) name = decodeURIComponent(String(req.headers['x-file-name'])); } catch (e) { name = key; }
      name = name.replace(/[\u0000-\u001f\/\\]/g, '_').slice(0, 200) || key;
      const r = await store.audioPut(id, key, req, { name, mime: ct, limit: AUDIO_LIMIT });
      if (r.tooLarge) throw new HttpError(413, 'too_large');
      return sendJson(res, 200, { fileKey: key, size: r.size, name: r.name });
    }
    if (M === 'DELETE') {
      if (!(await store.audioDel(id, key))) throw new HttpError(404, 'not_found');
      return sendJson(res, 200, { ok: true });
    }
    if (M === 'GET' || M === 'HEAD') return sendAudio(req, res, id, key, query);
    throw new HttpError(405, 'method_not_allowed');
  }

  async function sendAudio(req, res, id, key, query) {
    const meta = await store.audioMeta(id, key);
    const file = store.audioFile(id, key);
    let st;
    try { st = await fs.promises.stat(file); } catch (e) { st = null; }
    if (!meta || !st) throw new HttpError(404, 'not_found');
    const size = st.size;
    const disp = query.get('download') === '1' ? 'attachment' : 'inline';
    const ascii = String(meta.name || key).replace(/[^\x20-\x7e]|["\\]/g, '_');
    const headers = {
      'Content-Type': meta.mime === 'application/octet-stream' || !meta.mime ? 'application/octet-stream' : meta.mime,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.name || key)}`
    };
    const range = req.headers.range ? parseRange(req.headers.range, size) : null;
    if (range === 'bad') { res.writeHead(416, Object.assign(headers, { 'Content-Range': `bytes */${size}`, 'Content-Type': 'application/json' })); return res.end(JSON.stringify({ error: 'range_not_satisfiable' })); }
    let status = 200, start = 0, end = size - 1;
    if (range) { status = 206; start = range.start; end = range.end; headers['Content-Range'] = `bytes ${start}-${end}/${size}`; }
    headers['Content-Length'] = size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !size) return res.end();
    await new Promise(resolve => {
      const s = fs.createReadStream(file, { start, end });
      s.on('error', () => { res.destroy(); resolve(); });
      s.on('end', resolve);
      res.on('close', () => { s.destroy(); resolve(); });
      s.pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    let u;
    try { u = new URL(req.url || '/', 'http://x'); } catch (e) { u = new URL('http://x/'); }
    const pathname = u.pathname;
    // 로그에는 쿼리(?key=)를 남기지 않는다
    res.on('finish', () => { if (log) log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - t0}ms`); });
    const text = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); };
    if (pathname.includes('..') || (req.url || '').includes('..')) return text(404, 'not found');

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await ready;
        let parts;
        try { parts = pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent); } catch (e) { throw new HttpError(400, 'bad_path'); }
        await api(req, res, parts, u.searchParams);
      } catch (e) {
        if (res.headersSent) { res.destroy(); return; }
        if (e instanceof HttpError) return sendJson(res, e.status, Object.assign({ error: e.code }, e.extra));
        console.error(e);
        sendJson(res, 500, { error: 'server_error' });
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return text(404, 'not found');
    if (pathname === '/healthz') return text(200, 'ok');
    if (pathname === '/' || pathname === '/index.html') {
      return fs.readFile(INDEX, (err, data) => {
        if (err) return text(500, 'error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    }
    text(404, 'not found');
  });
  server.ready = ready;
  server.store = store;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = createServer();
  server.ready.then(() => {
    server.listen(PORT, '0.0.0.0', () => console.log(`cue-sheet listening on :${PORT} (data: ${server.store.dir}${process.env.APP_PASSWORD ? ', password on' : ''})`));
  }, err => { console.error('DATA_DIR 를 만들 수 없습니다:', err); process.exit(1); });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
