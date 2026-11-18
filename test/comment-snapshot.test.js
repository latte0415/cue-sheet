// 코멘트 스냅샷(코멘트 당시 문단) — index.html 의 순수 함수 cmtSnap·snapDiff·applySnap 과 migrate 보존
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateShow } = require('../lib/validate');

// validate.test.js 와 같은 방식: index.html 의 "상수" ~ "상태" 구간만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다');
  return vm.runInNewContext(html.slice(a, b) + '\n;({ migrate, cmtSnap, snapDiff, applySnap })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));

const light = (id, dim) => ({ id, dept: 'light', trigger: '대사 끝', offsetSec: null, note: '', status: 'set', light: { looks: [], channels: [{ ch: 'front', action: 'on', dim, color: null, colorName: null, timeSec: null }], anim: '' } });
const sound = id => ({ id, dept: 'sound', trigger: '', offsetSec: null, note: '', status: 'set', sound: { track: 1, action: 'play', timeSec: null, level: null } });
const item = () => ({ id: 'i-1', kind: 'line', speaker: 'p-a', text: '안녕하세요', label: '1', isCue: true, cues: [light('q-1', 50), sound('q-2')], comments: [] });

test('cmtSnap 은 문단 내용만, 큐는 깊은 복사로 남긴다', () => {
  const it = item(), s = FE.cmtSnap(it);
  assert.deepEqual(Object.keys(s).sort(), ['cues', 'kind', 'speaker', 'text']);
  it.cues[0].light.channels[0].dim = 80;
  assert.equal(s.cues[0].light.channels[0].dim, 50);
});

test('snapDiff: 바뀐 것이 없으면 same', () => {
  const it = item(), s = FE.cmtSnap(it);
  assert.equal(FE.snapDiff(s, it).same, true);
  // 키 순서만 다른 큐는 같은 큐
  const r = it.cues[1]; it.cues[1] = { sound: r.sound, status: r.status, note: r.note, offsetSec: r.offsetSec, trigger: r.trigger, dept: r.dept, id: r.id };
  assert.equal(FE.snapDiff(s, it).same, true);
});

test('snapDiff: 문장 · 큐 추가/삭제/변경 · 순서', () => {
  const it = item(), s = FE.cmtSnap(it);
  it.text = '반갑습니다';
  it.cues[0].light.channels[0].dim = 80; // 변경
  it.cues.splice(1, 1); // q-2 삭제
  it.cues.push(light('q-3', 30)); // 추가
  const d = FE.snapDiff(s, it);
  assert.equal(d.same, false);
  assert.equal(d.text, true);
  assert.deepEqual(plain(d.gone.map(c => c.id)), ['q-2']);
  assert.deepEqual(plain(d.extra.map(c => c.id)), ['q-3']);
  assert.deepEqual(plain(d.changed.map(x => [x.then.light.channels[0].dim, x.now.light.channels[0].dim])), [[50, 80]]);
  assert.equal(d.order, false);

  const it2 = item(), s2 = FE.cmtSnap(it2);
  it2.cues.reverse();
  const d2 = FE.snapDiff(s2, it2);
  assert.equal(d2.order, true);
  assert.equal(d2.same, false);
  assert.equal(d2.text, false);

  const it3 = item(), s3 = FE.cmtSnap(it3);
  it3.kind = 'action'; it3.speaker = null; it3.text = '(퇴장)';
  assert.equal(FE.snapDiff(s3, it3).text, true);
});

test('applySnap 후에는 차이가 없고, 스냅샷은 그대로다', () => {
  const it = item(), s = FE.cmtSnap(it);
  it.text = '바뀜'; it.speaker = null; it.cues = [];
  it.isCue = false;
  FE.applySnap(it, s);
  assert.equal(FE.snapDiff(s, it).same, true);
  assert.equal(it.isCue, true);
  assert.equal(it.speaker, 'p-a');
  assert.equal(it.id, 'i-1'); // 문단 id·코멘트는 건드리지 않는다
  it.cues[0].note = '되돌린 뒤 수정';
  assert.equal(s.cues[0].note, '');
});

const showWith = comments => ({
  version: 5, title: 't', people: [{ id: 'p-a', name: 'A', role: 'performer', note: '' }], tracks: [{ id: 'tr-1', no: 1, title: '', durationSec: null, fileName: null, fileKey: null, note: '', loop: false }],
  parts: [{ id: 'pt-1', name: '1부', scenes: [{ id: 's-1', type: 'act', title: '씬', cast: ['p-a'], durationSec: null, setup: '', comments: [], items: [Object.assign(item(), { comments })] }] }]
});

test('migrate 는 snapshot 을 보존·정규화하고, 없는 코멘트에는 키를 만들지 않는다', () => {
  const snap = FE.cmtSnap(item());
  const raw = showWith([
    { id: 'c-1', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null, snapshot: snap },
    { id: 'c-2', author: 'a', text: '옛 코멘트', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null },
    { id: 'c-3', author: 'a', text: '이상한 값', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, snapshot: 'x' }
  ]);
  const cm = plain(FE.migrate(raw)).parts[0].scenes[0].items[0].comments;
  assert.deepEqual(cm[0].snapshot, plain(snap));
  assert.equal('snapshot' in cm[1], false);
  assert.equal('snapshot' in cm[2], false);
  // 한 번 더 돌려도 같다 (저장 → 불러오기 왕복)
  assert.deepEqual(plain(FE.migrate(plain(FE.migrate(raw)))).parts[0].scenes[0].items[0].comments, cm);
});

test('validateShow: snapshot 은 모르는 키 경고가 나지 않는다', () => {
  const s = plain(FE.migrate(showWith([{ id: 'c-1', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null, snapshot: FE.cmtSnap(item()) }])));
  const v = validateShow(s);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.filter(w => /snapshot/.test(w.path + ' ' + w.message)), []);
});

