// 조명 룩의 배치 (show v13) — show.lights[].rig [{ pos: back|top|front, count: 1~24, color, side?: in|out }]
// 상수 대조 · migrate(v12 → v13, 나쁜 줄 정규화) · 검증 코드 · MCP ops(set/add/지우기) · 개요·검색 · 병합(통째 값) · 삭제 되돌리기 · 그림(rigSvg) · 옛 화면 차단
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { validateShow, rigRows, rigText, SHOW_VER, CONST } = require('../lib/validate');
const { applyOps, upgradeShow, OpError } = require('../lib/ops');
const { outline, search } = require('../lib/view');
const M = require('../lib/merge');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const sec = from => {
  const a = HTML.indexOf('/* ================= ' + from), b = HTML.indexOf('/* =================', a + 10);
  assert.ok(a > 0 && b > a, `index.html 에서 ${from} 구간 표시를 찾지 못했습니다`);
  return HTML.slice(a, b);
};
// 상수 ~ 상태: migrate · 삭제 되돌리기 · 배치 정규화와 그림(룩 배치 그림 구간도 이 사이)
const FE = (() => {
  const a = HTML.indexOf('/* ================= 상수'), b = HTML.indexOf('/* ================= 상태');
  return vm.runInNewContext(HTML.slice(a, b) + '\n;({ migrate, relabel, dropLook, delRestore, rigRows, rigText, rigSvg, rigPlace, RIG_POS, RIG_SIDE, RIG_COLORS, RIG_COUNT_MAX, RIG_COLOR_MAX, RIG_G, SHOW_VER })', {});
})();
const plain = o => JSON.parse(JSON.stringify(o));
const migrate = s => plain(FE.migrate(s));
const relabel = s => FE.relabel(s);
const merge = (b, l, r) => M.mergeShows(b, l, r, { relabel });

// 브리프의 예 "링앤로프"
const RING = [{ pos: 'top', count: 3, color: '노랑' }, { pos: 'back', count: 2, color: '마젠타', side: 'in' }, { pos: 'back', count: 2, color: '그린', side: 'out' }, { pos: 'front', count: 2, color: '화이트' }];
const RING_TEXT = '백 안쪽 마젠타 2 · 백 바깥쪽 그린 2 · 탑 노랑 3 · 프론트 화이트 2';
function v12(lights) {
  return {
    id: 'show-r', title: '배치 테스트', version: 12, revision: '', updatedAt: '2026-11-20T00:00:00.000Z', preShowSetup: '',
    people: [], props: [], preShowProps: [], lights: lights || [
      { id: 'lk-ring', name: '링앤로프', note: '리허설 11/19 확정', rig: plain(RING) },
      { id: 'lk-wash', name: '오프닝 워시', note: '' }
    ],
    tracks: [],
    parts: [{ id: 'pt-1', name: '1부', scenes: [{ id: 's-1', type: 'act', title: '링', cast: [], durationSec: null, setup: '', comments: [], items: [
      { id: 'i-1', kind: 'cue', speaker: null, text: '', label: '1', isCue: true, trigger: { type: 'signal', text: '박수 끝' }, offsetSec: null, comments: [],
        cues: [{ id: 'q-1', dept: 'light', note: '', status: 'set', light: { looks: [{ lookId: 'lk-wash', action: 'off' }, { lookId: 'lk-ring', action: 'on' }], channels: [], anim: '' } }] }
    ] }] }]
  };
}

