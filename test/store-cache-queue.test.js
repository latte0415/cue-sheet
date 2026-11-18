// 폴링 304 빠른 길(store 의 rev 캐시)과 프로젝트별 쓰기 큐 — 임시 DATA_DIR 로 Store·서버를 띄워 검사한다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('../lib/store');
const { createServer } = require('../server');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const show = (title, extra) => Object.assign({ id: 'x', title, version: 5, parts: [{ id: 'pt1', name: '1부', scenes: [{ id: 's1', items: [] }] }], people: [], tracks: [] }, extra);
const EK = { 'X-Edit-Key': '1234' };
const J = (method, body, headers) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, EK, headers), body: body === undefined ? undefined : JSON.stringify(body) });

async function fresh(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-cq-'));
  const store = new Store(dir, opts);
  await store.init();
  return { store, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function start(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-cq-'));
  const server = createServer(Object.assign({ password: '', log: null, adminKey: '' }, opts, { dataDir: dir }));
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
}
function stop(s) { return new Promise(r => { s.server.closeAllConnections(); s.server.close(() => { fs.rmSync(s.dir, { recursive: true, force: true }); r(); }); }); }
const diskRev = (dir, id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'shows', id + '.json'), 'utf8')).rev; } catch (e) { return undefined; } };
// 수동으로 여는 문: open() 하기 전까지 wait() 가 멈춘다
function gate() { let open; const p = new Promise(r => { open = r; }); return { wait: () => p, open }; }
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
// store._write 를 감싸 id 별로 지연·동시 실행 수를 잰다
function instrumentWrites(store, hold) {
  const orig = store._write.bind(store), active = new Map(), maxActive = new Map(), order = [];
  store._write = async function (id, ...rest) {
    active.set(id, (active.get(id) || 0) + 1);
    maxActive.set(id, Math.max(maxActive.get(id) || 0, active.get(id)));
    try {
      if (hold && hold[id]) await hold[id]();
      const r = await orig(id, ...rest);
      order.push(id + ':' + r.rev);
      return r;
    } finally { active.set(id, active.get(id) - 1); }
  };
  return { maxActive, order };
}
async function poll(S, id, etag) {
  const r = await fetch(`${S.base}/api/shows/${id}`, etag ? { headers: { 'If-None-Match': etag } } : undefined);
  const body = r.status === 200 || r.status === 404 ? await r.json() : null;
  return { status: r.status, etag: r.headers.get('etag'), body };
}

// ---------- 304 빠른 길
test('GET If-None-Match 가 캐시된 rev 와 맞으면 파일을 읽지 않고 304, 처음(캐시 없음)엔 한 번 읽어 채운다', async () => {
  const S = await start();
  try {
    const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('A') }))).json();
    const store = S.server.store;
    let gets = 0, reads = 0;
    const origGet = store.get.bind(store);
    store.get = id2 => { gets++; return origGet(id2); };
    const file = path.join(S.dir, 'shows', id + '.json');
    const origRead = fs.promises.readFile;
    fs.promises.readFile = function (f, ...rest) { if (String(f) === file) reads++; return origRead.call(this, f, ...rest); };
    try {
      for (let i = 0; i < 5; i++) {
        const r = await poll(S, id, '"1"');
        assert.equal(r.status, 304); assert.equal(r.etag, '"1"');
      }
      assert.equal(gets, 0, 'create 가 캐시를 채웠으므로 store.get 을 부르지 않는다');
      assert.equal(reads, 0, '레코드 파일을 읽지 않는다');
      // W/ 접두어·여러 값·* 도 예전처럼
      assert.equal((await poll(S, id, 'W/"1"')).status, 304);
      assert.equal((await poll(S, id, '"9", "1"')).status, 304);
      assert.equal((await poll(S, id, '*')).status, 304);
      assert.equal(reads, 0);
      // 다른 ETag 나 ETag 없는 GET 은 파일에서 본문을 읽어 200
      const r = await poll(S, id, '"0"');
      assert.equal(r.status, 200); assert.equal(r.etag, '"1"'); assert.equal(r.body.show.title, 'A');
      assert.equal(reads, 1);
      // 캐시를 비우면(재시작과 같음) 첫 폴링은 읽어서 304, 다음부터 다시 안 읽는다
      store.revCache.clear();
      assert.equal((await poll(S, id, '"1"')).status, 304);
      assert.equal(reads, 2);
      assert.equal((await poll(S, id, '"1"')).status, 304);
      assert.equal(reads, 2);
    } finally { fs.promises.readFile = origRead; store.get = origGet; }
  } finally { await stop(S); }
});

