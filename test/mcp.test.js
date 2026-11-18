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
  const headers = opts.headers || { Authorization: `Bearer ${PW}` };
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

test('e2e: 도구 목록·annotations, list_shows → get_show → search → edit(dryRun·저장·오류·충돌) → 기록 → 복원', async () => {
  const { id } = await S.server.store.create(backstage());
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
    assert.match(o, /people: p-yejun=조예준\(mc\)/);
    assert.match(o, /i-3 Q1 \(하우스 오픈/);
    assert.match(o, /q-1 sound BGM 1 play/);
    assert.match(o, /i-k 조예준: 안녕하세요/);
    assert.ok(o.length < JSON.stringify(backstage()).length / 3, `개요가 너무 깁니다: ${o.length}자`);
    assert.equal(r.structuredContent.rev, 1);
    r = await c.callTool({ name: 'get_show', arguments: { showId: id, sceneId: 's-12' } });
    assert.match(text(r), /scene s-12 "멘탈"/);
    assert.doesNotMatch(text(r), /s-4/);
    r = await c.callTool({ name: 'get_show', arguments: { showId: id, view: 'full', sceneId: 's-4' } });
    assert.equal(r.structuredContent.data.items[0].id, 'i-3');
    r = await c.callTool({ name: 'get_show', arguments: { showId: id, sceneId: 'nope' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /no scene with id "nope"/);
    r = await c.callTool({ name: 'get_show', arguments: { showId: 'nothere' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /list_shows/);

    r = await c.callTool({ name: 'search_show', arguments: { showId: id, query: '탑햇' } });
    assert.ok(r.structuredContent.total >= 3);
    assert.ok(r.structuredContent.matches.some(m => m.kind === 'cue' && m.itemId));

    // dryRun: 저장 안 함
    const ops = [{ op: 'add', kind: 'item', parent: 's-12', after: 'i-y', data: { text: '(테이블 정리)', cues: [{ dept: 'stage', stage: { text: '테이블 정리' } }] } }];
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops, dryRun: true } });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /dry run — nothing saved/);
    assert.equal((await S.server.store.get(id)).rev, 1);

    // 저장: 새 큐 문단에 사이 번호 (Q11 과 Q12 사이 → 11.1)
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops, expectRev: 1 } });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.rev, 2);
    assert.deepEqual(r.structuredContent.labels.map(l => l.label), ['11.1']);
    assert.match(text(r), /Q11\.1 assigned/);
    assert.match(text(r), /restore_revision \{"showId":"[^"]+","rev":1\}/);
    const api = await (await fetch(`${S.base}/api/shows/${id}`, { headers: { Authorization: `Bearer ${PW}` } })).json();
    assert.equal(api.rev, 2, '브라우저가 폴링하는 API 에 바로 보인다');
    assert.equal(api.show.parts[0].scenes.find(s => s.id === 's-12').items[1].text, '(테이블 정리)');

    // 실패는 isError 결과 + 고칠 방법 (아무것도 안 바뀜)
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: 'i-k', fields: { speaker: '박대훈' } }] } });
    assert.equal(r.isError, true);
    assert.match(text(r), /"박대훈" is a name, use id "p-daehoon"/);
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'remove', id: 'p-yejun' }] } });
    assert.equal(r.isError, true);
    assert.match(text(r), /still used in \d+ place/);
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: 'i-k', fields: { text: 'x' } }], expectRev: 1 } });
    assert.equal(r.isError, true);
    assert.match(text(r), /now at rev 2, not rev 1/);
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: 'nope' } });
    assert.equal(r.isError, true, '스키마 검증 실패도 isError 결과');
    assert.equal((await S.server.store.get(id)).rev, 2);

    // 트랙 번호 변경 → 음향 큐 함께
    r = await c.callTool({ name: 'edit_show', arguments: { showId: id, ops: [{ op: 'set', id: 'tr-3', fields: { no: 33 } }] } });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /BGM 3 → 33, \d+ sound cue/);

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
