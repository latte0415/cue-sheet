// 이름 붙인 조명 (show v11) — show.lights [{ id, name, note }] + 조명 큐 light.looks [{ lookId, action: on|off }]
// migrate(v10 → v11) · 검증 · 머리글(사이트 = lib/cuehead.js) · MCP ops · 점검 · 병합 · 삭제 되돌리기를 한 곳에서 본다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateShow, SHOW_VER, CONST } = require('../lib/validate');
const { applyOps, OpError } = require('../lib/ops');
const { outline, search } = require('../lib/view');
const LIB = require('../lib/cuehead');
const M = require('../lib/merge');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const sec = from => {
  const a = HTML.indexOf('/* ================= ' + from), b = HTML.indexOf('/* =================', a + 10);
  assert.ok(a > 0 && b > a, `index.html 에서 ${from} 구간 표시를 찾지 못했습니다`);
  return HTML.slice(a, b);
};
// 상수 ~ 상태: migrate · 삭제 되돌리기 모델(dropLook · delRestore) · 큐 번호
const FE = (() => {
  const a = HTML.indexOf('/* ================= 상수'), b = HTML.indexOf('/* ================= 상태');
  return vm.runInNewContext(HTML.slice(a, b) + '\n;({ migrate, relabel, dropLook, delRestore, LOOK_ACTS, SHOW_VER })', {});
})();
const HEAD = vm.runInNewContext(sec('상수') + sec('유틸') + sec('큐 요약') + '\n;({ cueHead, cueDetail, cueText })', {});
const CHECK = vm.runInNewContext(sec('상수') + sec('유틸') + sec('점검: 규칙') + '\n;({ checkCollect, checkFilter, CK_GROUPS })', {});
const plain = o => JSON.parse(JSON.stringify(o));
const items = s => s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items));
const cues = s => items(s).flatMap(i => i.cues);
const findCue = (s, id) => cues(s).find(c => c.id === id);

// 작은 v11 공연: 조명 셋(무대 A · 엔딩 블루 · 핀), 조명 큐 넷
const LIGHTS = [
  { id: 'lk-a', name: '무대 A', note: '프론트 70 + 탑 블루, 리허설 11/12 확정' },
  { id: 'lk-b', name: '엔딩 블루', note: '' },
  { id: 'lk-pin', name: '핀', note: '센터 핀 — 조예준' }
];
const lq = (id, looks, extra) => Object.assign({ id, dept: 'light', trigger: '대사 끝', offsetSec: null, note: '', status: 'set', light: { looks, channels: [], anim: '' } }, extra);
const on = lookId => ({ lookId, action: 'on' }), off = lookId => ({ lookId, action: 'off' });
const ch = (c, action, x) => Object.assign({ ch: c, action, dim: null, color: null, colorName: null, timeSec: null }, x);
function v11() {
  return {
    id: 'show-x', title: '조명 테스트', version: 11, revision: '', updatedAt: '2026-11-19T00:00:00.000Z', preShowSetup: '',
    people: [{ id: 'p-a', name: '조예준', role: 'mc', note: '' }], props: [], preShowProps: [], lights: plain(LIGHTS),
    tracks: [],
    parts: [{ id: 'pt-1', name: '1부', scenes: [{ id: 's-1', type: 'act', title: '오프닝', cast: ['p-a'], durationSec: null, setup: '', comments: [], items: [
      { id: 'i-1', kind: 'cue', speaker: null, text: '', label: '1', isCue: true, comments: [], cues: [lq('q-1', [on('lk-a')])] },
      { id: 'i-2', kind: 'line', speaker: 'p-a', text: '안녕하세요', label: '2', isCue: true, comments: [], cues: [lq('q-2', [on('lk-pin')])] },
      { id: 'i-3', kind: 'cue', speaker: null, text: '', label: '3', isCue: true, comments: [], cues: [lq('q-3', [off('lk-a'), off('lk-pin'), on('lk-b')])] },
      { id: 'i-4', kind: 'cue', speaker: null, text: '', label: '4', isCue: true, comments: [], cues: [lq('q-4', [off('lk-b')], { light: { looks: [off('lk-b')], channels: [ch('house', 'on')], anim: '' } })] }
    ] }] }]
  };
}
const LOOK = { person: id => ({ 'p-a': '조예준' })[id] || '(삭제된 사람)', track: () => '', prop: () => '', light: id => (LIGHTS.find(l => l.id === id) || { name: '(삭제된 조명)' }).name };

