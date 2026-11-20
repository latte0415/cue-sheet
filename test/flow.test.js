// 흐름 보기 자리 계산 (index.html 의 flowModel · flowLanes · flowNowX · flowChain) — 칸 · x, 출연자 줄(6줄 넘으면 "기타 출연"),
// 켜져 있는 동안 막대(부서마다 · 왼쪽 끝부터 · 오른쪽 끝까지 · 겹치면 아래 칸), 연결(후 · 함께 · 대사 눈금)의 끝점, 지금 선
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// index.html 의 "상수"·"유틸"·"점검: 규칙"(trigGraph · trigKind) 구간과 "흐름: 배치" 구간만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cut = from => {
    const a = html.indexOf('/* ================= ' + from), b = html.indexOf('/* =================', a + 10);
    assert.ok(a > 0 && b > a, `index.html 에서 ${from} 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)`);
    return html.slice(a, b);
  };
  return vm.runInNewContext(cut('상수') + cut('유틸') + cut('점검: 규칙') + cut('흐름: 배치') + '\n;({ flowModel, flowLanes, flowNowX, flowChain, trigGraph, FLOW_G })', {});
}
const FE = frontend();
const G = FE.FLOW_G;
const plain = o => JSON.parse(JSON.stringify(o)); // vm 쪽 배열·객체는 프로토타입이 달라 deepEqual 전에 평범한 값으로
const eq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);

// 작은 공연: 문단(대사 · 지문)과 큐(kind:'cue'). 동작 = { dept, ... }
const line = (id, speaker) => ({ id, kind: 'line', speaker: speaker || null, text: id + ' 대사', cues: [], comments: [] });
const action = id => ({ id, kind: 'action', speaker: null, text: '(' + id + ')', cues: [], comments: [] });
const cue = (id, trigger, acts, offsetSec) => ({ id, kind: 'cue', text: '', label: id, trigger, offsetSec: offsetSec == null ? null : offsetSec, cues: acts, comments: [] });
const sig = t => ({ type: 'signal', text: t || '신호' });
const after = (cueId, mode) => ({ type: 'cue', cueId, mode: mode || 'after' });
const onLine = itemId => ({ type: 'line', itemId, at: 'end' });
let an = 0;
const cast = (...rows) => ({ id: 'a' + (++an), dept: 'cast', status: 'set', note: '', cast: { people: rows.map(r => ({ personId: r[0], move: r[1] })) } });
const lt = () => ({ id: 'a' + (++an), dept: 'light', status: 'set', note: '', light: { looks: [], channels: [] } });
const snd = () => ({ id: 'a' + (++an), dept: 'sound', status: 'set', note: '', sound: { track: 1, action: 'play' } });
const stg = () => ({ id: 'a' + (++an), dept: 'stage', status: 'set', note: '', stage: { props: [] } });
const people = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: '사람' + i, role: 'performer', note: '' }));
const show = (parts, ppl) => ({ people: ppl || people(3), parts: parts.map((scenes, i) => ({ id: 'pt' + i, name: (i + 1) + '부', scenes })) });
const scene = (id, type, items) => ({ id, type, title: id, items });
const model = (s, tl, avail) => FE.flowModel({ show: s, trig: FE.trigGraph(s), tl: tl || new Map(), avail: avail || 0 });
// tl 한 칸: on = [[key, lane, label]…], ends = [[key, lane, label]…]
const st = (on, ends) => ({ on: new Map((on || []).map(x => [x[0], { lane: x[1], label: x[2] || x[0] }])), ends: (ends || []).map(x => ({ key: x[0], lane: x[1], label: x[2] || x[0] })) });

