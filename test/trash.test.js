// 휴지통(소프트 삭제)·복구, TRASH_DAYS 정리, 관리자 복구 키(ADMIN_KEY) — 임시 DATA_DIR 로 서버를 띄워 검사한다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');

function start(opts) {
  const dir = (opts && opts.dataDir) || fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-trash-'));
  const server = createServer(Object.assign({ password: '', log: null, adminKey: '' }, opts, { dataDir: dir }));
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
}
function stop(s) { return new Promise(r => s.server.close(() => { fs.rmSync(s.dir, { recursive: true, force: true }); r(); })); }
const show = (title, extra) => Object.assign({ id: 'x', title, version: 5, parts: [{ id: 'pt1', name: '1부', scenes: [{ id: 's1', items: [] }] }], people: [], tracks: [] }, extra);
const J = (method, body, headers) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });
const K = k => ({ 'X-Edit-Key': encodeURIComponent(k) });

// 음원·기록·바꾼 편집 비밀번호가 있는 프로젝트 하나
async function richShow(P, title, pw) {
  const { id } = await (await fetch(P.base + '/api/shows', J('POST', { show: show(title + ' v1') }))).json();
  assert.equal((await fetch(`${P.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show(title + ' v2') }, K('1234')))).status, 200);
  assert.equal((await fetch(`${P.base}/api/shows/${id}/audio/f-1`, { method: 'PUT', headers: { ...K('1234'), 'Content-Type': 'audio/wav' }, body: 'RIFF-abc' })).status, 200);
  assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-password`, J('POST', { current: '1234', next: pw }))).status, 200);
  return id;
}
async function intact(P, id, title, pw) {
  const g = await (await fetch(`${P.base}/api/shows/${id}`)).json();
  assert.deepEqual([g.rev, g.show.title], [2, title + ' v2']);
  assert.deepEqual((await (await fetch(`${P.base}/api/shows/${id}/history`)).json()).map(x => x.rev), [2, 1], '기록 유지');
  const a = await fetch(`${P.base}/api/shows/${id}/audio/f-1`);
  assert.equal(a.status, 200); assert.equal(await a.text(), 'RIFF-abc', '음원 유지');
  assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K('1234') })).status, 403, 'auth 유지 — 옛 1234 는 안 됨');
  assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K(pw) })).status, 200);
}