test('v11 형식(지금은 v13 의 앞): SHOW_VER 13, LOOK_ACTS 는 사이트와 같다', () => {
  assert.equal(SHOW_VER, 13);
  assert.equal(FE.SHOW_VER, 13);
  assert.deepEqual(CONST.SHOW_VERS, [5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(Object.keys(FE.LOOK_ACTS), CONST.LOOK_ACTS);
});

test('migrate v10 → v11: lights: [] 와 조명 큐 looks: [] 만 붙고 채널 큐는 그대로 (자동 변환 없음)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
  raw.version = 10;
  // v9 배포본이라 출연 큐를 v10 모양으로 올린 뒤 v10 → v11 만 본다
  const v10 = plain(FE.migrate(raw)); v10.version = 10; delete v10.lights;
  cues(v10).forEach(c => { if (c.dept === 'light') delete c.light.looks; });
  const m = plain(FE.migrate(v10));
  assert.equal(m.version, 13);
  assert.deepEqual(m.lights, []);
  assert.deepEqual(Object.keys(m).slice(Object.keys(m).indexOf('people')), ['people', 'props', 'preShowProps', 'lights', 'tracks', 'parts']);
  const before = cues(v10).filter(c => c.dept === 'light'), after = cues(m).filter(c => c.dept === 'light');
  assert.ok(before.length > 5);
  after.forEach((c, k) => {
    assert.deepEqual(Object.keys(c.light), ['looks', 'channels', 'anim']);
    assert.deepEqual(c.light.looks, []);
    assert.deepEqual(c.light.channels, before[k].light.channels, '채널은 바뀌지 않는다');
  });
  // 그 밖은 같다
  // 큐 id 는 그대로 (v12: 큐가 큐 문단으로 옮겨지는 것은 test/trigger.test.js)
  assert.deepEqual(cues(m).map(c => c.id), cues(v10).map(c => c.id));
  // 검증: v10 원본도 v11 결과도 오류 없음
  assert.deepEqual(validateShow(v10).errors, []);
  assert.deepEqual(validateShow(m).errors, []);
  // 왕복해도 같다
  assert.deepEqual(plain(FE.migrate(m)), m);
});

test('migrate: 조명 줄 정규화 — 빈 lookId 줄은 버리고, 모르는 id 는 남기고("(삭제된 조명)"), 모르는 action 은 on', () => {
  const s = v11();
  findCue(s, 'q-1').light.looks = [{ lookId: '', action: 'on' }, { lookId: 'lk-gone', action: 'off' }, { lookId: 'lk-a', action: 'fade' }, 'x', { action: 'off' }];
  s.lights.push({ name: '' }, 'bad');
  const m = plain(FE.migrate(s));
  assert.deepEqual(findCue(m, 'q-1').light.looks, [off('lk-gone'), on('lk-a')]);
  assert.equal(m.lights.length, 4);
  assert.equal(m.lights[3].name, '이름 없음');
  assert.match(m.lights[3].id, /^lk-/);
});

test('검증: 조명 목록·조명 줄 — 모르는 id·빈 id 경고, 틀린 action 오류, 같은 조명 두 줄 light-dup, 빈 조명 큐 light-empty', () => {
  const ok = v11();
  assert.deepEqual(validateShow(ok), { errors: [], warnings: [] });
  const s = v11();
  findCue(s, 'q-1').light.looks = [on('lk-a'), off('lk-a'), { lookId: 'lk-gone', action: 'on' }, { lookId: '', action: 'on' }, { lookId: 'lk-b', action: 'fadeIn' }, { lookId: 'lk-pin', action: 'on', timeSec: 3 }];
  findCue(s, 'q-2').light.looks = []; // 확정인데 비었다
  s.lights.push({ id: 'lk-a', name: '겹침', note: '' }, { id: 'lk-x', note: 3, extra: 1 });
  const v = validateShow(s);
  const P = list => list.map(x => [x.path.replace(/^parts\[0\]\.scenes\[0\]\.items\[(\d)\]\.cues\[0\]/, 'i$1'), x.code || '']);
  assert.deepEqual(P(v.errors).sort(), [['i0.light.looks[4].action', ''], ['lights[3].id', '']].sort());
  assert.deepEqual(P(v.warnings).sort(), [
    ['i0.light.looks[1].lookId', 'light-dup'], ['i0.light.looks[2].lookId', ''], ['i0.light.looks[3].lookId', ''], ['i0.light.looks[5].timeSec', ''],
    ['i1.light', 'light-empty'], ['lights[4].extra', ''], ['lights[4].name', ''], ['lights[4].note', '']
  ].sort());
  assert.match(v.warnings.find(w => /looks\[2\]/.test(w.path)).msg, /"lk-gone" 가 lights 에 없습니다 — "\(삭제된 조명\)"/);
  // 미정 큐는 비어도 된다
  findCue(s, 'q-2').status = 'tbd';
  assert.ok(!validateShow(s).warnings.some(w => w.code === 'light-empty'));
  // lights 가 배열이 아니면 서버도 막는다
  const { basicInvalid } = require('../lib/validate');
  assert.match(basicInvalid(Object.assign(v11(), { lights: {} })), /show\.lights 가 배열이 아닙니다/);
});

test('머리글: "무대 A ON", 같은 액션끼리 "·", 섞이면 " · ", 채널과 함께면 그 뒤에 — 사이트 · 사본(lib/cuehead.js) 같게', () => {
  const H = c => [LIB.cueHead(c, LOOK).head, LIB.cueText(c, LOOK)];
  const c1 = lq('x', [on('lk-a')]), c2 = lq('x', [on('lk-a'), on('lk-pin')]), c3 = lq('x', [off('lk-a'), on('lk-b')]);
  const c4 = lq('x', [off('lk-a'), on('lk-b'), on('lk-pin')]);
  const c5 = { ...lq('x', []), light: { looks: [on('lk-a')], channels: [ch('house', 'off')], anim: '' } };
  const c6 = { ...lq('x', []), light: { looks: [off('lk-a')], channels: ['back', 'top', 'front', 'house'].map(x => ch(x, 'off', { timeSec: 3 })), anim: '' } };
  const c7 = lq('x', [on('lk-gone')]), c8 = lq('x', [], { status: 'tbd' }), c9 = lq('x', []);
  const c10 = { ...lq('x', [on('lk-a')]), light: { looks: [on('lk-a')], channels: [], anim: '스파클' } };
  assert.deepEqual(H(c1), ['무대 A ON', '무대 A ON']);
  assert.deepEqual(H(c2), ['무대 A·핀 ON', '무대 A·핀 ON']);
  assert.deepEqual(H(c3), ['무대 A OFF · 엔딩 블루 ON', '무대 A OFF · 엔딩 블루 ON']);
  assert.deepEqual(H(c4), ['무대 A OFF · 엔딩 블루·핀 ON', '무대 A OFF · 엔딩 블루·핀 ON']);
  assert.deepEqual(H(c5), ['무대 A ON · 객석 OFF', '무대 A ON · 객석 OFF']);
  assert.deepEqual(H(c6), ['무대 A OFF · BLACKOUT', '무대 A OFF · BLACKOUT 3s']);
  assert.deepEqual(H(c7), ['(삭제된 조명) ON', '(삭제된 조명) ON']);
  assert.deepEqual([LIB.cueHead(c8, LOOK).head, LIB.cueHead(c8, LOOK).miss], ['조명 미정', true]);
  assert.deepEqual([LIB.cueHead(c9, LOOK).head, LIB.cueHead(c9, LOOK).miss], ['조명 미지정', true]);
  assert.deepEqual(H(c10), ['무대 A ON · ANIM', '무대 A ON · ANIM "스파클"']);
  // look.light 가 없으면(옛 호출) id 그대로
  assert.equal(LIB.cueHead(c1, { person: () => '', track: () => '', prop: () => '' }).head, 'lk-a ON');
  for (const c of [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10]) {
    assert.deepEqual(LIB.cueHead(c, LOOK), plain(HEAD.cueHead(c, LOOK)), JSON.stringify(c));
    assert.deepEqual(LIB.cueDetail(c, LOOK), plain(HEAD.cueDetail(c, LOOK)));
    assert.equal(LIB.cueText(c, LOOK), HEAD.cueText(c, LOOK));
  }
});

test('MCP ops: 조명 추가·고치기·순서·삭제(쓰는 큐가 있으면 거부, force 면 다른 줄이 있는 큐에서만 그 줄을 뺌)', () => {
  const s = v11();
  let r = applyOps(s, [
    { op: 'add', kind: 'look', data: { name: '오프닝 스모크', note: '헤이즈 + 백 앰버' } },
    { op: 'set', id: 'lk-b', fields: { name: '엔딩 블루 (풀)', note: '탑 블루 100' } },
    { op: 'move', id: 'lk-pin', kind: 'look', after: 'first' }
  ]);
  assert.deepEqual(r.show.lights.map(l => l.name), ['핀', '무대 A', '엔딩 블루 (풀)', '오프닝 스모크']);
  const nl = r.show.lights[3];
  assert.match(nl.id, /^lk-/); assert.equal(nl.note, '헤이즈 + 백 앰버');
  assert.deepEqual(r.warnings, []);
  assert.throws(() => applyOps(s, [{ op: 'add', kind: 'look', data: { note: '이름 없음' } }]), e => e instanceof OpError && /a new look needs a "name"/.test(e.message));
  assert.throws(() => applyOps(s, [{ op: 'add', kind: 'look', data: { name: 'x', channels: [] } }]), e => e.code === 'bad_field' && /unknown field "channels" for look/.test(e.message));
  // 쓰는 큐가 있으면 거부 (목록 포함)
  assert.throws(() => applyOps(s, [{ op: 'remove', id: 'lk-a' }]), e => e.code === 'referenced' && /look lk-a \(무대 A\) is still used in 2 light cue\(s\): light cue q-1 .*light cue q-3/.test(e.message) && e.references.length === 2);
  // force: q-3(세 줄)에서는 그 줄만 빠지고, q-1(그 조명뿐)은 그대로 "(삭제된 조명)" — 경고로 알린다
  r = applyOps(s, [{ op: 'remove', id: 'lk-a', force: true }]);
  assert.deepEqual(r.show.lights.map(l => l.id), ['lk-b', 'lk-pin']);
  assert.deepEqual(findCue(r.show, 'q-3').light.looks, [off('lk-pin'), on('lk-b')]);
  assert.deepEqual(findCue(r.show, 'q-1').light.looks, [on('lk-a')]);
  assert.ok(r.warnings.some(w => /removed look lk-a from light cue q-3/.test(w.msg)));
  assert.ok(r.warnings.some(w => /"lk-a" 가 lights 에 없습니다/.test(w.msg)));
  // 쓰지 않는 조명은 그냥 지워진다
  r = applyOps(applyOps(s, [{ op: 'add', kind: 'look', data: { id: 'lk-new', name: '새 조명' } }]).show, [{ op: 'remove', id: 'lk-new' }]);
  assert.equal(r.show.lights.length, 3);
});

test('MCP ops: 조명 큐 light.looks 통째 — 이름 대신 id, 같은 조명 두 줄 거부, 모르는 필드 거부, 채널 형식도 그대로 받는다', () => {
  const s = v11();
  let r = applyOps(s, [
    { op: 'add', kind: 'cue', parent: 'i-2', data: { dept: 'light', trigger: '박수', light: { looks: [{ lookId: 'lk-pin', action: 'off' }, { lookId: 'lk-a' }] } } },
    { op: 'set', id: 'q-4', fields: { light: { looks: [off('lk-b'), on('lk-a')] } } }
  ]);
  // v12: 대사(i-2)에 붙이는 옛 방식은 그 대사 바로 뒤의 큐로 — 트리거는 글과 상관없이 그 대사 끝(옛 글 "박수" 는 표시·메모로)
  const nc = cues(r.show).find(c => c.dept === 'light' && c.light.looks.length === 2 && c.light.looks[0].lookId === 'lk-pin');
  assert.deepEqual(items(r.show).find(i => i.cues.includes(nc)).trigger, { type: 'line', itemId: 'i-2', at: 'end', migrated: true, was: '박수' });
  assert.equal(nc.note, '옮기기 전 글: 박수');
  assert.deepEqual(nc.light, { looks: [off('lk-pin'), on('lk-a')], channels: [], anim: '' }, 'action 기본은 on, 채널은 빈 배열');
  assert.deepEqual(findCue(r.show, 'q-4').light, { looks: [off('lk-b'), on('lk-a')], channels: [ch('house', 'on')], anim: '' }, 'looks 만 바꾸면 채널은 그대로');
  const bad = (light, re) => assert.throws(() => applyOps(s, [{ op: 'set', id: 'q-1', fields: { light } }]), e => e.code === 'bad_field' && re.test(e.message), JSON.stringify(light));
  bad({ looks: [{ lookId: '무대 A', action: 'on' }] }, /"무대 A" is a name, use id "lk-a"/);
  bad({ looks: [{ lookId: 'lk-zz', action: 'on' }] }, /a look id from lights\[\] \(known: lk-a=무대 A/);
  bad({ looks: [on('lk-a'), off('lk-a')] }, /look lk-a is already in light\.looks\[0\]/);
  bad({ looks: [{ lookId: 'lk-a', action: 'fadeIn' }] }, /one of on\|off/);
  bad({ looks: [{ lookId: 'lk-a', timeSec: 2 }] }, /unknown field "light\.looks\[0\]\.timeSec"/);
  bad({ looks: [{ action: 'on' }] }, /light\.looks\[0\]\.lookId" is required/);
  bad({ looks: 'lk-a' }, /must be an array/);
  // 채널 형식(상세)도 그대로
  r = applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { looks: [], channels: [{ ch: 'front', action: 'fadeIn', dim: 70 }] } } }]);
  assert.deepEqual(findCue(r.show, 'q-1').light.looks, []);
  assert.equal(findCue(r.show, 'q-1').light.channels[0].dim, 70);
  // 빈 조명 큐는 경고
  r = applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { looks: [] } } }]);
  assert.ok(r.warnings.some(w => /light cue q-1 has no content yet/.test(w.msg)));
});

