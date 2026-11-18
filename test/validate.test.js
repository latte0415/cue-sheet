// lib/validate.js — 프런트(index.html)의 migrate()·상수와 어긋나지 않는지까지 본다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateShow, basicInvalid, unwrapShow, fillIds, CONST, SHOW_VER } = require('../lib/validate');

// index.html 의 "상수" ~ "상태" 구간(상수·유틸·샘플·라벨·migrate)만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  return vm.runInNewContext(html.slice(a, b) + '\n;({ sampleShow, migrate, DEPTS, CH, L_ACT, S_ACT, MOVES, ROLES, ACT_RE })', {});
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
  assert.deepEqual(Object.keys(FE.ROLES), CONST.ROLES);
  assert.ok(CONST.SHOW_VERS.includes(plain(FE.migrate({ version: 5, parts: [] })).version), '프런트가 내보내는 version 은 읽을 수 있는 형식이어야 한다');
  // 프런트가 내보내는 version = 서버 스키마 SHOW_VER (MCP ops 도 이 값으로 저장)
  assert.equal(plain(FE.migrate({ version: 6, parts: [] })).version, SHOW_VER);
  assert.ok(CONST.SHOW_VERS.includes(SHOW_VER) && SHOW_VER === Math.max(...CONST.SHOW_VERS), 'SHOW_VER 는 읽을 수 있는 형식 중 가장 새 것');
  assert.equal(plain(FE.migrate({ version: 7, parts: [] })).version, 7);
  assert.equal(FE.ACT_RE.source, CONST.ACT_RE.source);
});

test('프런트 샘플(migrate 결과)은 오류·경고 없이 통과하고 서버 검사도 통과', () => {
  const s = plain(FE.migrate(FE.sampleShow()));
  const v = validateShow(s);
  assert.deepEqual(v.errors, []);
  // 지문 표기 경고('action-format')는 뺀다 — sampleShow 가 아직 "* …" 지문을 쓰고, index.html 은 이 변경의 범위 밖이다.
  // 다른 경고는 그대로 0 이어야 하므로 코드로 거른다. sampleShow 를 괄호 지문으로 고치면 이 필터를 지운다.
  assert.deepEqual(v.warnings.filter(w => w.code !== 'action-format'), []);
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

test('v6: 소품이 있는 정상 문서는 오류·경고 없음, v5 도 경고 없음', () => {
  const s = docExample();
  assert.equal(s.version, 7);
  assert.ok(s.props.length && s.preShowProps.length);
  assert.deepEqual(validateShow(s).warnings, []);
  const v5 = plain(s); v5.version = 5; delete v5.props; delete v5.preShowProps;
  v5.parts[0].scenes[0].items[1].cues[1].stage = { text: '탑햇테이블에 탑햇 세팅' };
  const r = validateShow(v5);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  // 실데이터(v5, 배포 서버에 있는 파일)
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
  const rr = validateShow(unwrapShow(real));
  assert.equal(unwrapShow(real).version, 5);
  assert.deepEqual(rr.errors, []);
  assert.deepEqual(rr.warnings, []);
});

test('v6: 소품 검사 — 모르는 propId 경고, 잘못된 action 오류, 빈 stage 큐 경고, 레지스트리 id 중복 오류', () => {
  const s = docExample();
  const st = s.parts[0].scenes[0].items[1].cues[1].stage;
  const P = 'parts[0].scenes[0].items[1].cues[1].stage';
  st.props.push({ propId: 'pr-ghost', action: 'in', at: '' }, { propId: 'pr-tophat', action: 'enter', at: '' });
  s.preShowProps.push({ propId: 'pr-ghost', at: '' });
  s.props.push({ id: 'pr-tophat', name: '중복' });
  let v = validateShow(s);
  assert.deepEqual(paths(v.errors).sort(), ['props[2].id', `${P}.props[2].action`].sort());
  assert.deepEqual(paths(v.warnings).sort(), [`${P}.props[1].propId`, 'preShowProps[1].propId'].sort());
  assert.match(v.warnings.find(w => w.path === 'preShowProps[1].propId').msg, /"pr-ghost" 가 props 에 없습니다/);

  const e = docExample();
  e.parts[0].scenes[0].items[1].cues[1].stage = { text: ' ', props: [] };
  v = validateShow(e);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(paths(v.warnings), ['parts[0].scenes[0].items[1].cues[1].stage']);
  e.parts[0].scenes[0].items[1].cues[1].stage = { text: '', props: [{ propId: 'pr-tophat', action: 'out', at: '' }] }; // props 만 있어도 유효
  assert.deepEqual(validateShow(e).warnings, []);
  e.parts[0].scenes[0].items[1].cues[1].stage.props[0].propId = 3;
  assert.deepEqual(paths(validateShow(e).errors), ['parts[0].scenes[0].items[1].cues[1].stage.props[0].propId']);
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
