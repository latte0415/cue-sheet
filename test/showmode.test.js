// 공연 모드 준비 계획 (index.html 의 smPlan / smStatus / smBootPick) — 받을 것·건너뛸 것, fileKey 교체 감지, 오프라인 새로고침 때 열 내용
// + sw.js 를 서버가 내주는지
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createServer } = require('../server');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// index.html 의 "공연 모드: 계획" 구간만 떼어 Node 에서 돌린다
function frontend() {
  const a = HTML.indexOf('/* ================= 공연 모드: 계획'), b = HTML.indexOf('/* =================', a + 10);
  assert.ok(a > 0 && b > a, 'index.html 에서 "공연 모드: 계획" 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  return vm.runInNewContext(HTML.slice(a, b) + '\n;({ smKey, smPlan, smStatus, smMB, smNos, smBootPick })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));
const tr = (id, no, fileKey) => ({ id, no, title: 't' + no, fileKey: fileKey || null });
const M = o => new Map(Object.entries(o));

test('smKey: showId/fileKey', () => {
  assert.equal(FE.smKey('show-1', 'f-abc'), 'show-1/f-abc');
});

test('smPlan: 처음 준비 — 파일 있는 트랙은 받고, 파일 없는 트랙은 따로', () => {
  const tracks = [tr('a', 1, 'f1'), tr('b', 2, 'f2'), tr('c', 3, null)];
  const p = FE.smPlan(tracks, new Map(), M({ f1: 100, f2: 250 }));
  assert.deepEqual(plain(p.get.map(x => [x.fileKey, x.size, x.nos])), [['f1', 100, [1]], ['f2', 250, [2]]]);
  assert.equal(p.skip.length, 0);
  assert.deepEqual(plain(p.nofile.map(t => t.no)), [3]);
  assert.equal(p.bytes, 350);
  assert.deepEqual(plain(p.drop), []);
});

test('smPlan: 이미 받은 파일은 건너뛰고, 크기가 다르면(덜 받음) 다시 받는다', () => {
  const tracks = [tr('a', 1, 'f1'), tr('b', 2, 'f2')];
  const p = FE.smPlan(tracks, M({ f1: 100, f2: 10 }), M({ f1: 100, f2: 250 }));
  assert.deepEqual(plain(p.skip.map(x => x.fileKey)), ['f1']);
  assert.deepEqual(plain(p.get.map(x => x.fileKey)), ['f2']);
  assert.equal(p.bytes, 250);
});

test('smPlan: 트랙 파일을 바꿔 올림(fileKey 바뀜) → 새 파일을 받고 옛 파일은 지울 목록', () => {
  const tracks = [tr('a', 1, 'f1'), tr('b', 2, 'f2-new')];
  const p = FE.smPlan(tracks, M({ f1: 100, f2: 250 }), M({ f1: 100, 'f2-new': 300 }));
  assert.deepEqual(plain(p.get.map(x => x.fileKey)), ['f2-new']);
  assert.deepEqual(plain(p.skip.map(x => x.fileKey)), ['f1']);
  assert.deepEqual(plain(p.drop), ['f2']);
});

test('smPlan: 같은 파일을 쓰는 트랙은 한 번만 받는다', () => {
  const p = FE.smPlan([tr('a', 1, 'f1'), tr('b', 2, 'f1')], new Map(), M({ f1: 100 }));
  assert.equal(p.get.length, 1);
  assert.deepEqual(plain(p.get[0].nos), [1, 2]);
  assert.equal(p.bytes, 100);
});

test('smPlan: 서버 목록에 없는 파일 — 받아 둔 게 있으면 그대로, 없으면 gone', () => {
  const tracks = [tr('a', 1, 'f1'), tr('b', 2, 'f2')];
  const p = FE.smPlan(tracks, M({ f1: 100 }), M({}));
  assert.deepEqual(plain(p.skip.map(x => x.fileKey)), ['f1'], '서버에서 지워졌어도 이 기기 사본으로는 재생할 수 있다');
  assert.deepEqual(plain(p.gone.map(x => x.fileKey)), ['f2']);
  assert.equal(p.get.length, 0);
});

test('smPlan: 서버 목록을 모르면(null) 받아 둔 것은 건너뛰고 나머지는 받는다(크기 모름)', () => {
  const p = FE.smPlan([tr('a', 1, 'f1'), tr('b', 2, 'f2')], M({ f1: 5 }), null);
  assert.deepEqual(plain(p.skip.map(x => x.fileKey)), ['f1']);
  assert.deepEqual(plain(p.get.map(x => [x.fileKey, x.size])), [['f2', null]]);
  assert.equal(p.bytes, 0);
});

