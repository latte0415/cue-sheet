// 대본 끌어 옮기기의 데이터 변경 (index.html 의 relocateItem / relocateCue / relocateCueGroup / stepSlot / labelMap·restoreLabels)
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
    '\n;({ relocateItem, relocateCue, relocateCueGroup, stepSlot, labelMap, restoreLabels, renumberLabels, pruneCuePoint, restoreCuePoint, relocateCuesToNewPoint })', {});
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
  assert.deepEqual(plain(r), { from: { itemId: 'a', index: 0 }, to: { itemId: 'd', index: 1 }, changed: true, pruned: null });
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

test('Q 묶음: 문단의 큐 전부를 원래 순서대로 — 본문·코멘트는 제자리, isCue 갱신, 기본은 끝', () => {
  const s = show();
  const r = FE.relocateCueGroup(s, 'c', 'b', null);
  assert.deepEqual(plain(r), { ids: ['q2', 'q3'], from: { itemId: 'c', index: 0 }, to: { itemId: 'b', index: 0 }, changed: true, pruned: null });
  assert.deepEqual(find(s, 'b').cues.map(x => x.id), ['q2', 'q3']);
  assert.equal(find(s, 'b').isCue, true);
  assert.deepEqual(find(s, 'c').cues, []);
  assert.equal(find(s, 'c').isCue, false);
  assert.equal(find(s, 'c').comments.length, 1, '코멘트는 문단에 남는다');
  assert.deepEqual(ids(s, 'S1'), ['a', 'b', 'c'], '문단 순서는 그대로');
});

test('Q 묶음: 큐가 있는 문단이면 그 뒤에 합치고, index 를 주면 그 자리에 (다른 씬으로도)', () => {
  const s = show();
  const r = FE.relocateCueGroup(s, 'c', 'd', null);
  assert.deepEqual(find(s, 'd').cues.map(x => x.id), ['q4', 'q2', 'q3']);
  assert.equal(r.to.index, 1);
  const s2 = show();
  FE.relocateCueGroup(s2, 'c', 'a', 0);
  assert.deepEqual(find(s2, 'a').cues.map(x => x.id), ['q2', 'q3', 'q1']);
});

test('Q 묶음: 왕복하면 원래대로 — 합쳤을 때는 ids 로 옮긴 큐만 되돌린다', () => {
  const s = show(), before = JSON.stringify(s);
  let r = FE.relocateCueGroup(s, 'c', 'b', null);
  FE.relocateCueGroup(s, r.to.itemId, r.from.itemId, r.from.index);
  assert.equal(JSON.stringify(s), before);
  r = FE.relocateCueGroup(s, 'c', 'd', null);
  FE.relocateCueGroup(s, r.to.itemId, r.from.itemId, r.from.index, r.ids);
  assert.equal(JSON.stringify(s), before);
  // 다시 실행(redo)도 to 와 ids 로
  FE.relocateCueGroup(s, 'c', r.to.itemId, r.to.index, r.ids);
  assert.deepEqual(find(s, 'd').cues.map(x => x.id), ['q4', 'q2', 'q3']);
});

test('Q 묶음: ids 를 주면 그 큐만 — 합친 문단을 지나갈 때 원래 큐는 남는다', () => {
  const s = show();
  FE.relocateCueGroup(s, 'c', 'd', null); // d = q4 q2 q3
  const r = FE.relocateCueGroup(s, 'd', 'b', null, ['q2', 'q3']);
  assert.deepEqual(r.ids, ['q2', 'q3']);
  assert.equal(r.from.index, 1);
  assert.deepEqual(find(s, 'd').cues.map(x => x.id), ['q4']);
  assert.equal(find(s, 'd').isCue, true);
  assert.deepEqual(find(s, 'b').cues.map(x => x.id), ['q2', 'q3']);
});

test('Q 묶음: 같은 문단·큐 없는 문단은 changed=false, 없는 문단은 null — 아무것도 바꾸지 않는다', () => {
  const s = show(), before = JSON.stringify(s);
  assert.equal(FE.relocateCueGroup(s, 'c', 'c', null).changed, false);
  assert.equal(FE.relocateCueGroup(s, 'b', 'a', null).changed, false);
  assert.equal(FE.relocateCueGroup(s, 'zz', 'a', null), null);
  assert.equal(FE.relocateCueGroup(s, 'a', 'zz', null), null);
  assert.equal(JSON.stringify(s), before);
});