test('304 빠른 길도 인증(APP_PASSWORD)·id 검사를 먼저 거친다, 없는 id 는 404', async () => {
  const S = await start({ password: 'site' });
  try {
    const A = { 'X-App-Key': 'site' };
    const { id } = await (await fetch(S.base + '/api/shows', J('POST', { show: show('A') }, A))).json();
    assert.equal(S.server.store.cachedRev(id), 1);
    let r = await fetch(`${S.base}/api/shows/${id}`, { headers: { 'If-None-Match': '"1"' } });
    assert.equal(r.status, 401, '비밀번호 없이 304 를 주지 않는다');
    r = await fetch(`${S.base}/api/shows/${id}`, { headers: Object.assign({ 'If-None-Match': '"1"' }, A) });
    assert.equal(r.status, 304);
    r = await fetch(`${S.base}/api/shows/bad.id`, { headers: Object.assign({ 'If-None-Match': '*' }, A) });
    assert.equal(r.status, 400);
    r = await fetch(`${S.base}/api/shows/nothere`, { headers: Object.assign({ 'If-None-Match': '*' }, A) });
    assert.equal(r.status, 404);
    assert.equal(S.server.store.cachedRev('nothere'), undefined, '없는 id 는 캐시에 남지 않는다');
  } finally { await stop(S); }
});

