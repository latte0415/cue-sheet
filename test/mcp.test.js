// /mcp — 인증과, SDK 클라이언트로 Streamable HTTP 에 붙어 도구를 끝까지 호출하는 e2e (localhost 만)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const PW = 'stage-pw';
function start(password) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-mcp-'));
  const server = createServer({ dataDir: dir, password, log: null });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
}
function stop(s) { return new Promise(r => { s.server.closeAllConnections(); s.server.close(() => { fs.rmSync(s.dir, { recursive: true, force: true }); r(); }); }); }
const backstage = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
const rpc = (method, params, id) => JSON.stringify({ jsonrpc: '2.0', id: id == null ? 1 : id, method, params });
const H = extra => Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, extra);
// SSE 또는 JSON 응답에서 JSON-RPC 메시지 꺼내기
async function rpcBody(r) {
  const t = await r.text();
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) return JSON.parse(/^data: (.*)$/m.exec(t)[1]);
  return JSON.parse(t);
}
async function connect(base, opts) {
  opts = opts || {};
  const client = new Client({ name: 'cue-sheet-test', version: '1.0.0' }, opts.clientOptions);
  const headers = opts.headers || { Authorization: `Bearer ${PW}`, 'X-Edit-Key': '1234' }; // 새 프로젝트의 편집 비밀번호는 1234
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers } }));
  return client;
}
const text = r => r.content.map(c => c.text).join('\n');

let S;
before(async () => { S = await start(PW); });
after(() => stop(S));

test('인증: 없거나 틀리면 401 JSON, Bearer·X-App-Key·?key= 는 /api 와 /mcp 모두 통과', async () => {
  const init = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'curl', version: '1' } });
  let r = await fetch(S.base + '/mcp', { method: 'POST', headers: H(), body: init });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer/);
  assert.equal((await r.json()).error, 'unauthorized');
  r = await fetch(S.base + '/mcp', { method: 'POST', headers: H({ Authorization: 'Bearer wrong' }), body: init });
  assert.equal(r.status, 401);
  r = await fetch(S.base + '/mcp', { method: 'POST', headers: H({ Authorization: `Bearer ${PW}` }), body: init });
  assert.equal(r.status, 200);
  assert.equal((await rpcBody(r)).result.serverInfo.name, 'cue-sheet');
  r = await fetch(S.base + '/mcp', { method: 'POST', headers: H({ 'X-App-Key': PW }), body: init });
  assert.equal(r.status, 200);
  r = await fetch(S.base + '/mcp?key=' + PW, { method: 'POST', headers: H(), body: init });
  assert.equal(r.status, 200);
  // /api 도 같은 검사
  assert.equal((await fetch(S.base + '/api/shows')).status, 401);
  assert.equal((await fetch(S.base + '/api/shows', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(S.base + '/api/shows', { headers: { Authorization: `Bearer ${PW}` } })).status, 200);
  assert.equal((await fetch(S.base + '/api/shows', { headers: { 'X-App-Key': PW } })).status, 200);
  // 인증 없이 열리는 것들은 그대로
  assert.equal((await fetch(S.base + '/api/health')).status, 200);
  assert.equal((await fetch(S.base + '/healthz')).status, 200);
});

test('인증: 한글 비밀번호 — UTF-8 바이트 그대로 보낸 Bearer 도, URL 인코딩한 X-App-Key 도 통과', async () => {
  const K = await start('무대 비번');
  try {
    const raw = Buffer.from('무대 비번', 'utf8').toString('latin1'); // 클라이언트가 UTF-8 바이트를 그대로 실은 헤더
    assert.equal((await fetch(K.base + '/api/shows', { headers: { Authorization: 'Bearer ' + raw } })).status, 200);
    assert.equal((await fetch(K.base + '/api/shows', { headers: { Authorization: 'Bearer ' + encodeURIComponent('무대 비번') } })).status, 200);
    assert.equal((await fetch(K.base + '/api/shows', { headers: { 'X-App-Key': encodeURIComponent('무대 비번') } })).status, 200);
    assert.equal((await fetch(K.base + '/api/shows', { headers: { Authorization: 'Bearer ' + encodeURIComponent('무대') } })).status, 401);
  } finally { await stop(K); }
});