test('칸 · x: 대사·지문 12px · 큐 28px, 씬 앞뒤 8px, 문단 없는 씬도 최소 폭, 부 경계 표시, 넓으면 그릴 폭까지 늘림', () => {
  const s = show([[scene('A', 'mc', [line('l1'), cue('c1', sig(), [lt()]), action('d1')]), scene('B', 'act', [])], [scene('C', 'act', [cue('c2', sig(), [lt()])])]]);
  const m = model(s);
  assert.equal(m.X.get('l1'), 8 + 6);
  assert.equal(m.X.get('c1'), 20 + 14);
  assert.equal(m.X.get('d1'), 48 + 6);
  eq(m.bands.map(b => [b.id, b.x0, b.x1, b.type, b.partStart]), [['A', 0, 68, 'mc', false], ['B', 68, 68 + 8 + G.empty + 8, 'act', false], ['C', 136, 180, 'act', true]]);
  assert.equal(m.X.get('c2'), 136 + 8 + 14);
  assert.equal(m.W, 180);
  assert.equal(m.H, G.lt + m.lanes.length * G.lh + 18);
  // 넓은 화면: 360px 에 맞춰 두 배
  const w = model(s, null, 360);
  assert.equal(w.W, 360);
  assert.equal(w.X.get('c1'), 68);
  eq(w.bands.map(b => [b.x0, b.x1]), [[0, 136], [136, 272], [272, 360]]);
  // 좁은 화면: 줄이지 않는다 (가로 스크롤)
  assert.equal(model(s, null, 100).W, 180);
});

test('줄: 출연 큐에 나오는 사람만 show.people 순서 + 조명 · 음향 · 무대, 큐 동작은 그 줄에', () => {
  const s = show([[scene('A', 'mc', [cue('c1', sig(), [cast(['p2', 'in'], ['p0', 'in']), lt(), snd(), stg()])])]]);
  const m = model(s);
  eq(m.lanes.map(l => l.k), ['p:p0', 'p:p2', 'light', 'sound', 'stage']);
  eq(m.lanes.map(l => l.lb), ['사람0', '사람2', '조명', '음향', '무대']);
  const c = m.cues.get('c1');
  eq(c.nodes.map(n => n.lane), ['p:p2', 'p:p0', 'light', 'sound', 'stage']);
  eq(c.nodes.map(n => n.y), [1, 0, 2, 3, 4].map(i => G.lt + i * G.lh + G.lh / 2));
  assert.equal(c.top, G.lt + G.lh / 2); assert.equal(c.bot, G.lt + 4 * G.lh + G.lh / 2);
  // 같은 줄에 동작 둘 → 위아래로 벌림
  const m2 = model(show([[scene('A', 'mc', [cue('c1', sig(), [lt(), lt()])])]]));
  const ys = m2.cues.get('c1').nodes.map(n => n.y), mid = m2.laneY('light');
  eq(ys, [mid - 6, mid + 6]);
});

test('줄: 출연자가 6줄을 넘으면 앞 5명 + "기타 출연" — 목록에 없는 사람 · 사람 없는 출연 큐도 기타', () => {
  const ppl = people(8);
  const s = show([[scene('A', 'mc', [cue('c1', sig(), [cast(...[6, 1, 0, 3, 2, 5, 4].map(i => ['p' + i, 'in']))]), cue('c2', sig(), [cast(['p6', 'out'])])])]], ppl);
  const lanes = FE.flowLanes(s);
  eq(lanes.map(l => l.k), ['p:p0', 'p:p1', 'p:p2', 'p:p3', 'p:p4', 'p:etc', 'light', 'sound', 'stage']);
  eq(Array.from(lanes[5].pids), ['p5', 'p6']);
  assert.equal(lanes[5].lb, '기타 출연');
  const m = model(s);
  eq(m.cues.get('c2').nodes.map(n => n.lane), ['p:etc']);
  // 정확히 6명이면 묶지 않는다
  assert.equal(FE.flowLanes(show([[scene('A', 'mc', [cue('c1', sig(), [cast(...[0, 1, 2, 3, 4, 5].map(i => ['p' + i, 'in']))])])]], ppl)).filter(l => l.d === 'cast').length, 6);
  // 목록에 없는 사람 · 사람을 안 고른 출연 큐 → 기타 출연 줄이 생긴다
  const s3 = show([[scene('A', 'mc', [cue('c1', sig(), [cast(['p0', 'in'])]), cue('c2', sig(), [cast(['zz', 'in'])]), cue('c3', sig(), [cast()])])]]);
  const m3 = model(s3);
  eq(m3.lanes.map(l => l.k).slice(0, 2), ['p:p0', 'p:etc']);
  eq([m3.cues.get('c2').nodes[0].lane, m3.cues.get('c3').nodes[0].lane], ['p:etc', 'p:etc']);
  // 출연 큐가 하나도 없으면 출연자 줄 없음
  eq(FE.flowLanes(show([[scene('A', 'mc', [cue('c1', sig(), [lt()])])]])).map(l => l.k), ['light', 'sound', 'stage']);
});

