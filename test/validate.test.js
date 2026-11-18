// lib/validate.js — 프런트(index.html)의 migrate()·상수와 어긋나지 않는지까지 본다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateShow, basicInvalid, unwrapShow, fillIds, actionEcho, CONST, SHOW_VER } = require('../lib/validate');

// index.html 의 "상수" ~ "상태" 구간(상수·유틸·샘플·라벨·migrate)만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  return vm.runInNewContext(html.slice(a, b) + '\n;({ sampleShow, migrate, DEPTS, CH, L_ACT, S_ACT, MOVES, PROP_ACTS, ROLES, ACT_RE })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));
const docExample = () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'cue-format.md'), 'utf8');
  const m = /```json\n([\s\S]*?)```/.exec(md);
  assert.ok(m, 'docs/cue-format.md 에 json 예시 블록이 없습니다');
  return JSON.parse(m[1]);
};
const paths = list => list.map(x => x.path);

test('상수가 index.html 과 같다', () => {
  assert.deepEqual(plain(FE.DEPTS), CONST.DEPTS);
  assert.deepEqual(plain(FE.CH), CONST.CH);
  assert.deepEqual(plain(FE.L_ACT), CONST.L_ACT);
  assert.deepEqual(plain(FE.S_ACT), CONST.S_ACT);
  assert.deepEqual(Object.keys(FE.MOVES), CONST.MOVES);
  assert.deepEqual(Object.keys(FE.PROP_ACTS), CONST.PROP_ACTS);
  assert.deepEqual(Object.keys(FE.ROLES), CONST.ROLES);
  assert.ok(CONST.SHOW_VERS.includes(plain(FE.migrate({ version: 5, parts: [] })).version), '프런트가 내보내는 version 은 읽을 수 있는 형식이어야 한다');
  // 프런트가 내보내는 version = 서버 스키마 SHOW_VER (MCP ops 도 이 값으로 저장)
  assert.equal(plain(FE.migrate({ version: 6, parts: [] })).version, SHOW_VER);
  assert.ok(CONST.SHOW_VERS.includes(SHOW_VER) && SHOW_VER === Math.max(...CONST.SHOW_VERS), 'SHOW_VER 는 읽을 수 있는 형식 중 가장 새 것');
  assert.equal(plain(FE.migrate({ version: 7, parts: [] })).version, 9);
  assert.equal(FE.ACT_RE.source, CONST.ACT_RE.source);
});

test('프런트 샘플(migrate 결과)은 오류·경고 없이 통과하고 서버 검사도 통과', () => {
  const s = plain(FE.migrate(FE.sampleShow()));
  const v = validateShow(s);
  assert.deepEqual(v.errors, []);
  // 지문 표기 경고('action-format')·큐를 다시 적은 지문('action-echo')은 뺀다 — sampleShow 는 실데이터 초안을 그대로 옮긴 것이라
  // 아직 "* …" 지문과 "(조예준 인)" 같은 중복 지문이 있다. 다른 경고는 그대로 0 이어야 하므로 코드로 거른다.
  assert.deepEqual(v.warnings.filter(w => w.code !== 'action-format' && w.code !== 'action-echo'), []);
  assert.equal(basicInvalid(s), null);
});

test('문서 예시는 오류·경고 없이 통과하고, 사이트가 불러와도 내용이 그대로다', () => {
  const ex = docExample();
  const v = validateShow(ex);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  const m = plain(FE.migrate(ex));
  // migrate 가 채우는 값(쇼 id·revision·updatedAt, 큐 번호·isCue)만 빼고 비교
  const strip = s => {
    s = plain(s); delete s.id; delete s.revision; delete s.updatedAt;
    s.parts.forEach(p => p.scenes.forEach(sc => sc.items.forEach(i => { delete i.label; delete i.isCue; })));
    return s;
  };
  assert.deepEqual(strip(m), strip(ex));
  assert.deepEqual(m.parts[0].scenes[0].items.map(i => i.label), ['1', '2']);
});