test('비밀번호 없는 서버는 /mcp 도 인증 없이 (/api 와 같게)', async () => {
  const O = await start('');
  try {
    const c = await connect(O.base, { headers: {} });
    const r = await c.callTool({ name: 'list_shows', arguments: {} });
    assert.deepEqual(r.structuredContent, { shows: [] });
    await c.close();
  } finally { await stop(O); }
});

// 픽스처(cues/backstage-part1.json)는 원문 수정에 따라 바뀐다 — id·이름은 하드코딩하지 않고 여기서 골라 쓴다
function fixtureFacts(show) {
  const scenes = show.parts.flatMap(p => p.scenes);
  const items = scenes.flatMap(sc => sc.items.map(it => ({ sc, it })));
  const person = id => show.people.find(p => p.id === id);
  const firstLabeled = items.find(x => x.it.label != null && x.it.cues.length);
  const line = items.find(x => x.it.kind === 'line' && person(x.it.speaker));
  // 제목 있는 씬 중, 큐 번호 붙은 문단이 있고 그 뒤(다른 씬 포함)에도 번호 붙은 문단이 있는 씬 → 사이에 끼우면 뒤 번호가 밀린다
  const labeledIdx = items.map((x, k) => (x.it.label != null && x.it.cues.length ? k : -1)).filter(k => k >= 0);
  const k = labeledIdx.find((k, n) => items[k].sc.title && n < labeledIdx.length - 1);
  const insert = items[k];
  const other = scenes.find(sc => sc !== insert.sc && sc.items.length);
  const usedNos = new Set(items.flatMap(x => x.it.cues).filter(c => c.dept === 'sound' && c.sound).map(c => c.sound.track));
  const track = show.tracks.find(t => usedNos.has(t.no));
  // 무대 큐 글: v7 이하 원본은 stage.text, v8 은 note
  const stageText = c => String(c.note || (c.stage && c.stage.text) || '').trim();
  // 글이 없으면(소품을 지정하고 note 를 비운 v8 무대 큐) 소품 이름으로 — search_show 는 stage.props 의 소품 이름도 찾는다
  const propName = c => { const r = c.stage && Array.isArray(c.stage.props) ? c.stage.props.find(x => x && x.propId) : null; const p = r && (show.props || []).find(x => x.id === r.propId); return p ? String(p.name).trim() : ''; };
  const stage = items.flatMap(x => x.it.cues).find(c => c.dept === 'stage' && (stageText(c).length >= 2 || propName(c)));
  return {
    firstLabeled, line, speaker: person(line.it.speaker),
    otherPerson: show.people.find(p => p.id !== line.it.speaker),
    insert, other, track, maxNo: Math.max(...show.tracks.map(t => t.no)),
    stageWord: (stageText(stage) || propName(stage)).split(/\s+/)[0]
  };
}
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('e2e: 도구 목록·annotations, list_shows → get_show → search → edit(dryRun·저장·오류·충돌) → 기록 → 복원', async () => {
  const show = backstage(), F = fixtureFacts(show);
  const { id } = await S.server.store.create(show);
  const c = await connect(S.base);
  try {
    assert.match(c.getInstructions(), /get_show[\s\S]*edit_show[\s\S]*restore_revision/);
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map(t => t.name), ['list_shows', 'get_show', 'search_show', 'edit_show', 'list_revisions', 'restore_revision']);
    const ann = Object.fromEntries(tools.map(t => [t.name, t.annotations]));
    assert.equal(ann.get_show.readOnlyHint, true);
    assert.equal(ann.edit_show.readOnlyHint, false);
    assert.equal(ann.edit_show.destructiveHint, true);
    assert.equal(ann.restore_revision.idempotentHint, true);
    assert.ok(tools.find(t => t.name === 'edit_show').inputSchema.properties.ops);

    let r = await c.callTool({ name: 'list_shows', arguments: {} });
    const listed = r.structuredContent.shows.find(s => s.id === id);
    assert.equal(listed.rev, 1);
    assert.match(text(r), new RegExp(id));

    // 개요: id·큐 번호·화자 이름이 보이고, JSON 전체보다 훨씬 짧다
    r = await c.callTool({ name: 'get_show', arguments: { showId: id } });
    const o = text(r);
    const p0 = show.people[0];
    assert.match(o, new RegExp(`people: ${esc(p0.id)}=${esc(p0.name)}\\(${p0.role}\\)`));
    assert.match(o, new RegExp(`${esc(F.firstLabeled.it.id)} Q${esc(F.firstLabeled.it.label)} `));
    assert.match(o, new RegExp(`${esc(F.firstLabeled.it.cues[0].id)} ${F.firstLabeled.it.cues[0].dept} `));
    assert.match(o, new RegExp(`${esc(F.line.it.id)}( Q[\\d.]+)? ${esc(F.speaker.name)}: `), '대사 줄에 화자 이름');
    assert.ok(o.length < JSON.stringify(backstage()).length / 3, `개요가 너무 깁니다: ${o.length}자`);
    assert.equal(r.structuredContent.rev, 1);
    r = await c.callTool({ name: 'get_show', arguments: { showId: id, sceneId: F.insert.sc.id } });
    assert.ok(text(r).includes(`scene ${F.insert.sc.id} "${F.insert.sc.title}"`), text(r));
    assert.ok(!text(r).includes(`scene ${F.other.id} `), '고른 씬만');
    r = await c.callTool({ name: 'get_show', arguments: { showId: id, view: 'full', sceneId: F.other.id } });
    assert.equal(r.structuredContent.data.items[0].id, F.other.items[0].id);
    r = await c.callTool({ name: 'get_show', arguments: { showId: id, sceneId: 'nope' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /no scene with id "nope"/);
    r = await c.callTool({ name: 'get_show', arguments: { showId: 'nothere' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /list_shows/);

    r = await c.callTool({ name: 'search_show', arguments: { showId: id, query: F.stageWord } });
    assert.ok(r.structuredContent.total >= 1);
    assert.ok(r.structuredContent.matches.some(m => m.kind === 'cue' && m.itemId));

    // dryRun: 저장 안 함
    const ops = [{ op: 'add', kind: 'item', parent: F.insert.sc.id, after: F.insert.it.id, data: { text: '(테이블 정리)', cues: [{ dept: 'sound', note: '테이블 정리하는 동안', sound: { track: F.track.no, action: 'play' } }] } }];
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops, dryRun: true } });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /dry run — nothing saved/);
    assert.equal((await S.server.store.get(id)).rev, 1);

    // 저장: 번호 붙은 문단 사이에 끼운 새 큐 문단 → 바로 다음 번호, 그 뒤 번호는 하나씩 밀린다 (늘 1부터 연속)
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops, expectRev: 1 } });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.rev, 2);
    const lb = r.structuredContent.labels;
    const added = lb.filter(l => l.was == null);
    assert.equal(added.length, 1);
    assert.equal(added[0].label, String(Number(F.insert.it.label) + 1));
    assert.ok(lb.length > 1 && lb.filter(l => l.was != null).every(l => Number(l.label) === Number(l.was) + 1));
    assert.ok(text(r).includes(`Q${added[0].label} assigned`));
    assert.ok(/renumbered Q\d+ → Q\d+/.test(text(r)));
    assert.match(text(r), /restore_revision \{"showId":"[^"]+","rev":1\}/);
    const api = await (await fetch(`${S.base}/api/shows/${id}`, { headers: { Authorization: `Bearer ${PW}` } })).json();
    assert.equal(api.rev, 2, '브라우저가 폴링하는 API 에 바로 보인다');
    const sc2 = api.show.parts.flatMap(p => p.scenes).find(s => s.id === F.insert.sc.id);
    assert.equal(sc2.items[sc2.items.findIndex(i => i.id === F.insert.it.id) + 1].text, '(테이블 정리)');

    // 실패는 isError 결과 + 고칠 방법 (아무것도 안 바뀜)
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: F.line.it.id, fields: { speaker: F.otherPerson.name } }] } });
    assert.equal(r.isError, true);
    assert.ok(text(r).includes(`"${F.otherPerson.name}" is a name, use id "${F.otherPerson.id}"`), text(r));
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'remove', id: F.speaker.id }] } });
    assert.equal(r.isError, true);
    assert.match(text(r), /still used in \d+ place/);
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: F.line.it.id, fields: { text: 'x' } }], expectRev: 1 } });
    assert.equal(r.isError, true);
    assert.match(text(r), /now at rev 2, not rev 1/);
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: 'nope' } });
    assert.equal(r.isError, true, '스키마 검증 실패도 isError 결과');
    assert.equal((await S.server.store.get(id)).rev, 2);

    // 트랙 번호 변경 → 음향 큐 함께
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: F.track.id, fields: { no: F.maxNo + 30 } }] } });
    assert.ok(!r.isError, text(r));
    assert.ok(new RegExp(`BGM ${F.track.no} → ${F.maxNo + 30}, \\d+ sound cue`).test(text(r)), text(r));

    // 기록과 복원
    r = await c.callTool({ name: 'list_revisions', arguments: { showId: id } });
    assert.deepEqual(r.structuredContent.revisions.map(x => [x.rev, x.current]), [[3, true], [2, false], [1, false]]);
    r = await c.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 1 } });
    assert.ok(!r.isError, text(r));
    assert.deepEqual([r.structuredContent.rev, r.structuredContent.restoredFrom], [4, 1]);
    assert.deepEqual((await S.server.store.get(id)).show, backstage());
    r = await c.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 1 } });
    assert.equal(r.structuredContent.unchanged, true, '같은 내용이면 다시 쓰지 않는다');
    r = await c.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 3 } });
    assert.equal(r.structuredContent.rev, 5, '복원도 되돌릴 수 있다');
    r = await c.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 77 } });
    assert.equal(r.isError, true);
    assert.match(text(r), /list_revisions/);
  } finally { await c.close(); }
});