// 막대 시험용: 큐 다섯 개
function five() {
  return show([[scene('A', 'mc', [cue('c1', sig(), [cast(['p0', 'in'])]), cue('c2', sig(), [lt()]), cue('c3', sig(), [cast(['p0', 'out'])]), line('l1'), cue('c4', sig(), [snd()]), cue('c5', sig(), [stg()])])]]);
}
const bar = (m, key) => m.bars.filter(b => b.key === key).map(b => ({ x1: b.x1, x2: b.x2, from: b.from, to: b.to, open: b.open, left: b.left, lane: b.lane }));

test('막대 · 출연: IN 큐 → OUT 큐 (MOVE 는 켜짐 유지), 안 닫히면 오른쪽 끝까지(open), 켠 적 없이 OUT 이면 왼쪽 끝부터', () => {
  const s = five(), X = model(s).X;
  const tl = new Map([
    ['c1', st([['p:p0', 'p:p0']])],
    ['c2', st([['p:p0', 'p:p0']])], // 이동(MOVE) — 켜짐 그대로
    ['c3', st([], [['p:p0', 'p:p0']])], // OUT
    ['c4', st([['p:p1', 'p:p1']], [['p:p2', 'p:p2']])], // p1 IN(안 닫힘) · p2 는 IN 없이 OUT
    ['c5', st([['p:p1', 'p:p1']], [['p:p0', 'p:p0']])] // p0 다시 OUT — 앞에서 막대가 있었으니 왼쪽 끝 막대 아님
  ]);
  const s2 = show([[scene('A', 'mc', s.parts[0].scenes[0].items.concat([cue('c6', sig(), [cast(['p1', 'in'], ['p2', 'out'])])]))]]); // p1 · p2 도 줄이 있게
  const m = model(s2, tl);
  eq(bar(m, 'p:p0'), [{ x1: X.get('c1'), x2: X.get('c3'), from: 'c1', to: 'c3', open: false, left: false, lane: 'p:p0' }]);
  eq(bar(m, 'p:p1'), [{ x1: X.get('c4'), x2: m.W, from: 'c4', to: null, open: true, left: false, lane: 'p:p1' }]);
  eq(bar(m, 'p:p2'), [{ x1: 0, x2: X.get('c4'), from: null, to: 'c4', open: false, left: true, lane: 'p:p2' }]);
});