test('모든 쓰기 경로 뒤 ETag: 옛 ETag → 200 + 새 ETag, 새 ETag → 304, 삭제 → 404, 되살리기(같은 id·새 id)', async () => {
  const S = await start({ password: 'site' });
  const A = { 'X-App-Key': 'site' };
  const f = (u, o) => fetch(u, Object.assign({}, o, { headers: Object.assign({}, A, o && o.headers) }));
  const p = async (id, etag) => {
    const r = await f(`${S.base}/api/shows/${id}`, etag ? { headers: { 'If-None-Match': etag } } : undefined);
    return { status: r.status, etag: r.headers.get('etag'), body: r.status === 200 ? await r.json() : null };
  };
  // 옛 ETag 는 200 + 새 ETag(디스크와 같은 rev), 새 ETag 는 304
  const moved = async (id, old, want) => {
    const r = await p(id, old);
    assert.equal(r.status, 200, `${id}: 옛 ETag ${old} 는 200`);
    assert.equal(r.etag, `"${want}"`); assert.equal(r.body.rev, want); assert.equal(diskRev(S.dir, id), want);
    assert.equal((await p(id, r.etag)).status, 304);
    assert.equal(S.server.store.cachedRev(id), want, '캐시 = 디스크');
  };
  try {
    // create
    const { id } = await (await f(S.base + '/api/shows', J('POST', { show: show('A') }))).json();
    assert.equal((await p(id, '"1"')).status, 304);
    // PUT
    assert.equal((await f(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show('A2') }))).status, 200);
    await moved(id, '"1"', 2);
    // 409·426 은 쓰지 않으므로 그대로
    assert.equal((await f(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: show('X') }))).status, 409);
    assert.equal((await f(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 2, show: show('old', { version: 4 }) }))).status, 426);
    assert.equal((await p(id, '"2"')).status, 304);
    // MCP edit_show 가 쓰는 길 = store.update
    await S.server.store.update(id, s => Object.assign(s, { title: 'A3' }), { by: 't', via: 'mcp' });
    await moved(id, '"2"', 3);
    // 기록 복원 (/api/.../restore)
    let r = await f(`${S.base}/api/shows/${id}/restore`, J('POST', { rev: 1 }));
    assert.equal(r.status, 200); assert.equal((await r.json()).rev, 4);
    await moved(id, '"3"', 4);
    // MCP restore_revision (실제 /mcp 로)
    const client = new Client({ name: 'cq-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(S.base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer site', 'X-Edit-Key': '1234' } } }));
    try {
      const m = await client.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 2 } });
      assert.ok(!m.isError, JSON.stringify(m.content));
    } finally { await client.close(); }
    await moved(id, '"4"', 5);
    // 음원 올리기·지우기·편집 비밀번호는 레코드(rev)를 바꾸지 않는다 — ETag 그대로
    assert.equal((await f(`${S.base}/api/shows/${id}/audio/f-1`, { method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav' }, body: 'RIFF-1' })).status, 200);
    assert.equal((await f(`${S.base}/api/shows/${id}/audio/f-1`, { method: 'PUT', headers: { ...EK, 'Content-Type': 'audio/wav' }, body: 'RIFF-2' })).status, 200);
    assert.equal((await p(id, '"5"')).status, 304); assert.equal(diskRev(S.dir, id), 5);
    // duplicate: 새 id 는 rev 1, 원본 ETag 그대로
    r = await f(`${S.base}/api/shows/${id}/duplicate`, { method: 'POST' });
    const dup = (await r.json()).id;
    assert.equal((await p(dup, '"1"')).status, 304);
    assert.equal((await p(dup, '"5"')).status, 200);
    assert.equal((await p(id, '"5"')).status, 304);
    // DELETE → 캐시에 rev 가 있어도 404 (304 아님)
    r = await f(`${S.base}/api/shows/${id}`, { method: 'DELETE', headers: EK });
    assert.equal(r.status, 200);
    const t1 = (await r.json()).trashId;
    assert.equal(S.server.store.cachedRev(id), undefined);
    assert.equal((await p(id, '"5"')).status, 404);
    assert.equal((await p(id, '*')).status, 404);
    // 되살리기 — 같은 id: 내용이 같은 rev 5 이므로 "5" 는 304, 옛 "4" 는 200
    r = await f(`${S.base}/api/trash/${t1}/restore`, { method: 'POST' });
    assert.equal((await r.json()).id, id);
    assert.equal((await p(id, '"5"')).status, 304);
    await moved(id, '"4"', 5);
    // 되살리기 — 같은 id 가 이미 있으면 새 id: 같은 원래 id 의 휴지통 항목을 하나 더 두고(복사), 하나를 원래 id 로 되살린 뒤 다른 하나를
    r = await f(`${S.base}/api/shows/${id}`, { method: 'DELETE', headers: EK });
    const t2 = (await r.json()).trashId;
    const t3 = id + '-' + (Number(t2.split('-').pop()) + 1);
    fs.cpSync(path.join(S.dir, 'trash', t2), path.join(S.dir, 'trash', t3), { recursive: true });
    r = await f(`${S.base}/api/trash/${t2}/restore`, { method: 'POST' });
    assert.equal((await r.json()).id, id);
    assert.equal((await f(`${S.base}/api/shows/${id}`, J('PUT', { baseRev: 5, show: show('A6') }))).status, 200);
    await moved(id, '"5"', 6);
    r = await f(`${S.base}/api/trash/${t3}/restore`, { method: 'POST' });
    const rr = await r.json();
    assert.equal(rr.originalId, id); assert.notEqual(rr.id, id, '쓰이는 id 면 새 id 로');
    assert.equal((await p(rr.id, '"5"')).status, 304, '새 id 에 되살린 rev 5');
    assert.equal(S.server.store.cachedRev(rr.id), 5);
    await moved(rr.id, '"6"', 5);
    assert.equal((await p(id, '"6"')).status, 304, '원래 id 는 그대로 rev 6');
  } finally { await stop(S); }
});

test('get() 이 파일을 읽는 사이 쓰기가 끼어들면 옛 rev 로 캐시를 채우지 않는다', async () => {
  const { store, dir, done } = await fresh();
  const origRead = fs.promises.readFile;
  try {
    const { id } = await store.create(show('A'));
    store.revCache.clear(); // 재시작 직후처럼
    const file = path.join(dir, 'shows', id + '.json');
    const g = gate();
    let first = true;
    // 첫 읽기만: 실제로 읽은(옛 rev 1) 뒤 돌려주기 전에 멈춘다
    fs.promises.readFile = async function (f, ...rest) {
      const data = await origRead.call(this, f, ...rest);
      if (first && String(f) === file) { first = false; await g.wait(); }
      return data;
    };
    const slowGet = store.get(id);
    await tick();
    const w = await store.put(id, 1, show('A2'));
    assert.equal(w.rev, 2);
    assert.equal(store.cachedRev(id), 2);
    g.open();
    assert.equal((await slowGet).rev, 1, '옛 내용을 읽었다');
    assert.equal(store.cachedRev(id), 2, '그 옛 rev 로 캐시를 덮지 않는다');
  } finally { fs.promises.readFile = origRead; done(); }
});

// ---------- 프로젝트별 쓰기 큐
test('다른 프로젝트의 쓰기는 서로 기다리지 않는다 (A 가 멈춰 있어도 B 가 먼저 끝난다)', async () => {
  const { store, done } = await fresh();
  try {
    const a = (await store.create(show('A'))).id, b = (await store.create(show('B'))).id;
    const g = gate();
    instrumentWrites(store, { [a]: g.wait });
    const pa = store.put(a, 1, show('A2'));
    await tick();
    const pb = store.put(b, 1, show('B2'));
    const first = await Promise.race([pa.then(() => 'A'), pb.then(() => 'B'), tick(2000).then(() => 'timeout')]);
    assert.equal(first, 'B', '전역 큐였다면 B 가 A 뒤에서 기다린다');
    assert.equal(store.cachedRev(b), 2);
    // A 와 B 를 함께 잡는 작업(B 의 복제는 B 만 잡는다)도 A 와 상관없이 끝난다
    const d = await Promise.race([store.duplicate(b), tick(2000).then(() => 'timeout')]);
    assert.notEqual(d, 'timeout');
    g.open();
    assert.equal((await pa).rev, 2);
    await store.idle();
    assert.equal(store.queues.size, 0, '빈 큐는 지운다');
  } finally { done(); }
});

test('같은 프로젝트의 쓰기는 하나씩: 동시에 넣은 PUT 이 순서대로 rev 를 올리고, 같은 baseRev 는 하나만 이긴다', async () => {
  const { store, dir, done } = await fresh();
  try {
    const { id } = await store.create(show('A'));
    const { maxActive, order } = instrumentWrites(store, { [id]: () => tick(5) });
    // 순서대로 넣은 baseRev 1..5 → rev 2..6
    const rs = await Promise.all([1, 2, 3, 4, 5].map(n => store.put(id, n, show('A' + n))));
    assert.deepEqual(rs.map(r => r.rev), [2, 3, 4, 5, 6]);
    assert.deepEqual(order, ['2', '3', '4', '5', '6'].map(r => id + ':' + r));
    assert.equal(maxActive.get(id), 1, '겹쳐 쓰지 않는다');
    // 같은 baseRev 6 으로 여럿 → 첫 번째만 저장, 나머지는 409(현재 rev 7)
    const cs = await Promise.all([0, 1, 2, 3].map(i => store.put(id, 6, show('C' + i))));
    assert.equal(cs[0].rev, 7);
    for (const c of cs.slice(1)) assert.equal(c.conflict.rev, 7);
    // 옛 형식은 426(outdated)
    assert.ok((await store.put(id, 7, show('old', { version: 4 }))).outdated);
    assert.equal(diskRev(dir, id), 7); assert.equal(store.cachedRev(id), 7);
    await store.idle();
    assert.equal(store.queues.size, 0);
  } finally { done(); }
});

test('HTTP: 같은 프로젝트에 동시에 PUT 하면 하나만 200, 나머지 409 — 다른 프로젝트는 영향 없음', async () => {
  const S = await start();
  try {
    const a = (await (await fetch(S.base + '/api/shows', J('POST', { show: show('A') }))).json()).id;
    const b = (await (await fetch(S.base + '/api/shows', J('POST', { show: show('B') }))).json()).id;
    const res = await Promise.all([
      ...[0, 1, 2, 3, 4].map(i => fetch(`${S.base}/api/shows/${a}`, J('PUT', { baseRev: 1, show: show('A' + i) }))),
      fetch(`${S.base}/api/shows/${b}`, J('PUT', { baseRev: 1, show: show('B2') }))
    ]);
    const sa = res.slice(0, 5).map(r => r.status).sort();
    assert.deepEqual(sa, [200, 409, 409, 409, 409]);
    assert.equal(res[5].status, 200);
    assert.equal(diskRev(S.dir, a), 2); assert.equal(diskRev(S.dir, b), 2);
    assert.equal((await poll(S, a, '"2"')).status, 304);
    assert.equal((await poll(S, b, '"2"')).status, 304);
  } finally { await stop(S); }
});

// ---------- 여러 키를 잡는 작업
test('복제 중에 원본을 휴지통으로: 먼저 들어온 복제가 끝난 뒤 옮긴다 / 먼저 지우면 복제는 null', async () => {
  const { store, dir, done } = await fresh();
  try {
    const { id } = await store.create(show('A'));
    fs.writeFileSync(path.join(store.audioDir(id), 'k1'), 'AUDIO');
    fs.writeFileSync(path.join(store.audioDir(id), 'k1.json'), '{}');
    // 복제 시작 → 원본 레코드를 읽는 사이 remove 가 들어온다
    const [d, rm] = await Promise.all([store.duplicate(id), store.remove(id)]);
    assert.ok(d && d.id && rm && rm.trashId);
    assert.equal(fs.readFileSync(path.join(store.audioDir(d.id), 'k1'), 'utf8'), 'AUDIO', '음원까지 복사한 뒤 옮겼다');
    assert.equal(diskRev(dir, d.id), 1); assert.equal(store.cachedRev(d.id), 1);
    assert.equal(diskRev(dir, id), undefined); assert.equal(store.cachedRev(id), undefined);
    // 반대 순서: 지운 뒤 복제 → null, 남는 id 없음
    const { id: id2 } = await store.create(show('B'));
    const [rm2, d2] = await Promise.all([store.remove(id2), store.duplicate(id2)]);
    assert.ok(rm2.trashId); assert.equal(d2, null);
    assert.equal(store.reserved.size, 0, '예약을 다 풀었다');
    const left = fs.readdirSync(path.join(dir, 'shows')).filter(n => n.endsWith('.json'));
    assert.deepEqual(left, [d.id + '.json']);
  } finally { done(); }
});

test('동시에 복제 둘·생성 여럿 → 모두 다른 id. newId 가 겹쳐도(같은 ms·같은 난수) 예약 때문에 다시 고른다', async () => {
  const { store, dir, done } = await fresh();
  try {
    const { id } = await store.create(show('A'));
    const [d1, d2] = await Promise.all([store.duplicate(id), store.duplicate(id)]);
    assert.notEqual(d1.id, d2.id);
    assert.equal(diskRev(dir, d1.id), 1); assert.equal(diskRev(dir, d2.id), 1);
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => store.create(show('C' + i))));
    assert.equal(new Set(many.map(m => m.id)).size, 20);
    // 같은 id 가 나오게 Date.now·randomBytes 를 고정 (처음 몇 번만 — 그 뒤엔 원래대로라 결국 다른 id 가 나온다)
    const origNow = Date.now, origRand = crypto.randomBytes;
    let forced = 6;
    Date.now = () => (forced > 0 ? 1700000000000 : origNow());
    crypto.randomBytes = function (n, ...rest) { if (n === 3 && forced > 0) { forced--; return Buffer.from([1, 2, 3]); } return origRand.call(this, n, ...rest); };
    let made;
    try { made = await Promise.all([store.create(show('X')), store.create(show('Y')), store.duplicate(id)]); } finally { Date.now = origNow; crypto.randomBytes = origRand; }
    assert.equal(new Set(made.map(m => m.id)).size, 3, '같은 id 를 두 작업이 고르지 않는다');
    for (const m of made) assert.equal(diskRev(dir, m.id), 1);
    assert.deepEqual(made.map(m => JSON.parse(fs.readFileSync(path.join(dir, 'shows', m.id + '.json'), 'utf8')).show.title), ['X', 'Y', 'A (복제)']);
  } finally { done(); }
});