test('v6 → v8: snapshot 의 무대 큐 소품 동작(stage.props)도 보존되고, 결과는 version 8 로 검증 통과', () => {
  const stage = { id: 'q-3', dept: 'stage', trigger: '', offsetSec: null, memo: '', status: 'set', stage: { text: '', props: [{ propId: 'pr-hat', action: 'in', at: '테이블' }] } }; // v6 모양
  const it = Object.assign(item(), { cues: [light('q-1', 50), stage] });
  const raw = Object.assign(showWith([{ id: 'c-1', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null, snapshot: FE.cmtSnap(it) }]),
    { version: 6, props: [{ id: 'pr-hat', name: '탑햇', note: '' }], preShowProps: [] });
  raw.parts[0].scenes[0].items[0].cues = plain(it.cues);
  const s = plain(FE.migrate(raw));
  assert.equal(s.version, 11);
  assert.deepEqual(s.parts[0].scenes[0].items[0].comments[0].snapshot.cues[1].stage, { props: [{ propId: 'pr-hat', action: 'in', at: '테이블' }] });
  const v = validateShow(s);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.filter(w => /snapshot/.test(w.path + ' ' + w.message)), []);
  // v5 snapshot 의 무대 큐(props 없음)는 v8 모양(props: [], 글은 note)으로 정규화
  const old = Object.assign(item(), { cues: [{ id: 'q-9', dept: 'stage', trigger: '', offsetSec: null, memo: '', status: 'set', stage: { text: '컵 빼기' } }] });
  const s5 = plain(FE.migrate(showWith([{ id: 'c-2', author: 'a', text: '옛', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, snapshot: FE.cmtSnap(old) }])));
  assert.deepEqual(s5.parts[0].scenes[0].items[0].comments[0].snapshot.cues[0].stage, { props: [] });
  assert.equal(s5.parts[0].scenes[0].items[0].comments[0].snapshot.cues[0].note, '컵 빼기');
});

test('v6 → v8: snapshot 이 없는 v6 공연(memo 비어 있음)은 version 과 memo → note 만 바뀐다', () => {
  const raw = Object.assign(showWith([{ id: 'c-1', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null }]),
    { id: 'show-x', revision: '', updatedAt: '2026-11-01T00:00:00.000Z', preShowSetup: '', version: 6, props: [], preShowProps: [] });
  raw.parts[0].scenes[0].items[0].cues = [light('q-1', 50), sound('q-2')];
  const once = plain(FE.migrate(raw));
  assert.equal(once.version, 11);
  const v6 = Object.assign(plain(once), { version: 6 });
  assert.deepEqual(plain(FE.migrate(v6)), once, 'v6 으로 다시 읽어도 같다');
  assert.equal('snapshot' in once.parts[0].scenes[0].items[0].comments[0], false);
  assert.deepEqual(validateShow(Object.assign(plain(once), { version: 6 })).warnings, [], 'v6 도 경고 없이 읽힌다');
  assert.deepEqual(validateShow(once).warnings, []);
});