test('오류: 의미가 바뀌는 값은 경로와 함께', () => {
  const s = docExample();
  const sc = s.parts[0].scenes[0];
  sc.items[0].cues[0].dept = 'lighting';
  sc.items[0].cues[1].offsetSec = '7초';
  sc.items[0].cues[1].sound.action = 'pause';
  sc.items[1].speaker = '조예준';
  sc.items[1].cues[0].cast.personId = 'p-nobody';
  sc.items[1].cues[0].cast.move = 'enter';
  sc.items[1].kind = 'dialog';
  sc.type = 'magic';
  s.parts[0].scenes[1].cast = ['박대훈'];
  s.parts[0].scenes[1].id = 's-1';
  s.tracks.push({ id: 'tr-2', no: 1, title: '' });
  const v = validateShow(s);
  const P = 'parts[0].scenes[0]';
  assert.deepEqual(paths(v.errors).sort(), [
    `${P}.items[0].cues[0].dept`, `${P}.items[0].cues[1].offsetSec`, `${P}.items[0].cues[1].sound.action`,
    `${P}.items[1].speaker`, `${P}.items[1].cues[0].cast.personId`, `${P}.items[1].cues[0].cast.move`, `${P}.items[1].kind`,
    `${P}.type`, 'parts[0].scenes[1].cast[0]', 'parts[0].scenes[1].id', 'tracks[1].no'
  ].sort());
  const sp = v.errors.find(e => e.path === `${P}.items[1].speaker`);
  assert.match(sp.msg, /"조예준" 는 이름입니다 — people\[\]\.id 인 "p-yejun" 를 쓰세요/);
  assert.match(v.errors.find(e => e.path === `${P}.items[1].cues[0].cast.personId`).msg, /"p-nobody" 가 people 에 없습니다/);
  assert.match(sp.where, /1부 › 씬 1\(\?\) › #2 "소개합니다 박대훈"/);
});

test('오류: 구조·필수 값', () => {
  assert.deepEqual(paths(validateShow(null).errors), ['']);
  assert.deepEqual(paths(validateShow({ version: 5 }).errors), ['parts']);
  assert.deepEqual(paths(validateShow({ parts: [] }).errors), ['version']);
  const v = validateShow({ version: 5, parts: [{ scenes: [{ items: [{ cues: [{}] }, 3] }] }, 'x'], people: {} });
  assert.deepEqual(paths(v.errors).sort(), ['parts[0].scenes[0].items[0].cues[0].dept', 'parts[0].scenes[0].items[1]', 'parts[1]', 'people'].sort());
});

test('경고: 사이트가 뜻을 유지한 채 고치는 값', () => {
  const s = docExample();
  delete s.parts[0].scenes[0].items[0].id;
  s.parts[0].scenes[0].items[0].cues[1].offsetSec = '7';
  s.parts[0].scenes[0].items[0].note = '모르는 필드';
  s.parts[0].scenes[0].items[0].cues[1].sound.level = 120;
  s.parts[0].scenes[0].items[0].cues[1].sound.track = 9;
  s.parts[0].scenes[0].items[1].kind = 'action'; // 화자 있는 동작 + 괄호 없는 지문
  s.version = 4;
  const v = validateShow(s);
  assert.deepEqual(v.errors, []);
  const P = 'parts[0].scenes[0]';
  assert.deepEqual(paths(v.warnings).sort(), [
    'version', `${P}.items[0].id`, `${P}.items[0].note`, `${P}.items[0].cues[1].offsetSec`,
    `${P}.items[0].cues[1].sound.level`, `${P}.items[0].cues[1].sound.track`, `${P}.items[1].speaker`, `${P}.items[1].text`
  ].sort());
});

test('음향 level: play 시작 볼륨은 경고 없음, stop·fadeOut 의 level 은 "쓰이지 않음" 경고 (범위 밖이면 범위 경고 하나만)', () => {
  const s = docExample(), q = s.parts[0].scenes[0].items[0].cues[1]; // fadeOut
  const P = 'parts[0].scenes[0].items[0].cues[1].sound.level';
  Object.assign(q.sound, { action: 'play', level: 50 });
  assert.deepEqual(validateShow(s).warnings, []);
  Object.assign(q.sound, { action: 'fadeIn', level: 70 });
  assert.deepEqual(validateShow(s).warnings, []);
  for (const action of ['stop', 'fadeOut']) {
    Object.assign(q.sound, { action, level: 50 });
    const w = validateShow(s).warnings;
    assert.deepEqual(paths(w), [P], action);
    assert.match(w[0].msg, /쓰이지 않습니다/);
  }
  Object.assign(q.sound, { action: 'stop', level: 120 });
  assert.deepEqual(paths(validateShow(s).warnings), [P], '범위 경고와 겹치지 않는다');
  // 사이트도 불러올 때 play 의 level 을 그대로 둔다 — v8 → v9 는 version 만 바뀐다
  Object.assign(q.sound, { action: 'play', level: 50 });
  s.version = 8;
  assert.deepEqual(validateShow(s).warnings, [], 'v8 도 경고 없이 읽힌다');
  const m = plain(FE.migrate(s));
  assert.equal(m.version, SHOW_VER);
  assert.equal(m.parts[0].scenes[0].items[0].cues[1].sound.level, 50);
});

test('경고: 지문 표기 규칙 — 괄호 한 쌍 (…)', () => {
  const s = docExample();
  const items = s.parts[0].scenes[0].items;
  const mk = text => ({ id: 'i-x' + items.length, kind: 'action', speaker: null, text, label: null, comments: [], cues: [] });
  const bad = ['* 액트 도중 조예준 인', '— 보충', '(여는 괄호만', '닫는 괄호만)', '(조예준 인 (고개 절레절레))', '(가) (나)', '조예준 인'];
  const good = ['(조예준 인 — 고개 절레절레)', '(암전)'];
  [...bad, ...good].forEach(t => items.push(mk(t)));
  const v = validateShow(s);
  assert.deepEqual(v.errors, []);
  const base = items.length - bad.length - good.length;
  const warned = v.warnings.filter(w => w.code === 'action-format');
  assert.deepEqual(warned.map(w => w.path), bad.map((_, i) => `parts[0].scenes[0].items[${base + i}].text`));
  assert.ok(warned.every(w => /괄호 지문 `\(…\)` 으로 쓰세요/.test(w.msg)));
  assert.match(warned[4].msg, /괄호가 또 있습니다/);
  assert.match(warned[0].where, /1부 › 씬 1\(mc\) › #\d+ "\* 액트 도중 조예준 인"/);
  assert.equal(v.warnings.length, warned.length, '다른 경고는 없어야 한다');
  // 큰 틀: 경고일 뿐 오류가 아니다 (사이트 편집기는 * 와 — 시작을 허용)
  assert.equal(CONST.ACT_RE.test('* x') && CONST.ACT_RE.test('— x'), true);
});

test('소품이 있는 정상 문서는 오류·경고 없음, v5 도 경고 없음 · 실데이터(v5)는 소품 없는 무대 큐만 경고', () => {
  const s = docExample();
  assert.equal(s.version, 9);
  assert.ok(s.props.length && s.preShowProps.length);
  assert.deepEqual(validateShow(s).warnings, []);
  const v5 = plain(s); v5.version = 5; delete v5.props; delete v5.preShowProps;
  v5.parts[0].scenes[0].items[1].cues[1].stage = { text: '탑햇테이블에 탑햇 세팅' };
  v5.parts[0].scenes[0].items[1].cues[1].status = 'tbd';
  v5.parts[0].scenes[0].items[1].cues.forEach(c => { c.memo = c.note; delete c.note; });
  const r = validateShow(v5);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [], 'v7 이하의 memo · stage.text 는 정상');
  // 정리 전 실데이터(v5 고정 사본 test/fixtures): 소품 없는 확정 무대 큐 3개만 경고 — 올라가는 데는 문제없다
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backstage-part1-v5.json'), 'utf8'));
  const rr = validateShow(unwrapShow(real));
  assert.equal(unwrapShow(real).version, 5);
  assert.deepEqual(rr.errors, []);
  assert.deepEqual(rr.warnings.filter(w => w.code !== 'action-echo').map(w => w.code), ['stage-no-props', 'stage-no-props', 'stage-no-props']);
});

test('action-echo: 큐의 대상·액션·트리거만 다시 적은 지문은 "큐 지점으로 바꾸세요" 경고 (보수적)', () => {
  const look = { person: id => ({ 'p-yejun': '조예준', 'p-daehoon': '박대훈' })[id] || '', track: () => '', prop: id => ({ 'pr-card': '카드' })[id] || '' };
  const ch = (c, action) => ({ ch: c, action, dim: null, color: null, colorName: null, timeSec: null });
  const cue = (dept, body, extra) => Object.assign({ dept, trigger: '', offsetSec: null, note: '', status: 'set', [dept]: body }, extra);
  const it = (text, cues, kind) => ({ kind: kind || 'action', text, cues });
  const yjIn = cue('cast', { personId: 'p-yejun', move: 'in' }, { trigger: '암전 후' });
  const black = cue('light', { channels: ['back', 'top', 'front', 'house'].map(c => ch(c, 'off')), anim: '' });
  const play = cue('sound', { track: 2, action: 'play', timeSec: null, level: null }, { trigger: '예준 스냅 주면' });
  const clean = cue('stage', { props: [{ propId: 'pr-card', action: 'clean', at: '' }] });
  assert.equal(actionEcho(it('(조예준 인)', [yjIn]), look), true);
  assert.equal(actionEcho(it('(암전)', [black]), look), true);
  assert.equal(actionEcho(it('(예준 스냅 주면 노래 시작)', [play]), look), true, '트리거 + 액션');
  assert.equal(actionEcho(it('(카드 청소)', [clean]), look), true);
  assert.equal(actionEcho(it('(조예준 인 — 마이크 들고 들어와 라태형에게 건넴)', [yjIn]), look), false, '보충이 있으면 아님');
  assert.equal(actionEcho(it('(조예준 아웃)', [yjIn]), look), false, '액션이 다르면 아님');
  assert.equal(actionEcho(it('(박대훈 인)', [yjIn]), look), false, '대상이 다르면 아님');
  assert.equal(actionEcho(it('(조예준 인)', []), look), false, '큐가 없으면 아님');
  assert.equal(actionEcho(it('(조예준 인)', [yjIn], 'line'), look), false, '대사는 보지 않는다');
  assert.equal(actionEcho(it('', [yjIn]), look), false, '이미 비운 지문은 아님');
  // validateShow 경고: 경로 · 코드 · 안내
  const e = docExample();
  const i1 = e.parts[0].scenes[0].items[0];
  i1.text = '(암전)';
  const v = validateShow(e);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.map(w => [w.path, w.code]), [['parts[0].scenes[0].items[0].text', 'action-echo']]);
  assert.match(v.warnings[0].msg, /큐를 다시 적은 지문 — .*큐 지점으로 바꾸세요 \(kind:"cue"/);
});

// 정리 전 실데이터(v5 고정 사본)에서 걸리던 15개 — 규칙 회귀 확인용. 현재 cues/ 데이터는 아래 테스트처럼 0개
test('action-echo: 정리 전 실데이터(test/fixtures/backstage-part1-v5.json)에서 걸리는 지문 15개 — 데이터 정리 목록', () => {
  const s = unwrapShow(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backstage-part1-v5.json'), 'utf8')));
  const its = s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items));
  const byPath = w => { const m = /parts\[(\d+)\]\.scenes\[(\d+)\]\.items\[(\d+)\]/.exec(w.path); return s.parts[+m[1]].scenes[+m[2]].items[+m[3]]; };
  const got = validateShow(s).warnings.filter(w => w.code === 'action-echo').map(w => { const i = byPath(w); return `${i.id} ${i.text}`; });
  assert.deepEqual(got, [
    'i-7 (하우스 음악 커지면서 관객석 조명 Off)', 'i-b (암전)', 'i-d (조예준 인)', 'i-h (예준 스냅 주면 노래 시작)', 'i-p (조예준 아웃)',
    'i-s (멘트 끝나자마자 음원 시작)', 'i-u (박대훈 인)', 'i-z (조예준 인)', 'i-19 (박대훈 아웃)', 'i-1c (암전)', 'i-1e (조예준 아웃)',
    'i-1j (라태형 인)', 'i-2i (라태형 아웃)', 'i-2n (라태형 인)', 'i-2t (조예준 절레절레하며 퇴장)'
  ]);
  // 정보가 더 있는 지문은 걸리지 않는다
  ['(조예준 인 — 마이크 들고 들어와 라태형에게 건넴)', '(소개팅 2명 불러오기)', '(조예준 인 — 고개 절레절레 하며)'].forEach(t => assert.ok(!got.some(g => g.endsWith(' ' + t)), t));
  assert.equal(its.filter(i => i.kind === 'action' && i.cues.length).length > got.length, true);
});