test('smStatus: 분모는 트랙 수(점검 탭과 같음) — 다 받음 / 파일 없는 트랙만 남음', () => {
  const tracks = [tr('a', 1, 'f1'), tr('b', 2, 'f2')];
  let s = FE.smStatus(tracks, M({ f1: 1, f2: 1 }), { a: 'f1', b: 'f2' });
  assert.deepEqual(plain([s.total, s.ready, s.level]), [2, 2, 'ok']);
  s = FE.smStatus([...tracks, tr('c', 3, null)], M({ f1: 1, f2: 1 }), { a: 'f1', b: 'f2' });
  assert.deepEqual(plain([s.total, s.ready, s.nofile, s.level]), [3, 2, [3], 'part']);
});

test('smStatus: 준비 뒤 서버에서 파일이 바뀜 → changed, 준비 때 없던 트랙·받기 실패 → missing', () => {
  const tracks = [tr('a', 1, 'f1'), tr('b', 2, 'f2-new'), tr('c', 3, 'f3'), tr('d', 4, 'f4')];
  const s = FE.smStatus(tracks, M({ f1: 1, f2: 1 }), { a: 'f1', b: 'f2', d: 'f4' });
  assert.equal(s.ready, 1);
  assert.deepEqual(plain(s.changed), [2]);
  assert.deepEqual(plain(s.missing), [3, 4], 'c 는 준비 뒤에 생긴 트랙, d 는 준비 때 못 받은 트랙(같은 fileKey)');
  assert.equal(s.level, 'warn');
});

test('smStatus: 준비한 적 없으면(prepared null) changed 없이 missing', () => {
  const s = FE.smStatus([tr('a', 1, 'f1')], new Map(), null);
  assert.deepEqual(plain([s.ready, s.changed, s.missing, s.level]), [0, [], [1], 'warn']);
});

test('smMB · smNos', () => {
  assert.equal(FE.smMB(42 * 1048576), '42MB');
  assert.equal(FE.smMB(1.25 * 1048576), '1.3MB');
  assert.equal(FE.smMB(0), '0MB');
  assert.equal(FE.smNos([3, null, 5]), 'BGM 3, ?, 5');
});

test('smBootPick: 사본만 있으면 사본, 병합 기준은 base 일 때만', () => {
  const cache = { rev: 5, savedAt: '2026-11-18T10:00:00Z', base: true, show: { title: 'c' } };
  assert.deepEqual(plain(FE.smBootPick(cache, null)), { show: { title: 'c' }, rev: 5, dirty: false, base: { title: 'c' } });
  assert.equal(FE.smBootPick(Object.assign({}, cache, { base: false }), null).base, null);
  assert.equal(FE.smBootPick(null, null), null);
  assert.equal(FE.smBootPick({ savedAt: 'x' }, null), null, 'rev 없는 사본은 쓰지 않는다');
});

test('smBootPick: 저장 못 한 백업이 같은 판 위에서 더 나중이면 백업을 열고 다시 저장(dirty), 기준은 사본', () => {
  const cache = { rev: 5, savedAt: '2026-11-18T10:00:00Z', base: true, show: { title: 'c' } };
  const backup = { baseRev: 5, savedAt: '2026-11-18T10:05:00Z', show: { title: 'b' } };
  assert.deepEqual(plain(FE.smBootPick(cache, backup)), { show: { title: 'b' }, rev: 5, dirty: true, base: { title: 'c' } });
});

test('smBootPick: 옛 판의 백업·사본보다 먼저 쓴 백업은 무시', () => {
  const cache = { rev: 7, savedAt: '2026-11-18T10:00:00Z', base: true, show: { title: 'c' } };
  assert.equal(FE.smBootPick(cache, { baseRev: 5, savedAt: '2026-11-18T11:00:00Z', show: { title: 'old' } }).show.title, 'c', '옛 판 위의 백업');
  assert.equal(FE.smBootPick(cache, { baseRev: 7, savedAt: '2026-11-18T09:00:00Z', show: { title: 'early' } }).show.title, 'c', '이미 저장된 뒤 남은 백업');
});

