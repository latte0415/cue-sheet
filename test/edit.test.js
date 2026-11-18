// 프로젝트별 편집 비밀번호 · 실패 제한 · 히스토리/복원 — 임시 DATA_DIR 로 서버를 띄워 검사한다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');

function start(opts) {
  const dir = (opts && opts.dataDir) || fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-edit-'));
  const server = createServer(Object.assign({ password: '', log: null }, opts, { dataDir: dir }));
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
}
function stop(s) { return new Promise(r => s.server.close(() => { fs.rmSync(s.dir, { recursive: true, force: true }); r(); })); }
const show = (title, extra) => Object.assign({ id: 'x', title, version: 5, parts: [{ id: 'pt1', name: '1부', scenes: [{ id: 's1', items: [{ id: 'i1', cues: [{ id: 'q1' }, { id: 'q2' }] }] }] }], people: [], tracks: [] }, extra);
const EK = { 'X-Edit-Key': '1234' };
const K = k => ({ 'X-Edit-Key': encodeURIComponent(k) });
const J = (method, body, headers) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, EK, headers), body: body === undefined ? undefined : JSON.stringify(body) });

test('편집 비밀번호: 키 없음·틀림 403, 기본 1234, 읽기·새 프로젝트·복제는 사이트 권한만', async () => {
  const P = await start({ password: 'site', editRate: { max: 100, windowMs: 60000 } });
  const A = { 'X-App-Key': 'site' };
  try {
    let r = await fetch(P.base + '/api/shows', { method: 'POST', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify({ show: show('편집') }) });
    assert.equal(r.status, 201, '새 프로젝트는 편집 키 없이');
    const { id } = await r.json();
    // 사이트 비밀번호가 먼저(401), 편집 키는 그다음(403)
    r = await fetch(`${P.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show('x') }));
    assert.equal(r.status, 401);
    const list = await (await fetch(P.base + '/api/shows', { headers: A })).json();
    assert.equal(list.find(x => x.id === id).editDefault, true);
    r = await fetch(`${P.base}/api/shows/${id}`, { headers: A });
    assert.equal(r.status, 200, '읽기는 편집 키 없이');
    assert.deepEqual(Object.keys(await r.json()).sort(), ['rev', 'show', 'updatedAt'], 'GET 에 비밀번호 정보가 섞이지 않는다');

    const W = (h, method, p, body) => fetch(`${P.base}/api/shows/${id}${p || ''}`, { method, headers: { ...A, 'Content-Type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const h of [{}, K('9999')]) {
      r = await W(h, 'PUT', '', { baseRev: 1, show: show('x') });
      assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'edit_forbidden' });
      assert.equal((await W(h, 'DELETE')).status, 403);
      assert.equal((await W(h, 'DELETE', '/audio')).status, 403);
      assert.equal((await fetch(`${P.base}/api/shows/${id}/audio/f-1`, { method: 'PUT', headers: { ...A, ...h, 'Content-Type': 'audio/wav' }, body: 'abc' })).status, 403);
      assert.equal((await W(h, 'DELETE', '/audio/f-1')).status, 403);
      assert.equal((await W(h, 'GET', '/history')).status, 200, '기록 목록(메타)은 보기 권한으로');
      assert.equal((await W(h, 'GET', '/history/1')).status, 403);
      assert.equal((await W(h, 'POST', '/restore', { rev: 1 })).status, 403);
      assert.equal((await W(h, 'POST', '/edit-check')).status, 403);
    }
    assert.equal((await (await fetch(`${P.base}/api/shows/${id}`, { headers: A })).json()).show.title, '편집', '거절된 쓰기는 반영되지 않는다');
    r = await fetch(`${P.base}/api/shows/${id}/duplicate`, { method: 'POST', headers: A });
    assert.equal(r.status, 201, '복제는 새 프로젝트 만들기 — 편집 키 불필요');

    r = await W(K('1234'), 'POST', '/edit-check');
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, isDefault: true });
    assert.equal((await W(K('1234'), 'PUT', '', { baseRev: 1, show: show('수정') })).status, 200);
    r = await fetch(`${P.base}/api/shows/${id}/audio/f-1`, { method: 'PUT', headers: { ...A, ...K('1234'), 'Content-Type': 'audio/wav' }, body: 'abc' });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${P.base}/api/shows/${id}/audio/f-1`, { headers: A })).status, 200, '음원 재생은 편집 키 없이');
    assert.equal((await W(K('1234'), 'DELETE', '/audio/f-1')).status, 200);
    // 없는 프로젝트는 키와 상관없이 404
    assert.equal((await W({}, 'PUT', 'zz', { baseRev: 1, show: show('x') })).status, 404);
  } finally { await stop(P); }
});