test('휴지통 되살리기와 PUT 이 겹쳐도 레코드·캐시가 일관된다, 같은 항목을 둘이 되살리면 하나만', async () => {
  const { store, dir, done } = await fresh();
  try {
    const { id } = await store.create(show('A'));
    await store.put(id, 1, show('A2'));
    const { trashId } = await store.remove(id);
    // 지워진 동안의 PUT 은 null(404)
    assert.equal(await store.put(id, 2, show('gone')), null);
    // 되살리기와 PUT 을 동시에 — PUT 이 먼저 큐를 잡으면 null, 아니면 rev 3. 어느 쪽이든 디스크와 캐시가 같다
    const [rr, pr] = await Promise.all([store.trashRestore(trashId), store.put(id, 2, show('A3'))]);
    assert.equal(rr.id, id);
    const want = pr ? 3 : 2;
    assert.equal(diskRev(dir, id), want);
    assert.equal((await store.get(id)).rev, want);
    assert.equal(store.cachedRev(id), want);
    // 같은 항목을 동시에 두 번 되살리기 → 하나만 성공, 다른 하나는 null. 남는 프로젝트는 하나
    const r2 = await store.remove(id);
    const both = await Promise.all([store.trashRestore(r2.trashId), store.trashRestore(r2.trashId)]);
    assert.equal(both.filter(Boolean).length, 1);
    assert.equal(both.find(Boolean).id, id);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'shows')).filter(n => n.endsWith('.json')), [id + '.json']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'trash')), []);
    assert.equal(store.reserved.size, 0);
    // 휴지통 정리와 되살리기가 겹쳐도 되살린 프로젝트를 잃지 않는다
    const r3 = await store.remove(id);
    const [rest3, gone] = await Promise.all([store.trashRestore(r3.trashId), store.trashPurge(Date.now() + 365 * 86400000)]);
    if (rest3) { assert.equal(diskRev(dir, rest3.id), want); assert.deepEqual(gone, []); } else assert.deepEqual(gone, [r3.trashId]);
    await store.idle();
    assert.equal(store.queues.size, 0);
  } finally { done(); }
});

