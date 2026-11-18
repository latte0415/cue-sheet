// lib/store.js — update(읽고-고치고-쓰기)·기록(history)·복원
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, HISTORY_KEEP } = require('../lib/store');

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-store-'));
  const store = new Store(dir);
  await store.init();
  return { store, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const show = title => ({ title, version: 5, people: [], tracks: [], parts: [] });

test('update: 복사본을 받아 고친 show 를 쓰고 rev 를 올린다. throw 하면 아무것도 안 쓴다', async () => {
  const { store, done } = await fresh();
  try {
    const { id } = await store.create(show('A'));
    let seen;
    const r = await store.update(id, (s, cur) => { seen = cur; s.title = 'B'; return s; });
    assert.equal(r.rev, 2);
    assert.deepEqual(seen.rev, 1);
    assert.equal((await store.get(id)).show.title, 'B');
    await assert.rejects(store.update(id, () => { throw new Error('nope'); }), /nope/);
    assert.equal((await store.get(id)).rev, 2);
    await assert.rejects(store.update(id, () => ({ title: 'no parts' })), /invalid show/);
    assert.equal(await store.update('missing', s => s), null);
    // fn 이 받은 객체를 고쳐도 저장된 레코드는 그대로 (깊은 복사)
    let leaked;
    await store.update(id, s => { leaked = s; return JSON.parse(JSON.stringify(s)); });
    leaked.title = 'mutated later';
    assert.equal((await store.get(id)).show.title, 'B');
  } finally { done(); }
});

test('update 는 쓰기 큐 안에서 직렬화된다 (동시에 여러 번 → 잃는 수정 없음)', async () => {
  const { store, done } = await fresh();
  try {
    const { id } = await store.create(Object.assign(show('A'), { revision: '' }));
    await Promise.all(Array.from({ length: 10 }, (_, k) => store.update(id, s => { s.revision += String(k); return s; })));
    const rec = await store.get(id);
    assert.equal(rec.rev, 11);
    assert.equal(rec.show.revision.length, 10);
  } finally { done(); }
});

test('기록: update 마다 이전 버전, revisions 최신 먼저, restore 는 새 쓰기라 다시 되돌릴 수 있다', async () => {
  const { store, dir, done } = await fresh();
  try {
    const { id } = await store.create(show('v1'));
    await store.update(id, s => Object.assign(s, { title: 'v2' }));
    await store.update(id, s => Object.assign(s, { title: 'v3' }));
    assert.ok(fs.existsSync(path.join(dir, 'shows', id, 'history', '1.json')));
    let revs = await store.revisions(id);
    assert.deepEqual(revs.map(r => [r.rev, r.title, r.current]), [[3, 'v3', true], [2, 'v2', false], [1, 'v1', false]]);
    assert.equal(revs[0].sceneCount, 0);

    const r = await store.restore(id, 1);
    assert.deepEqual([r.rev, r.restoredFrom], [4, 1]);
    assert.equal((await store.get(id)).show.title, 'v1');
    // 복원 되돌리기
    await store.restore(id, 3);
    assert.equal((await store.get(id)).show.title, 'v3');
    revs = await store.revisions(id);
    assert.deepEqual(revs.map(r => r.rev), [5, 4, 3, 2, 1]);
    // 같은 내용이면 쓰지 않는다, 없는 rev
    assert.deepEqual(await store.restore(id, 3), { unchanged: true, rev: 5, updatedAt: (await store.get(id)).updatedAt });
    assert.equal((await store.restore(id, 5)).unchanged, true);
    assert.deepEqual(await store.restore(id, 99), { missing: true });
    assert.equal(await store.restore('missing', 1), null);
    assert.equal(await store.revisions('missing'), null);
    // 목록·개수에 기록 폴더가 섞이지 않는다
    assert.equal((await store.list()).length, 1);
    assert.equal(await store.count(), 1);
  } finally { done(); }
});

test(`기록은 최근 ${HISTORY_KEEP}개만`, async () => {
  const { store, dir, done } = await fresh();
  try {
    const { id } = await store.create(Object.assign(show('A'), { revision: '' }));
    for (let k = 0; k < HISTORY_KEEP + 5; k++) await store.update(id, s => { s.revision = String(k); return s; });
    const files = fs.readdirSync(path.join(dir, 'shows', id, 'history'));
    assert.equal(files.length, HISTORY_KEEP);
    const revs = await store.revisions(id);
    assert.equal(revs.length, HISTORY_KEEP + 1);
    assert.equal(revs.at(-1).rev, 6, '가장 오래된 1~5 는 지워짐');
  } finally { done(); }
});

test('put: 브라우저 자동 저장은 솎아서 남긴다 — 첫 PUT·update 직후 PUT 은 남기고 연속 PUT 은 건너뜀', async () => {
  const { store, done } = await fresh();
  try {
    const { id } = await store.create(show('p1'));
    await store.put(id, 1, show('p2')); // 이 프로세스의 첫 쓰기 → 1 을 남김
    await store.put(id, 2, show('p3')); // 연속 PUT → 안 남김
    await store.put(id, 3, show('p4'));
    assert.deepEqual((await store.revisions(id)).map(r => r.rev), [4, 1]);
    await store.update(id, s => Object.assign(s, { title: 'mcp' })); // 4 를 남김
    await store.put(id, 5, show('p6')); // update 직후 PUT → 5(=MCP 수정 결과)를 남김
    await store.put(id, 6, show('p7'));
    assert.deepEqual((await store.revisions(id)).map(r => r.rev), [7, 5, 4, 1]);
    // 충돌은 그대로
    assert.equal((await store.put(id, 1, show('x'))).conflict.rev, 7);
  } finally { done(); }
});

test('remove: 기록 폴더도 지운다. duplicate 는 기록을 가져가지 않는다', async () => {
  const { store, dir, done } = await fresh();
  try {
    const { id } = await store.create(show('A'));
    await store.update(id, s => Object.assign(s, { title: 'B' }));
    const d = await store.duplicate(id);
    assert.deepEqual((await store.revisions(d.id)).map(r => r.rev), [1]);
    assert.ok((await store.remove(id)).trashId, '삭제는 휴지통으로');
    assert.ok(!fs.existsSync(path.join(dir, 'shows', id, 'history')));
    assert.ok(!fs.existsSync(path.join(dir, 'shows', id + '.json')));
  } finally { done(); }
});

test('restore: 그 사이 지워진 음원을 가리키는 트랙은 fileKey·fileName 을 비우고 경고', async () => {
  const { Readable } = require('stream');
  const { store, done } = await fresh();
  try {
    const tracks = [
      { id: 'tr-1', no: 1, title: '하우스', fileName: 'house.mp3', fileKey: 'k1', note: '', loop: true },
      { id: 'tr-2', no: 2, title: '오프닝', fileName: 'open.mp3', fileKey: 'k2', note: '', loop: false }
    ];
    const { id } = await store.create(Object.assign(show('A'), { tracks }));
    for (const k of ['k1', 'k2']) await store.audioPut(id, k, Readable.from([Buffer.from('ID3')]), { name: k + '.mp3', mime: 'audio/mpeg', limit: 1e6 });
    await store.update(id, s => Object.assign(s, { tracks: [] })); // rev 2: 트랙 삭제
    await store.audioDel(id, 'k1');                                  // 사이트에서 음원도 지움
    const r = await store.restore(id, 1);
    assert.equal(r.rev, 3);
    assert.equal(r.warnings.length, 1);
    assert.deepEqual([r.warnings[0].trackId, r.warnings[0].fileKey], ['tr-1', 'k1']);
    assert.match(r.warnings[0].msg, /no longer on the server/);
    const t = (await store.get(id)).show.tracks;
    assert.deepEqual([t[0].fileKey, t[0].fileName, t[0].title], [null, null, '하우스'], '트랙 정보는 살리고 연결만 끊는다');
    assert.deepEqual([t[1].fileKey, t[1].fileName], ['k2', 'open.mp3'], '파일이 남아 있으면 그대로');
    assert.equal((await store.getRevision(id, 1)).show.tracks[0].fileKey, 'k1', '기록 파일 자체는 그대로');
  } finally { done(); }
});