test('편집 비밀번호 변경: 해시만 show 밖에 저장, 새 비번으로만 통과, 1234 로 되돌리면 기본 상태', async () => {
  const P = await start({});
  try {
    const { id } = await (await fetch(P.base + '/api/shows', J('POST', { show: show('변경') }))).json();
    const C = (body, h) => fetch(`${P.base}/api/shows/${id}/edit-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
    let r = await C({ current: '0000', next: '새비번-한글' });
    assert.equal(r.status, 403);
    r = await C({ current: '1234', next: 'abc' });
    assert.equal(r.status, 400);
    const bad = await r.json();
    assert.equal(bad.error, 'bad_password'); assert.match(bad.message, /4자 이상/);
    assert.equal((await C({ current: '1234' })).status, 400);
    r = await C({ current: '1234', next: '새비번-한글' });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, isDefault: false });

    const authFile = path.join(P.dir, 'shows', id, 'auth.json');
    const raw = fs.readFileSync(authFile, 'utf8');
    assert.ok(!raw.includes('새비번'), '평문 없음');
    const auth = JSON.parse(raw);
    assert.equal(auth.algo, 'scrypt'); assert.ok(auth.salt); assert.ok(auth.hash);
    assert.ok(!fs.readFileSync(path.join(P.dir, 'shows', id + '.json'), 'utf8').includes(auth.hash), '레코드(show)와 분리');
    assert.equal((await (await fetch(P.base + '/api/shows')).json()).find(x => x.id === id).editDefault, false);

    assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K('1234') })).status, 403, '옛 비밀번호 거절');
    r = await fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K('새비번-한글') });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, isDefault: false });
    r = await fetch(`${P.base}/api/shows/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...K('새비번-한글') }, body: JSON.stringify({ baseRev: 1, show: show('새 비번으로') }) });
    assert.equal(r.status, 200);
    assert.equal((await (await fetch(`${P.base}/api/shows/${id}`)).json()).rev, 2, '비밀번호 변경은 rev 를 올리지 않는다');
    // 한 번 통과한 비밀번호도(서버가 기억해 둔 것) 바뀐 뒤에는 거절
    assert.equal((await C({ current: '새비번-한글', next: '둘째-비번' })).status, 200);
    assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K('새비번-한글') })).status, 403);
    assert.equal((await C({ current: '둘째-비번', next: '새비번-한글' })).status, 200);

    r = await C({ current: '새비번-한글', next: '1234' });
    assert.deepEqual(await r.json(), { ok: true, isDefault: true });
    assert.ok(!fs.existsSync(authFile), '1234 로 되돌리면 해시를 지운다');
    assert.equal((await (await fetch(P.base + '/api/shows')).json()).find(x => x.id === id).editDefault, true);
    r = await C({ next: 'zzzz' }, K('1234'));
    assert.equal(r.status, 200, 'current 는 헤더(X-Edit-Key)로도');
  } finally { await stop(P); }
});