test('2026-07-28 개정판으로 협상하는 클라이언트도 같은 도구를 쓴다', async () => {
  const c = await connect(S.base, { clientOptions: { versionNegotiation: { mode: { pin: '2026-07-28' } } } });
  try {
    const { tools } = await c.listTools();
    assert.equal(tools.length, 6);
    const r = await c.callTool({ name: 'list_shows', arguments: {} });
    assert.ok(Array.isArray(r.structuredContent.shows));
  } finally { await c.close(); }
});

test('옛 개정판(2025-03-26) 클라이언트: 손으로 보낸 JSON-RPC 로 tools/list·tools/call', async () => {
  const h = H({ Authorization: `Bearer ${PW}`, 'MCP-Protocol-Version': '2025-03-26' });
  let r = await fetch(S.base + '/mcp', { method: 'POST', headers: h, body: rpc('tools/list', {}, 2) });
  assert.equal(r.status, 200);
  assert.equal((await rpcBody(r)).result.tools.length, 6);
  r = await fetch(S.base + '/mcp', { method: 'POST', headers: h, body: rpc('tools/call', { name: 'list_shows', arguments: {} }, 3) });
  const m = await rpcBody(r);
  assert.ok(Array.isArray(m.result.structuredContent.shows));
  // 세션 없는 서버: GET(SSE 대기)은 405
  r = await fetch(S.base + '/mcp', { headers: { Authorization: `Bearer ${PW}`, Accept: 'text/event-stream' } });
  assert.equal(r.status, 405);
});

