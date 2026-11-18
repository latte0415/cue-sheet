// GET 본문 캐시(store.bodies)·gzip, 음원 캐시 헤더, PUT 의 중복 읽기 제거, 화면 파일(index.html·merge.js·sw.js) ETag·압축
// — 임시 DATA_DIR(과 화면 파일 사본)로 서버를 띄워 검사한다. fetch 는 Accept-Encoding 을 스스로 붙이고 풀어 버리므로 헤더·바이트는 http.request 로 본다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Store, BodyCache } = require('../lib/store');
const { createServer } = require('../server');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const show = (title, extra) => Object.assign({ id: 'x', title, version: 5, parts: [{ id: 'pt1', name: '1부', scenes: [{ id: 's1', items: [] }] }], people: [], tracks: [] }, extra);
// 압축 문턱(1KB·8KB)을 넘는 큐시트: 메모를 길게
const bigShow = (title, kb) => show(title, { preShowSetup: ('무대 준비 메모 ' + title + ' ').repeat(Math.ceil(kb * 1024 / 20)) });
const EK = { 'X-Edit-Key': '1234' };
const J = (method, body, headers) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, EK, headers), body: body === undefined ? undefined : JSON.stringify(body) });

function start(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-cc-'));
  const server = createServer(Object.assign({ password: '', log: null, adminKey: '' }, opts, { dataDir: dir }));
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
}
function stop(s) { return new Promise(r => { s.server.closeAllConnections(); s.server.close(() => { fs.rmSync(s.dir, { recursive: true, force: true }); r(); }); }); }
// 헤더를 그대로(자동 Accept-Encoding·압축 풀기 없이). body = 받은 바이트, text = 압축을 푼 문자열
function raw(base, method, p, headers, body) {
  const u = new URL(base + p);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: Object.assign({}, headers, body ? { 'Content-Length': Buffer.byteLength(body) } : null) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks), enc = res.headers['content-encoding'];
        const plain = !b.length ? b : enc === 'gzip' ? zlib.gunzipSync(b) : enc === 'br' ? zlib.brotliDecompressSync(b) : b;
        resolve({ status: res.statusCode, headers: res.headers, body: b, plain, text: plain.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const showFile = (S, id) => path.join(S.dir, 'shows', id + '.json');
const disk = (S, id) => fs.readFileSync(showFile(S, id));
// 레코드 파일 읽기 횟수(fs.promises.readFile)와 store.get 호출 횟수를 센다. restore() 로 되돌린다
function spyReads(S) {
  const store = S.server.store, origRead = fs.promises.readFile, origGet = store.get;
  const n = { reads: 0, gets: 0 };
  const showsDir = path.join(S.dir, 'shows');
  fs.promises.readFile = function (f, ...rest) { if (path.dirname(String(f)) === showsDir && String(f).endsWith('.json')) n.reads++; return origRead.call(this, f, ...rest); };
  store.get = function (...a) { n.gets++; return origGet.apply(this, a); };
  n.restore = () => { fs.promises.readFile = origRead; store.get = origGet; };
  return n;
}
// GET 200 이 디스크와 같은 JSON 인지: 원본(Accept-Encoding 없음)·gzip 둘 다, 예전 응답(JSON.stringify(JSON.parse(파일)))과 바이트까지 같다
async function sameAsDisk(S, id, rev) {
  const file = disk(S, id), old = JSON.stringify(JSON.parse(file.toString('utf8')));
  const a = await raw(S.base, 'GET', '/api/shows/' + id);
  assert.equal(a.status, 200); assert.equal(a.headers['content-encoding'], undefined, 'Accept-Encoding 이 없으면 압축하지 않는다');
  assert.equal(a.headers.etag, `"${rev}"`); assert.equal(a.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(a.text, old, '예전 응답과 같은 바이트'); assert.equal(Number(a.headers['content-length']), a.body.length);
  assert.equal(JSON.parse(a.text).rev, rev);
  const g = await raw(S.base, 'GET', '/api/shows/' + id, { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(g.status, 200); assert.equal(g.headers.etag, `"${rev}"`); assert.equal(g.headers.vary, 'Accept-Encoding');
  if (file.length >= 1024) { assert.equal(g.headers['content-encoding'], 'gzip'); assert.ok(g.body.length < file.length); }
  assert.equal(g.text, old, 'gzip 을 풀면 같은 JSON');
  return JSON.parse(a.text);
}
function gate() { let open; const p = new Promise(r => { open = r; }); return { wait: () => p, open }; }
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// ---------- 1. GET 200 본문 캐시 + gzip
test('GET 200: 본문이 캐시에 있으면 파일을 읽지 않고(store.get 도 안 부름) 같은 JSON 을, gzip 요청엔 gzip 으로', async () => {
  const S = await start();
  try {
    const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: bigShow('A', 20) }))).json();
    const n = spyReads(S);
    try {
      await sameAsDisk(S, id, 1); // create 는 본문을 채우지 않는다 → 첫 GET 이 한 번 읽어 채운다
      assert.equal(n.reads, 1);
      for (let i = 0; i < 5; i++) await sameAsDisk(S, id, 1);
      await raw(S.base, 'GET', '/api/shows/' + id, { 'If-None-Match': '"0"', 'Accept-Encoding': 'gzip' });
      assert.equal(n.reads, 1, '그다음 200 들은 파일을 읽지 않는다');
      assert.equal(n.gets, 0, 'store.get 도 부르지 않는다');
      // gzip 본은 한 번만 만든다
      const e = S.server.store.cachedBody(id);
      assert.ok(e && e.gz && e.rev === 1);
      const gz = e.gz;
      await raw(S.base, 'GET', '/api/shows/' + id, { 'Accept-Encoding': 'gzip' });
      assert.equal(S.server.store.cachedBody(id).gz, gz);
      assert.equal(S.server.store.bodies.bytes, e.raw.length + gz.length, '바이트 합에 gzip 본도 센다');
      // q=0 은 거절, x-gzip·* 는 받음
      assert.equal((await raw(S.base, 'GET', '/api/shows/' + id, { 'Accept-Encoding': 'gzip;q=0, identity' })).headers['content-encoding'], undefined);
      assert.equal((await raw(S.base, 'GET', '/api/shows/' + id, { 'Accept-Encoding': '*' })).headers['content-encoding'], 'gzip');
      assert.equal((await raw(S.base, 'GET', '/api/shows/' + id, { 'Accept-Encoding': 'br' })).headers['content-encoding'], undefined, 'br 만 받으면 원본');
      // 304·404 는 예전 그대로
      const r = await raw(S.base, 'GET', '/api/shows/' + id, { 'If-None-Match': '"1"', 'Accept-Encoding': 'gzip' });
      assert.equal(r.status, 304); assert.equal(r.headers.etag, '"1"'); assert.equal(r.body.length, 0);
      assert.equal((await raw(S.base, 'GET', '/api/shows/nothere', { 'Accept-Encoding': 'gzip' })).status, 404);
      assert.equal((await raw(S.base, 'GET', '/api/shows/bad.id')).status, 400);
      // fetch(자동 gzip)로 받아도 같은 객체
      assert.deepEqual(await (await fetch(`${S.base}/api/shows/${id}`)).json(), JSON.parse(disk(S, id)));
    } finally { n.restore(); }
  } finally { await stop(S); }
});

test('본문 캐시는 모든 쓰기 경로 뒤 디스크와 같다: PUT·MCP 수정·복원(API·MCP)·복제·삭제(404)·되살리기(같은 id·새 id)', async () => {
  const S = await start({ password: 'site' });
  const A = { 'X-App-Key': 'site' };
  const f = (u, o) => fetch(u, Object.assign({}, o, { headers: Object.assign({}, A, o && o.headers) }));
  const store = S.server.store;
  const check = async (id, rev) => {
    const a = await raw(S.base, 'GET', '/api/shows/' + id, A);
    assert.equal(a.status, 200); assert.equal(JSON.parse(a.text).rev, rev); assert.equal(a.text, disk(S, id).toString('utf8'));
    const g = await raw(S.base, 'GET', '/api/shows/' + id, Object.assign({ 'Accept-Encoding': 'gzip' }, A));
    assert.equal(g.headers['content-encoding'], 'gzip'); assert.equal(g.text, disk(S, id).toString('utf8'));
    const e = store.cachedBody(id);
    assert.ok(e, `${id}: 본문이 캐시에 있다`); assert.equal(e.rev, rev); assert.equal(store.cachedRev(id), rev);
    assert.ok(e.raw.equals(disk(S, id)), '캐시 본문 = 디스크 바이트');
  };
  try {
    const { id } = await (await f(S.base + '/api/shows', J('POST', { show: bigShow('A', 4) }))).json();
    await check(id, 1);
    // PUT: 쓴 바이트를 그대로 캐시에 — 다음 GET 은 읽지 않는다
    assert.equal((await f(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: bigShow('A2', 4) }))).status, 200);
    let n = spyReads(S);
    try { await check(id, 2); assert.equal(n.reads, 0, 'PUT 뒤 GET 200 은 파일을 읽지 않는다'); } finally { n.restore(); }
    // 409·426 은 쓰지 않으므로 캐시 그대로
    assert.equal((await f(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: bigShow('X', 4) }))).status, 409);
    assert.equal((await f(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 2, show: Object.assign(bigShow('old', 4), { version: 4 }) }))).status, 426);
    await check(id, 2);
    // MCP edit_show 가 쓰는 store.update
    await store.update(id, s => Object.assign(s, { title: 'A3' }), { by: 't', via: 'mcp' });
    n = spyReads(S);
    try { await check(id, 3); assert.equal(n.reads, 0); } finally { n.restore(); }
    // /api 복원
    assert.equal((await f(`${S.base}/api/shows/${id}/restore`, J('POST', { rev: 1 }))).status, 200);
    await check(id, 4);
    assert.equal(JSON.parse(disk(S, id)).show.title, 'A');
    // MCP restore_revision (실제 /mcp)
    const client = new Client({ name: 'cc-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(S.base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer site', 'X-Edit-Key': '1234' } } }));
    try {
      const m = await client.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 2 } });
      assert.ok(!m.isError, JSON.stringify(m.content));
    } finally { await client.close(); }
    await check(id, 5);
    assert.equal(JSON.parse(disk(S, id)).show.title, 'A2');
    // 복제: 새 id 는 rev 1, 원본은 그대로
    const dup = (await (await f(`${S.base}/api/shows/${id}/duplicate`, { method: 'POST' })).json()).id;
    await check(dup, 1); await check(id, 5);
    // 삭제 → 본문 캐시도 지우고 404 (본문을 들고 있어도)
    const t1 = (await (await f(`${S.base}/api/shows/${id}`, { method: 'DELETE', headers: EK })).json()).trashId;
    assert.equal(store.cachedBody(id), undefined); assert.equal(store.bodies.map.has(id), false);
    assert.equal((await raw(S.base, 'GET', '/api/shows/' + id, Object.assign({ 'Accept-Encoding': 'gzip' }, A))).status, 404);
    // 되살리기(같은 id)
    assert.equal((await (await f(`${S.base}/api/trash/${t1}/restore`, { method: 'POST' })).json()).id, id);
    assert.equal(store.bodies.map.has(id), false, '되살린 직후엔 비어 있다 — 다음 GET 이 읽어 채운다');
    await check(id, 5);
    // 되살리기(새 id): 같은 원래 id 의 항목 둘
    const t2 = (await (await f(`${S.base}/api/shows/${id}`, { method: 'DELETE', headers: EK })).json()).trashId;
    const t3 = id + '-' + (Number(t2.split('-').pop()) + 1);
    fs.cpSync(path.join(S.dir, 'trash', t2), path.join(S.dir, 'trash', t3), { recursive: true });
    assert.equal((await (await f(`${S.base}/api/trash/${t2}/restore`, { method: 'POST' })).json()).id, id);
    assert.equal((await f(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 5, show: bigShow('A6', 4) }))).status, 200);
    await check(id, 6);
    const rr = await (await f(`${S.base}/api/trash/${t3}/restore`, { method: 'POST' })).json();
    assert.notEqual(rr.id, id);
    await check(rr.id, 5); await check(id, 6);
  } finally { await stop(S); }
});