test('현재 실데이터(cues/backstage-part1.json, 2026-11-18 배포본 rev 84): v8, 오류·경고 없음 — action-echo 지문 22개는 큐 지점, 무대 큐 3개는 소품 지정', () => {
  const s = unwrapShow(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8')));
  assert.equal(s.version, 8, '배포본 사본은 v8 — v9(PLAY 시작 볼륨, 모양은 같다)에서도 경고 없이 읽힌다');
  assert.ok(CONST.SHOW_VERS.includes(s.version));
  const v = validateShow(s);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  const its = s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items));
  const points = its.filter(i => i.kind === 'cue');
  assert.equal(points.length, 22);
  assert.ok(points.every(i => i.text === '' && i.speaker == null && i.cues.length));
  const stage = its.flatMap(i => i.cues).filter(c => c.dept === 'stage');
  assert.equal(stage.length, 3);
  assert.ok(stage.every(c => c.stage.props.length && c.stage.props.every(x => s.props.some(p => p.id === x.propId))));
  assert.deepEqual(s.preShowProps.map(x => x.propId).sort(), ['pr-cup', 'pr-tophat-table']);
});

test('소품 검사 — 모르는 propId 경고, 잘못된 action 오류, clean 허용, 레지스트리 id 중복 오류', () => {
  const s = docExample();
  const st = s.parts[0].scenes[0].items[1].cues[1].stage;
  const P = 'parts[0].scenes[0].items[1].cues[1].stage';
  st.props.push({ propId: 'pr-ghost', action: 'in', at: '' }, { propId: 'pr-tophat', action: 'enter', at: '' }, { propId: 'pr-table', action: 'clean', at: '' });
  s.preShowProps.push({ propId: 'pr-ghost', at: '' });
  s.props.push({ id: 'pr-tophat', name: '중복' });
  const v = validateShow(s);
  assert.deepEqual(paths(v.errors).sort(), ['props[2].id', `${P}.props[2].action`].sort());
  assert.match(v.errors.find(e => e.path === `${P}.props[2].action`).msg, /in\|out\|move\|clean/);
  assert.deepEqual(paths(v.warnings).sort(), [`${P}.props[1].propId`, 'preShowProps[1].propId'].sort());
  assert.match(v.warnings.find(w => w.path === 'preShowProps[1].propId').msg, /"pr-ghost" 가 props 에 없습니다/);
  const e = docExample();
  e.parts[0].scenes[0].items[1].cues[1].stage.props[0].propId = 3;
  assert.deepEqual(paths(validateShow(e).errors), ['parts[0].scenes[0].items[1].cues[1].stage.props[0].propId']);
});

