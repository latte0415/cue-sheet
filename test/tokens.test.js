// 사람별 MCP 토큰 (lib/tokens.js) — 발급·목록·폐기·조회, 인증 범위(/mcp 만), 수정 기록의 by·via, SDK 클라이언트 e2e
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tokens, TokenError, sha256hex, NAME_MAX } = require('../lib/tokens');
const { Store } = require('../lib/store');
const { createServer } = require('../server');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
async function freshTokens() {
  const dir = tmp('cuesheet-tokens-');
  const t = new Tokens(dir);
  await t.init();
  return { t, dir, done: async () => { await t.idle(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ---- lib/tokens.js

test('tokens: 발급 → 목록(해시 없음) → 조회 → 폐기, 파일에는 원문이 없다', async () => {
  const { t, dir, done } = await freshTokens();
  try {
    const a = await t.create('  김민수 ');
    assert.match(a.token, /^cue_[A-Za-z0-9_-]{43}$/, '32바이트 base64url');
    assert.equal(a.name, '김민수', '앞뒤 공백 제거');
    assert.match(a.id, /^tk-[0-9a-f]{12}$/);
    const b = await t.create('Lee');
    assert.notEqual(a.token, b.token);

    const list = t.list();
    assert.deepEqual(list.map(x => x.name), ['김민수', 'Lee']);
    assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'lastUsedAt', 'name']);
    assert.equal(list[0].lastUsedAt, null);

    const raw = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8');
    assert.ok(!raw.includes(a.token) && !raw.includes(b.token), '토큰 원문은 저장하지 않는다');
    assert.ok(raw.includes(sha256hex(a.token)), 'sha256 hex 만');

    assert.deepEqual(t.lookup(a.token), { id: a.id, name: '김민수' });
    assert.equal(t.lookup(a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A')), null);
    assert.equal(t.lookup('nope'), null);
    assert.equal(t.lookup(''), null);
    assert.equal(t.lookup(undefined), null);

    assert.equal(await t.revoke(a.id), true);
    assert.equal(t.lookup(a.token), null, '폐기 즉시 거부');
    assert.equal(await t.revoke(a.id), false);
    assert.deepEqual(t.list().map(x => x.name), ['Lee']);

    // 다시 읽어도 같다
    const t2 = new Tokens(dir); await t2.init();
    assert.deepEqual(t2.lookup(b.token), { id: b.id, name: 'Lee' });
    assert.equal(t2.lookup(a.token), null);
    // 폐기한 이름은 다시 쓸 수 있다
    assert.equal((await t.create('김민수')).name, '김민수');
  } finally { await done(); }
});

test('tokens: 이름 검사 — 필수, 40자 이하, 대소문자 무시 중복, 기록용 이름·제어 문자 거부', async () => {
  const { t, done } = await freshTokens();
  try {
    const code = async (name, c, status) => {
      await assert.rejects(t.create(name), e => e instanceof TokenError && e.code === c && (!status || e.status === status), JSON.stringify(name));
    };
    await code('', 'bad_name', 400);
    await code('   ', 'bad_name');
    await code(undefined, 'bad_name');
    await code(42, 'bad_name');
    await code('가'.repeat(NAME_MAX + 1), 'bad_name');
    assert.equal((await t.create('가'.repeat(NAME_MAX))).name.length, NAME_MAX);
    await code('관리자', 'bad_name');
    await code('사이트 비밀번호', 'bad_name');
    // 보이지 않는 문자·줄 구분자·C1 제어 문자: 예약 이름과 똑같아 보이거나 기록 한 줄을 깨는 이름
    for (const bad of ['관리자\u200b', '\u200b관리자', 'a\u202eb', 'a\u2028b', 'a\u2029b', 'a\u0085b', 'a\u00adb', 'a\ufeffb', 'a\u2066b', 'a\u0007b']) await code(bad, 'bad_name');
    await code('브라우저', 'bad_name');
    await code('a\nb', 'bad_name');
    await t.create('Alice');
    await code('alice', 'name_taken', 409);
    await code(' ALICE ', 'name_taken');
    // 전각·호환 문자도 같은 이름으로 본다 (NFKC + 대소문자 무시)
    await code('ＡＬＩＣＥ', 'name_taken');
    await code('Ａｌｉｃｅ', 'name_taken');
    await code('브라우저'.normalize('NFD'), 'bad_name');
    await code('사이트　비밀번호', 'bad_name'); // 전각 공백
    assert.equal(t.size, 2, '실패한 발급은 아무것도 남기지 않는다');
  } finally { await done(); }
});

test('tokens: lastUsedAt 은 1분에 한 번만 갱신·저장, 깨진 파일은 시작을 멈춘다', async () => {
  const { t, dir, done } = await freshTokens();
  try {
    const a = await t.create('A');
    t.lookup(a.token);
    const first = t.list()[0].lastUsedAt;
    assert.ok(first);
    await t.idle();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'))[0].lastUsedAt, first, '파일에도 저장');
    await new Promise(r => setTimeout(r, 5));
    t.lookup(a.token);
    assert.equal(t.list()[0].lastUsedAt, first, '1분 안에는 그대로');

    fs.writeFileSync(path.join(dir, 'tokens.json'), '{not json');
    await assert.rejects(new Tokens(dir).init(), /JSON/);
  } finally { await done(); }
});

// ---- store: by·via

test('store: 쓰기 메타 by·via 가 그 버전에 붙고 기록·revisions 에 따라간다. 옛 파일은 null', async () => {
  const dir = tmp('cuesheet-store-meta-');
  try {
    const store = new Store(dir); await store.init();
    const show = title => ({ title, version: 5, people: [], tracks: [], parts: [] });
    const { id } = await store.create(show('A'));
    // 옛 형식 파일: by·via 없음
    assert.equal((await store.get(id)).by, undefined);
    await store.put(id, 1, show('B'), { by: '브라우저', via: 'browser' });
    await store.update(id, s => Object.assign(s, { title: 'C' }), { by: '김민수', via: 'mcp' });
    await store.restore(id, 2, null, { by: 'Lee', via: 'restore' });
    const cur = await store.get(id);
    assert.equal(cur.by, 'Lee'); assert.equal(cur.via, 'restore');
    const revs = await store.revisions(id);
    assert.deepEqual(revs.map(r => [r.rev, r.by, r.via, r.restoredFrom]), [[4, 'Lee', 'restore', 2], [3, '김민수', 'mcp', null], [2, '브라우저', 'browser', null], [1, null, null, null]]);
    // 기록 파일(스냅숏)에도 그 버전의 by·via
    assert.equal((await store.getRevision(id, 3)).by, '김민수');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 서버: 인증 범위와 관리 API

const PW = 'stage-pw';
function start(password, extra) {
  const dir = tmp('cuesheet-tok-srv-');
  const server = createServer(Object.assign({ dataDir: dir, password, log: null }, extra));
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
}
function stop(s) { return new Promise(r => { s.server.closeAllConnections(); s.server.close(async () => { await s.server.tokens.idle(); fs.rmSync(s.dir, { recursive: true, force: true }); r(); }); }); }
const J = (method, body, headers) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });
const ADMIN = { 'X-App-Key': PW };
const EK = { 'X-Edit-Key': '1234' }; // 프로젝트 편집 비밀번호 (auth.json 이 없으면 기본값)
const H = extra => Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, extra);
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'curl', version: '1' } } });
async function connect(base, headers) {
  const client = new Client({ name: 'cue-sheet-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers } }));
  return client;
}
const text = r => r.content.map(c => c.text).join('\n');

let S;
before(async () => { S = await start(PW); });
after(() => stop(S));

test('/api/tokens: 사이트 비밀번호로만 발급·목록·폐기, 원문은 발급 응답에 한 번만', async () => {
  let r = await fetch(S.base + '/api/tokens', J('POST', { name: '김민수' }));
  assert.equal(r.status, 401, '비밀번호 없이는 안 된다');
  r = await fetch(S.base + '/api/tokens', J('POST', { name: '김민수' }, ADMIN));
  assert.equal(r.status, 201);
  const a = await r.json();
  assert.match(a.token, /^cue_/); assert.equal(a.name, '김민수'); assert.ok(a.id && a.createdAt);

  // 토큰으로는 관리 API 도, 다른 /api 도 안 된다
  for (const h of [{ Authorization: `Bearer ${a.token}` }, { 'X-App-Key': a.token }]) {
    assert.equal((await fetch(S.base + '/api/tokens', { headers: h })).status, 401);
    assert.equal((await fetch(S.base + '/api/tokens', J('POST', { name: 'x' }, h))).status, 401);
    assert.equal((await fetch(S.base + '/api/shows', { headers: h })).status, 401);
  }
  assert.equal((await fetch(S.base + '/api/shows?key=' + a.token)).status, 401);

  r = await fetch(S.base + '/api/tokens', { headers: ADMIN });
  assert.equal(r.status, 200);
  const list = await r.json();
  const row = list.find(x => x.id === a.id);
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'lastUsedAt', 'name']);
  assert.ok(!JSON.stringify(list).includes(a.token));

  r = await fetch(S.base + '/api/tokens', J('POST', { name: ' 김민수 ' }, ADMIN));
  assert.equal(r.status, 409); assert.equal((await r.json()).error, 'name_taken');
  r = await fetch(S.base + '/api/tokens', J('POST', { name: '' }, ADMIN));
  assert.equal(r.status, 400);
  const e = await r.json();
  assert.equal(e.error, 'bad_name'); assert.ok(e.message);
  r = await fetch(S.base + '/api/tokens', J('POST', {}, ADMIN));
  assert.equal(r.status, 400);
  assert.equal((await fetch(S.base + '/api/tokens', J('PUT', {}, ADMIN))).status, 405);

  assert.equal((await fetch(S.base + '/api/tokens/' + a.id, { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}` } })).status, 401, '토큰으로 자기 폐기도 안 됨');
  assert.equal((await fetch(S.base + '/api/tokens/' + a.id, { method: 'DELETE', headers: ADMIN })).status, 200);
  assert.equal((await fetch(S.base + '/api/tokens/' + a.id, { method: 'DELETE', headers: ADMIN })).status, 404);
  assert.equal((await fetch(S.base + '/api/tokens/' + a.id, { headers: ADMIN })).status, 405);
});

test('/mcp: 토큰은 Bearer 로만, 폐기하면 401. 사이트 비밀번호는 그대로 어디서나', async () => {
  const { token, id } = await (await fetch(S.base + '/api/tokens', J('POST', { name: 'Bearer전용' }, ADMIN))).json();
  let r = await fetch(S.base + '/mcp', { method: 'POST', headers: H({ Authorization: `Bearer ${token}` }), body: init });
  assert.equal(r.status, 200);
  r = await fetch(S.base + '/mcp', { method: 'POST', headers: H({ 'X-App-Key': token }), body: init });
  assert.equal(r.status, 401, 'X-App-Key 로는 안 받는다');
  r = await fetch(S.base + '/mcp?key=' + token, { method: 'POST', headers: H(), body: init });
  assert.equal(r.status, 401, '?key= 로는 안 받는다');
  // 사이트 비밀번호: /mcp 의 세 방식 + /api
  for (const [url, h] of [['/mcp', { Authorization: `Bearer ${PW}` }], ['/mcp', { 'X-App-Key': PW }], ['/mcp?key=' + PW, {}]]) {
    assert.equal((await fetch(S.base + url, { method: 'POST', headers: H(h), body: init })).status, 200, url);
  }
  assert.equal((await fetch(S.base + '/api/shows', { headers: ADMIN })).status, 200);

  await fetch(S.base + '/api/tokens/' + id, { method: 'DELETE', headers: ADMIN });
  r = await fetch(S.base + '/mcp', { method: 'POST', headers: H({ Authorization: `Bearer ${token}` }), body: init });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer/);
  assert.equal((await r.json()).error, 'unauthorized');
});

test('/mcp: 토큰을 쓰면 lastUsedAt 이 목록에 보인다', async () => {
  const { token, id } = await (await fetch(S.base + '/api/tokens', J('POST', { name: '사용확인' }, ADMIN))).json();
  let row = (await (await fetch(S.base + '/api/tokens', { headers: ADMIN })).json()).find(x => x.id === id);
  assert.equal(row.lastUsedAt, null);
  await fetch(S.base + '/mcp', { method: 'POST', headers: H({ Authorization: `Bearer ${token}` }), body: init });
  row = (await (await fetch(S.base + '/api/tokens', { headers: ADMIN })).json()).find(x => x.id === id);
  assert.ok(!isNaN(Date.parse(row.lastUsedAt)));
});

test('e2e: 토큰으로 붙은 SDK 클라이언트 — edit_show·restore_revision 결과와 list_revisions 에 이름, 브라우저 PUT 은 브라우저', async () => {
  const { token } = await (await fetch(S.base + '/api/tokens', J('POST', { name: '김민수2' }, ADMIN))).json();
  const show = title => ({ title, version: 5, people: [], tracks: [], parts: [] });
  const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('원본') }, ADMIN))).json();
  // 브라우저 PUT → rev 2 by 브라우저
  let r = await fetch(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show('브라우저 수정') }, Object.assign({}, ADMIN, EK)));
  assert.equal(r.status, 200);

  const c = await connect(S.base, Object.assign({ Authorization: `Bearer ${token}` }, EK));
  try {
    assert.match(c.getInstructions(), /연결한 사람의 이름/);
    const desc = Object.fromEntries((await c.listTools()).tools.map(t => [t.name, t.description]));
    assert.match(desc.edit_show, /connected person's name/);
    assert.match(desc.list_revisions, /by/);

    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', kind: 'show', fields: { title: '토큰 수정' } }] } });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.by, '김민수2');
    assert.match(text(r), /saved by 김민수2/);
    assert.equal(r.structuredContent.rev, 3);

    r = await c.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 2 } });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.by, '김민수2');
    assert.match(text(r), /restored by 김민수2/);

    r = await c.callTool({ name: 'list_revisions', arguments: { showId: id } });
    const revs = r.structuredContent.revisions;
    assert.deepEqual(revs.map(x => [x.rev, x.by, x.via]), [[4, '김민수2', 'restore'], [3, '김민수2', 'mcp'], [2, '브라우저', 'browser'], [1, '브라우저', 'browser']]);
    assert.match(text(r), /rev 3 \S+ by 김민수2 via mcp/);
    assert.match(text(r), /rev 2 \S+ by 브라우저 via browser/);
  } finally { await c.close(); }

  // 사이트 비밀번호로 붙으면 "사이트 비밀번호"
  const m = await connect(S.base, Object.assign({ Authorization: `Bearer ${PW}` }, EK));
  try {
    r = await m.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', kind: 'show', fields: { title: '사이트 비밀번호 수정' } }] } });
    assert.equal(r.structuredContent.by, '사이트 비밀번호');
    const cur = (await m.callTool({ name: 'list_revisions', arguments: { showId: id } })).structuredContent.revisions[0];
    assert.deepEqual([cur.by, cur.via], ['사이트 비밀번호', 'mcp']);
  } finally { await m.close(); }
});

test('같은 서버에 동시에 붙은 두 토큰은 각자의 이름으로 기록된다 (요청마다 따로 묶임)', async () => {
  const mk = async n => (await (await fetch(S.base + '/api/tokens', J('POST', { name: n }, ADMIN))).json()).token;
  const [ta, tb] = await Promise.all([mk('동시A'), mk('동시B')]);
  const { id } = await S.server.store.create({ title: 'x', version: 5, people: [], tracks: [], parts: [] });
  const [ca, cb] = await Promise.all([connect(S.base, Object.assign({ Authorization: `Bearer ${ta}` }, EK)), connect(S.base, Object.assign({ Authorization: `Bearer ${tb}` }, EK))]);
  try {
    const edit = (c, t) => c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', kind: 'show', fields: { title: t } }] } });
    const rs = await Promise.all([edit(ca, 'a1'), edit(cb, 'b1'), edit(ca, 'a2'), edit(cb, 'b2')]);
    assert.deepEqual(rs.map(r => r.structuredContent.by), ['동시A', '동시B', '동시A', '동시B']);
    const revs = await S.server.store.revisions(id);
    const byRev = Object.fromEntries(revs.map(r => [r.rev, r.by]));
    rs.forEach((r, i) => assert.equal(byRev[r.structuredContent.rev], ['동시A', '동시B'][i % 2]));
  } finally { await ca.close(); await cb.close(); }
});

test('비밀번호 없는 서버: 토큰 관리는 404 tokens_disabled, /mcp 는 그대로 열림(기록은 익명)', async () => {
  const O = await start('');
  try {
    let r = await fetch(O.base + '/api/tokens');
    assert.equal(r.status, 404);
    const e = await r.json();
    assert.equal(e.error, 'tokens_disabled'); assert.match(e.message, /APP_PASSWORD/);
    assert.equal((await fetch(O.base + '/api/tokens', J('POST', { name: 'a' }))).status, 404);
    const { id } = await O.server.store.create({ title: 'x', version: 5, people: [], tracks: [], parts: [] });
    const c = await connect(O.base, EK);
    try {
      r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', kind: 'show', fields: { title: 'y' } }] } });
      assert.equal(r.structuredContent.by, '익명');
    } finally { await c.close(); }
  } finally { await stop(O); }
});

test('토큰은 편집 비밀번호를 대신하지 않는다: 읽기·dryRun 은 되고, 저장은 X-Edit-Key 나 editKey 가 있어야 한다', async () => {
  const { token } = await (await fetch(S.base + '/api/tokens', J('POST', { name: '읽기만' }, ADMIN))).json();
  const { id } = await S.server.store.create({ title: 'x', version: 5, people: [], tracks: [], parts: [] });
  await S.server.store.setAuth(id, await require('../lib/editkey').hashKey('secret-ek'));
  const c = await connect(S.base, { Authorization: `Bearer ${token}` });
  try {
    const set = (extra) => c.callTool({ name: 'edit_show', arguments: Object.assign({ showId: id, ops: [{ op: 'set', kind: 'show', fields: { title: 'y' } }] }, extra) });
    assert.ok(!(await c.callTool({ name: 'get_show', arguments: { showId: id } })).isError, '읽기는 토큰만으로');
    assert.ok(!(await set({ dryRun: true })).isError, 'dryRun 은 편집 비밀번호 없이');
    let r = await set();
    assert.equal(r.isError, true); assert.match(r.content[0].text, /edit password required/);
    r = await set({ editKey: '1234' });
    assert.equal(r.isError, true, '기본값이 아닌 프로젝트에 1234 는 안 된다');
    r = await c.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 1 } });
    assert.equal(r.isError, true);
    assert.equal((await S.server.store.get(id)).rev, 1, '아무것도 저장되지 않았다');
    r = await set({ editKey: 'secret-ek' });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(r.structuredContent.by, '읽기만');
  } finally { await c.close(); }
});

test('ADMIN_KEY 가 있으면 토큰 발급·폐기는 X-Admin-Key 도 필요 (목록은 사이트 비밀번호만), 틀리면 실패 제한', async () => {
  const A = await start(PW, { adminKey: '관리 키', editRate: { max: 3, windowMs: 60000 } });
  const AK = { 'X-Admin-Key': encodeURIComponent('관리 키') };
  try {
    let r = await fetch(A.base + '/api/tokens', J('POST', { name: 'a' }, ADMIN));
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'admin_forbidden');
    r = await fetch(A.base + '/api/tokens', J('POST', { name: 'a' }, Object.assign({}, AK)));
    assert.equal(r.status, 401, '관리자 키만으로는 안 된다 — 사이트 비밀번호가 먼저');
    r = await fetch(A.base + '/api/tokens', J('POST', { name: 'a' }, Object.assign({}, ADMIN, AK)));
    assert.equal(r.status, 201);
    const { id, token } = await r.json();
    assert.equal((await fetch(A.base + '/api/tokens', { headers: ADMIN })).status, 200, '목록은 사이트 비밀번호만');
    assert.equal((await fetch(A.base + '/api/tokens/' + id, { method: 'DELETE', headers: ADMIN })).status, 403);
    assert.equal((await fetch(A.base + '/mcp', { method: 'POST', headers: H({ Authorization: `Bearer ${token}` }), body: init })).status, 200, '폐기 실패 → 토큰은 그대로');
    for (let i = 0; i < 3; i++) assert.equal((await fetch(A.base + '/api/tokens/' + id, { method: 'DELETE', headers: Object.assign({}, ADMIN, { 'X-Admin-Key': 'wrong' }) })).status, 403);
    r = await fetch(A.base + '/api/tokens/' + id, { method: 'DELETE', headers: Object.assign({}, ADMIN, AK) });
    assert.equal(r.status, 429, '틀린 관리자 키가 쌓이면 맞는 키도 잠시 막힌다');
  } finally { await stop(A); }
});

test('휴지통: 지운 공연은 MCP 에서 안 보이고, 되살리면 by·via 기록과 함께 돌아온다. tokens.json 은 그대로', async () => {
  const { token } = await (await fetch(S.base + '/api/tokens', J('POST', { name: '휴지통확인' }, ADMIN))).json();
  const { id } = await S.server.store.create({ title: '지울 공연', version: 5, people: [], tracks: [], parts: [] });
  const c = await connect(S.base, Object.assign({ Authorization: `Bearer ${token}` }, EK));
  try {
    let r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', kind: 'show', fields: { title: '고친 공연' } }] } });
    assert.ok(!r.isError, text(r));
    assert.equal((await fetch(`${S.base}/api/shows/${id}`, { method: 'DELETE', headers: Object.assign({}, ADMIN, EK) })).status, 200);
    r = await c.callTool({ name: 'list_shows', arguments: {} });
    assert.ok(!r.structuredContent.shows.some(x => x.id === id), 'list_shows 에 없음');
    r = await c.callTool({ name: 'get_show', arguments: { showId: id } });
    assert.equal(r.isError, true);
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', kind: 'show', fields: { title: 'x' } }] } });
    assert.equal(r.isError, true, '지운 공연은 고칠 수 없다');
    assert.ok(fs.existsSync(path.join(S.dir, 'tokens.json')));

    const { items } = await (await fetch(S.base + '/api/trash', { headers: ADMIN })).json();
    const t = items.find(x => x.id === id);
    r = await fetch(`${S.base}/api/trash/${t.trashId}/restore`, { method: 'POST', headers: ADMIN });
    assert.equal(r.status, 200);
    r = await c.callTool({ name: 'list_revisions', arguments: { showId: id } });
    assert.deepEqual(r.structuredContent.revisions.slice(0, 1).map(x => [x.by, x.via]), [['휴지통확인', 'mcp']]);
  } finally { await c.close(); }
});

test('tokens: 폐기는 즉시(쓰기 대기 중에도) 막히고, 파일 쓰기가 실패하면 reject — 이 프로세스에서는 계속 막히고 파일·메모리는 그대로', async () => {
  const { t, dir, done } = await freshTokens();
  try {
    const a = await t.create('A'), b = await t.create('B');
    // 쓰기 큐가 막혀 있어도 revoke 를 부른 순간부터 거부
    let release; const gate = new Promise(r => { release = r; });
    t.serial(() => gate);
    const p = t.revoke(a.id);
    assert.equal(t.lookup(a.token), null, '큐를 기다리기 전에 막힌다');
    release(); assert.equal(await p, true);

    // 쓰기 실패: _save 를 실패시키면 reject, 토큰은 계속 막히고, 목록·파일에는 남아 다시 폐기할 수 있다
    const orig = t._save.bind(t);
    t._save = async () => { throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); };
    await assert.rejects(t.revoke(b.id), /EROFS/);
    assert.equal(t.lookup(b.token), null, '실패해도 이 프로세스에서는 막힌다');
    assert.ok(t.list().some(x => x.id === b.id), '목록에 남아 다시 폐기할 수 있다');
    assert.ok(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8').includes(sha256hex(b.token)), '파일은 이전 그대로');
    // 다시 읽은(= 재시작한) 인스턴스에서는 통한다 — 그래서 실패를 500 으로 알린다
    const t2 = new Tokens(dir); await t2.init();
    assert.deepEqual(t2.lookup(b.token), { id: b.id, name: 'B' });
    // 쓰기가 되살아나면 다시 폐기 → 파일에서도 빠진다
    t._save = orig;
    assert.equal(await t.revoke(b.id), true);
    const t3 = new Tokens(dir); await t3.init();
    assert.equal(t3.lookup(b.token), null);
    assert.equal(t3.size, 0);
  } finally { await done(); }
});

test('tokens: 실제 파일 쓰기 실패(읽기 전용 폴더)에서도 메모리를 먼저 바꾸지 않는다', { skip: process.getuid && process.getuid() === 0 ? 'root 는 권한을 무시한다' : false }, async () => {
  const { t, dir, done } = await freshTokens();
  try {
    const a = await t.create('A');
    fs.chmodSync(dir, 0o555);
    try {
      await assert.rejects(t.revoke(a.id));
      assert.equal(t.lookup(a.token), null);
      assert.equal(t.size, 1, '메모리 목록은 성공했을 때만 바뀐다');
      await assert.rejects(t.create('B'));
      assert.equal(t.size, 1, '실패한 발급도 아무것도 남기지 않는다');
    } finally { fs.chmodSync(dir, 0o755); }
    assert.equal(await t.revoke(a.id), true);
    const t2 = new Tokens(dir); await t2.init();
    assert.equal(t2.lookup(a.token), null);
  } finally { await done(); }
});

test('DELETE /api/tokens/:id: 파일 쓰기가 실패하면 500 save_failed + 안내, 그래도 /mcp 는 바로 401', async () => {
  const { token, id } = await (await fetch(S.base + '/api/tokens', J('POST', { name: '쓰기실패' }, ADMIN))).json();
  const tk = S.server.tokens, orig = tk._save;
  tk._save = async () => { throw new Error('EROFS'); };
  const err = console.error; console.error = () => {};
  try {
    const r = await fetch(S.base + '/api/tokens/' + id, { method: 'DELETE', headers: ADMIN });
    assert.equal(r.status, 500);
    const e = await r.json();
    assert.equal(e.error, 'save_failed'); assert.match(e.message, /다시 폐기/);
    assert.equal((await fetch(S.base + '/mcp', { method: 'POST', headers: H({ Authorization: `Bearer ${token}` }), body: init })).status, 401);
  } finally { tk._save = orig; console.error = err; }
  assert.equal((await fetch(S.base + '/api/tokens/' + id, { method: 'DELETE', headers: ADMIN })).status, 200, '쓰기가 되살아나면 다시 폐기');
});