test('401: 길이를 모르는(chunked) 본문은 읽지 않고 바로 401 + 연결 닫기, /api 도 같게', async () => {
  const http = require('http');
  const u = new URL(S.base);
  for (const p of ['/mcp', '/api/shows']) {
    const res = await new Promise((resolve, reject) => {
      const rq = http.request({ host: u.hostname, port: u.port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, resolve);
      rq.on('error', reject);
      rq.write('{"jsonrpc":"2.0",'); // 끝내지 않는다 — 서버가 본문 끝을 기다리면 이 테스트는 시간 초과
    });
    assert.equal(res.statusCode, 401, p);
    assert.equal(res.headers.connection, 'close', p);
    res.resume();
  }
  // 작은 본문(Content-Length)은 비우고 연결을 유지
  const r = await fetch(S.base + '/api/shows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"show":{}}' });
  assert.equal(r.status, 401);
  assert.notEqual(r.headers.get('connection'), 'close');
  assert.equal(S.server.keepAliveTimeout, 65000);
  assert.ok(S.server.headersTimeout > S.server.keepAliveTimeout);
});

test('편집 비밀번호: 쓰기 도구(edit_show·restore_revision)는 그 프로젝트의 키 — X-Edit-Key 헤더 또는 editKey 인자, 읽기 도구는 사이트 비밀번호만', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-mcp-'));
  const server = createServer({ dataDir: dir, password: PW, log: null, editRate: { max: 4, windowMs: 60000 } });
  const E = await new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, dir, base: `http://127.0.0.1:${server.address().port}` })));
  const B = { Authorization: `Bearer ${PW}` };
  const KEY = '무대-편집';
  const cs = [];
  const conn = async extra => { const c = await connect(E.base, { headers: Object.assign({}, B, extra) }); cs.push(c); return c; };
  try {
    const { id } = await (await fetch(E.base + '/api/shows', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, B), body: JSON.stringify({ show: backstage() }) })).json();
    let res = await fetch(`${E.base}/api/shows/${id}/edit-password`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, B), body: JSON.stringify({ current: '1234', next: KEY }) });
    assert.equal(res.status, 200);
    // 본문을 고칠 수 있는 첫 문단 (큐 지점 kind:"cue" 는 본문이 없어야 해서 제외)
    const it = backstage().parts.flatMap(p => p.scenes.flatMap(sc => sc.items)).find(i => i.kind !== 'cue');
    const ops = n => [{ op: 'set', id: it.id, fields: { text: `(편집 키 ${n})` } }];
    const rev = async () => (await E.server.store.get(id)).rev;

    // 키 없는 연결: 읽기는 되고, 쓰기는 isError 로 막히며 아무것도 저장되지 않는다
    const c0 = await conn({});
    for (const [name, args] of [['list_shows', {}], ['get_show', { showId: id }], ['search_show', { showId: id, query: '(' }], ['list_revisions', { showId: id }]]) {
      const r = await c0.callTool({ name, arguments: args });
      assert.ok(!r.isError, name + ': ' + text(r));
    }
    let r = await c0.callTool({ name: 'edit_show', arguments: { showId: id, ops: ops(0) } });
    assert.equal(r.isError, true);
    assert.match(text(r), /edit password required for show .* X-Edit-Key header .* editKey/);
    assert.equal(await rev(), 1);
    r = await c0.callTool({ name: 'edit_show', arguments: { showId: id, ops: ops(0), dryRun: true } });
    assert.ok(!r.isError, 'dryRun 은 저장하지 않으므로 키 없이: ' + text(r));
    r = await c0.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 1 } });
    assert.equal(r.isError, true);
    assert.match(text(r), /edit password required/);
    // 기본값 1234 도 이제 안 됨, editKey 인자로 맞는 키를 주면 저장
    r = await c0.callTool({ name: 'edit_show', arguments: { showId: id, ops: ops(1), editKey: '1234' } });
    assert.equal(r.isError, true);
    r = await c0.callTool({ name: 'edit_show', arguments: { showId: id, ops: ops(1), editKey: KEY } });
    assert.ok(!r.isError, text(r));
    assert.equal(await rev(), 2);

    // 헤더: UTF-8 바이트 그대로(클라이언트 설정에 한글을 그대로 쓴 경우)와 URL 인코딩 둘 다
    const c1 = await conn({ 'X-Edit-Key': Buffer.from(KEY, 'utf8').toString('latin1') });
    r = await c1.callTool({ name: 'edit_show', arguments: { showId: id, ops: ops(2) } });
    assert.ok(!r.isError, text(r));
    assert.equal(await rev(), 3);
    const c2 = await conn({ 'X-Edit-Key': encodeURIComponent(KEY) });
    r = await c2.callTool({ name: 'restore_revision', arguments: { showId: id, rev: 1 } });
    assert.ok(!r.isError, text(r));
    assert.equal(await rev(), 4);

    // 틀린 키는 /api 와 같은 실패 제한(IP+프로젝트, 여기선 1분 4회): 지금까지 1회 틀림 → 3회 더 틀리면 막힌다
    const c3 = await conn({ 'X-Edit-Key': 'wrong' });
    for (let k = 0; k < 3; k++) assert.match(text(await c3.callTool({ name: 'edit_show', arguments: { showId: id, ops: ops(3) } })), /edit password required/);
    r = await c2.callTool({ name: 'edit_show', arguments: { showId: id, ops: ops(3) } });
    assert.equal(r.isError, true);
    assert.match(text(r), /too many wrong edit passwords .* wait \d+s/, '막힌 동안은 맞는 키도');
    res = await fetch(`${E.base}/api/shows/${id}/edit-check`, { method: 'POST', headers: Object.assign({ 'X-Edit-Key': encodeURIComponent(KEY) }, B) });
    assert.equal(res.status, 429, '/api 와 같은 카운터');
    assert.equal(await rev(), 4);
  } finally {
    for (const c of cs) await c.close().catch(() => {});
    await stop(E);
  }
});