test('MCP ops: v10 공연에 op 를 적용하면 v11 로 — lights: [] (preShowProps 뒤), 조명 큐 looks: [] 앞에, 채널 그대로', () => {
  const s = v11(); s.version = 10; delete s.lights;
  cues(s).forEach(c => { c.light = { channels: [ch('front', 'on')], anim: '' }; });
  const r = applyOps(s, [{ op: 'set', kind: 'show', fields: { revision: 'v11' } }]);
  assert.equal(r.show.version, 13);
  assert.deepEqual(Object.keys(r.show).slice(Object.keys(r.show).indexOf('people')), ['people', 'props', 'preShowProps', 'lights', 'tracks', 'parts']);
  cues(r.show).forEach(c => { assert.deepEqual(Object.keys(c.light), ['looks', 'channels', 'anim']); assert.deepEqual(c.light.channels, [ch('front', 'on')]); });
  // 사이트가 불러와도 같다
  assert.deepEqual(plain(FE.migrate(r.show)).parts, plain(r.show.parts).map(p => p));
});

test('MCP 개요·검색: lights 줄(이름·설명), 큐 줄은 사이트 머리글, 조명 이름·설명으로 찾는다', () => {
  const s = v11();
  const o = outline(s, { showId: 'x', rev: 1 });
  assert.match(o, /^lights: lk-a=무대 A \(프론트 70 \+ 탑 블루, 리허설 11\/12 확정\), lk-b=엔딩 블루, lk-pin=핀 \(센터 핀 — 조예준\)$/m);
  assert.match(o, /q-3 light 무대 A·핀 OFF · 엔딩 블루 ON @ "대사 끝"/);
  assert.match(o, /q-4 light 엔딩 블루 OFF · 객석 ON/);
  let r = search(s, '엔딩 블루');
  assert.ok(r.matches.some(m => m.kind === 'look' && m.id === 'lk-b' && m.field === 'name'));
  assert.ok(r.matches.some(m => m.kind === 'cue' && m.id === 'q-3' && m.field === 'light.look'));
  r = search(s, '탑 블루');
  assert.ok(r.matches.some(m => m.kind === 'look' && m.id === 'lk-a' && m.field === 'note'));
});