test('삭제는 휴지통으로: 목록에서 사라지고 휴지통에 나오며, 보기 권한만으로 복구하면 기록·음원·auth 그대로', async () => {
  const P = await start({ password: 'site' });
  const A = { 'X-App-Key': 'site' };
  const f = (u, o) => fetch(u, Object.assign({}, o, { headers: Object.assign({}, A, o && o.headers) }));
  try {
    const { id } = await (await f(P.base + '/api/shows', J('POST', { show: show('삭제 v1') }))).json();
    await f(`${P.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show('삭제 v2') }, K('1234')));
    await f(`${P.base}/api/shows/${id}/audio/f-1`, { method: 'PUT', headers: { ...K('1234'), 'Content-Type': 'audio/wav' }, body: 'RIFF-abc' });
    await f(`${P.base}/api/shows/${id}/edit-password`, J('POST', { current: '1234', next: '공격자가-바꿈' }));

    assert.equal((await f(`${P.base}/api/shows/${id}`, { method: 'DELETE', headers: K('1234') })).status, 403, '삭제는 여전히 편집 권한');
    const d = await f(`${P.base}/api/shows/${id}`, { method: 'DELETE', headers: K('공격자가-바꿈') });
    assert.equal(d.status, 200);
    const dj = await d.json();
    assert.equal(dj.ok, true); assert.ok(dj.trashId.startsWith(id + '-')); assert.equal(dj.trashDays, 30);
    assert.ok(!(await (await f(P.base + '/api/shows')).json()).some(x => x.id === id), '목록에서 사라짐');
    assert.equal((await f(`${P.base}/api/shows/${id}`)).status, 404);
    assert.ok(!fs.existsSync(path.join(P.dir, 'shows', id)) && !fs.existsSync(path.join(P.dir, 'shows', id + '.json')));
    // 폴더째 옮긴다: shows/<id>/ 안의 구조(audio·history·auth.json)를 그대로
    const tdir = path.join(P.dir, 'trash', dj.trashId);
    for (const x of ['meta.json', 'show.json', 'files/auth.json', 'files/audio/f-1', 'files/history/1.json']) assert.ok(fs.existsSync(path.join(tdir, x)), x);
    assert.ok(JSON.parse(fs.readFileSync(path.join(tdir, 'meta.json'), 'utf8')).ip, '삭제 요청 IP 는 meta.json 에');

    assert.equal((await fetch(P.base + '/api/trash')).status, 401, '휴지통도 사이트 비밀번호는 필요');
    const t = await (await f(P.base + '/api/trash')).json();
    assert.equal(t.days, 30);
    assert.equal(t.items.length, 1);
    const it = t.items[0];
    assert.deepEqual([it.trashId, it.id, it.title, it.rev, it.daysLeft], [dj.trashId, id, '삭제 v2', 2, 30]);
    assert.ok(it.deletedAt && it.expiresAt);
    assert.equal(it.ip, undefined, '목록 응답에는 IP 를 싣지 않는다');

    assert.equal((await f(`${P.base}/api/trash/nope-1234567890123/restore`, { method: 'POST' })).status, 404);
    assert.equal((await f(`${P.base}/api/trash/${dj.trashId}/restore`)).status, 405);
    const r = await f(`${P.base}/api/trash/${dj.trashId}/restore`, { method: 'POST' });
    assert.equal(r.status, 200, '편집 비밀번호 없이 복구');
    assert.deepEqual(await r.json(), { id, originalId: id, title: '삭제 v2' });
    assert.deepEqual((await (await f(P.base + '/api/trash')).json()).items, []);
    assert.ok(!fs.existsSync(tdir));
    const g = await (await f(`${P.base}/api/shows/${id}`)).json();
    assert.deepEqual([g.rev, g.show.title], [2, '삭제 v2']);
    assert.deepEqual((await (await f(`${P.base}/api/shows/${id}/history`)).json()).map(x => x.rev), [2, 1], '기록 유지');
    assert.equal(await (await f(`${P.base}/api/shows/${id}/audio/f-1`)).text(), 'RIFF-abc', '음원 유지');
    assert.equal((await f(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K('공격자가-바꿈') })).status, 200, 'auth 도 그대로 (관리자 키로 초기화)');
    assert.equal((await f(`${P.base}/api/shows/${id}/restore`, J('POST', { rev: 1 }, K('공격자가-바꿈')))).status, 200, '복구 뒤 기록 복원도 된다');
  } finally { await stop(P); }
});

test('복구할 때 같은 id 가 이미 있으면 새 id 로 (기록·음원·auth 같이)', async () => {
  const P = await start({});
  try {
    const id = await richShow(P, '충돌', '충돌-비번');
    const { trashId } = await (await fetch(`${P.base}/api/shows/${id}`, { method: 'DELETE', headers: K('충돌-비번') })).json();
    // 그 사이 같은 id 의 프로젝트가 생겼다(파일로 흉내)
    fs.writeFileSync(path.join(P.dir, 'shows', id + '.json'), JSON.stringify({ rev: 1, updatedAt: new Date().toISOString(), show: show('새로 생긴 것') }));
    const r = await (await fetch(`${P.base}/api/trash/${trashId}/restore`, { method: 'POST' })).json();
    assert.notEqual(r.id, id); assert.equal(r.originalId, id); assert.match(r.id, /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal((await (await fetch(`${P.base}/api/shows/${id}`)).json()).show.title, '새로 생긴 것', '기존 것은 그대로');
    await intact(P, r.id, '충돌', '충돌-비번');
  } finally { await stop(P); }
});

test('TRASH_DAYS 가 지난 항목은 정리: 시작할 때와 trashPurge', async () => {
  const P = await start({ trashDays: 2 });
  try {
    const a = await richShow(P, 'A', 'aaaa'), b = await richShow(P, 'B', 'bbbb');
    await fetch(`${P.base}/api/shows/${a}`, { method: 'DELETE', headers: K('aaaa') });
    await fetch(`${P.base}/api/shows/${b}`, { method: 'DELETE', headers: K('bbbb') });
    const st = P.server.store, items = await st.trashList();
    assert.deepEqual(items.map(x => x.daysLeft), [2, 2]);
    assert.deepEqual((await st.trashList(Date.now() + 1.5 * 86400000)).map(x => x.daysLeft), [1, 1]);
    assert.deepEqual(await st.trashPurge(Date.now() + 86400000), [], '아직 안 지남');
    assert.equal((await st.trashPurge(Date.now() + 2 * 86400000 + 1000)).length, 2);
    assert.deepEqual(fs.readdirSync(path.join(P.dir, 'trash')), []);
  } finally { await stop(P); }
  // 서버 시작 때 정리: 31일 전에 지운 항목
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-trash-'));
  const old = path.join(dir, 'trash', 'gone-1000000000000'), fresh = path.join(dir, 'trash', 'keep-' + Date.now());
  for (const [d, ago] of [[old, 31], [fresh, 1]]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'show.json'), JSON.stringify({ rev: 1, show: show('x') }));
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: path.basename(d).split('-')[0], title: 'x', deletedAt: new Date(Date.now() - ago * 86400000).toISOString() }));
  }
  const Q = await start({ dataDir: dir });
  try {
    await Q.server.ready;
    assert.ok(!fs.existsSync(old), '30일 지난 것은 시작할 때 영구 삭제');
    assert.deepEqual((await (await fetch(Q.base + '/api/trash')).json()).items.map(x => [x.id, x.daysLeft]), [['keep', 29]]);
  } finally { await stop(Q); }
});

test('관리자 복구 키: ADMIN_KEY 가 없으면 404, 틀리면 403, 맞으면 편집 비밀번호를 1234 로. 실패 제한', async () => {
  const N = await start({});
  try {
    const id = await richShow(N, '키 없음', 'nnnn');
    assert.equal((await fetch(`${N.base}/api/shows/${id}/edit-password/reset`, { method: 'POST', headers: { 'X-Admin-Key': '' + 'anything' } })).status, 404, 'ADMIN_KEY 미설정이면 기능 없음');
  } finally { await stop(N); }

  const P = await start({ adminKey: '관리-키 1', editRate: { max: 3, windowMs: 60000 } });
  try {
    const id = await richShow(P, '잠김', '공격자-비번');
    const R = h => fetch(`${P.base}/api/shows/${id}/edit-password/reset`, { method: 'POST', headers: h });
    let r = await R({});
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'admin_forbidden');
    assert.equal((await R({ 'X-Admin-Key': 'wrong' })).status, 403);
    assert.equal((await fetch(`${P.base}/api/shows/nothere/edit-password/reset`, { method: 'POST', headers: { 'X-Admin-Key': encodeURIComponent('관리-키 1') } })).status, 404);
    assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-password/reset`, { headers: { 'X-Admin-Key': encodeURIComponent('관리-키 1') } })).status, 405);
    assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K('1234') })).status, 403, '초기화 전에는 1234 안 됨');
    r = await R({ 'X-Admin-Key': encodeURIComponent('관리-키 1') });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, isDefault: true });
    assert.ok(!fs.existsSync(path.join(P.dir, 'shows', id, 'auth.json')));
    assert.equal((await (await fetch(P.base + '/api/shows')).json()).find(x => x.id === id).editDefault, true);
    assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K('1234') })).status, 200, '1234 로 다시 편집');
    assert.equal((await fetch(`${P.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: K('공격자-비번') })).status, 403);
    assert.equal(await (await fetch(`${P.base}/api/shows/${id}/audio/f-1`)).text(), 'RIFF-abc', '내용·음원은 그대로');
    // UTF-8 그대로 실은 헤더도 (curl 로 한글 키를 그대로 쓴 경우)
    assert.equal((await R({ 'X-Admin-Key': Buffer.from('관리-키 1', 'utf8').toString('latin1') })).status, 200);
    // 실패 제한: 지금까지 틀린 키 1회(헤더 없는 요청은 세지 않음) → 2회 더 틀리면 맞는 키도 429
    assert.equal((await R({ 'X-Admin-Key': 'wrong2' })).status, 403);
    assert.equal((await R({ 'X-Admin-Key': 'wrong3' })).status, 403);
    r = await R({ 'X-Admin-Key': encodeURIComponent('관리-키 1') });
    assert.equal(r.status, 429); assert.equal((await r.json()).error, 'too_many_attempts');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
  } finally { await stop(P); }
});