test('v8: 소품 없는 무대 큐는 경고(올라감), 미정이면 경고 없음', () => {
  const e = docExample();
  const c = e.parts[0].scenes[0].items[1].cues[1];
  c.stage = { props: [] }; c.status = 'set';
  let v = validateShow(e);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.map(w => [w.path, w.code]), [['parts[0].scenes[0].items[1].cues[1].stage', 'stage-no-props']]);
  assert.match(v.warnings[0].msg, /소품이 필요합니다/);
  c.status = 'tbd';
  assert.deepEqual(validateShow(e).warnings, []);
});

test('v8: note 허용, memo · cast.text · stage.text 는 v8 에서 옛 필드 경고 (v7 이하는 정상)', () => {
  const e = docExample();
  const [cast, stage] = e.parts[0].scenes[0].items[1].cues;
  cast.memo = '옛 메모'; cast.cast.text = '옛 설명'; stage.stage.text = '옛 작업';
  let v = validateShow(e);
  assert.deepEqual(v.errors, []);
  const P = 'parts[0].scenes[0].items[1]';
  assert.deepEqual(v.warnings.map(w => [w.path, w.code]).sort(), [[`${P}.cues[0].memo`, 'legacy-field'], [`${P}.cues[0].cast.text`, 'legacy-field'], [`${P}.cues[1].stage.text`, 'legacy-field']].sort());
  e.version = 7;
  assert.deepEqual(validateShow(e).warnings, []);
  // note 는 문자열
  const n = docExample(); n.parts[0].scenes[0].items[1].cues[0].note = ['x'];
  assert.deepEqual(paths(validateShow(n).errors), [`${P}.cues[0].note`]);
});

