// node --test test/ — 임시 DATA_DIR 로 서버를 띄워 API 를 검사한다 (의존성 없음)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');

function start(password) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-test-'));
  const server = createServer({ dataDir: dir, password, log: null });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
}
function stop(s) { return new Promise(r => s.server.close(() => { fs.rmSync(s.dir, { recursive: true, force: true }); r(); })); }
const show = (title, extra) => Object.assign({ id: 'x', title, version: 5, parts: [{ id: 'pt1', name: '1부', scenes: [{ id: 's1', items: [{ id: 'i1', cues: [{ id: 'q1' }, { id: 'q2' }] }] }] }], people: [], tracks: [] }, extra);
const J = (method, body, headers) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });

let S;
before(async () => { S = await start(''); });
after(() => stop(S));

test('health: 비밀번호 없음, showCount', async () => {
  const r = await fetch(S.base + '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { ok: true, hasPassword: false, showCount: 0 });
  assert.equal((await fetch(S.base + '/healthz')).status, 200);
  assert.equal((await fetch(S.base + '/')).status, 200);
  assert.equal((await fetch(S.base + '/nope')).status, 404);
  assert.equal((await fetch(S.base + '/api/nope')).status, 404);
});

test('shows: 404 → POST → GET → ETag 304 → PUT → 409 → 덮어쓰기', async () => {
  let r = await fetch(S.base + '/api/shows/nothere');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'not_found' });
  assert.deepEqual(await (await fetch(S.base + '/api/shows')).json(), []);

  r = await fetch(S.base + '/api/shows', J('POST', { show: show('A') }));
  assert.equal(r.status, 201);
  const { id, rev } = await r.json();
  assert.match(id, /^[A-Za-z0-9_-]{1,32}$/);
  assert.equal(rev, 1);
  assert.ok(fs.existsSync(path.join(S.dir, 'shows', id + '.json')));

  r = await fetch(`${S.base}/api/shows/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), '"1"');
  const g = await r.json();
  assert.equal(g.rev, 1); assert.equal(g.show.title, 'A'); assert.ok(!isNaN(Date.parse(g.updatedAt)));

  r = await fetch(`${S.base}/api/shows/${id}`, { headers: { 'If-None-Match': '"1"' } });
  assert.equal(r.status, 304);

  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show('A2') }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rev, 2);
  r = await fetch(`${S.base}/api/shows/${id}`, { headers: { 'If-None-Match': '"1"' } });
  assert.equal(r.status, 200, '새 rev 면 304 아님');

  // 다른 기기가 rev 1 기준으로 저장 → 409 + 서버 버전
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show('B') }));
  assert.equal(r.status, 409);
  const c = await r.json();
  assert.equal(c.error, 'conflict'); assert.equal(c.rev, 2); assert.equal(c.show.title, 'A2'); assert.ok(c.updatedAt);
  // 덮어쓰기: 서버 rev 를 base 로
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: c.rev, show: show('B') }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rev, 3);
  assert.equal((await (await fetch(`${S.base}/api/shows/${id}`)).json()).show.title, 'B');

  // 검증
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 3, show: { version: 5 } }));
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_show');
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 3, show: { parts: [] } }));
  assert.equal(r.status, 400);
  r = await fetch(`${S.base}/api/shows/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'bad_json');
  r = await fetch(`${S.base}/api/shows/nothere`, J('PUT', { baseRev: 0, show: show('Z') }));
  assert.equal(r.status, 404);
  r = await fetch(`${S.base}/api/shows/bad.id!`);
  assert.equal(r.status, 400);
});

test('동시 PUT 은 직렬화 — 같은 baseRev 둘 중 하나만 성공', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('C') }))).json();
  const rs = await Promise.all([1, 2, 3].map(n => fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show('C' + n) }))));
  const codes = rs.map(r => r.status).sort();
  assert.deepEqual(codes, [200, 409, 409]);
});

test('5MB 초과 JSON → 413', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('Big') }))).json();
  const big = show('Big', { pad: 'x'.repeat(5 * 1024 * 1024 + 10) });
  const r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: big }));
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'too_large');
  const r2 = await fetch(S.base + '/api/shows', J('POST', { show: big }));
  assert.equal(r2.status, 413);
});