test('Q 묶음: 번호를 다시 매기고, labelMap 으로 적어 둔 번호로 되돌린다', () => {
  const s = show();
  assert.deepEqual(['a', 'c', 'd'].map(i => find(s, i).label), ['1', '2', '3']);
  const m = FE.labelMap(s);
  // c(Q2) 묶음을 b 로: 번호 자리는 같고 문단만 바뀐다 → a 1, b 2, c 없음, d 3
  let r = FE.relocateCueGroup(s, 'c', 'b', null);
  FE.renumberLabels(s);
  assert.deepEqual(['a', 'b', 'c', 'd'].map(i => find(s, i).label), ['1', '2', null, '3']);
  FE.relocateCueGroup(s, r.to.itemId, r.from.itemId, r.from.index, r.ids);
  FE.restoreLabels(s, m);
  assert.deepEqual(['a', 'b', 'c', 'd'].map(i => find(s, i).label), ['1', null, '2', '3']);
  // a(Q1) 묶음을 d(Q3) 에 합치면 큐 문단이 둘 → c 1, d 2. 되돌리면 1 2 3
  r = FE.relocateCueGroup(s, 'a', 'd', null);
  FE.renumberLabels(s);
  assert.deepEqual(['a', 'c', 'd'].map(i => find(s, i).label), [null, '1', '2']);
  FE.relocateCueGroup(s, r.to.itemId, r.from.itemId, r.from.index, r.ids);
  FE.restoreLabels(s, m);
  assert.deepEqual(['a', 'c', 'd'].map(i => find(s, i).label), ['1', '2', '3']);
});

// ---- 큐 지점(kind:'cue'): 큐가 0개면 지점도 없다 — 옮겨서 비면 정리, 되돌리면 같은 자리에 되살린다
const point = (id, cues) => ({ id, kind: 'cue', speaker: null, text: '', label: null, isCue: true, cues, comments: [] });
test('큐 지점: 큐 하나를 옮겨 비면 지점이 사라지고(pruned), restoreCuePoint 로 되살려 되돌린다', () => {
  const s = show();
  s.parts[0].scenes[0].items.splice(1, 0, point('pt', [cue('qp')]));
  const r = FE.relocateCue(s, 'qp', 'd', null);
  assert.deepEqual(plain(r.pruned), { sceneId: 'S1', index: 1, item: { id: 'pt', kind: 'cue', speaker: null, text: '', label: null, isCue: false, cues: [], comments: [] } });
  assert.ok(!find(s, 'pt'));
  assert.deepEqual(find(s, 'd').cues.map(c => c.id), ['q4', 'qp']);
  // 되돌리기 = 지점을 먼저 되살리고 큐를 돌려보낸다
  assert.equal(FE.restoreCuePoint(s, r.pruned), true);
  FE.relocateCue(s, 'qp', r.from.itemId, r.from.index);
  assert.deepEqual(s.parts[0].scenes[0].items.map(i => i.id), ['a', 'pt', 'b', 'c']);
  assert.deepEqual(find(s, 'pt').cues.map(c => c.id), ['qp']);
  assert.equal(find(s, 'pt').isCue, true);
});

test('큐 지점: Q 묶음을 통째로 옮겨도 정리, 큐가 남거나 일반 문단이면 그대로, 코멘트가 있으면 빈 지문으로 남긴다', () => {
  const s = show();
  s.parts[0].scenes[0].items.push(point('pt', [cue('x1'), cue('x2')]));
  let r = FE.relocateCueGroup(s, 'pt', 'b', null);
  assert.equal(r.pruned.item.id, 'pt'); assert.ok(!find(s, 'pt'));
  // 일부만(ids) 옮기면 남은 큐가 있어 지점 유지
  const s2 = show(); s2.parts[0].scenes[0].items.push(point('pt', [cue('x1'), cue('x2')]));
  r = FE.relocateCueGroup(s2, 'pt', 'b', null, ['x1']);
  assert.equal(r.pruned, null); assert.deepEqual(find(s2, 'pt').cues.map(c => c.id), ['x2']);
  // 일반 문단은 큐가 0개여도 남는다
  const s3 = show();
  r = FE.relocateCue(s3, 'q1', 'b', null);
  assert.equal(r.pruned, null); assert.ok(find(s3, 'a'));
  // 코멘트 달린 지점: 지우지 않고 빈 지문으로 (코멘트 보존)
  const s4 = show(); const pc = point('pc', [cue('y1')]); pc.comments.push({ id: 'cm', text: '확인' }); s4.parts[0].scenes[1].items.push(pc);
  r = FE.relocateCue(s4, 'y1', 'a', null);
  assert.equal(r.pruned, null); assert.equal(find(s4, 'pc').kind, 'action');
});

test('큐 지점은 큐 번호 대상이다 (큐가 있는 문단)', () => {
  const s = show();
  s.parts[0].scenes[0].items.splice(1, 0, point('pt', [cue('qp')]));
  FE.renumberLabels(s);
  assert.deepEqual(['a', 'pt', 'c', 'd'].map(i => find(s, i).label), ['1', '2', '3', '4']);
});