// 점검: 작은 입력 (test/check.test.js 와 같은 모양)
function ckInput(show) {
  const entries = [];
  let q = 0;
  show.parts.forEach(p => p.scenes.forEach(s => s.items.forEach(it => entries.push({ item: it, scene: s, q: it.cues.length ? String(++q) : null }))));
  return { show, entries, sceneTitle: s => s.title, pname: () => '?', hasPerson: () => true, cueText: c => LIB.cueText(c, LOOK), trackByNo: () => null, hasFile: () => true, useCount: () => 0, propIssues: () => [], fileWhere: '' };
}
const ck = (show, k) => plain(CHECK.checkCollect(ckInput(show)).groups.find(g => g.k === k).list.map(x => x.text.replace(/^Q\d+ · 오프닝 — /, '')));

test('점검 "조명 ON/OFF 연속성"(확인): 켜진 조명을 또 ON, 켜지지 않은 조명을 OFF, 목록에 없는 조명 — 무대 암전은 모두 끈다', () => {
  const g = CHECK.CK_GROUPS.find(x => x.k === 'looks');
  assert.equal(g.sev, 'check');
  assert.deepEqual(plain(g.depts), ['light']);
  assert.deepEqual(ck(v11(), 'looks'), [], '정상 흐름은 문제 없음');
  const s = v11();
  findCue(s, 'q-2').light.looks = [on('lk-a'), on('lk-pin')]; // 무대 A 가 이미 켜져 있다
  findCue(s, 'q-4').light.looks = [off('lk-b'), off('lk-b2')];
  assert.deepEqual(ck(s, 'looks'), [
    '무대 A ON 다음 또 ON (앞: Q1 · 오프닝)',
    '(삭제된 조명) OFF — 조명 목록에 없음',
    '(삭제된 조명) OFF 인데 켜져 있지 않음'
  ]);
  // 처음부터 OFF
  const s2 = v11(); findCue(s2, 'q-1').light.looks = [off('lk-a')];
  assert.deepEqual(ck(s2, 'looks'), ['무대 A OFF 인데 켜져 있지 않음', '무대 A OFF 인데 켜져 있지 않음']);
  // 무대 암전(백·탑·프론트 OFF) 뒤에는 다시 ON 해도 문제 아님
  const s3 = v11();
  findCue(s3, 'q-2').light = { looks: [], channels: ['back', 'top', 'front'].map(x => ch(x, 'off')), anim: '' };
  findCue(s3, 'q-3').light.looks = [on('lk-a')];
  findCue(s3, 'q-4').light.looks = [];
  assert.deepEqual(ck(s3, 'looks'), []);
  // 역할 필터: 조명 역할에 나오고 음향 역할에는 안 나온다
  const r = CHECK.checkCollect(ckInput(s));
  const n = (role) => CHECK.checkFilter(r, role).groups.find(x => x.k === 'looks').list.length;
  assert.deepEqual([n('all'), n('light'), n('sound')], [3, 3, 0]);
});