test('v13 형식: SHOW_VER 13 · 배치 상수(위치 · 쪽 · 색 이름 · 상한)는 사이트와 같다', () => {
  assert.equal(SHOW_VER, 13);
  assert.equal(FE.SHOW_VER, 13);
  assert.deepEqual(CONST.SHOW_VERS, [5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(Object.keys(FE.RIG_POS), CONST.RIG_POS);
  assert.deepEqual(Object.keys(FE.RIG_SIDE), CONST.RIG_SIDES);
  assert.deepEqual(Object.keys(FE.RIG_COLORS), CONST.RIG_COLORS);
  assert.equal(FE.RIG_COUNT_MAX, CONST.RIG_COUNT_MAX);
  assert.equal(FE.RIG_COLOR_MAX, CONST.RIG_COLOR_MAX);
  assert.deepEqual(Object.keys(FE.RIG_COLORS), ['노랑', '연노랑', '화이트', '웜화이트', '레드', '마젠타', '핑크', '그린', '시안', '블루', '퍼플', '앰버', '오렌지', '라임']);
  Object.values(FE.RIG_COLORS).forEach(c => assert.match(c, /^#[0-9a-f]{6}$/));
});

test('한 줄 글: 백 → 탑 → 프론트, 쪽은 "백 안쪽", 빈 색은 "색 미정" — 사이트 rigText 와 lib rigText 가 같다', () => {
  assert.equal(rigText(RING), RING_TEXT);
  assert.equal(FE.rigText(RING), RING_TEXT);
  assert.equal(rigText([{ pos: 'back', count: 4, color: '노랑' }, { pos: 'top', count: 3, color: '연노랑' }, { pos: 'front', count: 2, color: '화이트' }]), '백 노랑 4 · 탑 연노랑 3 · 프론트 화이트 2');
  assert.equal(rigText([{ pos: 'front', count: 1, color: '' }]), '프론트 색 미정 1');
  assert.equal(rigText(null), '');
  assert.equal(rigText('x'), '');
});

// 정규화가 버리고 고치는 것 — 사이트(migrate) · lib(rigRows) 같은 규칙
const MESSY = [
  { pos: 'top', count: 3, color: '노랑' },
  { pos: 'side', count: 2, color: '레드' }, // 모르는 위치 → 버림
  { pos: 'back', count: 0, color: '블루' }, // 1 미만 → 버림
  { pos: 'back', count: 'x', color: '블루' }, // 숫자 아님 → 버림
  { pos: 'back', color: '블루' }, // 개수 없음 → 버림
  'not a row', null, // 객체 아님 → 버림
  { pos: 'back', count: '2', color: ' 레드  +  화이트 ', side: 'in' }, // 숫자 문자열 → 2, '+' 둘레 빈칸 지움
  { pos: 'front', count: 30, color: '화이트', side: 'left' }, // 24 로 줄임, 모르는 쪽은 버림(줄은 남김)
  { pos: 'front', count: 2.6, color: 7, extra: true }, // 반올림 3, 숫자 색 → 글, 모르는 필드는 버림
  { pos: 'top', count: 1, color: 'ㄱ'.repeat(50) } // 40자까지
];
const MESSY_OUT = [
  { pos: 'top', count: 3, color: '노랑' },
  { pos: 'back', count: 2, color: '레드+화이트', side: 'in' },
  { pos: 'front', count: 24, color: '화이트' },
  { pos: 'front', count: 3, color: '7' },
  { pos: 'top', count: 1, color: 'ㄱ'.repeat(40) }
];
test('정규화(rigRows): 나쁜 줄은 버리고 개수 · 색 · 쪽을 고친다 — 사이트와 lib 가 같다', () => {
  assert.deepEqual(rigRows(MESSY), MESSY_OUT);
  assert.deepEqual(plain(FE.rigRows(MESSY)), MESSY_OUT);
  assert.deepEqual(rigRows({ pos: 'top' }), []);
  assert.deepEqual(plain(FE.rigRows(undefined)), []);
  MESSY_OUT.forEach(r => assert.deepEqual(Object.keys(r), r.side ? ['pos', 'count', 'color', 'side'] : ['pos', 'count', 'color']));
});

test('migrate v12 → v13: rig 는 그대로 옮기고(키 순서 id · name · note · rig), 나쁜 줄은 정규화, 줄이 없으면 필드째 없다', () => {
  const s = v12([
    { id: 'lk-ring', name: '링앤로프', note: '', rig: plain(RING) },
    { id: 'lk-messy', name: '엉망', note: '', rig: plain(MESSY) },
    { id: 'lk-none', name: '없음', note: '' },
    { id: 'lk-empty', name: '빈 배치', note: '', rig: [] },
    { id: 'lk-bad', name: '모양 틀림', note: '', rig: { pos: 'top', count: 1 } },
    { id: 'lk-allbad', name: '다 버림', note: '', rig: [{ pos: 'x', count: 1, color: '레드' }] }
  ]);
  const m = migrate(s);
  assert.equal(m.version, 13);
  assert.deepEqual(m.lights[0], { id: 'lk-ring', name: '링앤로프', note: '', rig: RING });
  assert.deepEqual(Object.keys(m.lights[0]), ['id', 'name', 'note', 'rig']);
  assert.deepEqual(m.lights[1].rig, MESSY_OUT);
  m.lights.slice(2).forEach(l => assert.ok(!('rig' in l), l.name));
  // 왕복해도 같다 · 검증 통과(경고는 모르는 색 '7' · 'ㄱ…' 뿐)
  assert.deepEqual(migrate(m), m);
  const v = validateShow(m);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.filter(w => w.path.startsWith('lights')).map(w => [w.path, w.code]), [['lights[1].rig[3].color', 'rig-color'], ['lights[1].rig[4].color', 'rig-color']]);
  // v12 이하(배치 없음)는 lights 모양이 그대로 — version 만
  const old = v12([{ id: 'lk-a', name: '무대 A', note: '프론트 70' }]);
  assert.deepEqual(migrate(old).lights, old.lights);
});

test('검증: 좋은 배치는 깨끗하고, 버려지는 줄은 오류(rig-shape · rig-pos · rig-count · rig-side), 고쳐 남기는 값은 경고(rig-count · rig-color)', () => {
  assert.deepEqual(validateShow(migrate(v12())), { errors: [], warnings: [] });
  const s = migrate(v12());
  s.lights[0].rig = plain(MESSY);
  s.lights[1].rig = { pos: 'top' };
  const v = validateShow(s);
  const E = v.errors.map(e => [e.path, e.code]), W = v.warnings.map(w => [w.path, w.code || null]);
  assert.deepEqual(E, [
    ['lights[0].rig[1].pos', 'rig-pos'],
    ['lights[0].rig[2].count', 'rig-count'],
    ['lights[0].rig[3].count', 'rig-count'],
    ['lights[0].rig[4].count', 'rig-count'],
    ['lights[0].rig[5]', 'rig-shape'],
    ['lights[0].rig[6]', 'rig-shape'],
    ['lights[0].rig[8].side', 'rig-side'],
    ['lights[1].rig', 'rig-shape']
  ]);
  assert.deepEqual(W, [
    ['lights[0].rig[7].count', 'rig-count'], // "2" → 2
    ['lights[0].rig[8].count', 'rig-count'], // 30 → 24
    ['lights[0].rig[9].extra', null], // 모르는 필드
    ['lights[0].rig[9].count', 'rig-count'], // 2.6 → 3
    ['lights[0].rig[9].color', 'rig-color'], // 숫자
    ['lights[0].rig[9].color', 'rig-color'], // 모르는 색 "7"
    ['lights[0].rig[10].color', 'rig-color'], // 40자 넘음
    ['lights[0].rig[10].color', 'rig-color'] // 모르는 색
  ]);
  assert.match(v.errors[0].msg, /back\|top\|front/);
  // 색 없음 · 모르는 색은 경고(회색으로 그림), 섞인 색은 이름마다 본다
  s.lights[0].rig = [{ pos: 'top', count: 1, color: '' }, { pos: 'top', count: 1, color: '레드+보라' }, { pos: 'top', count: 1, color: '블루+화이트' }];
  s.lights[1].rig = [{ pos: 'top', count: 1, color: { r: 1 } }];
  const v2 = validateShow(s);
  assert.deepEqual(v2.errors.map(e => [e.path, e.code]), [['lights[1].rig[0].color', 'rig-color']]);
  assert.deepEqual(v2.warnings.map(w => [w.path, w.code]), [['lights[0].rig[0].color', 'rig-color'], ['lights[0].rig[1].color', 'rig-color']]);
  assert.match(v2.warnings[1].msg, /모르는 색 "보라"/);
});

test('MCP ops: look 의 rig 를 set/add 로 통째로 — 정규화된 모양, null · [] 이면 지움, 틀린 값은 bad_field, 모르는 색은 경고', () => {
  const s = migrate(v12());
  let r = applyOps(s, [{ op: 'set', id: 'lk-wash', fields: { rig: [{ color: '웜화이트', count: 4, pos: 'front' }, { pos: 'back', count: '2', color: '블루 + 화이트', side: 'out' }] } }]);
  const w = r.show.lights.find(l => l.id === 'lk-wash');
  assert.deepEqual(w.rig, [{ pos: 'front', count: 4, color: '웜화이트' }, { pos: 'back', count: 2, color: '블루+화이트', side: 'out' }]);
  assert.deepEqual(Object.keys(w.rig[1]), ['pos', 'count', 'color', 'side']);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.show.version, 13);
  // 이름만 고치면 배치는 그대로
  r = applyOps(r.show, [{ op: 'set', id: 'lk-ring', fields: { name: '링 앤 로프' } }]);
  assert.deepEqual(r.show.lights[0].rig, RING);
  // 지우기
  for (const v of [null, []]) {
    const x = applyOps(r.show, [{ op: 'set', id: 'lk-ring', fields: { rig: v } }]).show.lights[0];
    assert.ok(!('rig' in x), JSON.stringify(v));
  }
  // 추가와 함께
  r = applyOps(s, [{ op: 'add', kind: 'look', data: { name: '엔딩', note: '', rig: [{ pos: 'top', count: 6, color: '퍼플' }] } }]);
  assert.deepEqual(r.show.lights[2].rig, [{ pos: 'top', count: 6, color: '퍼플' }]);
  // 모르는 색은 받되 경고
  r = applyOps(s, [{ op: 'set', id: 'lk-wash', fields: { rig: [{ pos: 'top', count: 1, color: '보라' }] } }]);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual([r.warnings[0].path, r.warnings[0].code], ['lights[1].rig[0].color', 'rig-color']); // 검증 경고 하나 (모르는 색 — 그림에서 회색)
  assert.match(r.warnings[0].msg, /모르는 색 "보라"/);
  // 거부
  const bad = [
    [{ rig: 'top' }, /must be an array/],
    [{ rig: [{ pos: 'side', count: 1, color: '레드' }] }, /rig\[0\]\.pos" must be one of back\|top\|front/],
    [{ rig: [{ pos: 'top', count: 0, color: '레드' }] }, /rig\[0\]\.count" must be a whole number 1~24/],
    [{ rig: [{ pos: 'top', count: 25, color: '레드' }] }, /count/],
    [{ rig: [{ pos: 'top', count: 1.5, color: '레드' }] }, /count/],
    [{ rig: [{ pos: 'top', count: 1, color: '' }] }, /rig\[0\]\.color" must be a colour name/],
    [{ rig: [{ pos: 'top', count: 1, color: '레'.repeat(41) }] }, /longer than 40/],
    [{ rig: [{ pos: 'top', count: 1, color: '레드', side: 'left' }] }, /side" must be in\|out/],
    [{ rig: [{ pos: 'top', count: 1, color: '레드', dim: 50 }] }, /unknown field "rig\[0\]\.dim"/],
    [{ rig: ['x'] }, /rig\[0\] must be an object/]
  ];
  bad.forEach(([fields, re]) => assert.throws(() => applyOps(s, [{ op: 'set', id: 'lk-wash', fields }]), e => e instanceof OpError && e.code === 'bad_field' && re.test(e.message), JSON.stringify(fields)));
  // 다른 종류에는 rig 가 없다
  assert.throws(() => applyOps(s, [{ op: 'add', kind: 'prop', data: { name: '링', rig: [] } }]), e => e.code === 'bad_field' && /unknown field "rig" for prop/.test(e.message));
});

test('MCP: v12 공연은 version 만 13 으로(배치 그대로), 개요의 lights 줄에 [rig: …], 검색은 배치 글도 찾는다', () => {
  const up = upgradeShow(plain(v12()));
  assert.equal(up.version, 13);
  assert.deepEqual(up.lights, v12().lights);
  const s = migrate(v12());
  const o = outline(s, {});
  assert.ok(o.includes(`lk-ring=링앤로프 (리허설 11/19 확정) [rig: ${RING_TEXT}]`), o);
  assert.ok(o.includes('lk-wash=오프닝 워시,') || o.includes('lk-wash=오프닝 워시\n') || /lk-wash=오프닝 워시(,|$)/m.test(o), '배치 없는 룩은 그대로');
  const hit = search(s, '마젠타');
  assert.equal(hit.total, 1);
  assert.deepEqual([hit.matches[0].kind, hit.matches[0].id, hit.matches[0].field], ['look', 'lk-ring', 'rig']);
});

test('병합: rig 는 통째 값 — 한쪽만 바꾸면 그쪽(지운 것 포함), 다른 필드와는 따로, 양쪽이 다르게 바꾸면 충돌(서버 것)', () => {
  const base = migrate(v12());
  const withRig = (s, id, rig) => { const x = plain(s), l = x.lights.find(y => y.id === id); if (rig) l.rig = rig; else delete l.rig; return x; };
  // 서버는 설명, 이 기기는 배치 → 둘 다
  let remote = plain(base); remote.lights[0].note = '서버 설명';
  let local = withRig(base, 'lk-ring', [{ pos: 'top', count: 4, color: '노랑' }]);
  let r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.show.lights[0], { id: 'lk-ring', name: '링앤로프', note: '서버 설명', rig: [{ pos: 'top', count: 4, color: '노랑' }] });
  // 배치가 없던 룩에 한쪽만 배치를 넣음
  local = withRig(base, 'lk-wash', [{ pos: 'front', count: 2, color: '화이트' }]);
  r = merge(base, local, plain(base));
  assert.deepEqual(r.show.lights[1].rig, [{ pos: 'front', count: 2, color: '화이트' }]);
  // 한쪽이 지우고 다른 쪽은 그대로 → 지움
  r = merge(base, withRig(base, 'lk-ring', null), plain(base));
  assert.deepEqual(r.conflicts, []);
  assert.ok(!('rig' in r.show.lights[0]));
  // 줄 단위로 섞지 않는다: 이 기기는 탑 줄을, 서버는 프론트 줄을 고침 → 충돌, 서버 것 전체
  const lr = plain(RING); lr[0].count = 5;
  const rr = plain(RING); rr[3].color = '웜화이트';
  r = merge(base, withRig(base, 'lk-ring', lr), withRig(base, 'lk-ring', rr));
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0].text, /조명 링앤로프 — 배치: 양쪽에서 다르게 고침$/);
  assert.deepEqual(r.show.lights[0].rig, rr);
  // 한쪽은 지우고 다른 쪽은 고침 → 충돌, 서버 것
  r = merge(base, withRig(base, 'lk-ring', lr), withRig(base, 'lk-ring', null));
  assert.equal(r.conflicts.length, 1);
  assert.ok(!('rig' in r.show.lights[0]));
  // 같게 바꾸면 충돌 아님
  r = merge(base, withRig(base, 'lk-ring', lr), withRig(base, 'lk-ring', plain(lr)));
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(validateShow(r.show).errors, []);
});

test('삭제 되돌리기: 배치가 있는 룩을 지웠다가 되살리면 배치까지 제자리에', () => {
  const s = migrate(v12());
  relabel(s);
  const before = JSON.stringify(s);
  FE.dropLook(s, 'lk-ring');
  assert.deepEqual(s.lights.map(l => l.id), ['lk-wash']);
  const e = { before, after: JSON.stringify(s), seq: 1 };
  const cur = plain(s); cur.lights[0].rig = [{ pos: 'front', count: 2, color: '화이트' }]; // 지운 뒤 다른 룩에 배치를 넣어도
  const r = FE.delRestore(e, cur, M, relabel);
  assert.equal(r.ok, true); assert.equal(r.conflicts, 0);
  assert.deepEqual(r.show.lights.map(l => [l.id, l.rig || null]), [['lk-ring', RING], ['lk-wash', [{ pos: 'front', count: 2, color: '화이트' }]]]);
});

test('그림(rigSvg): 백 위 · 탑 가운데 · 프론트 아래 + 객석 선, 조명기마다 원(섞인 색은 조각), 안쪽은 가운데 · 바깥쪽은 끝, 모르는 색은 회색', () => {
  assert.equal(FE.rigSvg([]), '');
  assert.equal(FE.rigSvg(undefined), '');
  const svg = FE.rigSvg(RING.concat([{ pos: 'front', count: 1, color: '레드+화이트' }, { pos: 'front', count: 1, color: '모르는색' }]), { w: 200, label: '링앤로프' });
  assert.match(svg, /^<svg class="rig-svg" viewBox="0 0 200 112" width="200" height="112" role="img" aria-label="링앤로프 — 배치: 백 안쪽 마젠타 2 · 백 바깥쪽 그린 2 · 탑 노랑 3 · 프론트 화이트 2 · 프론트 레드\+화이트 1 · 프론트 모르는색 1">/);
  assert.equal((svg.match(/class="rig-o"/g) || []).length, 3 + 2 + 2 + 2 + 1 + 1, '조명기 하나 = 테두리 원 하나');
  assert.equal((svg.match(/<path /g) || []).length, 2, '레드+화이트 = 반원 두 조각');
  assert.equal((svg.match(/class="rig-x"/g) || []).length, 1, '모르는 색은 회색 하나');
  assert.ok(svg.includes(`fill="${FE.RIG_COLORS['마젠타']}"`) && svg.includes(`fill="${FE.RIG_COLORS['노랑']}"`));
  ['백', '탑', '프론트', '객석'].forEach(t => assert.ok(svg.includes(`>${t}</text>`), t));
  const G = FE.RIG_G;
  assert.ok(G.y.back < G.y.top && G.y.top < G.y.front && G.y.front < G.base, '백 → 탑 → 프론트 → 객석 (위에서 아래로)');
  // 안쪽 한 쌍은 가운데 가까이 좌우 대칭, 바깥쪽 한 쌍은 양 끝
  const cx = (G.x0 + G.x1) / 2, P = plain(FE.rigPlace(RING.filter(r => r.pos === 'back'), G.x0, G.x1).pts);
  const ins = P.filter(p => p.color === '마젠타').map(p => p.x), outs = P.filter(p => p.color === '그린').map(p => p.x);
  assert.ok(Math.abs(ins[0] + ins[1] - 2 * cx) < 1e-9 && Math.abs(outs[0] + outs[1] - 2 * cx) < 1e-9, '대칭');
  assert.ok(Math.max(...ins.map(x => Math.abs(x - cx))) < Math.min(...outs.map(x => Math.abs(x - cx))), '안쪽이 바깥쪽보다 가운데에 가깝다');
  // 쪽 없음은 가운데 기준 고르게, 24개도 무대 폭 안에
  const U = plain(FE.rigPlace([{ pos: 'top', count: 24, color: '블루' }], G.x0, G.x1).pts).map(p => p.x);
  assert.equal(U.length, 24);
  assert.ok(U.every(x => x > G.x0 && x < G.x1));
  assert.ok(Math.abs(U[0] + U[23] - 2 * cx) < 1e-9);
  const T = plain(FE.rigPlace([{ pos: 'top', count: 3, color: '노랑' }], G.x0, G.x1).pts).map(p => p.x);
  assert.deepEqual(T.map(x => Math.round(x - cx)), [-40, 0, 40]);
});

test('옛 화면 차단 (v13): 배치가 있는 v13 저장본에 v12 화면(rig 를 모름)이 저장하면 426, 배치는 그대로 · health schema 13', async () => {
  const { createServer } = require('../server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-rig-'));
  const server = createServer({ dataDir: dir, password: '', log: null });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const J = (method, body) => ({ method, headers: { 'Content-Type': 'application/json', 'X-Edit-Key': '1234' }, body: JSON.stringify(body) });
  try {
    const s13 = Object.assign(migrate(v12()), { title: 'v13' });
    const { id } = await (await fetch(base + '/api/shows', J('POST', { show: s13 }))).json();
    const old = plain(s13); old.version = 12; old.title = 'v12 화면'; old.lights.forEach(l => delete l.rig);
    let r = await fetch(`${base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: old }));
    assert.equal(r.status, 426);
    assert.deepEqual(await r.json().then(x => [x.error, x.version, x.schema]), ['client_outdated', 13, 13]);
    const g = await (await fetch(`${base}/api/shows/${id}`)).json();
    assert.deepEqual(g.show.lights[0].rig, RING);
    const now = plain(s13); now.lights[0].rig = [{ pos: 'top', count: 1, color: '레드' }];
    r = await fetch(`${base}/api/shows/${id}`, J('PUT', { baseRev: 1, show: now }));
    assert.equal(r.status, 200);
    assert.equal((await (await fetch(base + '/api/health')).json()).schema, 13);
  } finally {
    await new Promise(res => server.close(res));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