test('실패 제한: IP+프로젝트당 창 안에 max 회, 막힌 동안 맞는 비번도 429, 다른 프로젝트는 별개, 창이 지나면 풀림', async () => {
  const P = await start({ editRate: { max: 3, windowMs: 1500 } });
  try {
    const a = await (await fetch(P.base + '/api/shows', J('POST', { show: show('RL-A') }))).json();
    const b = await (await fetch(P.base + '/api/shows', J('POST', { show: show('RL-B') }))).json();
    const chk = (id, h) => fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: h });
    for (let i = 0; i < 3; i++) assert.equal((await chk(a.id, K('nope'))).status, 403);
    let r = await chk(a.id, EK);
    assert.equal(r.status, 429);
    const j = await r.json();
    assert.equal(j.error, 'too_many_attempts'); assert.ok(j.retryAfter >= 1);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal((await fetch(`${P.base}/api/shows/${a.id}`, J('PUT', { baseRev: 1, show: show('x') }))).status, 429);
    assert.equal((await fetch(`${P.base}/api/shows/${a.id}/edit-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: '1234', next: 'abcd' }) })).status, 429);
    assert.equal((await chk(b.id, EK)).status, 200, '다른 프로젝트는 영향 없음');
    for (let i = 0; i < 5; i++) assert.equal((await chk(b.id, {})).status, 403);
    assert.equal((await chk(b.id, EK)).status, 200, '키 없이 보낸 요청은 실패로 세지 않는다');
    await new Promise(res => setTimeout(res, 1600));
    assert.equal((await chk(a.id, EK)).status, 200, '창이 지나면 다시 허용');
  } finally { await stop(P); }
});

test('trustProxy: X-Forwarded-For 마지막 값(프록시가 붙인 주소)으로 IP 구분', async () => {
  const P = await start({ editRate: { max: 2, windowMs: 60000 }, trustProxy: true });
  try {
    const { id } = await (await fetch(P.base + '/api/shows', J('POST', { show: show('XFF') }))).json();
    const chk = (xff, h) => fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: { ...h, 'X-Forwarded-For': xff } });
    assert.equal((await chk('1.1.1.1, 9.9.9.9', K('x'))).status, 403);
    assert.equal((await chk('2.2.2.2, 9.9.9.9', K('x'))).status, 403);
    assert.equal((await chk('3.3.3.3, 9.9.9.9', EK)).status, 429, '앞쪽 값을 바꿔도 같은 IP');
    assert.equal((await chk('9.9.9.8', EK)).status, 200, '다른 IP 는 별개');
  } finally { await stop(P); }
});


test('기록(HTTP): 목록은 보기 권한, 내용·복원은 편집. 최근 N 개, 복원은 새 rev 라 되돌릴 수 있음', async () => {
  const P = await start({ historyKeep: 3, putSnapshotMs: 0 });
  try {
    const { id } = await (await fetch(P.base + '/api/shows', J('POST', { show: show('v1') }))).json();
    const H = p => fetch(`${P.base}/api/shows/${id}/history${p || ''}`, { headers: EK });
    assert.deepEqual((await (await fetch(`${P.base}/api/shows/${id}/history`)).json()).map(x => [x.rev, x.current]), [[1, true]], '처음엔 현재 버전만');
    for (let rev = 1; rev <= 5; rev++) {
      const extra = rev === 4 ? { parts: [{ id: 'pt1', name: '1부', scenes: [{ id: 's1', items: [] }, { id: 's2', items: [] }] }] } : undefined;
      assert.equal((await fetch(`${P.base}/api/shows/${id}`, J('PUT', { baseRev: rev, show: show('v' + (rev + 1), extra) }))).status, 200);
    }
    // 현재 rev 6 + 직전 3개(rev 5,4,3)
    let list = await (await H()).json();
    assert.deepEqual(list.map(x => x.rev), [6, 5, 4, 3]);
    assert.deepEqual(Object.keys(list[0]).sort(), ['cueCount', 'current', 'restoredFrom', 'rev', 'sceneCount', 'title', 'updatedAt']);
    assert.deepEqual([list[1].title, list[1].sceneCount, list[1].cueCount, list[1].current], ['v5', 2, 0, false]);
    assert.deepEqual([list[2].sceneCount, list[2].cueCount], [1, 2]);
    assert.equal(fs.readdirSync(path.join(P.dir, 'shows', id, 'history')).length, 3, '오래된 것은 지운다');

    let r = await H('/4');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json().then(h => [h.rev, h.show.title]), [4, 'v4']);
    assert.equal((await H('/1')).status, 404, '정리된 rev');
    assert.equal((await H('/abc')).status, 404);

    const R = body => fetch(`${P.base}/api/shows/${id}/restore`, J('POST', body));
    r = await R({ rev: 4, baseRev: 5 });
    assert.equal(r.status, 409); assert.equal((await r.json()).rev, 6);
    r = await R({ rev: 99 });
    assert.equal(r.status, 404); assert.equal((await r.json()).error, 'rev_not_found');
    r = await R({ rev: 4, baseRev: 6 });
    assert.equal(r.status, 200); assert.equal(r.headers.get('etag'), '"7"');
    assert.deepEqual(await r.json().then(x => [x.rev, x.restoredFrom]), [7, 4]);
    let g = await (await fetch(`${P.base}/api/shows/${id}`)).json();
    assert.deepEqual([g.rev, g.show.title, g.restoredFrom], [7, 'v4', 4]);
    list = await (await H()).json();
    assert.deepEqual(list.map(x => x.rev), [7, 6, 5, 4], '복원 직전(rev 6)도 남아 복원을 되돌릴 수 있다');
    assert.equal((await R({ rev: 6 })).status, 200);
    g = await (await fetch(`${P.base}/api/shows/${id}`)).json();
    assert.deepEqual([g.rev, g.show.title], [8, 'v6']);
    list = await (await H()).json();
    assert.deepEqual([list[1].rev, list[1].restoredFrom], [7, 4]);
    r = await R({ rev: 6 });
    assert.deepEqual(await r.json().then(x => [x.unchanged, x.rev]), [true, 8], '이미 같은 내용이면 아무것도 안 함');
    await fetch(`${P.base}/api/shows/${id}`, J('PUT', { baseRev: 8, show: show('v9') }));
    assert.equal((await (await fetch(`${P.base}/api/shows/${id}`)).json()).restoredFrom, undefined, '일반 저장 뒤에는 restoredFrom 없음');
    const d = await (await fetch(`${P.base}/api/shows/${id}/duplicate`, { method: 'POST' })).json();
    assert.deepEqual((await (await fetch(`${P.base}/api/shows/${d.id}/history`)).json()).map(x => x.rev), [1], '복제본에는 기록이 따라가지 않는다');
    assert.equal((await fetch(`${P.base}/api/shows/${id}`, { method: 'DELETE', headers: EK })).status, 200);
    assert.ok(!fs.existsSync(path.join(P.dir, 'shows', id)), '삭제하면 기록·비밀번호도 함께(한 폴더)');
  } finally { await stop(P); }
});

test('웹 자동 저장(PUT)은 10분에 한 번만 기록, 복원은 매번', async () => {
  const P = await start({});
  try {
    const { id } = await (await fetch(P.base + '/api/shows', J('POST', { show: show('a1') }))).json();
    for (let rev = 1; rev <= 3; rev++) await fetch(`${P.base}/api/shows/${id}`, J('PUT', { baseRev: rev, show: show('a' + (rev + 1)) }));
    const revs = async () => (await (await fetch(`${P.base}/api/shows/${id}/history`)).json()).map(x => x.rev);
    assert.deepEqual(await revs(), [4, 1]);
    assert.equal((await fetch(`${P.base}/api/shows/${id}/restore`, J('POST', { rev: 1 }))).status, 200);
    assert.deepEqual(await revs(), [5, 4, 1]);
  } finally { await stop(P); }
});

test('기존 데이터 호환: auth·기록 없는 옛 레코드(rev 22)는 1234 로 열리고, 예전 위치(<id>.history)의 기록은 폴더 안으로 옮긴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-edit-'));
  fs.mkdirSync(path.join(dir, 'shows', 'old-2.history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shows', 'old-1.json'), JSON.stringify({ rev: 22, updatedAt: '2026-11-17T00:00:00.000Z', show: show('옛 공연') }));
  fs.writeFileSync(path.join(dir, 'shows', 'old-2.json'), JSON.stringify({ rev: 4, updatedAt: '2026-11-18T00:00:00.000Z', show: show('MCP 로 고친 공연') }));
  fs.writeFileSync(path.join(dir, 'shows', 'old-2.history', '3.json'), JSON.stringify({ rev: 3, updatedAt: '2026-11-17T12:00:00.000Z', show: show('MCP 전') }));
  const P = await start({ dataDir: dir });
  try {
    const list = await (await fetch(P.base + '/api/shows')).json();
    assert.deepEqual(list.map(x => [x.id, x.rev, x.editDefault]).sort(), [['old-1', 22, true], ['old-2', 4, true]]);
    assert.ok(!fs.existsSync(path.join(dir, 'shows', 'old-2.history')), '예전 기록 폴더는 정리');
    assert.ok(fs.existsSync(path.join(dir, 'shows', 'old-2', 'history', '3.json')));
    assert.deepEqual((await (await fetch(`${P.base}/api/shows/old-2/history`)).json()).map(x => [x.rev, x.title]), [[4, 'MCP 로 고친 공연'], [3, 'MCP 전']]);
    assert.equal((await fetch(`${P.base}/api/shows/old-1`, J('PUT', { baseRev: 22, show: show('새 판') }, K('0000')))).status, 403);
    assert.equal((await fetch(`${P.base}/api/shows/old-1`, J('PUT', { baseRev: 22, show: show('새 판') }))).status, 200);
    const h = await (await fetch(`${P.base}/api/shows/old-1/history`)).json();
    assert.deepEqual(h.map(x => [x.rev, x.title]), [[23, '새 판'], [22, '옛 공연']]);
  } finally { await stop(P); }
});