test('GET 이 파일을 읽는 사이 PUT 이 끼어들면: 그 GET 은 읽은 대로(예전처럼) 답하되 옛 본문으로 캐시를 덮지 않는다', async () => {
  const S = await start();
  const origRead = fs.promises.readFile;
  try {
    const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: bigShow('A', 2) }))).json();
    const store = S.server.store;
    store.revCache.clear(); store.bodies.clear(); // 재시작 직후처럼
    const file = showFile(S, id), g = gate();
    let first = true;
    fs.promises.readFile = async function (f2, ...rest) {
      const data = await origRead.call(this, f2, ...rest);
      if (first && String(f2) === file) { first = false; await g.wait(); }
      return data;
    };
    const slow = raw(S.base, 'GET', '/api/shows/' + id, { 'Accept-Encoding': 'gzip' });
    await tick(50);
    // PUT 의 store.put 은 큐 안에서 다시 읽는다 — 첫 읽기(멈춘 GET)와 다른 읽기라 막히지 않는다
    assert.equal((await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: bigShow('A2', 2) }))).status, 200);
    assert.equal(store.cachedRev(id), 2); assert.equal(store.cachedBody(id).rev, 2);
    g.open();
    const r = await slow;
    assert.equal(r.status, 200); assert.equal(r.headers.etag, '"1"'); assert.equal(JSON.parse(r.text).rev, 1, '옛 내용을 읽었다(ETag 와 본문의 rev 가 같다)');
    assert.equal(store.cachedRev(id), 2); assert.equal(store.cachedBody(id).rev, 2, '옛 본문으로 덮지 않는다');
    assert.ok(store.cachedBody(id).raw.equals(disk(S, id)));
    // store 단: loadBody 도 같은 규칙
    store.revCache.clear(); store.bodies.clear();
    const g2 = gate(); first = true;
    fs.promises.readFile = async function (f2, ...rest) {
      const data = await origRead.call(this, f2, ...rest);
      if (first && String(f2) === file) { first = false; await g2.wait(); }
      return data;
    };
    const lb = store.loadBody(id);
    await tick();
    fs.promises.readFile = origRead;
    assert.equal((await store.put(id, 2, bigShow('A3', 2))).rev, 3);
    g2.open();
    assert.equal((await lb).rev, 2);
    assert.equal(store.cachedBody(id).rev, 3); assert.equal(store.cachedRev(id), 3);
  } finally { fs.promises.readFile = origRead; await stop(S); }
});