test('점검 "비어 있는 확정 조명 큐"(막힘): 조명 줄·채널·애니메이션이 모두 없을 때만', () => {
  const s = v11();
  findCue(s, 'q-1').light.looks = [];
  findCue(s, 'q-2').light = { looks: [], channels: [ch('house', 'off')], anim: '' };
  findCue(s, 'q-3').light = { looks: [], channels: [], anim: '' }; findCue(s, 'q-3').status = 'tbd';
  const g = CHECK.checkCollect(ckInput(s)).groups.find(x => x.k === 'light');
  assert.equal(g.sev, 'block');
  assert.deepEqual(plain(g.list.map(x => x.item)), ['i-1']);
  // looks 키가 없는 옛 모양(채널만)도 읽는다
  const s2 = v11(); cues(s2).forEach(c => { c.light = { channels: [ch('front', 'on')], anim: '' }; });
  assert.deepEqual(ck(s2, 'light'), []);
  assert.deepEqual(ck(s2, 'looks'), []);
});

const migrate = s => plain(FE.migrate(s));
const relabel = s => FE.relabel(s);
const merge = (b, l, r) => M.mergeShows(b, l, r, { relabel });
test('병합: show.lights 는 id 로, 조명 큐의 looks 는 조명 id 로 — 양쪽 추가 모두, 같은 줄의 액션을 다르게 고치면 충돌(서버 것)', () => {
  const base = migrate(v11());
  // 조명 목록: 서버는 이름을 고치고 이 기기는 새 조명을 더함
  let remote = applyOps(base, [{ op: 'set', id: 'lk-b', fields: { name: '엔딩 블루 풀' } }]).show;
  let local = plain(base); local.lights.push({ id: 'lk-new', name: '스모크', note: '' });
  let r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.show.lights.map(l => l.name), ['무대 A', '엔딩 블루 풀', '핀', '스모크']);
  // 조명 줄: 서버는 핀 ON 을, 이 기기는 엔딩 블루 OFF 를 q-1 에 더함 → 둘 다(서버 순서 + 이 기기 것은 앞 이웃 뒤에), 채널 변경도 합쳐진다
  remote = applyOps(base, [{ op: 'set', id: 'q-1', fields: { light: { looks: [on('lk-a'), on('lk-pin')] } } }]).show;
  local = plain(base); findCue(local, 'q-1').light.looks.push(off('lk-b')); findCue(local, 'q-1').light.channels = [ch('house', 'off')];
  r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(findCue(r.show, 'q-1').light, { looks: [on('lk-a'), off('lk-b'), on('lk-pin')], channels: [ch('house', 'off')], anim: '' });
  assert.deepEqual(Object.keys(findCue(r.show, 'q-1').light), ['looks', 'channels', 'anim'], '키 순서 유지');
  assert.deepEqual(validateShow(r.show).errors, []);
  // 같은 조명의 액션을 양쪽에서 다르게 → 충돌, 서버 것. 다른 줄은 합쳐진다
  remote = applyOps(base, [{ op: 'set', id: 'q-3', fields: { light: { looks: [on('lk-a'), off('lk-pin'), on('lk-b')] } } }]).show;
  local = plain(base); findCue(local, 'q-3').light.looks[0].action = 'on'; findCue(local, 'q-3').light.looks[1].action = 'on';
  local.lights[0].note = '바뀜';
  r = merge(base, local, remote);
  assert.equal(r.conflicts.length, 0, '같은 값으로 바꾼 줄은 충돌 아님');
  assert.deepEqual(findCue(r.show, 'q-3').light.looks, [on('lk-a'), on('lk-pin'), on('lk-b')]);
  local = plain(base); findCue(local, 'q-3').light.looks[2].action = 'off';
  remote = applyOps(base, [{ op: 'set', id: 'q-3', fields: { light: { looks: [off('lk-a'), off('lk-pin')] } } }]).show; // 서버는 엔딩 블루 줄을 뺌
  r = merge(base, local, remote);
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0].text, / — 조명: 양쪽에서 다르게 고침$/);
  assert.deepEqual(findCue(r.show, 'q-3').light.looks, [off('lk-a'), off('lk-pin')]);
  // 조명 삭제 충돌의 설명
  remote = applyOps(base, [{ op: 'remove', id: 'lk-pin', force: true }]).show;
  local = plain(base); local.lights[2].note = '고침';
  r = merge(base, local, remote);
  assert.ok(r.conflicts.some(c => c.kind === 'look' && /조명 핀 — 다른 곳/.test(c.text)), JSON.stringify(r.conflicts));
});

