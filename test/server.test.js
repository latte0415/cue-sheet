// node --test test/ — 임시 DATA_DIR 로 서버를 띄워 API 를 검사한다 (의존성 없음)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');
const { SHOW_VER } = require('../lib/validate');

function start(password) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-test-'));
  const server = createServer({ dataDir: dir, password, log: null });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
}
function stop(s) { return new Promise(r => s.server.close(() => { fs.rmSync(s.dir, { recursive: true, force: true }); r(); })); }
const show = (title, extra) => Object.assign({ id: 'x', title, version: 5, parts: [{ id: 'pt1', name: '1부', scenes: [{ id: 's1', items: [{ id: 'i1', cues: [{ id: 'q1' }, { id: 'q2' }] }] }] }], people: [], tracks: [] }, extra);
// 편집 비밀번호: 새 프로젝트는 기본값 1234
const EK = { 'X-Edit-Key': '1234' };
const J = (method, body, headers) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, EK, headers), body: body === undefined ? undefined : JSON.stringify(body) });

let S;
before(async () => { S = await start(''); });
after(() => stop(S));

test('health: 비밀번호 없음, showCount', async () => {
  const r = await fetch(S.base + '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { ok: true, hasPassword: false, showCount: 0, schema: SHOW_VER });
  assert.equal((await fetch(S.base + '/healthz')).status, 200);
  assert.equal((await fetch(S.base + '/')).status, 200);
  const mj = await fetch(S.base + '/lib/merge.js'); // index.html 의 409 자동 병합 모듈
  assert.equal(mj.status, 200); assert.match(mj.headers.get('content-type'), /javascript/); assert.match(await mj.text(), /CueMerge/);
  assert.equal((await fetch(S.base + '/lib/store.js')).status, 404, 'lib/ 의 다른 파일은 내주지 않는다');
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
  r = await fetch(`${S.base}/api/shows/${id}`, { method: 'PUT', headers: { ...EK, 'Content-Type': 'application/json' }, body: '{nope' });
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
  let r = await fetch(`${S.base}/api/shows/${id}/audio/f-dup`, { method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav', 'X-File-Name': encodeURIComponent('곡.wav') }, body: bytes });
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

  r = await fetch(`${S.base}/api/shows/${id}`, { method: 'DELETE', headers: EK });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(S.dir, 'shows', id + '.json')));
  assert.ok(!fs.existsSync(path.join(S.dir, 'shows', id)), '음원 폴더도 삭제');
  assert.equal((await fetch(`${S.base}/api/shows/${id}`)).status, 404);
  assert.equal((await fetch(`${S.base}/api/shows/${id}`, { method: 'DELETE', headers: EK })).status, 404);
  // 복제본은 남아 있다
  assert.equal((await fetch(`${S.base}/api/shows/${d.id}/audio/f-dup`)).status, 200);
});

test('음원: PUT → GET 전체 → Range 206 → 목록 → DELETE → 전체 삭제', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('음원') }))).json();
  const A = `${S.base}/api/shows/${id}/audio`;
  const bytes = Buffer.alloc(1000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  let r = await fetch(A + '/f-abc_1', { method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav', 'X-File-Name': encodeURIComponent('01 오프닝.wav') }, body: bytes });
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

  r = await fetch(A + '/f-two', { method: 'PUT', headers: { ...EK, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('xyz') });
  assert.equal(r.status, 200);
  r = await fetch(A + '/f-bad', { method: 'PUT', headers: { ...EK, 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);

  let list = await (await fetch(A)).json();
  assert.deepEqual(list.map(x => x.fileKey).sort(), ['f-abc_1', 'f-two']);
  assert.deepEqual(list.find(x => x.fileKey === 'f-abc_1'), { fileKey: 'f-abc_1', name: '01 오프닝.wav', size: 1000, mime: 'audio/wav' });

  r = await fetch(A + '/f-two', { method: 'DELETE', headers: EK });
  assert.equal(r.status, 200);
  assert.equal((await fetch(A + '/f-two')).status, 404);
  assert.equal((await fetch(A + '/f-two', { method: 'DELETE', headers: EK })).status, 404);

  r = await fetch(A, { method: 'DELETE', headers: EK });
  assert.equal(r.status, 200);
  assert.deepEqual(await (await fetch(A)).json(), []);
  assert.equal((await fetch(`${S.base}/api/shows/nothere/audio`)).status, 404);
});

test('fileKey 검증 → 400', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('키') }))).json();
  const A = `${S.base}/api/shows/${id}/audio`;
  for (const k of ['a.b', 'a%20b', 'x'.repeat(65), 'ab$', '%E3%84%B1']) {
    const r = await fetch(A + '/' + k, { method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav' }, body: 'x' });
    assert.equal(r.status, 400, k);
    assert.equal((await r.json()).error, 'bad_file_key');
  }
  const r = await fetch(A + '/' + 'x'.repeat(64), { method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav' }, body: 'x' });
  assert.equal(r.status, 200);
});

test('프로젝트별 음원 격리: A 의 fileKey 를 B 에서 GET → 404', async () => {
  const a = await (await fetch(S.base + '/api/shows', J('POST', { show: show('A') }))).json();
  const b = await (await fetch(S.base + '/api/shows', J('POST', { show: show('B') }))).json();
  await fetch(`${S.base}/api/shows/${a.id}/audio/f-only-a`, { method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav' }, body: 'abc' });
  assert.equal((await fetch(`${S.base}/api/shows/${a.id}/audio/f-only-a`)).status, 200);
  assert.equal((await fetch(`${S.base}/api/shows/${b.id}/audio/f-only-a`)).status, 404);
  assert.deepEqual(await (await fetch(`${S.base}/api/shows/${b.id}/audio`)).json(), []);
});

test('음원 100MB 초과 → 413 (Content-Length 기준)', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('큰 음원') }))).json();
  const http = require('http');
  const u = new URL(`${S.base}/api/shows/${id}/audio/f-huge`);
  const status = await new Promise((res, rej) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav', 'Content-Length': 100 * 1024 * 1024 + 1 } }, r => { r.resume(); res(r.statusCode); req.destroy(); });
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
    assert.deepEqual(await r.json(), { ok: true, hasPassword: true, showCount: 0, schema: SHOW_VER });
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
    await fetch(`${P.base}/api/shows/${id}/audio/f-1?key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav' }, body: 'abc' });
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

// ---- 옛 화면 차단: 업데이트 전에 열어 둔 탭(옛 index.html)이 모르는 필드(v6 소품)를 떨어뜨린 채 저장하지 못하게
const v6show = (title, extra) => show(title, Object.assign({
  version: 6, props: [{ id: 'pr1', name: '모자', note: '' }], preShowProps: [{ propId: 'pr1', at: '테이블' }],
  parts: [{ id: 'pt1', name: '1부', scenes: [{ id: 's1', items: [{ id: 'i1', kind: 'action', text: '(등장)', cues: [{ id: 'q1', dept: 'stage', stage: { text: '', props: [{ propId: 'pr1', action: 'in', at: '테이블' }] } }] }] }] }]
}, extra));
// index.html 의 상수~상태 구간(migrate 포함)을 Node 에서 돌린다 (test/validate.test.js 와 같은 방식)
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다');
  return require('vm').runInNewContext(html.slice(a, b) + '\n;({ migrate, SHOW_VER })', {});
}

test('스키마 상수: lib/validate.js SHOW_VER 가 index.html 의 SHOW_VER·migrate 결과와 같다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = /^const SHOW_VER = (\d+);/m.exec(html);
  assert.ok(m, 'index.html 에서 const SHOW_VER 를 찾지 못했습니다');
  assert.equal(Number(m[1]), SHOW_VER);
  const FE = frontend();
  assert.equal(FE.SHOW_VER, SHOW_VER);
  assert.equal(FE.migrate({ version: 5, parts: [] }).version, SHOW_VER, '프런트가 저장하는 version 이 서버 스키마와 같아야 한다');
});

test('옛 화면 차단: 저장본보다 낮은 version 의 PUT 은 426 client_outdated, 같거나 높으면 저장', async () => {
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: v6show('소품') }))).json();
  const get = async () => (await fetch(`${S.base}/api/shows/${id}`)).json();
  // 옛 화면(v5 migrate 는 props·preShowProps·stage.props 를 버린다)이 같은 rev 위에 저장 → 거절, 저장본 그대로
  const old = show('옛 화면');
  let r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: old }));
  assert.equal(r.status, 426);
  assert.equal(r.headers.get('etag'), null);
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'schema', 'version']);
  assert.deepEqual([body.error, body.version, body.schema], ['client_outdated', 6, SHOW_VER]);
  assert.match(body.message, /새로고침/);
  let g = await get();
  assert.deepEqual([g.rev, g.show.title, g.show.props.length, g.show.preShowProps.length], [1, '소품', 1, 1]);
  assert.deepEqual(g.show.parts[0].scenes[0].items[0].cues[0].stage.props, [{ propId: 'pr1', action: 'in', at: '테이블' }]);

  // 옛 rev 를 기준으로 와도 409 가 아니라 426 — 옛 화면은 409 에만 "내 버전으로 덮어쓰기"를 띄운다
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 0, show: old }));
  assert.equal(r.status, 426);
  // 그래도 덮어쓰기(서버 rev 를 base 로 다시 PUT)를 시도하면 같은 답. 재시도해도 마찬가지
  for (let i = 0; i < 3; i++) {
    r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: g.rev, show: old }));
    assert.equal(r.status, 426);
    assert.equal((await r.json()).error, 'client_outdated');
  }
  assert.equal((await get()).rev, 1, '아무것도 저장되지 않았다');

  // 같은 version 은 저장, 높은 version 도 저장(높은 쪽이 기준이 된다)
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: v6show('같은 형식') }));
  assert.equal(r.status, 200); assert.equal((await r.json()).rev, 2);
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 2, show: v6show('새 형식', { version: 7 }) }));
  assert.equal(r.status, 200); assert.equal((await r.json()).rev, 3);
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 3, show: v6show('이제 옛 형식') }));
  assert.equal(r.status, 426);
  assert.deepEqual(await r.json().then(x => [x.version, x.schema]), [7, SHOW_VER]);
  assert.equal((await get()).show.title, '새 형식');

  // 편집 비밀번호 검사가 먼저다(키 없는 옛 화면은 지금처럼 403)
  r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 3, show: old }, { 'X-Edit-Key': '' }));
  assert.equal(r.status, 403);
  // v5 저장본에는 v5 저장이 그대로 된다(지울 새 필드가 없다)
  const { id: id5 } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('v5') }))).json();
  r = await fetch(`${S.base}/api/shows/${id5}`, J('PUT', { baseRev: 1, show: show('v5 수정') }));
  assert.equal(r.status, 200);
});

test('옛 화면 차단: POST·복제는 기존 저장본을 덮어쓰지 않고, 복제는 version 을 그대로 둔다', async () => {
  // 새 프로젝트는 덮어쓸 저장본이 없다 — 옛 형식도 받는다(사이트가 불러올 때 migrate)
  let r = await fetch(S.base + '/api/shows', J('POST', { show: show('옛 형식 새 프로젝트') }));
  assert.equal(r.status, 201);
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: v6show('복제 원본') }))).json();
  r = await fetch(`${S.base}/api/shows/${id}/duplicate`, { method: 'POST' });
  assert.equal(r.status, 201);
  const d = await (await fetch(`${S.base}/api/shows/${(await r.json()).id}`)).json();
  assert.deepEqual([d.show.version, d.show.props.length, d.show.preShowProps.length], [6, 1, 1]);
});

test('옛 화면 차단: MCP edit_show 는 version 을 낮추지 않는다 (v6 소품 유지, v5·v6 은 현재 형식 SHOW_VER 로)', async () => {
  const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26', 'X-Edit-Key': '1234' };
  const call = async (args, n) => {
    const r = await fetch(S.base + '/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'edit_show', arguments: args } }) });
    const t = await r.text();
    return JSON.parse((r.headers.get('content-type') || '').includes('text/event-stream') ? /^data: (.*)$/m.exec(t)[1] : t).result;
  };
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: v6show('MCP v6') }))).json();
  let res = await call({ showId: id, ops: [{ op: 'set', id: 'i1', fields: { text: '(MCP 가 고침)' } }] }, 1);
  assert.ok(!res.isError, JSON.stringify(res));
  let g = await (await fetch(`${S.base}/api/shows/${id}`)).json();
  assert.deepEqual([g.rev, g.show.version, g.show.props.length, g.show.preShowProps.length, g.show.parts[0].scenes[0].items[0].cues[0].stage.props.length], [2, SHOW_VER, 1, 1, 1]);
  const { id: id5 } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('MCP v5') }))).json();
  res = await call({ showId: id5, ops: [{ op: 'set', kind: 'show', fields: { title: 'MCP v5 → v6' } }] }, 2);
  assert.ok(!res.isError, JSON.stringify(res));
  g = await (await fetch(`${S.base}/api/shows/${id5}`)).json();
  assert.deepEqual([g.show.version, g.show.props, g.show.preShowProps], [SHOW_VER, [], []]);
});

test('옛 화면 차단: 버전 복원은 의도한 옛 내용을 그대로 쓰고(version 포함), 사이트는 불러올 때 현재 형식으로 올린다', async () => {
  const P = await new Promise(res => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-test-'));
    const server = createServer({ dataDir: dir, log: null, putSnapshotMs: 0 });
    server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` }));
  });
  try {
    const { id } = await (await fetch(P.base + '/api/shows', J('POST', { show: show('v5 시절') }))).json();
    let r = await fetch(`${P.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: v6show('v6 소품') }));
    assert.equal(r.status, 200);
    // 사용자가 기록에서 v5 시절(rev 1)을 고른다 → 그대로 복원(소품이 없던 내용)
    r = await fetch(`${P.base}/api/shows/${id}/restore`, J('POST', { rev: 1, baseRev: 2 }));
    assert.equal(r.status, 200);
    const g = await (await fetch(`${P.base}/api/shows/${id}`)).json();
    assert.deepEqual([g.rev, g.restoredFrom, g.show.version, g.show.title], [3, 1, 5, 'v5 시절']);
    // 사이트는 불러올 때 migrate 로 현재 형식(빈 소품)으로 올리고, 그 저장은 막히지 않는다
    const m = frontend().migrate(g.show);
    assert.equal(m.version, SHOW_VER);
    assert.deepEqual([JSON.parse(JSON.stringify(m.props)), JSON.parse(JSON.stringify(m.preShowProps))], [[], []]);
    r = await fetch(`${P.base}/api/shows/${id}`, J('PUT', { baseRev: 3, show: JSON.parse(JSON.stringify(m)) }));
    assert.equal(r.status, 200);
    // 복원으로 되돌린 v6 기록(rev 2)은 다시 복원할 수 있다 — 소품이 돌아온다
    r = await fetch(`${P.base}/api/shows/${id}/restore`, J('POST', { rev: 2 }));
    assert.equal(r.status, 200);
    const g2 = await (await fetch(`${P.base}/api/shows/${id}`)).json();
    assert.deepEqual([g2.show.version, g2.show.props.length], [6, 1]);
  } finally { await stop(P); }
});