test('v8: 객석(house)에 on/off 외 액션이나 밝기·색·시간이 있으면 경고', () => {
  const e = docExample();
  const chs = e.parts[0].scenes[0].items[0].cues[0].light.channels;
  const house = chs.find(x => x.ch === 'house');
  assert.deepEqual(validateShow(e).warnings, [], '객석 off 는 정상');
  house.action = 'fadeOut';
  let v = validateShow(e);
  assert.deepEqual(v.warnings.map(w => w.code), ['house-onoff']);
  assert.match(v.warnings[0].msg, /on\/off 만/);
  house.action = 'on'; house.dim = 40;
  assert.deepEqual(validateShow(e).warnings.map(w => w.code), ['house-onoff']);
  house.dim = null; house.colorName = '앰버';
  assert.deepEqual(validateShow(e).warnings.map(w => w.code), ['house-onoff']);
  // 무대 채널은 무엇이든 된다
  house.colorName = null; chs[0].action = 'fadeIn'; chs[0].dim = 40; chs[0].timeSec = 3;
  assert.deepEqual(validateShow(e).warnings, []);
});

test('v8 migrate: memo · text → note, 소품 없는 무대 큐는 남김, 객석은 on/off 로 접고 흔적, 왕복해도 같다', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backstage-part1-v5.json'), 'utf8'));
  const m = plain(FE.migrate(unwrapShow(real)));
  assert.equal(m.version, 9);
  const cues = m.parts.flatMap(p => p.scenes.flatMap(s => s.items.flatMap(i => i.cues)));
  const raw = unwrapShow(real).parts.flatMap(p => p.scenes.flatMap(s => s.items.flatMap(i => i.cues)));
  assert.equal(cues.length, raw.length, '큐를 하나도 잃지 않는다');
  cues.forEach(c => { assert.ok(!('memo' in c), 'memo 없음'); assert.equal(typeof c.note, 'string'); if (c.dept === 'cast' || c.dept === 'stage') assert.ok(!('text' in c[c.dept]), `${c.dept}.text 없음`); });
  const stage = cues.filter(c => c.dept === 'stage');
  assert.equal(stage.length, 3);
  assert.ok(stage.every(c => c.stage.props.length === 0 && c.note.length > 5), '소품 없는 무대 큐는 그대로, 원래 문장은 note');
  assert.equal(cues.find(c => c.dept === 'cast' && c.note).note, '마이크 들고 들어와 라태형에게 건넴');
  assert.equal(cues.find(c => c.dept === 'light' && c.note === '조명 상세 미정').status, 'tbd');
  // 둘 다 있으면 text / memo
  const both = FE.migrate({ version: 7, parts: [{ scenes: [{ items: [{ cues: [
    { id: 'q1', dept: 'cast', memo: '확인 필요', cast: { personId: null, move: 'in', text: '마이크 들고' } },
    { id: 'q2', dept: 'stage', memo: '같은 말', stage: { text: '같은 말', props: [] } },
    { id: 'q3', dept: 'light', memo: '', light: { channels: [{ ch: 'house', action: 'fadeIn', dim: 40, timeSec: 3 }, { ch: 'back', action: 'fadeIn', dim: 40, timeSec: 3 }], anim: '' } },
    { id: 'q4', dept: 'light', memo: '메모', light: { channels: [{ ch: 'house', action: 'fadeOut' }, { ch: 'top', action: 'anim' }], anim: '체이스' } },
    { id: 'q5', dept: 'stage', stage: { props: [{ propId: 'pr-card', action: 'clean', at: '' }] } }
  ] }] }] }] });
  const q = plain(both).parts[0].scenes[0].items[0].cues;
  assert.equal(q[0].note, '마이크 들고 / 확인 필요');
  assert.deepEqual(q[0].cast, { personId: null, move: 'in' });
  assert.equal(q[1].note, '같은 말', '같은 문장은 한 번만');
  assert.deepEqual(q[1].stage, { props: [] });
  assert.deepEqual(q[2].light.channels[0], { ch: 'house', action: 'on', dim: null, color: null, colorName: null, timeSec: null });
  assert.deepEqual(q[2].light.channels[1], { ch: 'back', action: 'fadeIn', dim: 40, color: null, colorName: null, timeSec: 3 }, '무대 채널은 그대로');
  assert.equal(q[2].note, '(객석: 원래 FADE IN 40% 3s)');
  assert.equal(q[3].light.channels[0].action, 'off');
  assert.equal(q[3].note, '메모 / (객석: 원래 FADE OUT)');
  assert.equal(q[4].stage.props[0].action, 'clean');
  // 왕복: 한 번 더 migrate 해도 같고, 검증 통과(소품 없는 무대 큐 경고만)
  const again = plain(FE.migrate(m));
  delete again.updatedAt; const m2 = plain(m); delete m2.updatedAt;
  assert.deepEqual(again, m2);
  const v = validateShow(m);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.filter(w => w.code !== 'action-echo').map(w => w.code), ['stage-no-props', 'stage-no-props', 'stage-no-props']);
  const b2 = plain(FE.migrate(plain(both)));
  assert.deepEqual(b2.parts[0].scenes[0].items[0].cues, q, 'note 흔적이 두 번 붙지 않는다');
});

