// 대본 끌어 옮기기의 데이터 변경 (index.html 의 relocateItem / relocateCue / stepSlot / labelMap·restoreLabels)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// index.html 의 "큐 번호" 구간과 "끌어 옮기기: 모델" 구간만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cut = (from, to) => {
    const a = html.indexOf('/* ================= ' + from), b = html.indexOf('/* ================= ' + to);
    assert.ok(a > 0 && b > a, `index.html 에서 ${from}~${to} 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)`);
    return html.slice(a, b);
  };
  return vm.runInNewContext(cut('큐 번호', '마이그레이션') + cut('끌어 옮기기: 모델', '끌어 옮기기: 화면') +
    '\n;({ relocateItem, relocateCue, stepSlot, labelMap, restoreLabels, renumberLabels })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));

const cue = id => ({ id, dept: 'stage', trigger: '', offsetSec: null, memo: '', status: 'set', stage: { text: id } });
const item = (id, cues, comments) => ({ id, kind: 'line', speaker: null, text: id, label: null, isCue: !!(cues && cues.length), cues: cues || [], comments: comments || [] });
// 파트 2개: P1 = [S1: a b c, S2: d], P2 = [S3: (빈 씬)]
function show() {
  const s = {
    parts: [
      { id: 'P1', scenes: [
        { id: 'S1', items: [item('a', [cue('q1')]), item('b'), item('c', [cue('q2'), cue('q3')], [{ id: 'm1', text: '메모' }])] },
        { id: 'S2', items: [item('d', [cue('q4')])] },
      ] },
      { id: 'P2', scenes: [{ id: 'S3', items: [] }] },
    ],
  };
  FE.renumberLabels(s);
  return s;
}
const ids = (s, sid) => s.parts.flatMap(p => p.scenes).find(x => x.id === sid).items.map(i => i.id);
const find = (s, iid) => s.parts.flatMap(p => p.scenes).flatMap(x => x.items).find(i => i.id === iid);

test('같은 씬 안에서 문단 순서 바꾸기 — index 는 옮긴 뒤 자리', () => {
  const s = show();
  const r = FE.relocateItem(s, 'a', 'S1', 2);
  assert.deepEqual(ids(s, 'S1'), ['b', 'c', 'a']);
  assert.deepEqual(plain(r), { from: { sceneId: 'S1', index: 0 }, to: { sceneId: 'S1', index: 2 }, changed: true });
});

test('제자리에 놓으면 changed=false', () => {
  const s = show();
  const r = FE.relocateItem(s, 'b', 'S1', 1);
  assert.equal(r.changed, false);
  assert.deepEqual(ids(s, 'S1'), ['a', 'b', 'c']);
});

test('다른 씬으로 옮기면 큐·코멘트가 문단을 따라간다', () => {
  const s = show();
  FE.relocateItem(s, 'c', 'S2', 0);
  assert.deepEqual(ids(s, 'S1'), ['a', 'b']);
  assert.deepEqual(ids(s, 'S2'), ['c', 'd']);
  const c = find(s, 'c');
  assert.deepEqual(c.cues.map(x => x.id), ['q2', 'q3']);
  assert.equal(c.comments.length, 1);
});

test('빈 씬으로, 범위 밖 index 는 끝으로', () => {
  const s = show();
  FE.relocateItem(s, 'a', 'S3', 99);
  assert.deepEqual(ids(s, 'S3'), ['a']);
  const r = FE.relocateItem(s, 'b', 'S3', null);
  assert.deepEqual(ids(s, 'S3'), ['a', 'b']);
  assert.equal(r.to.index, 1);
});

test('from 을 그대로 다시 넣으면 원래대로 (되돌리기)', () => {
  const s = show(), before = JSON.stringify(s);
  const r = FE.relocateItem(s, 'c', 'S2', 1);
  FE.relocateItem(s, 'c', r.from.sceneId, r.from.index);
  assert.equal(JSON.stringify(s), before);
});

test('없는 문단·씬이면 null 이고 아무것도 바꾸지 않는다', () => {
  const s = show(), before = JSON.stringify(s);
  assert.equal(FE.relocateItem(s, 'zz', 'S1', 0), null);
  assert.equal(FE.relocateItem(s, 'a', 'S9', 0), null);
  assert.equal(JSON.stringify(s), before);
});

test('큐 하나를 다른 문단으로 — isCue 갱신, 기본은 맨 뒤', () => {
  const s = show();
  const r = FE.relocateCue(s, 'q1', 'd', null);
  assert.deepEqual(find(s, 'a').cues, []);
  assert.equal(find(s, 'a').isCue, false);
  assert.deepEqual(find(s, 'd').cues.map(x => x.id), ['q4', 'q1']);
  assert.equal(find(s, 'd').isCue, true);
  assert.deepEqual(plain(r), { from: { itemId: 'a', index: 0 }, to: { itemId: 'd', index: 1 }, changed: true });
  // 되돌리기
  FE.relocateCue(s, 'q1', r.from.itemId, r.from.index);
  assert.deepEqual(find(s, 'a').cues.map(x => x.id), ['q1']);
  assert.equal(find(s, 'a').isCue, true);
  assert.deepEqual(find(s, 'd').cues.map(x => x.id), ['q4']);
});

test('큐가 없던 문단으로 옮기면 그 문단이 큐 문단이 된다', () => {
  const s = show();
  FE.relocateCue(s, 'q3', 'b', 0);
  assert.deepEqual(find(s, 'b').cues.map(x => x.id), ['q3']);
  assert.equal(find(s, 'b').isCue, true);
  assert.deepEqual(find(s, 'c').cues.map(x => x.id), ['q2']);
});

test('stepSlot: 씬 안에서는 한 칸, 경계에서는 이웃 씬(파트를 넘어서도)', () => {
  const s = show();
  assert.deepEqual(plain(FE.stepSlot(s, 'b', -1)), { sceneId: 'S1', index: 0 });
  assert.deepEqual(plain(FE.stepSlot(s, 'b', 1)), { sceneId: 'S1', index: 2 });
  assert.deepEqual(plain(FE.stepSlot(s, 'c', 1)), { sceneId: 'S2', index: 0 });
  assert.deepEqual(plain(FE.stepSlot(s, 'd', -1)), { sceneId: 'S1', index: 3 });
  assert.deepEqual(plain(FE.stepSlot(s, 'd', 1)), { sceneId: 'S3', index: 0 });
  assert.equal(FE.stepSlot(s, 'a', -1), null);
});

test('옮긴 뒤 번호를 다시 매기고, 적어 둔 번호로 되돌린다', () => {
  const s = show();
  assert.deepEqual(['a', 'c', 'd'].map(i => find(s, i).label), ['1', '2', '3']);
  const m = FE.labelMap(s);
  const r = FE.relocateItem(s, 'd', 'S1', 0);
  FE.renumberLabels(s);
  assert.deepEqual(['d', 'a', 'c'].map(i => find(s, i).label), ['1', '2', '3']);
  FE.relocateItem(s, 'd', r.from.sceneId, r.from.index);
  FE.restoreLabels(s, m);
  assert.deepEqual(['a', 'c', 'd'].map(i => find(s, i).label), ['1', '2', '3']);
  assert.equal(find(s, 'b').label, null);
});

test('큐를 옮겨 큐가 없어진 문단은 되돌린 번호가 없으면 null', () => {
  const s = show();
  const m = FE.labelMap(s);
  FE.relocateCue(s, 'q1', 'b', null);
  FE.renumberLabels(s);
  assert.equal(find(s, 'a').label, null);
  assert.equal(find(s, 'b').label, '1');
  FE.relocateCue(s, 'q1', 'a', 0);
  FE.restoreLabels(s, m);
  assert.equal(find(s, 'a').label, '1');
  assert.equal(find(s, 'b').label, null);
});