// ---- 큐를 문단 사이 틈에 놓기 → 그 자리에 새 큐 지점 (relocateCuesToNewPoint)
const order = (s, sid) => s.parts.flatMap(p => p.scenes).find(x => x.id === sid).items.map(i => i.id);
test('새 큐 지점: 큐 하나를 틈에 — 새 지점이 그 자리에, 원래 문단은 그대로(일반 문단), 되돌리면 원래대로', () => {
  const s = show(), before = JSON.stringify(s);
  // c 의 q3 을 S1 의 a 와 b 사이(index 1)에
  const r = FE.relocateCuesToNewPoint(s, ['q3'], 'S1', 1, 'np');
  assert.deepEqual(plain({ ids: r.ids, pointId: r.pointId, to: r.to, from: r.from, changed: r.changed, pruned: r.pruned }),
    { ids: ['q3'], pointId: 'np', to: { sceneId: 'S1', index: 1 }, from: { itemId: 'c', index: 1 }, changed: true, pruned: null });
  assert.deepEqual(order(s, 'S1'), ['a', 'np', 'b', 'c']);
  assert.deepEqual(plain(find(s, 'np')), { id: 'np', kind: 'cue', speaker: null, text: '', label: null, isCue: true, trigger: { type: 'signal', text: '' }, offsetSec: null, cues: [cue('q3')], comments: [] }); // v12: 트리거를 안 주면 빈 신호
  assert.deepEqual(find(s, 'c').cues.map(c => c.id), ['q2']);
  // 되돌리기: 큐를 원래 문단 원래 자리로 → 빈 새 지점은 relocateCueGroup 이 정리
  const back = FE.relocateCueGroup(s, r.pointId, r.from.itemId, r.from.index, r.ids);
  assert.equal(back.pruned.item.id, 'np');
  assert.equal(JSON.stringify(s), before);
});

test('새 큐 지점: Q 묶음을 다른 씬 틈에 — 원래 큐 지점은 정리(pruned), 되돌리기 = 지점 복원 + 큐 되돌림', () => {
  const s = show();
  s.parts[0].scenes[0].items.splice(1, 0, point('pt', [cue('x1'), cue('x2')])); // S1: a pt b c
  const before = JSON.stringify(s);
  const r = FE.relocateCuesToNewPoint(s, ['x1', 'x2'], 'S2', 0, 'np');
  assert.equal(r.pruned.item.id, 'pt');
  assert.deepEqual([order(s, 'S1'), order(s, 'S2')], [['a', 'b', 'c'], ['np', 'd']]);
  assert.deepEqual(find(s, 'np').cues.map(c => c.id), ['x1', 'x2']);
  FE.restoreCuePoint(s, r.pruned);
  FE.relocateCueGroup(s, r.pointId, r.from.itemId, r.from.index, r.ids);
  assert.equal(JSON.stringify(s), before);
  // 다시 실행: 같은 pointId 로 같은 결과
  const r2 = FE.relocateCuesToNewPoint(s, r.ids, r.to.sceneId, r.to.index, r.pointId);
  assert.deepEqual([order(s, 'S1'), order(s, 'S2'), r2.pruned.index], [['a', 'b', 'c'], ['np', 'd'], 1]);
});

test('새 큐 지점: 같은 씬 뒤쪽 틈 — 원래 지점이 앞에서 빠져도 자리가 맞고, 되돌리면 원래대로', () => {
  const s = show();
  s.parts[0].scenes[0].items.splice(0, 0, point('pt', [cue('x1')])); // S1: pt a b c
  const before = JSON.stringify(s);
  const r = FE.relocateCuesToNewPoint(s, ['x1'], 'S1', 3, 'np'); // b 와 c 사이
  assert.deepEqual(order(s, 'S1'), ['a', 'b', 'np', 'c']);
  FE.restoreCuePoint(s, r.pruned);
  FE.relocateCueGroup(s, r.pointId, r.from.itemId, r.from.index, r.ids);
  assert.equal(JSON.stringify(s), before);
});

test('새 큐 지점: 지점의 큐 전부를 그 지점 바로 앞뒤 틈에 놓으면 제자리 — 아무것도 바꾸지 않는다', () => {
  const s = show();
  s.parts[0].scenes[0].items.splice(1, 0, point('pt', [cue('x1'), cue('x2')])); // S1: a pt b c → pt 는 index 1
  const before = JSON.stringify(s);
  assert.equal(FE.relocateCuesToNewPoint(s, ['x1', 'x2'], 'S1', 1, 'np').changed, false);
  assert.equal(FE.relocateCuesToNewPoint(s, ['x1', 'x2'], 'S1', 2, 'np').changed, false);
  assert.equal(JSON.stringify(s), before);
  // 일부만 옮기면 제자리가 아니다 (지점이 둘로 나뉜다)
  const r = FE.relocateCuesToNewPoint(s, ['x2'], 'S1', 2, 'np');
  assert.equal(r.changed, true); assert.equal(r.pruned, null);
  assert.deepEqual(order(s, 'S1'), ['a', 'pt', 'np', 'b', 'c']);
  // 일반 문단의 큐를 바로 앞 틈에 놓는 것은 새 지점이 생긴다
  const s2 = show();
  assert.equal(FE.relocateCuesToNewPoint(s2, ['q1'], 'S1', 0, 'np').changed, true);
  assert.deepEqual(order(s2, 'S1'), ['np', 'a', 'b', 'c']);
  // 없는 큐·씬
  assert.equal(FE.relocateCuesToNewPoint(show(), ['nope'], 'S1', 0, 'np'), null);
  assert.equal(FE.relocateCuesToNewPoint(show(), ['q1'], 'nope', 0, 'np'), null);
});