test('smBootPick: 사본보다 옛 형식(version)의 백업은 쓰지 않는다 — 옛 화면이 새 필드를 떨어뜨린 백업일 수 있다', () => {
  const cache = { rev: 5, savedAt: '2026-11-18T10:00:00Z', base: true, show: { version: 8, title: 'c' } };
  const r = FE.smBootPick(cache, { baseRev: 5, savedAt: '2026-11-18T10:05:00Z', show: { version: 7, title: 'old-ui' } });
  assert.deepEqual(plain([r.show.title, r.dirty]), ['c', false]);
  // 같은 형식이면 원래대로 백업
  assert.equal(FE.smBootPick(cache, { baseRev: 5, savedAt: '2026-11-18T10:05:00Z', show: { version: 8, title: 'b' } }).show.title, 'b');
});

test('오프라인 부팅: 옛 형식(v7) 사본은 migrate 로 v8 이 된다 (smOfflineBoot 가 pick.show 를 migrate)', () => {
  const a = HTML.indexOf('/* ================= 상수'), b = HTML.indexOf('/* ================= 상태');
  const { migrate } = vm.runInNewContext(HTML.slice(a, b) + '\n;({ migrate })', {});
  const v7 = { version: 7, title: 'v7 사본', parts: [{ id: 'pt', scenes: [{ id: 's', items: [{ id: 'i', kind: 'action', text: '(x)', cues: [
    { id: 'q', dept: 'cast', trigger: '', memo: '메모', status: 'set', cast: { personId: null, move: 'in', text: '천천히' } }] }] }] }] };
  const pick = FE.smBootPick({ rev: 3, savedAt: '2026-11-18T10:00:00Z', base: false, show: v7 }, null);
  const m = plain(migrate(pick.show));
  assert.equal(m.version, 12);
  assert.equal(m.parts[0].scenes[0].items[1].cues[0].note, '천천히 / 메모'); // v12: 지문 i 바로 뒤의 큐 문단
  assert.deepEqual(m.parts[0].scenes[0].items[1].cues[0].cast, { people: [{ personId: null, move: 'in' }] }, 'v10: 사람이 비어 있어도 줄은 남는다');
  // 코드: 오프라인 부팅은 migrate 를 거치고, 이 화면보다 새 형식 사본은 열지 않는다
  const boot = HTML.slice(HTML.indexOf('async function smOfflineBoot'), HTML.indexOf('async function smPrepare'));
  assert.match(boot, /show = migrate\(pick\.show\)/);
  assert.match(boot, /Number\(pick\.show\.version\) > SHOW_VER/);
});

test('smBootPick: 더 새 판 위의 백업은 열되 병합 기준은 없음', () => {
  const cache = { rev: 5, savedAt: '2026-11-18T10:00:00Z', base: true, show: { title: 'c' } };
  const r = FE.smBootPick(cache, { baseRev: 6, savedAt: '2026-11-18T10:05:00Z', show: { title: 'b' } });
  assert.deepEqual(plain([r.show.title, r.rev, r.dirty, r.base]), ['b', 6, true, null]);
  assert.equal(FE.smBootPick(null, { baseRev: 6, savedAt: '2026-11-18T10:05:00Z', show: { title: 'b' } }).base, null);
});

test('Service Worker 는 서버 모드에서만 등록한다 (file://·아티팩트 = 로컬 모드 제외)', () => {
  const m = /function smSwOk\(\) \{([^\n]*)\}/.exec(HTML);
  assert.ok(m, 'smSwOk 를 찾지 못했습니다');
  assert.match(m[1], /Store\.mode === 'server'/);
  assert.match(m[1], /https\?/);
  const regs = HTML.split('serviceWorker.register(').length - 1;
  assert.equal(regs, 1, 'register 호출은 smSwSync 한 곳뿐');
  const at = HTML.indexOf('serviceWorker.register('), fn = HTML.lastIndexOf('function smSwSync', at);
  assert.ok(fn > 0 && HTML.slice(fn, at).includes('if (!smSwOk()) return;'), 'register 앞에 smSwOk 검사');
});

test('server: /sw.js 를 no-cache 로 내준다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-sw-'));
  const server = createServer({ dataDir: dir, password: '', log: null });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(base + '/sw.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const body = await r.text();
    assert.match(body, /cue-sheet-shell-/);
    assert.ok(!/\/api/.test(body.replace(/\/\/.*$/gm, '')), 'sw.js 는 /api 를 다루지 않는다(주석 밖에 /api 없음)');
  } finally {
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