test('fillIds: 빠진 id 만 위치 기반으로, 기존 id 와 겹치지 않게', () => {
  const s = { version: 5, people: [{ name: 'A' }], tracks: [{ no: 3 }], parts: [{ scenes: [{ items: [{ cues: [{ dept: 'stage' }, { id: 'q-1-1-1-2', dept: 'stage' }] }, { id: 'i-1-1-1' }] }] }] };
  assert.equal(fillIds(s), 6);
  assert.equal(s.people[0].id, 'p-1');
  assert.equal(s.tracks[0].id, 'tr-3');
  assert.equal(s.parts[0].id, 'pt-1');
  assert.equal(s.parts[0].scenes[0].id, 's-1-1');
  assert.equal(s.parts[0].scenes[0].items[0].id, 'i-1-1-1-2', '이미 있는 i-1-1-1 과 겹치지 않게');
  assert.equal(s.parts[0].scenes[0].items[0].cues[0].id, 'q-1-1-1-1');
  assert.equal(fillIds(s), 0);
  assert.deepEqual(validateShow(s).errors, []);
});

test('unwrapShow / basicInvalid', () => {
  const s = { version: 5, parts: [] };
  assert.equal(unwrapShow(s), s);
  assert.equal(unwrapShow({ show: s }), s);
  assert.equal(unwrapShow({ rev: 3, updatedAt: 'x', show: s }), s);
  assert.equal(basicInvalid(s), null);
  assert.match(basicInvalid({ version: 5, parts: [{ scenes: {} }] }), /parts\[0\]\.scenes 가 배열이 아닙니다/);
  assert.match(basicInvalid({ version: 5, parts: [{ scenes: [{ items: [{ cues: 'x' }] }] }] }), /cues 가 배열이 아닙니다/);
  assert.match(basicInvalid({ version: 5, parts: [], people: 'x' }), /people/);
  assert.ok(basicInvalid({ parts: [] }));
});