test('삭제 되돌리기: 쓰는 큐가 있는 조명을 지워도(여러 줄 큐에서는 그 줄만 빠짐) Ctrl+Z 로 줄까지 제자리에, 그 뒤 고친 것은 남는다', () => {
  const s = migrate(v11());
  relabel(s);
  const before = JSON.stringify(s);
  const r0 = FE.dropLook(s, 'lk-a');
  assert.deepEqual(plain(r0), { rows: 1, kept: 1 });
  assert.deepEqual(s.lights.map(l => l.id), ['lk-b', 'lk-pin']);
  assert.deepEqual(findCue(s, 'q-3').light.looks, [off('lk-pin'), on('lk-b')]);
  assert.deepEqual(findCue(s, 'q-1').light.looks, [on('lk-a')], '그 조명뿐인 큐는 그대로 — "(삭제된 조명)"');
  relabel(s);
  const e = { before, after: JSON.stringify(s), seq: 1 };
  // 바로 되돌리면 지우기 전과 같다
  let r = FE.delRestore(e, plain(s), M, relabel);
  assert.equal(r.ok, true); assert.equal(r.conflicts, 0);
  assert.deepEqual(plain(r.show), JSON.parse(before));
  // 삭제 뒤에 다른 조명 설명을 고치고 q-3 에 줄을 더해도: 지운 조명과 줄이 제자리로, 고친 것은 남는다
  const cur = plain(s);
  cur.lights[0].note = '탑 블루 100';
  findCue(cur, 'q-4').light.looks.push(on('lk-pin'));
  r = FE.delRestore(e, cur, M, relabel);
  assert.equal(r.ok, true); assert.equal(r.conflicts, 0);
  assert.deepEqual(r.show.lights.map(l => [l.id, l.note]), [['lk-a', LIGHTS[0].note], ['lk-b', '탑 블루 100'], ['lk-pin', LIGHTS[2].note]]);
  assert.deepEqual(findCue(r.show, 'q-3').light.looks, [off('lk-a'), off('lk-pin'), on('lk-b')]);
  assert.deepEqual(findCue(r.show, 'q-4').light.looks, [off('lk-b'), on('lk-pin')]);
  // 채널이 있는 큐는 그 조명 줄이 마지막이어도 줄만 빠진다
  const s2 = migrate(v11());
  assert.deepEqual(plain(FE.dropLook(s2, 'lk-b')), { rows: 2, kept: 0 });
  assert.deepEqual(findCue(s2, 'q-4').light, { looks: [], channels: [ch('house', 'on')], anim: '' });
});