test('본문 캐시 상한(LRU, 바이트 합): 넘으면 오래 안 쓴 것부터 버리고, 상한보다 큰 본문은 두지 않는다 — 응답은 늘 맞다', async () => {
  // BodyCache 단위
  const c = new BodyCache(100);
  const e = n => ({ rev: 1, raw: Buffer.alloc(n) });
  c.set('a', e(40)); c.set('b', e(40));
  c.get('a'); // a 를 최근으로
  c.set('c', e(40)); // 120 > 100 → 가장 오래 안 쓴 b 를 버린다
  assert.deepEqual([...c.map.keys()], ['a', 'c']); assert.equal(c.bytes, 80);
  c.set('big', e(101)); assert.equal(c.map.has('big'), false, '상한보다 큰 것은 두지 않는다'); assert.equal(c.bytes, 80);
  c.addGz('a', c.get('a'), Buffer.alloc(30)); // 서버처럼 get(최근으로) 뒤 gzip 을 붙인다: 110 → c 를 버린다
  assert.deepEqual([...c.map.keys()], ['a']); assert.equal(c.bytes, 70);
  const gone = e(10); c.addGz('zz', gone, Buffer.alloc(5)); assert.equal(c.bytes, 70, '캐시에 없는 항목의 gzip 은 세지 않는다');
  c.delete('a'); assert.equal(c.bytes, 0);

  // 서버: 본문 ~3KB 셋, 상한 7KB → 둘까지
  const S = await start({ bodyCacheBytes: 7 * 1024 });
  try {
    const ids = [];
    for (const t of ['P', 'Q', 'R']) ids.push((await (await fetch(S.base + '/api/shows', J('POST', { show: bigShow(t, 3) }))).json()).id);
    for (let round = 0; round < 3; round++) for (const id of ids) {
      await sameAsDisk(S, id, 1);
      const b = S.server.store.bodies;
      assert.ok(b.bytes <= 7 * 1024, `바이트 합 ${b.bytes} ≤ 상한`);
      assert.ok(b.map.size <= 2);
      assert.equal(b.bytes, [...b.map.values()].reduce((n, x) => n + x.raw.length + (x.gz ? x.gz.length : 0), 0), '셈이 맞다');
    }
    // 쓰기도 상한을 지킨다
    for (const id of ids) assert.equal((await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: bigShow(id, 3) }))).status, 200);
    assert.ok(S.server.store.bodies.bytes <= 7 * 1024);
    for (const id of ids) await sameAsDisk(S, id, 2);
  } finally { await stop(S); }
  // 상한보다 큰 본문: 캐시하지 않고 매번 읽어 답한다
  const T = await start({ bodyCacheBytes: 2048 });
  try {
    const { id } = await (await fetch(T.base + '/api/shows', J('POST', { show: bigShow('Big', 8) }))).json();
    assert.equal((await fetch(`${T.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: bigShow('Big2', 8) }))).status, 200);
    assert.equal(T.server.store.bodies.map.size, 0);
    const n = spyReads(T);
    try {
      await sameAsDisk(T, id, 2); await sameAsDisk(T, id, 2);
      assert.equal(n.reads, 4, '캐시하지 않으므로 GET 마다 읽는다');
    } finally { n.restore(); }
    assert.equal(T.server.store.bodies.map.size, 0); assert.equal(T.server.store.cachedRev(id), 2, 'rev 캐시는 그대로');
    assert.equal((await raw(T.base, 'GET', '/api/shows/' + id, { 'If-None-Match': '"2"' })).status, 304);
  } finally { await stop(T); }
});

test('큰 JSON 응답(409 의 큐시트 전체·목록·기록)은 gzip 을 받으면 압축, 작거나 Accept-Encoding 이 없으면 그대로', async () => {
  const S = await start();
  try {
    const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: bigShow('A', 20) }))).json();
    const body = JSON.stringify({ baseRev: 0, show: bigShow('B', 20) });
    let r = await raw(S.base, 'PUT', '/api/shows/' + id, Object.assign({ 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' }, EK), body);
    assert.equal(r.status, 409); assert.equal(r.headers['content-encoding'], 'gzip'); assert.equal(r.headers.etag, '"1"'); assert.equal(r.headers.vary, 'Accept-Encoding');
    const c = JSON.parse(r.text);
    assert.equal(c.error, 'conflict'); assert.equal(c.rev, 1); assert.equal(c.show.title, 'A');
    r = await raw(S.base, 'PUT', '/api/shows/' + id, Object.assign({ 'Content-Type': 'application/json' }, EK), body);
    assert.equal(r.status, 409); assert.equal(r.headers['content-encoding'], undefined); assert.deepEqual(JSON.parse(r.text), c);
    // 목록이 작으면 압축하지 않는다
    r = await raw(S.base, 'GET', '/api/shows', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.status, 200); assert.equal(r.headers['content-encoding'], undefined); assert.equal(JSON.parse(r.text)[0].id, id);
    // 기록 내용(rev 1)은 크다
    assert.equal((await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: bigShow('A2', 20) }))).status, 200);
    r = await raw(S.base, 'GET', `/api/shows/${id}/history/1`, Object.assign({ 'Accept-Encoding': 'gzip' }, EK));
    assert.equal(r.status, 200); assert.equal(r.headers['content-encoding'], 'gzip'); assert.equal(JSON.parse(r.text).show.title, 'A');
    // 오류 응답은 예전 그대로(작다)
    r = await raw(S.base, 'GET', '/api/shows/nothere/history', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.status, 404); assert.equal(r.headers['content-encoding'], undefined); assert.equal(JSON.parse(r.text).error, 'not_found');
  } finally { await stop(S); }
});

// ---------- 2. 음원 캐시 헤더
test('음원: private, no-cache + 강한 ETag, If-None-Match → 304, Range·If-Range, 같은 키에 덮어쓰면 ETag 가 바뀐다', async () => {
  const S = await start({ password: 'site' });
  const A = { 'X-App-Key': 'site' };
  try {
    const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('음원') }, A))).json();
    const P = `/api/shows/${id}/audio/f-1`;
    const bytes = Buffer.alloc(1000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    assert.equal((await fetch(S.base + P, { method: 'PUT', headers: { ...A, ...EK, 'Content-Type': 'audio/wav' }, body: bytes })).status, 200);
    let r = await raw(S.base, 'GET', P, A);
    assert.equal(r.status, 200); assert.ok(r.body.equals(bytes));
    assert.equal(r.headers['cache-control'], 'private, no-cache');
    const tag = r.headers.etag;
    assert.match(tag, /^"[0-9a-z]+-[0-9a-z]+-[0-9a-z]+"$/);
    // 인증은 그대로: 비밀번호 없으면 401(no-store)
    r = await raw(S.base, 'GET', P);
    assert.equal(r.status, 401); assert.equal(r.headers['cache-control'], 'no-store');
    // 304 (GET·HEAD), 다른 ETag 면 200
    r = await raw(S.base, 'GET', P, { ...A, 'If-None-Match': tag });
    assert.equal(r.status, 304); assert.equal(r.headers.etag, tag); assert.equal(r.headers['cache-control'], 'private, no-cache'); assert.equal(r.body.length, 0);
    assert.equal((await raw(S.base, 'HEAD', P, { ...A, 'If-None-Match': tag })).status, 304);
    assert.equal((await raw(S.base, 'GET', P, { ...A, 'If-None-Match': '"nope"' })).status, 200);
    r = await raw(S.base, 'HEAD', P, A);
    assert.equal(r.status, 200); assert.equal(r.headers.etag, tag); assert.equal(r.headers['content-length'], '1000');
    // Range 는 그대로, If-None-Match 가 맞으면 Range 보다 먼저 304
    r = await raw(S.base, 'GET', P, { ...A, Range: 'bytes=100-199' });
    assert.equal(r.status, 206); assert.equal(r.headers['content-range'], 'bytes 100-199/1000'); assert.equal(r.headers.etag, tag);
    assert.ok(r.body.equals(bytes.subarray(100, 200)));
    assert.equal((await raw(S.base, 'GET', P, { ...A, Range: 'bytes=100-199', 'If-None-Match': tag })).status, 304);
    r = await raw(S.base, 'GET', P, { ...A, Range: 'bytes=5000-' });
    assert.equal(r.status, 416); assert.equal(r.headers['content-range'], 'bytes */1000'); assert.equal(r.headers['cache-control'], 'no-store');
    // If-Range: 같으면 206, 다르면(약한 ETag·날짜 포함) Range 를 무시하고 200 전체
    assert.equal((await raw(S.base, 'GET', P, { ...A, Range: 'bytes=0-9', 'If-Range': tag })).status, 206);
    for (const ir of ['"other"', 'W/' + tag, new Date().toUTCString()]) {
      r = await raw(S.base, 'GET', P, { ...A, Range: 'bytes=0-9', 'If-Range': ir });
      assert.equal(r.status, 200, ir); assert.ok(r.body.equals(bytes));
    }
    // ?download=1 도 같은 ETag
    assert.equal((await raw(S.base, 'GET', P + '?download=1', A)).headers.etag, tag);
    // 같은 키에 덮어쓰기(API 는 받는다) → ETag 가 바뀌고 옛 ETag 는 200 + 새 바이트. 크기가 같아도
    const bytes2 = Buffer.from(bytes).reverse();
    assert.equal((await fetch(S.base + P, { method: 'PUT', headers: { ...A, ...EK, 'Content-Type': 'audio/wav' }, body: bytes2 })).status, 200);
    r = await raw(S.base, 'GET', P, { ...A, 'If-None-Match': tag });
    assert.equal(r.status, 200); assert.notEqual(r.headers.etag, tag); assert.ok(r.body.equals(bytes2));
    r = await raw(S.base, 'GET', P, { ...A, Range: 'bytes=0-9', 'If-Range': tag });
    assert.equal(r.status, 200, '옛 조각과 섞지 않는다'); assert.ok(r.body.equals(bytes2));
    // 지우면 404 (304 아님)
    assert.equal((await fetch(S.base + P, { method: 'DELETE', headers: { ...A, ...EK } })).status, 200);
    assert.equal((await raw(S.base, 'GET', P, { ...A, 'If-None-Match': '*' })).status, 404);
  } finally { await stop(S); }
});

// ---------- 3. PUT 의 중복 읽기 제거 — 상태 코드 순서는 그대로
test('PUT: 401 → 400(id) → 404 → 403 → 400(본문) → 426 → 409 순서는 예전 그대로, 레코드 파일은 한 번만 읽는다', async () => {
  const S = await start({ password: 'site' });
  const A = { 'X-App-Key': 'site' };
  const put = (id, body, headers) => raw(S.base, 'PUT', '/api/shows/' + id, Object.assign({ 'Content-Type': 'application/json' }, A, headers), typeof body === 'string' ? body : JSON.stringify(body));
  try {
    const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('A') }, A))).json();
    // 인증이 맨 먼저
    assert.equal((await raw(S.base, 'PUT', '/api/shows/' + id, { 'Content-Type': 'application/json', ...EK }, '{}')).status, 401);
    // 400 bad_id
    assert.equal((await put('bad.id', '{}', EK)).status, 400);
    // 없는 id: 편집 비밀번호가 틀리거나 본문이 깨져도 404
    for (const h of [EK, { 'X-Edit-Key': 'wrong' }, {}]) {
      const r = await put('nothere', 'not json', h);
      assert.equal(r.status, 404, JSON.stringify(h)); assert.equal(JSON.parse(r.text).error, 'not_found');
    }
    // 캐시가 비어 있어도(재시작 직후) 같은 답 — 있으면 stat 으로, 없으면 404
    S.server.store.revCache.clear(); S.server.store.bodies.clear();
    assert.equal((await put('nothere', 'not json', EK)).status, 404);
    assert.equal((await put(id, 'not json', { 'X-Edit-Key': 'wrong' })).status, 403);
    // 있는 id: 편집 비밀번호가 본문보다 먼저 (403 edit_forbidden)
    let r = await put(id, 'not json', { 'X-Edit-Key': 'wrong' });
    assert.equal(r.status, 403); assert.equal(JSON.parse(r.text).error, 'edit_forbidden');
    r = await put(id, 'not json', EK);
    assert.equal(r.status, 400); assert.equal(JSON.parse(r.text).error, 'bad_json');
    r = await put(id, { baseRev: 1, show: { title: 'no parts' } }, EK);
    assert.equal(r.status, 400); assert.equal(JSON.parse(r.text).error, 'invalid_show');
    // 426(옛 형식)은 409 보다 먼저
    r = await put(id, { baseRev: 0, show: show('old', { version: 4 }) }, EK);
    assert.equal(r.status, 426); assert.equal(JSON.parse(r.text).error, 'client_outdated');
    r = await put(id, { baseRev: 0, show: show('X') }, EK);
    assert.equal(r.status, 409); assert.equal(JSON.parse(r.text).rev, 1);
    // 읽기 횟수: 캐시가 비어 있을 때도 따뜻할 때도 PUT 하나에 레코드 파일 한 번 (예전엔 needShow + store.put 로 두 번)
    S.server.store.revCache.clear(); S.server.store.bodies.clear();
    const n = spyReads(S);
    try {
      r = await put(id, { baseRev: 1, show: show('A2') }, EK);
      assert.equal(r.status, 200); assert.equal(n.reads, 1, '캐시가 빈 PUT');
      r = await put(id, { baseRev: 2, show: show('A3') }, EK);
      assert.equal(r.status, 200); assert.equal(n.reads, 2, '캐시가 있는 PUT');
      // 409 도 한 번
      r = await put(id, { baseRev: 1, show: show('A4') }, EK);
      assert.equal(r.status, 409); assert.equal(n.reads, 3);
      // 레코드를 쓰지 않는 다른 경로는 아예 읽지 않는다: 편집 확인·음원 목록·음원 GET·DELETE
      const before = n.reads;
      assert.equal((await raw(S.base, 'POST', `/api/shows/${id}/edit-check`, { ...A, ...EK })).status, 200);
      assert.equal((await raw(S.base, 'PUT', `/api/shows/${id}/audio/f-1`, { ...A, ...EK, 'Content-Type': 'audio/wav' }, 'RIFF')).status, 200);
      assert.equal((await raw(S.base, 'GET', `/api/shows/${id}/audio`, A)).status, 200);
      assert.equal((await raw(S.base, 'GET', `/api/shows/${id}/audio/f-1`, A)).status, 200);
      assert.equal(n.reads, before, '존재 확인만 하는 경로는 레코드를 읽지 않는다');
      assert.equal(n.gets, 3, 'store.get 은 PUT 셋의 큐 안에서만');
    } finally { n.restore(); }
    // 다른 하위 경로도 없는 id 는 예전처럼 404
    for (const [m, p] of [['DELETE', ''], ['POST', '/edit-check'], ['POST', '/edit-password'], ['GET', '/history'], ['POST', '/restore'], ['GET', '/audio'], ['GET', '/audio/f-1']]) {
      assert.equal((await raw(S.base, m, '/api/shows/nothere' + p, { ...A, ...EK, 'Content-Type': 'application/json' }, m === 'GET' ? undefined : '{}')).status, 404, m + ' ' + p);
    }
    // 삭제한 id 는 rev 캐시가 비므로 404
    assert.equal((await raw(S.base, 'DELETE', '/api/shows/' + id, { ...A, ...EK })).status, 200);
    assert.equal((await put(id, { baseRev: 3, show: show('Z') }, EK)).status, 404);
  } finally { await stop(S); }
});

// ---------- 4. 화면 파일
test('화면 파일(index.html·merge.js·sw.js): 약한 ETag·304, gzip·br, HEAD, 파일이 바뀌면 다시 읽는다', async () => {
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-static-'));
  fs.mkdirSync(path.join(sdir, 'lib'));
  const index1 = '<!doctype html><title>t</title>' + '<p>큐시트 화면</p>'.repeat(2000);
  fs.writeFileSync(path.join(sdir, 'index.html'), index1);
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'merge.js'), path.join(sdir, 'lib', 'merge.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'sw.js'), path.join(sdir, 'sw.js'));
  const S = await start({ staticDir: sdir });
  try {
    for (const [p, file, type] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/index.html', 'index.html', 'text/html; charset=utf-8'], ['/lib/merge.js', 'lib/merge.js', 'text/javascript; charset=utf-8'], ['/sw.js', 'sw.js', 'text/javascript; charset=utf-8']]) {
      const want = fs.readFileSync(path.join(sdir, file));
      const a = await raw(S.base, 'GET', p);
      assert.equal(a.status, 200); assert.equal(a.headers['content-type'], type); assert.equal(a.headers['cache-control'], 'no-cache');
      assert.equal(a.headers['content-encoding'], undefined); assert.ok(a.body.equals(want), p + ' 원본');
      assert.equal(a.headers.vary, 'Accept-Encoding');
      const tag = a.headers.etag;
      assert.match(tag, /^W\/"[A-Za-z0-9_-]+"$/);
      const g = await raw(S.base, 'GET', p, { 'Accept-Encoding': 'gzip, deflate' });
      assert.equal(g.headers['content-encoding'], 'gzip'); assert.ok(g.plain.equals(want)); assert.equal(g.headers.etag, tag);
      assert.equal(Number(g.headers['content-length']), g.body.length);
      const b = await raw(S.base, 'GET', p, { 'Accept-Encoding': 'gzip, deflate, br' });
      assert.equal(b.headers['content-encoding'], 'br'); assert.ok(b.plain.equals(want));
      // 304: W/ 가 있든 없든, 여러 값 중 하나여도
      for (const inm of [tag, tag.slice(2), `"x", ${tag}`]) {
        const r = await raw(S.base, 'GET', p, { 'If-None-Match': inm, 'Accept-Encoding': 'br' });
        assert.equal(r.status, 304, inm); assert.equal(r.headers.etag, tag); assert.equal(r.body.length, 0);
      }
      assert.equal((await raw(S.base, 'GET', p, { 'If-None-Match': 'W/"other"' })).status, 200);
      const h = await raw(S.base, 'HEAD', p, { 'Accept-Encoding': 'gzip' });
      assert.equal(h.status, 200); assert.equal(h.body.length, 0); assert.equal(h.headers['content-length'], g.headers['content-length']);
    }
    // 파일을 고치면(서버 재시작 없이) 다음 요청에 새 내용·새 ETag. 크기가 같아도 mtime 이 바뀌면
    const old = (await raw(S.base, 'GET', '/')).headers.etag;
    const index2 = index1.replace('<title>t</title>', '<title>u</title>');
    assert.equal(index2.length, index1.length);
    fs.writeFileSync(path.join(sdir, 'index.html'), index2);
    fs.utimesSync(path.join(sdir, 'index.html'), new Date(), new Date(Date.now() + 5000));
    let r = await raw(S.base, 'GET', '/', { 'If-None-Match': old, 'Accept-Encoding': 'br' });
    assert.equal(r.status, 200); assert.notEqual(r.headers.etag, old); assert.equal(r.text, index2);
    r = await raw(S.base, 'GET', '/', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.text, index2);
    // 내용이 같으면(mtime 만 바뀜) ETag 도 같다
    const t2 = r.headers.etag;
    fs.utimesSync(path.join(sdir, 'index.html'), new Date(), new Date(Date.now() + 10000));
    assert.equal((await raw(S.base, 'GET', '/', { 'If-None-Match': t2 })).status, 304);
    // 파일이 없어지면 500 (예전과 같음), 돌아오면 다시
    fs.rmSync(path.join(sdir, 'sw.js'));
    assert.equal((await raw(S.base, 'GET', '/sw.js')).status, 500);
    fs.copyFileSync(path.join(__dirname, '..', 'sw.js'), path.join(sdir, 'sw.js'));
    assert.equal((await raw(S.base, 'GET', '/sw.js')).status, 200);
    // POST 는 예전처럼 404
    assert.equal((await raw(S.base, 'POST', '/')).status, 404);
  } finally { await stop(S); fs.rmSync(sdir, { recursive: true, force: true }); }
});

test('화면 파일 기본 위치(staticDir 없음)는 저장소의 index.html 을 그대로 보낸다', async () => {
  const S = await start();
  try {
    const r = await raw(S.base, 'GET', '/', { 'Accept-Encoding': 'br' });
    assert.equal(r.status, 200); assert.ok(r.plain.equals(fs.readFileSync(path.join(__dirname, '..', 'index.html'))));
  } finally { await stop(S); }
});
