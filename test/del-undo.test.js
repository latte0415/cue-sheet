// 삭제 되돌리기 (index.html "삭제 되돌리기: 모델" — delRestore · histPush · undoPick)
// 지우기 직전·직후 show 와 지금 show 를 3-way 병합(lib/merge.js)으로 합쳐 지운 것만 제자리에 되살리는지
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../lib/merge');

// 다른 테스트와 같은 방식: index.html 의 "상수" ~ "상태" 구간을 떼어 Node 에서 돌린다 (migrate · relabel · pruneCuePoint 포함)
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  assert.ok(html.slice(a, b).includes('/* ================= 삭제 되돌리기: 모델'), '삭제 되돌리기 모델 구간이 상수~상태 안에 있어야 합니다');
  return vm.runInNewContext(html.slice(a, b) + '\n;({ relabel, migrate, pruneCuePoint, delRestore, delUnchanged, histPush, undoPick })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));
const J = o => JSON.stringify(o);
// 실데이터(cues/) — id 는 고정하지 않고 모양으로 고른다(데이터는 정리되며 바뀐다)
function show() {
  const s = plain(FE.migrate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'))));
  // 문단 코멘트는 실데이터에 없을 수 있어 하나 단다
  const it = s.parts[0].scenes.flatMap(sc => sc.items).find(i => i.kind !== 'cue');
  it.comments.push({ id: 'cm-test', author: '테스트', text: '여기 확인', createdAt: '2026-11-18T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null });
  FE.relabel(s);
  return s;
}
const scenes = s => s.parts.flatMap(p => p.scenes);
const entries = s => scenes(s).flatMap(sc => sc.items.map((it, ii) => ({ sc, it, ii })));
const findItem = (s, id) => entries(s).find(e => e.it.id === id);

// 화면이 하는 것과 같이: 직전 JSON → 지우기 → 저장(relabel) → 직후 JSON
function del(s, fn) {
  const before = J(s);
  fn(s);
  FE.relabel(s);
  return { before, after: J(s), seq: 1 };
}
// 화면의 삭제 동작들 (index.html 액션과 같은 변경)
const OPS = {
  '큐 (큐 여럿인 문단에서 하나)': s => { const e = entries(s).find(x => x.it.kind !== 'cue' && x.it.cues.length > 1) || entries(s).find(x => x.it.cues.length > 1); e.it.cues.splice(0, 1); e.it.isCue = e.it.cues.length > 0; },
  '큐 지점의 마지막 큐 (지점도 사라짐)': s => { const e = entries(s).find(x => x.it.kind === 'cue' && x.it.cues.length === 1); assert.ok(e, '큐 하나짜리 큐 지점이 실데이터에 있어야 합니다'); e.it.cues = []; e.it.isCue = false; assert.ok(FE.pruneCuePoint(s, e.it.id)); },
  '문단 (큐·코멘트 함께)': s => { const e = entries(s).find(x => x.it.comments.length); assert.ok(e.it.cues.length || e.it.comments.length); e.sc.items.splice(e.ii, 1); },
  '큐 있는 문단': s => { const e = entries(s).find(x => x.it.cues.length > 1); e.sc.items.splice(e.ii, 1); },
  '문단 코멘트': s => { const e = entries(s).find(x => x.it.comments.length); e.it.comments = e.it.comments.filter(c => c.id !== 'cm-test'); },
  '씬 코멘트': s => { const sc = scenes(s).find(x => x.comments && x.comments.length); assert.ok(sc, '씬 코멘트가 실데이터에 있어야 합니다'); sc.comments.splice(0, 1); },
  '씬': s => { const p = s.parts[0]; p.scenes.splice(2, 1); },
  '파트': s => { s.parts.splice(0, 1); },
  '사람 (씬 출연자에서도 빠짐)': s => { const id = s.people[0].id; s.people = s.people.filter(p => p.id !== id); scenes(s).forEach(sc => { sc.cast = sc.cast.filter(x => x !== id); }); },
  '소품 (공연 전 무대 소품에서도 빠짐)': s => { const id = s.preShowProps[0].propId; s.props = s.props.filter(p => p.id !== id); s.preShowProps = s.preShowProps.filter(x => x.propId !== id); },
  '공연 전 무대 소품 한 줄': s => { assert.ok(s.preShowProps.length, '공연 전 소품이 실데이터에 있어야 합니다'); s.preShowProps.splice(0, 1); },
  '트랙': s => { s.tracks.splice(1, 1); }
};

for (const [name, fn] of Object.entries(OPS)) {
  test(`삭제 직후 되돌리면 지우기 전과 똑같다 — ${name}`, () => {
    const s = show(), e = del(s, fn);
    assert.notEqual(e.after, e.before);
    const r = FE.delRestore(e, plain(s), M, FE.relabel);
    assert.equal(r.ok, true); assert.equal(r.stale, false); assert.equal(r.conflicts, 0);
    assert.deepEqual(plain(r.show), JSON.parse(e.before));
    // 병합 모듈이 없을 때(아티팩트·file://)도 삭제 뒤 바뀐 것이 없으면 그대로
    const r2 = FE.delRestore(e, plain(s), null, FE.relabel);
    assert.equal(r2.ok, true); assert.equal(r2.stale, false);
    assert.deepEqual(plain(r2.show), JSON.parse(e.before));
  });
}

test('삭제 뒤에 고친 것은 남기고 지운 문단만 제자리에 (큐 번호도 다시 연속)', () => {
  const s = show();
  const victim = entries(s).find(x => x.it.cues.length && x.ii > 0 && x.sc.items.length > 2), sid = victim.sc.id, idx = victim.ii, vid = victim.it.id, vcues = victim.it.cues.map(c => c.id);
  const e = del(s, x => { const v = findItem(x, vid); v.sc.items.splice(v.ii, 1); });
  // 삭제 뒤: 다른 문단 본문 고치기 · 같은 씬 맨 앞에 새 문단 · 사람 메모 고치기 · 다른 씬의 큐 지우기
  const other = entries(s).find(x => x.it.id !== vid && x.it.kind === 'line');
  other.it.text = '삭제 뒤에 고친 본문';
  scenes(s).find(x => x.id === sid).items.unshift({ id: 'i-new', kind: 'action', speaker: null, text: '새 문단', label: null, isCue: false, cues: [], comments: [] });
  s.people[0].note = '삭제 뒤 메모';
  const far = entries(s).filter(x => x.sc.id !== sid && x.it.cues.length > 1).pop();
  const farGone = far.it.cues[0].id; far.it.cues.splice(0, 1);
  FE.relabel(s);

  const r = FE.delRestore(e, plain(s), M, FE.relabel);
  assert.equal(r.ok, true); assert.equal(r.conflicts, 0);
  const got = r.show, sc = scenes(got).find(x => x.id === sid);
  assert.deepEqual(sc.items.map(i => i.id).slice(0, idx + 2), ['i-new'].concat(JSON.parse(e.before).parts.flatMap(p => p.scenes).find(x => x.id === sid).items.map(i => i.id).slice(0, idx + 1)),
    '지운 문단이 원래 이웃 사이로 (앞에 새 문단이 하나 더 생겼을 뿐)');
  assert.deepEqual(findItem(got, vid).it.cues.map(c => c.id), vcues, '지운 문단의 큐도 함께');
  assert.equal(findItem(got, other.it.id).it.text, '삭제 뒤에 고친 본문');
  assert.ok(findItem(got, 'i-new'));
  assert.equal(got.people[0].note, '삭제 뒤 메모');
  assert.ok(!entries(got).some(x => x.it.cues.some(c => c.id === farGone)), '삭제 뒤에 지운 다른 큐는 지운 채로');
  // 큐 번호는 대본 순서대로 1부터 연속
  const labels = entries(got).filter(x => x.it.cues.length).map(x => x.it.label);
  assert.deepEqual(labels, labels.map((_, i) => String(i + 1)));
});

test('여러 번 지운 것을 거꾸로 되돌리면 처음과 같다', () => {
  const s = show(), first = J(s);
  const list = [];
  ['문단 (큐·코멘트 함께)', '사람 (씬 출연자에서도 빠짐)', '큐 (큐 여럿인 문단에서 하나)', '트랙', '씬'].forEach(n => list.push(del(s, OPS[n])));
  let cur = plain(s);
  for (const e of list.reverse()) {
    const r = FE.delRestore(e, cur, M, FE.relabel);
    assert.equal(r.ok, true); assert.equal(r.conflicts, 0);
    cur = plain(r.show);
  }
  assert.deepEqual(cur, JSON.parse(first));
});

test('맨 위가 아닌 삭제를 되돌려도 그 뒤의 삭제는 그대로', () => {
  const s = show();
  const a = del(s, OPS['사람 (씬 출연자에서도 빠짐)']), pid = JSON.parse(a.before).people[0].id;
  const b = del(s, OPS['트랙']), tid = JSON.parse(b.before).tracks[1].id;
  const r = FE.delRestore(a, plain(s), M, FE.relabel);
  assert.equal(r.ok, true);
  assert.ok(r.show.people.some(p => p.id === pid));
  assert.ok(scenes(r.show).some(sc => sc.cast.includes(pid)), '씬 출연자 참조도 돌아온다');
  assert.ok(!r.show.tracks.some(t => t.id === tid), '나중에 지운 트랙은 지운 채로');
});

test('지운 것 안을 그 뒤에 또 바꿨으면 겹친 곳으로 세고 삭제 전 내용으로', () => {
  const s = show();
  const e = del(s, OPS['소품 (공연 전 무대 소품에서도 빠짐)']);
  s.preShowProps.push({ propId: s.props[0].id, at: '객석' }); // 같은 배열(통째 병합)을 삭제 뒤에 또 고침
  const r = FE.delRestore(e, plain(s), M, FE.relabel);
  assert.equal(r.ok, true);
  assert.ok(r.conflicts >= 1);
  assert.deepEqual(r.show.preShowProps, JSON.parse(e.before).preShowProps);
});

test('show 의 id·version·updatedAt 은 지금 것 (병합은 상대 = 직전 것을 고른다)', () => {
  const s = show(), e = del(s, OPS['트랙']);
  s.updatedAt = '2030-01-01T00:00:00.000Z';
  const r = FE.delRestore(e, plain(s), M, FE.relabel);
  assert.equal(r.show.updatedAt, '2030-01-01T00:00:00.000Z');
  assert.equal(r.show.id, s.id); assert.equal(r.show.version, s.version);
});

test('병합 모듈이 없고 삭제 뒤에 바뀐 것이 있으면 stale (통째 되돌리기 — 부르는 쪽이 정한다)', () => {
  const s = show(), e = del(s, OPS['트랙']);
  assert.equal(FE.delUnchanged(e, plain(s)), true);
  s.updatedAt = 'x'; assert.equal(FE.delUnchanged(e, plain(s)), true, '수정 시각만 다르면 같은 내용');
  s.title = '바뀐 제목';
  assert.equal(FE.delUnchanged(e, plain(s)), false);
  const r = FE.delRestore(e, plain(s), null, FE.relabel);
  assert.equal(r.ok, true); assert.equal(r.stale, true);
  assert.deepEqual(plain(r.show), JSON.parse(e.before));
});

test('histPush: 최대 n 개, 밀려난 것을 돌려준다', () => {
  const l = [];
  for (let i = 1; i <= 3; i++) assert.deepEqual(plain(FE.histPush(l, i, 3)), []);
  assert.deepEqual(plain(FE.histPush(l, 4, 3)), [1]);
  assert.deepEqual(plain(l), [2, 3, 4]);
});

test('undoPick: 이동과 삭제 중 순서 번호가 큰 쪽', () => {
  assert.equal(FE.undoPick(null, null), null);
  assert.equal(FE.undoPick({ seq: 3 }, null), 'mv');
  assert.equal(FE.undoPick(null, { seq: 3 }), 'del');
  assert.equal(FE.undoPick({ seq: 3 }, { seq: 5 }), 'del');
  assert.equal(FE.undoPick({ seq: 7 }, { seq: 5 }), 'mv');
});