test('같은 원래 id 의 휴지통 항목 둘을 동시에 되살리면 하나는 원래 id, 하나는 새 id', async () => {
  const { store, dir, done } = await fresh();
  try {
    const { id } = await store.create(show('A'));
    const z1 = (await store.remove(id)).trashId;
    const z2 = id + '-' + (Number(z1.split('-').pop()) + 1);
    fs.cpSync(path.join(dir, 'trash', z1), path.join(dir, 'trash', z2), { recursive: true });
    const [r1, r2] = await Promise.all([store.trashRestore(z1), store.trashRestore(z2)]);
    assert.equal(r1.originalId, id); assert.equal(r2.originalId, id);
    assert.notEqual(r1.id, r2.id, '같은 id 를 두 곳에 되살리지 않는다');
    assert.ok([r1.id, r2.id].includes(id));
    for (const r of [r1, r2]) { assert.equal((await store.get(r.id)).rev, 1); assert.equal(store.cachedRev(r.id), 1); }
    assert.equal(store.reserved.size, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'trash')), []);
  } finally { done(); }
});

test('serial: 여러 키를 서로 다른 순서로 잡아도 교착하지 않고, 실패해도 큐가 계속 돈다', async () => {
  const { store, done } = await fresh();
  try {
    const log = [];
    const work = (name, ms, fail) => async () => { log.push('+' + name); await tick(ms); log.push('-' + name); if (fail) throw new Error(name); return name; };
    const ps = [
      store.serial(['k:a', 'k:b'], work('ab', 15)),
      store.serial(['k:b', 'k:a'], work('ba', 5, true)),
      store.serial('k:a', work('a', 1)),
      store.serial('k:c', work('c', 1))
    ];
    const rs = await Promise.race([Promise.allSettled(ps), tick(3000).then(() => 'deadlock')]);
    assert.notEqual(rs, 'deadlock');
    assert.deepEqual(rs.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    // c 는 ab 를 기다리지 않는다, ba 는 ab 뒤, a 는 ba 뒤
    assert.ok(log.indexOf('-c') < log.indexOf('-ab'));
    assert.ok(log.indexOf('+ba') > log.indexOf('-ab'));
    assert.ok(log.indexOf('+a') > log.indexOf('-ba'));
    await store.idle();
    assert.equal(store.queues.size, 0);
  } finally { done(); }
});