test('큐 지점(kind:"cue"): 본문·화자 없이 큐만 — 정상은 경고 없음, 본문·화자는 경고, 큐 0개는 오류 · migrate 는 그대로 둔다', () => {
  const e = docExample();
  const i1 = e.parts[0].scenes[0].items[0];
  i1.kind = 'cue'; i1.text = '';
  let v = validateShow(e);
  assert.deepEqual(v.errors, []); assert.deepEqual(v.warnings, []);
  const m = plain(FE.migrate(e));
  assert.deepEqual([m.parts[0].scenes[0].items[0].kind, m.parts[0].scenes[0].items[0].text, m.parts[0].scenes[0].items[0].label], ['cue', '', '1'], '큐 지점도 번호 대상');
  i1.text = '(공연 시작)'; i1.speaker = 'p-yejun';
  v = validateShow(e);
  assert.deepEqual(v.warnings.map(w => [w.path, w.code || '']), [['parts[0].scenes[0].items[0].text', 'cue-text'], ['parts[0].scenes[0].items[0].speaker', '']]);
  assert.deepEqual(plain(FE.migrate(e)).parts[0].scenes[0].items[0].text, '', '사이트는 본문을 버린다');
  i1.text = ''; i1.speaker = null; i1.cues = [];
  v = validateShow(e);
  assert.deepEqual(v.errors.map(x => x.path), ['parts[0].scenes[0].items[0].cues']);
  // 사이트는 큐 없는 지점을 빈 지문으로 (코멘트·id 보존)
  assert.equal(plain(FE.migrate(e)).parts[0].scenes[0].items[0].kind, 'action');
  // 옛 데이터는 자동 변환하지 않는다 — 실데이터 중복 지문은 action 그대로(경고만)
  const real = plain(FE.migrate(unwrapShow(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backstage-part1-v5.json'), 'utf8')))));
  assert.ok(!real.parts.some(p => p.scenes.some(sc => sc.items.some(i => i.kind === 'cue'))));
});