test('목록 · 복제 · 삭제(음원 폴더까지)', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('목록용') }))).json();
  const bytes = Buffer.from('RIFFxxxxWAVE-data-0123456789');
  let r = await fetch(`${S.base}/api/shows/${id}/audio/f-dup`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav', 'X-File-Name': encodeURIComponent('곡.wav') }, body: bytes });
  assert.equal(r.status, 200);

  const list = await (await fetch(S.base + '/api/shows')).json();
  const it = list.find(x => x.id === id);
  assert.ok(it);
  assert.equal(it.title, '목록용'); assert.equal(it.rev, 1); assert.equal(it.sceneCount, 1); assert.equal(it.cueCount, 2); assert.ok(it.updatedAt);
  const h = await (await fetch(S.base + '/api/health')).json();
  assert.equal(h.showCount, list.length);

  r = await fetch(`${S.base}/api/shows/${id}/duplicate`, { method: 'POST' });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.notEqual(d.id, id); assert.equal(d.rev, 1);
  const dg = await (await fetch(`${S.base}/api/shows/${d.id}`)).json();
  assert.equal(dg.show.title, '목록용 (복제)');
  // 복제는 음원 파일도 복사한다
  r = await fetch(`${S.base}/api/shows/${d.id}/audio/f-dup`);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  assert.equal((await fetch(`${S.base}/api/shows/nothere/duplicate`, { method: 'POST' })).status, 404);

  r = await fetch(`${S.base}/api/shows/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(S.dir, 'shows', id + '.json')));
  assert.ok(!fs.existsSync(path.join(S.dir, 'shows', id)), '음원 폴더도 삭제');
  assert.equal((await fetch(`${S.base}/api/shows/${id}`)).status, 404);
  assert.equal((await fetch(`${S.base}/api/shows/${id}`, { method: 'DELETE' })).status, 404);
  // 복제본은 남아 있다
  assert.equal((await fetch(`${S.base}/api/shows/${d.id}/audio/f-dup`)).status, 200);
});

test('음원: PUT → GET 전체 → Range 206 → 목록 → DELETE → 전체 삭제', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('음원') }))).json();
  const A = `${S.base}/api/shows/${id}/audio`;
  const bytes = Buffer.alloc(1000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  let r = await fetch(A + '/f-abc_1', { method: 'PUT', headers: { 'Content-Type': 'audio/wav', 'X-File-Name': encodeURIComponent('01 오프닝.wav') }, body: bytes });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { fileKey: 'f-abc_1', size: 1000, name: '01 오프닝.wav' });

  r = await fetch(A + '/f-abc_1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-length'), '1000');
  assert.match(r.headers.get('content-disposition'), /^inline; .*filename\*=UTF-8''01%20%EC%98%A4%ED%94%84%EB%8B%9D\.wav$/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);

  r = await fetch(A + '/f-abc_1', { headers: { Range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(100, 200));
  r = await fetch(A + '/f-abc_1', { headers: { Range: 'bytes=990-' } });
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 990-999/1000');
  r = await fetch(A + '/f-abc_1', { headers: { Range: 'bytes=-10' } });
  assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 10);
  r = await fetch(A + '/f-abc_1', { headers: { Range: 'bytes=5000-' } });
  assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), 'bytes */1000');

  r = await fetch(A + '/f-abc_1?download=1');
  assert.match(r.headers.get('content-disposition'), /^attachment;/);

  r = await fetch(A + '/f-two', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('xyz') });
  assert.equal(r.status, 200);
  r = await fetch(A + '/f-bad', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);

  let list = await (await fetch(A)).json();
  assert.deepEqual(list.map(x => x.fileKey).sort(), ['f-abc_1', 'f-two']);
  assert.deepEqual(list.find(x => x.fileKey === 'f-abc_1'), { fileKey: 'f-abc_1', name: '01 오프닝.wav', size: 1000, mime: 'audio/wav' });

  r = await fetch(A + '/f-two', { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await fetch(A + '/f-two')).status, 404);
  assert.equal((await fetch(A + '/f-two', { method: 'DELETE' })).status, 404);

  r = await fetch(A, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(await (await fetch(A)).json(), []);
  assert.equal((await fetch(`${S.base}/api/shows/nothere/audio`)).status, 404);
});

test('fileKey 검증 → 400', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('키') }))).json();
  const A = `${S.base}/api/shows/${id}/audio`;
  for (const k of ['a.b', 'a%20b', 'x'.repeat(65), 'ab$', '%E3%84%B1']) {
    const r = await fetch(A + '/' + k, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: 'x' });
    assert.equal(r.status, 400, k);
    assert.equal((await r.json()).error, 'bad_file_key');
  }
  const r = await fetch(A + '/' + 'x'.repeat(64), { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: 'x' });
  assert.equal(r.status, 200);
});

test('프로젝트별 음원 격리: A 의 fileKey 를 B 에서 GET → 404', async () => {
  const a = await (await fetch(S.base + '/api/shows', J('POST', { show: show('A') }))).json();
  const b = await (await fetch(S.base + '/api/shows', J('POST', { show: show('B') }))).json();
  await fetch(`${S.base}/api/shows/${a.id}/audio/f-only-a`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: 'abc' });
  assert.equal((await fetch(`${S.base}/api/shows/${a.id}/audio/f-only-a`)).status, 200);
  assert.equal((await fetch(`${S.base}/api/shows/${b.id}/audio/f-only-a`)).status, 404);
  assert.deepEqual(await (await fetch(`${S.base}/api/shows/${b.id}/audio`)).json(), []);
});

test('음원 100MB 초과 → 413 (Content-Length 기준)', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('큰 음원') }))).json();
  const http = require('http');
  const u = new URL(`${S.base}/api/shows/${id}/audio/f-huge`);
  const status = await new Promise((res, rej) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'PUT', headers: { 'Content-Type': 'audio/wav', 'Content-Length': 100 * 1024 * 1024 + 1 } }, r => { r.resume(); res(r.statusCode); req.destroy(); });
    req.on('error', rej);
    // 실제로 100MB 를 보내지 않는다 — 서버는 헤더만 보고 413
    req.flushHeaders();
  }).catch(e => 'err:' + e.code);
  assert.equal(status, 413);
  assert.equal((await fetch(`${S.base}/api/shows/${id}/audio/f-huge`)).status, 404);
});

test('인증: APP_PASSWORD 설정 시 401/200, 헤더와 쿼리 둘 다', async () => {
  const P = await start('s3cret-비번');
  try {
    let r = await fetch(P.base + '/api/health');
    assert.deepEqual(await r.json(), { ok: true, hasPassword: true, showCount: 0 });
    r = await fetch(P.base + '/api/shows');
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'unauthorized' });
    r = await fetch(P.base + '/api/shows', { headers: { 'X-App-Key': 'wrong' } });
    assert.equal(r.status, 401);
    const key = 's3cret-비번';
    r = await fetch(P.base + '/api/shows', { headers: { 'X-App-Key': encodeURIComponent(key) } });
    assert.equal(r.status, 200, '헤더는 URL 인코딩해서 보낸다 (비ASCII 비밀번호)');
    r = await fetch(P.base + '/api/shows?key=' + encodeURIComponent(key));
    assert.equal(r.status, 200);
    const { id } = await (await fetch(P.base + '/api/shows?key=' + encodeURIComponent(key), J('POST', { show: show('잠김') }))).json();
    assert.ok(id);
    await fetch(`${P.base}/api/shows/${id}/audio/f-1?key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: 'abc' });
    assert.equal((await fetch(`${P.base}/api/shows/${id}/audio/f-1`)).status, 401);
    assert.equal((await fetch(`${P.base}/api/shows/${id}/audio/f-1?key=nope`)).status, 401);
    assert.equal((await fetch(`${P.base}/api/shows/${id}/audio/f-1?key=${encodeURIComponent(key)}`)).status, 200);
  } finally { await stop(P); }
  const Q = await start('ascii-pw');
  try {
    assert.equal((await fetch(Q.base + '/api/shows', { headers: { 'X-App-Key': 'ascii-pw' } })).status, 200);
    assert.equal((await fetch(Q.base + '/api/shows', { headers: { 'X-App-Key': 'ascii-pwx' } })).status, 401);
    assert.equal((await fetch(Q.base + '/api/shows?key=ascii-pw')).status, 200);
    assert.equal((await fetch(Q.base + '/', { headers: {} })).status, 200, '정적 페이지는 인증 없음');
  } finally { await stop(Q); }
});
