// 공연 큐시트 서버 — Node 20 내장 모듈만 사용
//   /            index.html
//   /healthz     Railway 헬스체크 (text)
//   /api/*       프로젝트(공연)별 큐시트 JSON + 음원 파일. README 의 API 표 참고
//   /mcp         원격 MCP 서버 (에이전트용 읽기·부분 수정). docs/mcp.md — 이 경로만 npm 의존성(MCP SDK)을 쓴다
// 환경변수: PORT, DATA_DIR(기본 ./data), APP_PASSWORD(설정 시 /api·/mcp 에 X-App-Key, Authorization: Bearer 또는 ?key= 필요),
//          HISTORY_KEEP(프로젝트별 보관할 이전 버전 수, 기본 100), TRUST_PROXY(1 이면 X-Forwarded-For 로 IP 판별. Railway 에서는 자동),
//          TRASH_DAYS(삭제한 프로젝트를 휴지통에 두는 일수, 기본 30), ADMIN_KEY(설정 시에만 편집 비밀번호 초기화 POST …/edit-password/reset)
// 권한 두 단계: APP_PASSWORD = 보기(읽기·새 프로젝트), 프로젝트별 편집 비밀번호(X-Edit-Key) = 그 프로젝트를 바꾸는 모든 쓰기 (/mcp 쓰기 도구 포함)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, ID_RE, KEY_RE, invalidShow } = require('./lib/store');
const { createMcp } = require('./lib/mcp');
const { hashKey, verifyKey, badNewKey, FailLimiter } = require('./lib/editkey');

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
// 본문을 읽지 않고 답할 때(401): keep-alive 로 다시 쓰는 연결이 남은 본문 때문에 깨지지 않게, 길이를 아는 작은 본문(≤64KB)만
// 비우고, 길이를 모르거나(chunked) 큰 본문은 읽지 않고 응답 뒤 연결을 닫는다
const DRAIN_LIMIT = 64 * 1024;
async function settleUnreadBody(req, res) {
  if (req.readableEnded) return;
  const cl = req.headers['content-length'], te = req.headers['transfer-encoding'];
  if (cl == null && te == null) return; // 본문 없음
  const n = Number(cl);
  if (te == null && Number.isInteger(n) && n >= 0 && n <= DRAIN_LIMIT) {
    await new Promise(r => { req.on('end', r); req.on('error', r); req.on('close', r); req.resume(); });
  } else res.setHeader('Connection', 'close');
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
  const store = new Store(opts.dataDir || process.env.DATA_DIR || './data', { historyKeep: opts.historyKeep, putSnapshotMs: opts.putSnapshotMs, trashDays: opts.trashDays });
  const password = opts.password !== undefined ? opts.password : (process.env.APP_PASSWORD || '');
  const pwDigest = password ? digest(password) : null;
  const log = opts.log !== undefined ? opts.log : (msg => console.log(msg));
  // 편집 비밀번호 실패 제한: IP+프로젝트마다 1분에 10회 (4자리 비밀번호 무차별 대입 완화)
  const rate = Object.assign({ max: 10, windowMs: 60 * 1000 }, opts.editRate);
  const limiter = new FailLimiter(rate.max, rate.windowMs);
  const trustProxy = opts.trustProxy !== undefined ? !!opts.trustProxy : (process.env.TRUST_PROXY === '1' || !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME));
  const passed = new Set();
  // 관리자 복구 키: 설정했을 때만 켜진다. 편집 비밀번호를 잊었거나 누가 바꿔 잠갔을 때 1234 로 되돌린다
  const adminKey = opts.adminKey !== undefined ? opts.adminKey : (process.env.ADMIN_KEY || '');
  const adminDigest = adminKey ? digest(adminKey) : null;
  const ready = store.init();
  // 휴지통 정리: 시작할 때(init) + 6시간마다
  const purgeT = setInterval(() => { store.trashPurge().catch(e => console.error('trash purge:', e)); }, 6 * 60 * 60 * 1000);
  if (purgeT.unref) purgeT.unref();
  const mcp = createMcp({ store, checkEdit: (req, id, given) => editCheck(req, id, given ? [given] : editKeysOf(req)) });

  // /api 와 /mcp 가 같이 쓴다. X-App-Key(프런트), Authorization: Bearer(MCP 클라이언트), ?key= 중 하나
  function authed(req, query) {
    if (!pwDigest) return true;
    const given = [];
    // 헤더는 Latin-1 만 실을 수 있어 프론트는 encodeURIComponent 해서 보낸다. MCP 클라이언트는 UTF-8 바이트를 그대로
    // 보낼 수 있어(Node 는 latin1 로 읽음) 그 해석도 함께 본다 (쿼리는 URLSearchParams 가 디코딩)
    const header = v => {
      if (!v) return;
      given.push(v);
      try { given.push(decodeURIComponent(v)); } catch (e) { /* 원문 그대로 */ }
      given.push(Buffer.from(v, 'latin1').toString('utf8'));
    };
    header(req.headers['x-app-key']);
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
    if (m) header(m[1].trim());
    if (!given.length) given.push(query.get('key') || '');
    let ok = false;
    for (const g of given) if (crypto.timingSafeEqual(digest(g), pwDigest)) ok = true;
    return ok;
  }
  async function needShow(id) {
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad_id');
    const rec = await store.get(id);
    if (!rec) throw new HttpError(404, 'not_found');
    return rec;
  }
  // 프록시 뒤면 X-Forwarded-For 의 마지막 값(가장 가까운 프록시가 본 주소). 클라이언트가 앞에 끼워 넣은 값은 무시된다
  function clientIp(req) {
    const xff = trustProxy && req.headers['x-forwarded-for'];
    if (xff) { const last = String(xff).split(',').map(x => x.trim()).filter(Boolean).pop(); if (last) return last; }
    return req.socket.remoteAddress || '';
  }
  // X-Edit-Key 의 후보들. 프런트·업로드 CLI 는 URL 인코딩해서, MCP 클라이언트 설정은 UTF-8 그대로 보낼 수 있다 (authed 와 같은 해석)
  function editKeysOf(req) {
    const v = req.headers['x-edit-key'];
    if (!v) return [];
    const out = [String(v)];
    try { out.push(decodeURIComponent(String(v))); } catch (e) { /* 원문 그대로 */ }
    out.push(Buffer.from(String(v), 'latin1').toString('utf8'));
    return out.filter((x, i) => x && out.indexOf(x) === i);
  }
  // 그 프로젝트의 편집 비밀번호 확인 — /api 와 /mcp 쓰기 도구가 같이 쓴다. 실패 제한도 같은 카운터(IP+프로젝트).
  // 통과 { auth }, 실패 { status: 403 } (키 없음·틀림), { status: 429, retryAfter } (너무 많이 틀림)
  async function editCheck(req, id, candidates) {
    const rk = clientIp(req) + '|' + id;
    const wait = limiter.blocked(rk);
    if (wait) return { status: 429, retryAfter: wait };
    if (!candidates.length) return { status: 403 };
    const auth = await store.getAuth(id);
    for (const given of candidates) {
      // 자동 저장마다 scrypt 를 돌리지 않게, 통과한 (프로젝트, 해시, 입력값의 sha256) 조합을 메모리에 기억한다. 비밀번호가 바뀌면 해시가 달라져 무효
      const memo = auth ? id + '|' + auth.hash + '|' + digest(given).toString('hex') : null;
      if (memo && passed.has(memo)) return { auth };
      if (await verifyKey(auth, given)) {
        if (memo) { if (passed.size > 1000) passed.clear(); passed.add(memo); }
        return { auth };
      }
    }
    limiter.fail(rk);
    return { status: 403 };
  }
  // 없거나 틀리면 403 edit_forbidden, 너무 많이 틀리면 429
  async function needEdit(req, id, given) {
    const r = await editCheck(req, id, given === undefined ? editKeysOf(req) : (given ? [given] : []));
    if (r.status === 429) throw new HttpError(429, 'too_many_attempts', { retryAfter: r.retryAfter, headers: { 'Retry-After': String(r.retryAfter) } });
    if (r.status) throw new HttpError(403, 'edit_forbidden');
    return r.auth;
  }
  function needKey(k) { if (!KEY_RE.test(k)) throw new HttpError(400, 'bad_file_key'); return k; }
  function checkShow(show) { const why = invalidShow(show); if (why) throw new HttpError(400, 'invalid_show', { message: why }); }

  async function api(req, res, parts, query) {
    const M = req.method;
    // /api/health 는 인증 없이 — 프론트가 서버 존재와 비밀번호 필요 여부를 알기 위해
    if (parts[0] === 'health' && parts.length === 1 && M === 'GET') {
      return sendJson(res, 200, { ok: true, hasPassword: !!pwDigest, showCount: await store.count() });
    }
    if (!authed(req, query)) { await settleUnreadBody(req, res); throw new HttpError(401, 'unauthorized'); }
    // 휴지통: 목록·복구는 보기 권한만 — 편집 비밀번호를 빼앗겨 삭제당해도 원래 편집자가 되살릴 수 있게 (복구는 아무것도 지우지 않는다)
    if (parts[0] === 'trash') {
      const [, tid, act, more] = parts;
      if (tid === undefined) {
        if (M !== 'GET') throw new HttpError(405, 'method_not_allowed');
        return sendJson(res, 200, { days: store.trashDays, items: await store.trashList() });
      }
      if (act !== 'restore' || more !== undefined) throw new HttpError(404, 'not_found');
      if (M !== 'POST') throw new HttpError(405, 'method_not_allowed');
      const r = await store.trashRestore(tid);
      if (!r) throw new HttpError(404, 'not_found');
      return sendJson(res, 200, r);
    }
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
        await needShow(id);
        await needEdit(req, id);
        const body = await readJson(req, JSON_LIMIT);
        checkShow(body && body.show);
        const r = await store.put(id, body.baseRev, body.show);
        if (!r) throw new HttpError(404, 'not_found');
        if (r.conflict) return sendJson(res, 409, { error: 'conflict', rev: r.conflict.rev, updatedAt: r.conflict.updatedAt, show: r.conflict.show }, { ETag: `"${r.conflict.rev}"` });
        return sendJson(res, 200, r, { ETag: `"${r.rev}"` });
      }
      if (M === 'DELETE') {
        await needShow(id);
        await needEdit(req, id);
        const r = await store.remove(id, { ip: clientIp(req) });
        if (!r) throw new HttpError(404, 'not_found');
        return sendJson(res, 200, { ok: true, trashId: r.trashId, trashDays: store.trashDays });
      }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (sub === 'duplicate' && key === undefined) {
      if (M !== 'POST') throw new HttpError(405, 'method_not_allowed');
      const r = await store.duplicate(id);
      if (!r) throw new HttpError(404, 'not_found');
      return sendJson(res, 201, r);
    }
    if (sub === 'edit-check' && key === undefined) {
      if (M !== 'POST') throw new HttpError(405, 'method_not_allowed');
      await needShow(id);
      const auth = await needEdit(req, id);
      return sendJson(res, 200, { ok: true, isDefault: !auth });
    }
    // 관리자 초기화: ADMIN_KEY 가 없으면 기능 자체가 없다(404). 틀리면 403 admin_forbidden, IP 당 실패 제한(편집 비밀번호와 같은 창)
    if (sub === 'edit-password' && key === 'reset') {
      if (!adminDigest) throw new HttpError(404, 'not_found');
      if (M !== 'POST') throw new HttpError(405, 'method_not_allowed');
      await needShow(id);
      const rk = clientIp(req) + '|#admin';
      const wait = limiter.blocked(rk);
      if (wait) throw new HttpError(429, 'too_many_attempts', { retryAfter: wait, headers: { 'Retry-After': String(wait) } });
      const v = req.headers['x-admin-key'];
      const cands = v ? [String(v)] : [];
      if (v) { try { cands.push(decodeURIComponent(String(v))); } catch (e) { /* 원문 그대로 */ } cands.push(Buffer.from(String(v), 'latin1').toString('utf8')); }
      let ok = false;
      for (const c of cands) if (crypto.timingSafeEqual(digest(c), adminDigest)) ok = true;
      if (!ok) { if (v) limiter.fail(rk); throw new HttpError(403, 'admin_forbidden'); }
      await store.setAuth(id, null);
      return sendJson(res, 200, { ok: true, isDefault: true });
    }
    if (sub === 'edit-password' && key === undefined) {
      if (M !== 'POST') throw new HttpError(405, 'method_not_allowed');
      await needShow(id);
      const body = await readJson(req, 64 * 1024);
      await needEdit(req, id, body && typeof body.current === 'string' ? body.current : undefined);
      const why = badNewKey(body && body.next);
      if (why) throw new HttpError(400, 'bad_password', { message: why });
      // 기본 비밀번호로 되돌리면 해시를 지워 "기본 상태"로 둔다 (목록의 editDefault 와 경고가 다시 켜진다)
      const isDefault = await verifyKey(null, body.next);
      await store.setAuth(id, isDefault ? null : await hashKey(body.next));
      return sendJson(res, 200, { ok: true, isDefault });
    }
    // 기록(store.revisions·restore, MCP 의 list_revisions·restore_revision 과 같은 것). 목록(메타)은 보기 권한, 내용·복원은 편집 권한
    if (sub === 'history') {
      if (M !== 'GET') throw new HttpError(405, 'method_not_allowed');
      await needShow(id);
      if (key === undefined) return sendJson(res, 200, await store.revisions(id));
      await needEdit(req, id);
      const rec = /^\d{1,12}$/.test(key) ? await store.getRevision(id, Number(key)) : null;
      if (!rec) throw new HttpError(404, 'not_found');
      return sendJson(res, 200, rec);
    }
    if (sub === 'restore' && key === undefined) {
      if (M !== 'POST') throw new HttpError(405, 'method_not_allowed');
      await needShow(id);
      await needEdit(req, id);
      const body = await readJson(req, 64 * 1024);
      const r = await store.restore(id, Number(body && body.rev), body && body.baseRev);
      if (!r) throw new HttpError(404, 'not_found');
      if (r.missing) throw new HttpError(404, 'rev_not_found');
      if (r.conflict) return sendJson(res, 409, { error: 'conflict', rev: r.conflict.rev, updatedAt: r.conflict.updatedAt, show: r.conflict.show }, { ETag: `"${r.conflict.rev}"` });
      return sendJson(res, 200, r, { ETag: `"${r.rev}"` });
    }
    if (sub !== 'audio') throw new HttpError(404, 'not_found');
    await needShow(id);

    if (key === undefined) {
      if (M === 'GET') return sendJson(res, 200, await store.audioList(id));
      if (M === 'DELETE') { await needEdit(req, id); await store.audioClear(id); return sendJson(res, 200, { ok: true }); }
      throw new HttpError(405, 'method_not_allowed');
    }
    needKey(key);
    if (M === 'PUT' || M === 'DELETE') await needEdit(req, id);
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
        // 본문을 읽기 전에 거절했으면(403·429 등) 작은 본문은 비우고 큰 본문은 응답 뒤 연결을 닫는다
        await settleUnreadBody(req, res);
        if (e instanceof HttpError) {
          const { headers, ...extra } = e.extra || {};
          return sendJson(res, e.status, Object.assign({ error: e.code }, extra), headers);
        }
        console.error(e);
        sendJson(res, 500, { error: 'server_error' });
      }
      return;
    }
    if (pathname === '/mcp') {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await ready;
        if (!authed(req, u.searchParams)) {
          await settleUnreadBody(req, res);
          return sendJson(res, 401, { error: 'unauthorized', message: 'Authorization: Bearer <APP_PASSWORD> 헤더가 필요합니다' }, { 'WWW-Authenticate': 'Bearer realm="cue-sheet"' });
        }
        await mcp(req, res);
      } catch (e) {
        console.error(e);
        if (res.headersSent) { res.destroy(); return; }
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
  // 프록시(Railway 등)의 유휴 연결 시간보다 길게 — 서버가 먼저 닫아 재사용 중인 연결이 끊기는 경쟁을 줄인다
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000; // keepAliveTimeout 보다 커야 한다
  server.on('close', () => clearInterval(purgeT));
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