test('막대 · 조명(룩마다 ON→OFF · 무대 채널 · 객석) · 음향(다음 PLAY 가 이어받음) · 무대(소품) — 줄과 칸', () => {
  const s = five(), X = model(s).X;
  const tl = new Map([
    ['c1', st([['look:a', 'light'], ['lch', 'light']])],
    ['c2', st([['look:a', 'light'], ['lch', 'light'], ['house', 'light'], ['snd:c2', 'sound'], ['prop:hat', 'stage']])],
    ['c3', st([['house', 'light'], ['snd:c3', 'sound'], ['prop:hat', 'stage']], [['lch', 'light'], ['look:a', 'light']])], // 암전: 룩 · 무대 채널 끝 · 새 음원
    ['c4', st([['prop:hat', 'stage'], ['look:b', 'light']], [['house', 'light']])], // 음원 STOP · 객석 OFF · 룩 b ON
    ['c5', st([], [['prop:hat', 'stage'], ['snd:pre', 'sound'], ['look:b', 'light']])] // 소품 OUT · 앞에서 시작한 음원(켠 큐 없음)은 왼쪽 끝부터
  ]);
  const m = model(s, tl);
  eq(bar(m, 'look:a').map(b => [b.x1, b.x2, b.lane]), [[X.get('c1'), X.get('c3'), 'light']]);
  eq(bar(m, 'lch').map(b => [b.x1, b.x2]), [[X.get('c1'), X.get('c3')]]);
  eq(bar(m, 'house').map(b => [b.x1, b.x2]), [[X.get('c2'), X.get('c4')]]);
  eq(bar(m, 'snd:c2').map(b => [b.x1, b.x2, b.lane]), [[X.get('c2'), X.get('c3'), 'sound']]);
  eq(bar(m, 'snd:c3').map(b => [b.x1, b.x2]), [[X.get('c3'), X.get('c4')]]);
  eq(bar(m, 'snd:pre').map(b => [b.x1, b.x2, b.left]), [[0, X.get('c5'), true]]);
  eq(bar(m, 'prop:hat').map(b => [b.x1, b.x2, b.lane]), [[X.get('c2'), X.get('c5'), 'stage']]);
  // 조명 줄: look:a · lch · house 가 겹침 → 세 칸, 나중의 look:b 는 비어 있는 첫 칸(0)을 다시 쓴다. 칸은 줄 높이 안에
  const L = m.bars.filter(b => b.lane === 'light');
  assert.ok(L.every(b => b.rows === 3), JSON.stringify(L.map(b => b.rows)));
  eq(Object.fromEntries(L.map(b => [b.key, b.row])), { 'look:a': 0, lch: 1, house: 2, 'look:b': 0 });
  const top = m.laneY('light') - G.lh / 2, bottom = m.laneY('light') + G.lh / 2;
  L.forEach(b => assert.ok(b.y >= top && b.y + b.h <= bottom, JSON.stringify(b)));
  // 출연 막대는 두껍고(10) 부서 막대는 얇다(5)
  assert.equal(bar(m, 'prop:hat').length, 1); assert.equal(m.bars.find(b => b.key === 'prop:hat').h, 5);
});

test('막대: 줄이 없는 사람 키는 "기타 출연" 줄로, 기타 줄도 없으면 버린다', () => {
  const s = show([[scene('A', 'mc', [cue('c1', sig(), [cast(['p0', 'in'])]), cue('c2', sig(), [cast(['zz', 'in'])])])]]);
  const m = model(s, new Map([['c1', st([['p:p0', 'p:p0'], ['p:zz', 'p:zz']])]]));
  assert.equal(m.bars.find(b => b.key === 'p:zz').lane, 'p:etc');
  const s2 = show([[scene('A', 'mc', [cue('c1', sig(), [cast(['p0', 'in'])])])]]);
  const m2 = model(s2, new Map([['c1', st([['p:p0', 'p:p0'], ['p:zz', 'p:zz']])]]));
  eq(m2.bars.map(b => b.key), ['p:p0']);
});

