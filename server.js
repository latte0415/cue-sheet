// 공연 큐시트 서버 — Node 20 내장 모듈만 사용
//   /            index.html
//   /healthz     Railway 헬스체크 (text)
//   /api/*       프로젝트(공연)별 큐시트 JSON + 음원 파일. README 의 API 표 참고
//   /mcp         원격 MCP 서버 (에이전트용 읽기·부분 수정). docs/mcp.md — 이 경로만 npm 의존성(MCP SDK)을 쓴다
// 환경변수: PORT, DATA_DIR(기본 ./data), APP_PASSWORD(설정 시 /api·/mcp 에 X-App-Key, Authorization: Bearer 또는 ?key= 필요),
//          HISTORY_KEEP(프로젝트별 보관할 이전 버전 수, 기본 100), TRUST_PROXY(1 이면 X-Forwarded-For 로 IP 판별. Railway 에서는 자동),
//          TRASH_DAYS(삭제한 프로젝트를 휴지통에 두는 일수, 기본 30), ADMIN_KEY(설정 시에만 편집 비밀번호 초기화 POST …/edit-password/reset, 그리고 MCP 토큰 발급·폐기에도 필요),
//          BODY_CACHE_MB(GET 본문을 메모리에 둘 상한, 기본 64 — lib/store.js)
// 압축: 받는 쪽이 Accept-Encoding 에 gzip 을 실었을 때만. 큐시트 GET 은 본문 캐시의 gzip 본(rev 마다 한 번 만든다), 목록·기록·409 처럼
//   큰(GZIP_MIN 이상) JSON 은 그때그때. 화면 파일(index.html 등)은 내용이 바뀔 때 한 번 gzip·brotli 해 둔다(staticFile)
// 권한 두 단계: APP_PASSWORD = 보기(읽기·새 프로젝트), 프로젝트별 편집 비밀번호(X-Edit-Key) = 그 프로젝트를 바꾸는 모든 쓰기 (/mcp 쓰기 도구 포함)
// 사람별 MCP 토큰(lib/tokens.js, /api/tokens 로 발급): /mcp 의 Bearer 로만, APP_PASSWORD 대신 '보기' 단계 + 이름(기록의 by).
//   토큰은 편집 비밀번호를 대신하지 않는다 — /mcp 쓰기 도구는 토큰으로 붙어도 그 프로젝트의 편집 비밀번호가 필요하다
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Store, ID_RE, KEY_RE, invalidShow } = require('./lib/store');
const { createMcp } = require('./lib/mcp');
const { hashKey, verifyKey, badNewKey, FailLimiter } = require('./lib/editkey');
const { Tokens, TokenError } = require('./lib/tokens');
const { SHOW_VER } = require('./lib/validate');

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
// 이보다 작은 JSON 은 압축하지 않는다(압축 비용이 아끼는 바이트보다 크다). 큐시트 본문은 rev 마다 한 번만 압축하므로 더 작아도 한다
const GZIP_MIN = 8 * 1024, GZIP_MIN_CACHED = 1024;
// Accept-Encoding 이 coding(gzip·br)을 받나. q=0 은 거절, 명시가 없으면 * 를 본다. 헤더가 없으면(테스트·MCP·curl) 받지 않는 것으로
function accepts(req, coding) {
  const h = req.headers['accept-encoding'];
  if (!h) return false;
  let star = null;
  for (const part of String(h).toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(x => x.trim());
    const q = params.map(x => /^q=([\d.]+)$/.exec(x)).find(Boolean);
    const ok = !q || Number(q[1]) > 0;
    if (name === coding || (coding === 'gzip' && name === 'x-gzip')) return ok;
    if (name === '*') star = ok;
  }
  return star === true;
}
const gzipAsync = buf => new Promise((res, rej) => zlib.gzip(buf, (e, out) => (e ? rej(e) : res(out))));
const brotliAsync = buf => new Promise((res, rej) => zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, (e, out) => (e ? rej(e) : res(out))));
// 이미 만든 JSON 바이트를 보낸다. gz = 그 gzip 본(있으면 Content-Encoding: gzip 으로)
function sendBytes(res, status, raw, gz, headers) {
  const body = gz || raw;
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }, gz ? { 'Content-Encoding': 'gzip' } : null, headers));
  res.end(body);
}
// 큰 JSON 응답(목록·기록·409 의 큐시트 전체): GZIP_MIN 이상이고 받는 쪽이 gzip 을 받으면 압축해서. 작으면 sendJson 과 같다
async function sendJsonZ(req, res, status, obj, headers) {
  const raw = Buffer.from(JSON.stringify(obj));
  if (raw.length < GZIP_MIN) return sendBytes(res, status, raw, null, headers);
  headers = Object.assign({ Vary: 'Accept-Encoding' }, headers);
  let gz = null;
  if (accepts(req, 'gzip')) { try { gz = await gzipAsync(raw); } catch (e) { gz = null; } }
  sendBytes(res, status, raw, gz, headers);
}
// 화면 파일(index.html·lib/merge.js·sw.js): 메모리에 두고 내용 해시를 약한 ETag 로(gzip·brotli·원본이 같은 ETag — 같은 내용의 다른 인코딩),
// If-None-Match 가 맞으면 304. 인코딩은 br > gzip > 원본. Cache-Control 은 예전처럼 no-cache(쓸 때마다 확인).
// 요청마다 stat 해서 (mtime·크기·inode) 가 바뀌었으면 다시 읽는다 — 서버를 끄지 않고 index.html 을 고쳐도 다음 새로고침에 반영(stat 은 싸다)
function staticFile(file, type) {
  let cur = null, loading = null; // cur = { sig, etag, raw, gz, br }, loading = { sig, p }
  const sigOf = st => `${st.size}-${st.mtimeMs}-${st.ino}`;
  async function load(sig) {
    const raw = await fs.promises.readFile(file);
    const [gz, br] = await Promise.all([gzipAsync(raw), brotliAsync(raw)]);
    const etag = 'W/"' + crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 27) + '"';
    return { sig, etag, raw, gz, br };
  }
  async function get() {
    const sig = sigOf(await fs.promises.stat(file));
    if (cur && cur.sig === sig) return cur;
    if (!loading || loading.sig !== sig) {
      const l = { sig, p: load(sig) };
      loading = l;
      l.p.then(v => { if (loading === l) { cur = v; loading = null; } }, () => { if (loading === l) loading = null; });
    }
    return loading.p;
  }
  return async function serve(req, res) {
    const f = await get();
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding' };
    if (etagMatch(req.headers['if-none-match'], f.etag.slice(3, -1))) { res.writeHead(304, headers); return res.end(); }
    const enc = accepts(req, 'br') ? 'br' : accepts(req, 'gzip') ? 'gzip' : null;
    const body = enc === 'br' ? f.br : enc === 'gzip' ? f.gz : f.raw;
    if (enc) headers['Content-Encoding'] = enc;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
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
  const store = new Store(opts.dataDir || process.env.DATA_DIR || './data', { historyKeep: opts.historyKeep, putSnapshotMs: opts.putSnapshotMs, trashDays: opts.trashDays, bodyCacheBytes: opts.bodyCacheBytes });
  // 화면 파일 위치 (테스트는 임시 사본 폴더를 준다)
  const staticDir = opts.staticDir || __dirname;
  const serveIndex = staticFile(path.join(staticDir, 'index.html'), 'text/html; charset=utf-8');
  const serveMerge = staticFile(path.join(staticDir, 'lib', 'merge.js'), 'text/javascript; charset=utf-8');
  const serveSw = staticFile(path.join(staticDir, 'sw.js'), 'text/javascript; charset=utf-8');
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
  const tokens = new Tokens(opts.dataDir || process.env.DATA_DIR || './data');
  const ready = Promise.all([store.init(), tokens.init()]);
  // 휴지통 정리: 시작할 때(init) + 6시간마다
  const purgeT = setInterval(() => { store.trashPurge().catch(e => console.error('trash purge:', e)); }, 6 * 60 * 60 * 1000);
  if (purgeT.unref) purgeT.unref();
  const mcp = createMcp({ store, checkEdit: (req, id, given) => editCheck(req, id, given ? [given] : editKeysOf(req)) });
  // 기록(by·via)에 남는 이름. 사이트 비밀번호(APP_PASSWORD)로 붙은 MCP 는 '사이트 비밀번호'(팀 공용이라 누군지 모름), 비밀번호 없는 서버의 MCP 는 누군지 모르므로 '익명'.
  // 브라우저(/api 쓰기)는 편집 비밀번호가 프로젝트 공용이라 사람을 구분할 수 없어 '브라우저'
  const MASTER = { kind: 'master', name: '사이트 비밀번호' }, OPEN = { kind: 'open', name: '익명' };
  const BROWSER = { by: '브라우저', via: 'browser' };

  // 사이트 비밀번호인가. /api 와 /mcp 가 같이 쓴다. X-App-Key(프런트), Authorization: Bearer(MCP 클라이언트), ?key= 중 하나
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
  // /mcp 의 호출자: 사이트 비밀번호 → MASTER, 사람별 토큰(Bearer 만) → { kind: 'token', id, name }, 아니면 null.
  // 토큰은 ?key=·X-App-Key 로 받지 않는다(주소는 로그·기록에 남기 쉽다)
  function mcpActor(req, query) {
    if (!pwDigest) return OPEN;
    if (authed(req, query)) return MASTER;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || '').trim());
    const t = m ? tokens.lookup(m[1]) : null;
    return t ? { kind: 'token', id: t.id, name: t.name } : null;
  }
  // 프로젝트가 있는지만 (없으면 404) — 레코드를 읽지 않는다(rev 캐시 또는 stat). 내용이 필요한 쓰기는 store 가 큐 안에서 다시 읽으므로
  // 여기서 읽으면 같은 파일을 두 번 읽는다. 404 를 편집 비밀번호(403)·본문(413·400)보다 먼저 답하는 순서는 예전 그대로
  async function needShow(id) {
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad_id');
    if (!(await store.exists(id))) throw new HttpError(404, 'not_found');
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
  // 관리자 키(X-Admin-Key, URL 인코딩 가능) 확인 — ADMIN_KEY 가 있을 때만 부른다. 틀리면 403 admin_forbidden,
  // IP 당 실패 제한(편집 비밀번호와 같은 창). 편집 비밀번호 초기화와 토큰 발급·폐기가 같이 쓴다
  function needAdmin(req) {
    const rk = clientIp(req) + '|#admin';
    const wait = limiter.blocked(rk);
    if (wait) throw new HttpError(429, 'too_many_attempts', { retryAfter: wait, headers: { 'Retry-After': String(wait) } });
    const v = req.headers['x-admin-key'];
    const cands = v ? [String(v)] : [];
    if (v) { try { cands.push(decodeURIComponent(String(v))); } catch (e) { /* 원문 그대로 */ } cands.push(Buffer.from(String(v), 'latin1').toString('utf8')); }
    let ok = false;
    for (const c of cands) if (crypto.timingSafeEqual(digest(c), adminDigest)) ok = true;
    if (!ok) { if (v) limiter.fail(rk); throw new HttpError(403, 'admin_forbidden'); }
  }
  function needKey(k) { if (!KEY_RE.test(k)) throw new HttpError(400, 'bad_file_key'); return k; }
  function checkShow(show) { const why = invalidShow(show); if (why) throw new HttpError(400, 'invalid_show', { message: why }); }

  async function api(req, res, parts, query) {
    const M = req.method;
    // /api/health 는 인증 없이 — 프론트가 서버 존재와 비밀번호 필요 여부를 알기 위해
    if (parts[0] === 'health' && parts.length === 1 && M === 'GET') {
      // schema = 서버가 아는 큐시트 형식(lib/validate.js SHOW_VER). 열어 둔 화면은 이것이 자기보다 높으면 새로고침을 요구한다
      return sendJson(res, 200, { ok: true, hasPassword: !!pwDigest, showCount: await store.count(), schema: SHOW_VER });
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
    if (parts[0] === 'tokens') return tokensApi(req, res, parts);
    if (parts[0] !== 'shows') throw new HttpError(404, 'not_found');
    const [, id, sub, key, extra] = parts;
    if (extra !== undefined) throw new HttpError(404, 'not_found');

    if (id === undefined) {
      if (M === 'GET') return sendJsonZ(req, res, 200, await store.list());
      if (M === 'POST') {
        const body = await readJson(req, JSON_LIMIT);
        checkShow(body && body.show);
        return sendJson(res, 201, await store.create(body.show, BROWSER));
      }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad_id');

    if (sub === undefined) {
      if (M === 'GET') {
        // 폴링 빠른 길: 메모리의 rev(store.cachedRev — 쓰기마다 store 가 고친다)와 맞으면 파일을 읽지 않고 304.
        // 인증(authed)·id 검사는 위에서 이미 지났다. 캐시에 없으면(시작 직후·되살린 직후) 아래에서 파일을 읽고 채운다
        const inm = req.headers['if-none-match'];
        const known = inm ? store.cachedRev(id) : undefined;
        if (known !== undefined && etagMatch(inm, known)) { res.writeHead(304, { ETag: `"${known}"` }); return res.end(); }
        // 200: 메모리의 본문(레코드 파일 바이트 그대로 = 예전 JSON.stringify(rec) 와 같은 JSON)을 보낸다. 없으면 파일을 읽어 채운다(store.loadBody)
        const b = store.cachedBody(id) || await store.loadBody(id);
        if (!b) throw new HttpError(404, 'not_found');
        const tag = `"${b.rev}"`;
        if (etagMatch(inm, b.rev)) { res.writeHead(304, { ETag: tag }); return res.end(); }
        const gz = b.raw.length >= GZIP_MIN_CACHED && accepts(req, 'gzip') ? await store.bodyGzip(id, b).catch(() => null) : null;
        return sendBytes(res, 200, b.raw, gz, { ETag: tag, Vary: 'Accept-Encoding' });
      }
      if (M === 'PUT') {
        await needShow(id);
        await needEdit(req, id);
        const body = await readJson(req, JSON_LIMIT);
        checkShow(body && body.show);
        const r = await store.put(id, body.baseRev, body.show, BROWSER);
        if (!r) throw new HttpError(404, 'not_found');
        // 옛 화면(옛 index.html)의 저장: 409 가 아닌 426 — 옛 화면은 409 에만 "내 버전으로 덮어쓰기"를 띄우고, 그 밖의 코드는 백업하고 재시도한다
        if (r.outdated) return sendJson(res, 426, { error: 'client_outdated', version: r.outdated.show.version, schema: SHOW_VER, message: `저장본(version ${r.outdated.show.version})보다 옛 형식(version ${body.show.version})이라 저장하지 않았습니다 — 화면을 새로고침하세요` });
        if (r.conflict) return sendJsonZ(req, res, 409, { error: 'conflict', rev: r.conflict.rev, updatedAt: r.conflict.updatedAt, show: r.conflict.show }, { ETag: `"${r.conflict.rev}"` });
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
      const r = await store.duplicate(id, BROWSER);
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
      needAdmin(req);
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
      if (key === undefined) return sendJsonZ(req, res, 200, await store.revisions(id));
      await needEdit(req, id);
      const rec = /^\d{1,12}$/.test(key) ? await store.getRevision(id, Number(key)) : null;
      if (!rec) throw new HttpError(404, 'not_found');
      return sendJsonZ(req, res, 200, rec);
    }
    if (sub === 'restore' && key === undefined) {
      if (M !== 'POST') throw new HttpError(405, 'method_not_allowed');
      await needShow(id);
      await needEdit(req, id);
      const body = await readJson(req, 64 * 1024);
      const r = await store.restore(id, Number(body && body.rev), body && body.baseRev, { by: BROWSER.by, via: 'restore' });
      if (!r) throw new HttpError(404, 'not_found');
      if (r.missing) throw new HttpError(404, 'rev_not_found');
      if (r.conflict) return sendJsonZ(req, res, 409, { error: 'conflict', rev: r.conflict.rev, updatedAt: r.conflict.updatedAt, show: r.conflict.show }, { ETag: `"${r.conflict.rev}"` });
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

  // 사람별 MCP 토큰 관리 — 위의 authed 를 지난 뒤라 사이트 비밀번호만 온다(/api 는 토큰을 받지 않는다).
  // ADMIN_KEY 가 있으면 발급·폐기는 관리자 키(X-Admin-Key)도 있어야 한다 — 토큰 이름이 기록의 "누가" 이므로, 사이트 비밀번호를 아는
  // 아무나 남의 이름으로 발급하거나 남의 토큰을 폐기하지 못하게. 목록은 사이트 비밀번호만. ADMIN_KEY 가 없으면 예전처럼 사이트 비밀번호로 다 된다
  //   GET /api/tokens → [{ id, name, createdAt, lastUsedAt }]   POST { name } → 201 { token, id, name, createdAt }   DELETE /api/tokens/:id
  async function tokensApi(req, res, parts) {
    const M = req.method, [, id, extra] = parts;
    if (extra !== undefined) throw new HttpError(404, 'not_found');
    if (!pwDigest) {
      throw new HttpError(404, 'tokens_disabled', { message: 'APP_PASSWORD 가 없는 서버는 인증 없이 열려 있어 토큰이 필요 없습니다' });
    }
    if (id === undefined) {
      if (M === 'GET') return sendJson(res, 200, tokens.list());
      if (M === 'POST') {
        if (adminDigest) needAdmin(req);
        const body = await readJson(req, 4096);
        try { return sendJson(res, 201, await tokens.create(body && body.name)); } catch (e) {
          if (e instanceof TokenError) throw new HttpError(e.status, e.code, { message: e.message });
          throw e;
        }
      }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (M !== 'DELETE') throw new HttpError(405, 'method_not_allowed');
    if (adminDigest) needAdmin(req);
    let gone;
    try { gone = await tokens.revoke(id); } catch (e) {
      console.error('tokens revoke:', e);
      throw new HttpError(500, 'save_failed', { message: '폐기를 파일에 저장하지 못했습니다 — 지금 실행 중인 서버에서는 막혔지만, 재시작 전에 다시 폐기하세요' });
    }
    if (!gone) throw new HttpError(404, 'not_found');
    return sendJson(res, 200, { ok: true });
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
    // 캐시: 화면은 올릴 때마다 새 fileKey 를 쓰지만 API 는 같은 키에 다시 PUT(덮어쓰기)을 받는다 — 그래서 immutable 이 아니라
    // private, no-cache + 강한 ETag(크기·mtime·inode — 덮어쓰기는 임시 파일 rename 이라 inode 가 바뀐다). 같으면 304, 다르면 새로 받는다
    const tag = `"${size.toString(36)}-${Math.round(st.mtimeMs * 1000).toString(36)}-${st.ino.toString(36)}"`;
    const cache = { ETag: tag, 'Cache-Control': 'private, no-cache' };
    if (etagMatch(req.headers['if-none-match'], tag.slice(1, -1))) { res.writeHead(304, cache); return res.end(); }
    // If-Range(이어 받기): 가진 조각의 ETag 가 지금과 다르면(덮어썼으면) Range 를 무시하고 전체 200 — 옛 조각과 새 조각을 섞지 않게.
    // Last-Modified 는 보내지 않으므로 날짜 If-Range 도 다른 것으로 본다
    const ifRange = req.headers['if-range'];
    const useRange = req.headers.range && (!ifRange || String(ifRange).trim() === tag);
    Object.assign(headers, cache);
    const range = useRange ? parseRange(req.headers.range, size) : null;
    if (range === 'bad') { res.writeHead(416, Object.assign(headers, { 'Content-Range': `bytes */${size}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })); return res.end(JSON.stringify({ error: 'range_not_satisfiable' })); }
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
        const actor = mcpActor(req, u.searchParams);
        if (!actor) {
          await settleUnreadBody(req, res);
          return sendJson(res, 401, { error: 'unauthorized', message: 'Authorization: Bearer <토큰> 헤더가 필요합니다 — 사이트의 에이전트 연결에서 토큰을 발급받으세요' }, { 'WWW-Authenticate': 'Bearer realm="cue-sheet"' });
        }
        await mcp(req, res, actor);
      } catch (e) {
        console.error(e);
        if (res.headersSent) { res.destroy(); return; }
        sendJson(res, 500, { error: 'server_error' });
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return text(404, 'not found');
    if (pathname === '/healthz') return text(200, 'ok');
    // 화면 파일은 staticFile(메모리 + ETag + gzip·br, 위 설명)
    const serveStatic = serve => serve(req, res).catch(() => { if (!res.headersSent) text(500, 'error'); else res.destroy(); });
    if (pathname === '/' || pathname === '/index.html') return serveStatic(serveIndex);
    // 브라우저 409 자동 병합 (index.html 이 서버 모드일 때만 이 경로를 <script> 로 동적으로 읽는다 — 같은 파일을 Node 테스트도 require)
    if (pathname === '/lib/merge.js') return serveStatic(serveMerge);
    // 공연 모드 Service Worker (index.html 이 서버 모드 + 공연 모드일 때만 등록). no-cache — 브라우저가 늘 새 워커가 있는지 확인하게
    if (pathname === '/sw.js') return serveStatic(serveSw);
    text(404, 'not found');
  });
  // 프록시(Railway 등)의 유휴 연결 시간보다 길게 — 서버가 먼저 닫아 재사용 중인 연결이 끊기는 경쟁을 줄인다
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000; // keepAliveTimeout 보다 커야 한다
  server.on('close', () => clearInterval(purgeT));
  server.ready = ready;
  server.store = store;
  server.tokens = tokens;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = createServer();
  server.ready.then(() => {
    server.listen(PORT, '0.0.0.0', () => console.log(`cue-sheet listening on :${PORT} (data: ${server.store.dir}${process.env.APP_PASSWORD ? ', password on' : ''})`));
  }, err => { console.error('DATA_DIR 를 준비할 수 없습니다:', err); process.exit(1); });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