test('v10 출연 큐: edit_show 가 cast.people(여러 사람)과 옛 한 사람 입력을 모두 받고, 개요·검색은 사이트 머리글("조예준·라태형 IN · 박대훈 OUT")', async () => {
  const show = backstage(); // v9 배포본 — 출연 큐가 한 사람
  const cq = show.parts.flatMap(p => p.scenes.flatMap(s => s.items.flatMap(i => i.cues))).find(q => q.dept === 'cast');
  const { id } = await S.server.store.create(show);
  const c = await connect(S.base);
  try {
    const desc = (await c.listTools()).tools.find(t => t.name === 'edit_show').description;
    assert.match(desc, /cast\.people/);
    assert.match(c.getInstructions(), /cast \{people:\[\{personId, move: in\|out\|move\}\]\}/);
    // 옛 한 사람 입력: 한 사람 큐에서는 그대로 (저장하며 v10 으로)
    let r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: cq.id, fields: { cast: { personId: 'p-taehyung', move: 'out' } } }] } });
    assert.ok(!r.isError, text(r));
    let g = await S.server.store.get(id);
    const at = s => s.parts.flatMap(p => p.scenes.flatMap(x => x.items.flatMap(i => i.cues))).find(q => q.id === cq.id);
    assert.equal(g.show.version, 10);
    assert.deepEqual(at(g.show).cast, { people: [{ personId: 'p-taehyung', move: 'out' }] });
    // 여러 사람
    const people = [{ personId: 'p-yejun', move: 'in' }, { personId: 'p-taehyung', move: 'in' }, { personId: 'p-daehoon', move: 'out' }];
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: cq.id, fields: { cast: { people } } }] } });
    assert.ok(!r.isError, text(r));
    g = await S.server.store.get(id);
    assert.deepEqual(at(g.show).cast, { people });
    r = await c.callTool({ name: 'get_show', arguments: { showId: id } });
    assert.match(text(r), new RegExp(`${cq.id} cast 조예준·라태형 IN · 박대훈 OUT`));
    r = await c.callTool({ name: 'search_show', arguments: { showId: id, query: '박대훈' } });
    assert.ok(r.structuredContent.matches.some(m => m.id === cq.id && m.field === 'cast.person'), JSON.stringify(r.structuredContent));
    // 여러 사람 큐에 옛 입력은 거부 — 고치지 않는다
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: cq.id, fields: { cast: { move: 'out' } } }] } });
    assert.equal(r.isError, true);
    assert.match(text(r), /has 3 people/);
  } finally { await c.close(); }
});