test('연결: "후" = 앞 큐 → 연속 큐 곡선(끝은 6px 앞) + 초, "함께" = 짧은 점선, 대사 트리거 = 축에서 큐 위까지 눈금, 신호 · 끊긴 트리거는 빈 네모', () => {
  const s = show([[scene('A', 'mc', [
    line('l1'), cue('c1', onLine('l1'), [lt()]), cue('c2', after('c1'), [snd()], 7), cue('c3', after('c1', 'with'), [stg()]), cue('c4', sig(), [lt()]), cue('c5', after('gone'), [lt()])
  ])]]);
  const m = model(s), C = id => m.cues.get(id);
  eq(['c1', 'c2', 'c3', 'c4', 'c5'].map(id => [C(id).kind, C(id).fill]), [['line', true], ['cue', true], ['cue', true], ['signal', false], ['cue-gone', false]]);
  // 대사 눈금
  assert.equal(m.ticks.length, 1);
  eq(m.ticks[0], { id: 'c1', item: 'l1', at: 'end', x: C('c1').x, y1: G.ax + 1, y2: C('c1').top - 6 });
  // 후 7초
  const a = m.links.find(l => l.id === 'c2');
  assert.equal(a.mode, 'after'); assert.equal(a.from, 'c1'); assert.equal(a.sec, 7);
  assert.equal(a.x1, C('c1').x); assert.equal(a.y1, C('c1').ay - 5);
  assert.ok(Math.abs(Math.hypot(a.x2 - C('c2').x, a.y2 - C('c2').ay) - 6) < 1e-9, '끝은 연속 큐 네모 6px 앞');
  assert.ok(a.cy < Math.min(C('c1').ay, C('c2').ay), '곡선은 위로 휜다');
  assert.ok(a.d.startsWith('M' + C('c1').x + ' ') && a.arrow.endsWith('Z'));
  assert.ok(a.lx > C('c1').x && a.lx < C('c2').x);
  // 함께
  const w = m.links.find(l => l.id === 'c3');
  assert.equal(w.mode, 'with'); assert.equal(w.sec, 0);
  const L = Math.hypot(C('c3').x - C('c1').x, C('c3').ay - C('c1').ay);
  assert.ok(Math.abs(Math.hypot(w.x2 - w.x1, w.y2 - w.y1) - (L - 12)) < 1e-9, '양 끝 6px 씩 줄임');
  // 끊긴 트리거 · 신호에는 연결 없음
  eq(m.links.map(l => l.id).sort(), ['c2', 'c3']);
  // 대사 · 지문 눈금 목록
  eq(m.lines.map(x => [x.id, x.x]), [['l1', m.X.get('l1')]]);
});

test('지금 선: 문단 id → 그 x, 씬 시작 → 띠 왼쪽 + 2, 공연 전 · 모르는 위치 → 왼쪽 끝', () => {
  const s = show([[scene('A', 'mc', [line('l1'), cue('c1', onLine('l1'), [lt()])]), scene('B', 'act', [])]]);
  const m = model(s);
  assert.equal(FE.flowNowX(m, 'l1'), m.X.get('l1'));
  assert.equal(FE.flowNowX(m, 'c1'), m.X.get('c1'));
  assert.equal(FE.flowNowX(m, 'scene:B'), m.bands[1].x0 + 2);
  assert.equal(FE.flowNowX(m, 'pre'), 2);
  assert.equal(FE.flowNowX(m, null), 2);
  assert.equal(FE.flowNowX(m, 'scene:없음'), 2);
});

test('트리거 사슬: 위로 앞 큐들 + 아래로 연속 큐 전부, 맨 앞 큐(대사 트리거)를 root 로 · 고리에서 멈춤', () => {
  const s = show([[scene('A', 'mc', [
    line('l1'), cue('c1', onLine('l1'), [lt()]), cue('c2', after('c1'), [lt()]), cue('c3', after('c2'), [lt()]), cue('c4', after('c2', 'with'), [lt()]), cue('c5', sig(), [lt()]),
    cue('x1', after('x2'), [lt()]), cue('x2', after('x1'), [lt()])
  ])]]);
  const T = FE.trigGraph(s);
  const ch = FE.flowChain(T, 'c2');
  eq(Array.from(ch.ids).sort(), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(ch.root.id, 'c1');
  eq(Array.from(FE.flowChain(T, 'c5').ids), ['c5']);
  const lp = FE.flowChain(T, 'x1');
  eq(Array.from(lp.ids).sort(), ['x1', 'x2']);
  eq(Array.from(FE.flowChain(T, 'l1').ids), ['l1']);
  assert.equal(FE.flowChain(T, 'l1').root, null);
});
