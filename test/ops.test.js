// lib/ops.js — edit_show 의 op 적용 (순수 함수)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { applyOps, OpError } = require('../lib/ops');
const { validateShow } = require('../lib/validate');
const { assignLabels } = require('../lib/labels');

const backstage = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
// 문서 예시는 label 이 null — 사이트에 한 번 올라간 상태처럼 번호(1, 2)를 매겨 둔다
const docExample = () => { const s = JSON.parse(/```json\n([\s\S]*?)```/.exec(fs.readFileSync(path.join(__dirname, '..', 'docs', 'cue-format.md'), 'utf8'))[1]); assignLabels(s); return s; };
const items = s => s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items));
const find = (s, id) => {
  for (const p of s.parts) for (const sc of p.scenes) {
    if (sc.id === id) return sc;
    for (const it of sc.items) { if (it.id === id) return it; for (const c of it.cues) if (c.id === id) return c; }
  }
  return null;
};
// OpError 를 기대하고 code·메시지를 확인
function rejects(fn, code, re) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof OpError, 'OpError 여야 합니다: ' + e.stack);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail('OpError 가 나야 합니다');
}

test('set: 준 필드만 바꾸고 입력은 그대로, 결과는 검증 통과', () => {
  const s = docExample(), before = JSON.stringify(s);
  const r = applyOps(s, [
    { op: 'set', id: 'i-2', fields: { text: '소개합니다, 박대훈!' } },
    { op: 'set', kind: 'show', fields: { title: '1부 (2차)' } },
    { op: 'set', id: 's-2', fields: { durationSec: '240', cast: ['p-daehoon', 'p-yejun', 'p-daehoon'] } }
  ]);
  assert.equal(JSON.stringify(s), before, '입력 show 는 바뀌지 않는다');
  assert.equal(find(r.show, 'i-2').text, '소개합니다, 박대훈!');
  assert.equal(find(r.show, 'i-2').speaker, 'p-yejun');
  assert.equal(r.show.title, '1부 (2차)');
  assert.equal(find(r.show, 's-2').durationSec, 240, '숫자 문자열은 숫자로');
  assert.deepEqual(find(r.show, 's-2').cast, ['p-daehoon', 'p-yejun'], '중복 제거');
  assert.deepEqual(validateShow(r.show).errors, []);
  assert.deepEqual(r.labels, []);
});

test('set: cue 부서 객체는 얕게 합치고, dept 를 바꾸면 이전 내용은 버린다', () => {
  const s = docExample();
  let r = applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { level: 120, action: 'volume' }, memo: '천천히' } }]);
  assert.deepEqual(find(r.show, 'q-2').sound, { track: 1, action: 'volume', timeSec: 3, level: 100 }, 'track·timeSec 유지, level 은 0–100 으로');
  assert.equal(find(r.show, 'q-2').memo, '천천히');
  r = applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { channels: [{ ch: 'front', action: 'fadeIn', dim: 80, color: '파랑' }] } } }]);
  const l = find(r.show, 'q-1').light;
  assert.equal(l.channels.length, 1, 'channels 는 통째로 바뀐다');
  assert.deepEqual(l.channels[0], { ch: 'front', action: 'fadeIn', dim: 80, color: null, colorName: '파랑', timeSec: null });
  assert.ok(r.warnings.some(w => /colorName/.test(w.msg)));
  r = applyOps(s, [{ op: 'set', id: 'q-4', fields: { dept: 'cast', cast: { personId: 'p-yejun', move: 'out' } } }]);
  const c = find(r.show, 'q-4');
  assert.equal(c.dept, 'cast'); assert.equal(c.stage, undefined);
  assert.deepEqual(c.cast, { personId: 'p-yejun', move: 'out', text: '' });
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { sound: { track: 1 } } }]), 'bad_field', /stage cue.*dept:"sound"/);
});

test('set: 모르는 필드·id·label·잘못된 값은 거부하고 이유를 말한다', () => {
  const s = docExample();
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-1', fields: { color: 'red' } }]), 'bad_field', /unknown field "color" for item\. Allowed: kind, speaker, text/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-1', fields: { id: 'zz' } }]), 'bad_field', /ids cannot be changed/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-1', fields: { label: '9' } }]), 'bad_field', /assigned automatically/);
  rejects(() => applyOps(s, [{ op: 'set', id: 's-1', fields: { items: [] } }]), 'bad_field', /child list/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-2', fields: { speaker: '조예준' } }]), 'bad_field', /is a name, use id "p-yejun"/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-2', fields: { kind: 'dialog' } }]), 'bad_field', /one of line\|action/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-2', fields: { offsetSec: '7초' } }]), 'bad_field', /number or null/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'nope', fields: { text: 'x' } }]), 'not_found', /get_show/);
  rejects(() => applyOps(s, [{ op: 'set', id: 's-1', kind: 'item', fields: { text: 'x' } }]), 'not_found', /is a scene, not a item/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-1', fields: { text: 'x' }, parentId: 's-1' }]), 'bad_op', /unknown key "parentId"/);
  rejects(() => applyOps(s, [{ op: 'rename', id: 'i-1' }]), 'bad_op', /set\|add\|remove\|move/);
  rejects(() => applyOps(s, []), 'bad_op');
});

test('같은 id 가 여러 종류면 kind 로 구분', () => {
  const s = docExample();
  s.parts[0].scenes[0].items[0].comments.push({ id: 's-2', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false });
  rejects(() => applyOps(s, [{ op: 'set', id: 's-2', fields: { title: 'x' } }]), 'ambiguous', /add "kind"/);
  const r = applyOps(s, [{ op: 'set', id: 's-2', kind: 'comment', fields: { resolved: true, resolvedBy: '연출' } }]);
  const c = r.show.parts[0].scenes[0].items[0].comments[0];
  assert.equal(c.resolved, true); assert.equal(c.resolvedBy, '연출'); assert.ok(!isNaN(Date.parse(c.resolvedAt)));
  const r2 = applyOps(r.show, [{ op: 'set', id: 's-2', kind: 'comment', fields: { resolved: false } }]);
  const c2 = r2.show.parts[0].scenes[0].items[0].comments[0];
  assert.equal(c2.resolvedBy, null); assert.equal(c2.resolvedAt, null);
});

test('add: 브라우저와 같은 id 접두어·기본값, 자식 포함, 위치(after/first/끝), 새 큐 문단에 번호', () => {
  const s = docExample();
  const r = applyOps(s, [
    { op: 'add', kind: 'item', parent: 's-1', after: 'i-1', data: { text: '(탑햇 세팅)', cues: [{ dept: 'stage', stage: { text: '탑햇테이블에 탑햇' } }] } },
    { op: 'add', kind: 'item', parent: 's-1', after: 'first', data: { kind: 'action', text: '하우스 오픈', cues: [{ dept: 'sound', sound: { track: 1, action: 'play' } }] } },
    { op: 'add', kind: 'cue', parent: 'i-2', data: { dept: 'light', trigger: '멘트 후', light: { channels: [{ ch: 'top' }] } } },
    { op: 'add', kind: 'person', data: { name: '라태형', role: 'performer' } },
    { op: 'add', kind: 'track', data: { title: '오프닝' } },
    { op: 'add', kind: 'scene', parent: 'pt-1', data: { type: 'act', title: '링앤로프', items: [{ text: '(링 세팅)' }, { kind: 'line', speaker: 'p-yejun', text: '박수!', cues: [{ dept: 'cast', cast: { personId: 'p-daehoon', move: 'out' } }] }] } },
    { op: 'add', kind: 'comment', parent: 'i-1', data: { author: '조명', text: '페이드 시간 확인' } }
  ]);
  const sc = r.show.parts[0].scenes[0];
  assert.deepEqual(sc.items.map(i => i.text), ['(하우스 오픈)', '(암전)', '(탑햇 세팅)', '소개합니다 박대훈'], 'first/after 위치, action 은 괄호');
  const [opened, , mid] = sc.items;
  assert.match(opened.id, /^i-[a-z0-9]+$/); assert.match(opened.cues[0].id, /^q-/);
  assert.deepEqual(Object.keys(mid), ['id', 'kind', 'speaker', 'text', 'label', 'isCue', 'cues', 'comments']);
  assert.equal(mid.kind, 'action', '"(" 로 시작하면 action');
  assert.equal(mid.isCue, true);
  assert.deepEqual(mid.cues[0], { id: mid.cues[0].id, dept: 'stage', trigger: '', offsetSec: null, memo: '', status: 'set', stage: { text: '탑햇테이블에 탑햇' } });
  // 번호: 맨 앞 → 0.1, 1 과 2 사이 → 1.1, 기존 1·2 그대로, 새 씬 끝 → 3
  assert.deepEqual(items(r.show).map(i => i.label), ['0.1', '1', '1.1', '2', null, '3', null].slice(0, items(r.show).length));
  assert.deepEqual(r.labels.map(l => l.label).sort(), ['0.1', '1.1', '3']);
  assert.equal(sc.items[3].cues[2].light.channels[0].action, 'on', '채널 기본값');
  const p = r.show.people[2];
  assert.match(p.id, /^p-/); assert.deepEqual([p.name, p.role, p.note], ['라태형', 'performer', '']);
  const t = r.show.tracks[1];
  assert.match(t.id, /^tr-/); assert.equal(t.no, 2, '다음 번호'); assert.equal(t.fileKey, null); assert.equal(t.loop, false);
  const ns = r.show.parts[0].scenes[2];
  assert.match(ns.id, /^s-/); assert.equal(ns.items.length, 2); assert.equal(ns.items[1].cues[0].cast.personId, 'p-daehoon');
  const cm = sc.items[1].comments[0];
  assert.match(cm.id, /^c-/); assert.equal(cm.author, '조명'); assert.equal(cm.resolved, false); assert.ok(!isNaN(Date.parse(cm.createdAt)));
  assert.deepEqual(validateShow(r.show).errors, []);
  // 바뀐 내용 요약
  assert.ok(r.changes.some(c => c.op === 'label' && c.label === '0.1'));
  assert.ok(r.changes.some(c => c.op === 'add' && c.kind === 'scene' && /2 items, 1 cues/.test(c.text)));
});

test('add: 같은 호출 안에서 data.id 로 만든 항목을 이어서 가리킬 수 있다', () => {
  const r = applyOps(docExample(), [
    { op: 'add', kind: 'item', parent: 's-2', data: { id: 'i-new', text: '(카드 세팅)' } },
    { op: 'add', kind: 'cue', parent: 'i-new', data: { dept: 'stage', stage: { text: '카드' } } }
  ]);
  assert.equal(find(r.show, 'i-new').label, '3');
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'item', parent: 's-2', data: { id: 'i-1' } }]), 'bad_field', /already used/);
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'cue', parent: 'i-1', data: { trigger: 'x' } }]), 'bad_field', /needs "dept"/);
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'item', data: { text: 'x' } }]), 'bad_op', /"parent" is required/);
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'item', parent: 'pt-1', data: {} }]), 'not_found', /is a part, not a scene/);
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'item', parent: 's-1', after: 'i-zz', data: {} }]), 'not_found', /after "i-zz"/);
  // after 가 형제면 parent 생략 가능
  const r2 = applyOps(docExample(), [{ op: 'add', kind: 'item', after: 'i-1', data: { kind: 'line', speaker: 'p-yejun', text: '자!' } }]);
  assert.deepEqual(r2.show.parts[0].scenes[0].items.map(i => i.text), ['(암전)', '자!', '소개합니다 박대훈']);
});

test('원자성: 뒤 op 가 실패하면 앞 op 도 반영되지 않는다 (검증 오류 포함)', () => {
  const s = docExample(), before = JSON.stringify(s);
  rejects(() => applyOps(s, [
    { op: 'set', id: 'i-1', fields: { text: '(바뀜)' } },
    { op: 'remove', id: 'q-1' },
    { op: 'set', id: 'nope', fields: {} }
  ]), 'not_found', /^ops\[2\]/);
  assert.equal(JSON.stringify(s), before);
  // 트랙 번호를 겹치게 → 거부
  rejects(() => applyOps(s, [{ op: 'add', kind: 'track', data: { no: 2 } }, { op: 'set', id: 'tr-1', fields: { no: 2 } }]), 'bad_field', /already used/);
  // 검증 단계 오류 (op 단계에서 못 잡는 것): 음수 길이
  rejects(() => applyOps(s, [{ op: 'set', id: 's-2', fields: { durationSec: -5 } }]), 'invalid', /nothing was changed[\s\S]*durationSec: 0 이상/);
});

test('트랙 no 를 바꾸면 그 트랙을 쓰는 음향 큐도 함께 바뀌고 트랙은 번호순', () => {
  const s = backstage();
  const sound = items(s).flatMap(i => i.cues).filter(c => c.dept === 'sound');
  const tr = s.tracks.find(t => sound.some(c => c.sound.track === t.no)); // 음향 큐가 쓰는 트랙 하나 (픽스처에서 고름)
  const uses = sound.filter(c => c.sound.track === tr.no).length;
  const to = Math.max(...s.tracks.map(t => t.no)) + 30;
  const r = applyOps(s, [{ op: 'set', id: tr.id, fields: { no: to } }]);
  const all = items(r.show).flatMap(i => i.cues).filter(c => c.dept === 'sound');
  assert.equal(all.filter(c => c.sound.track === to).length, uses);
  assert.equal(all.filter(c => c.sound.track === tr.no).length, 0);
  assert.deepEqual(r.show.tracks.map(t => t.no), s.tracks.map(t => t.no).filter(n => n !== tr.no).sort((a, b) => a - b).concat(to));
  assert.ok(r.changes.some(c => new RegExp(`BGM ${tr.no} → ${to}, ${uses} sound cue`).test(c.text)));
  assert.deepEqual(r.warnings, []);
});

test('remove: 참조 중인 사람·트랙은 거부(목록 포함), force 면 브라우저처럼', () => {
  const s = docExample();
  const e = rejects(() => applyOps(s, [{ op: 'remove', id: 'p-yejun' }]), 'referenced', /still used in 2 place\(s\).*cast of scene s-1.*speaker of item i-2.*force:true/);
  assert.equal(e.references.length, 2);
  rejects(() => applyOps(s, [{ op: 'remove', id: 'tr-1' }]), 'referenced', /BGM 1 is used by 1 sound cue\(s\): q-2/);
  const r = applyOps(s, [{ op: 'remove', id: 'p-yejun', force: true }]);
  assert.equal(r.show.people.length, 1);
  assert.deepEqual(find(r.show, 's-1').cast, [], '씬 출연자에서는 빠진다');
  assert.equal(find(r.show, 'i-2').speaker, 'p-yejun', '대사 화자는 그대로 (삭제된 사람)');
  assert.ok(r.warnings.some(w => /1 speaker\/cast-cue reference\(s\) to removed person p-yejun/.test(w.msg)));
  const r2 = applyOps(s, [{ op: 'remove', id: 'tr-1', force: true }]);
  assert.deepEqual(r2.show.tracks, []);
  assert.ok(r2.warnings.some(w => /no 1 인 트랙이 없습니다/.test(w.msg)), '끊긴 트랙 번호는 경고');
  // 안 쓰이는 사람은 그냥 지워진다
  const r3 = applyOps(s, [{ op: 'remove', id: 'q-3' }, { op: 'set', id: 's-2', fields: { cast: [] } }, { op: 'remove', id: 'p-daehoon', kind: 'person' }]);
  assert.equal(r3.show.people.length, 1);
  assert.equal(find(r3.show, 'i-2').cues.length, 1);
});

test('remove: 문단·큐·씬 — 큐를 다 지워도 번호는 남고 isCue 는 false', () => {
  const r = applyOps(docExample(), [{ op: 'remove', id: 'q-1' }, { op: 'remove', id: 'q-2', kind: 'cue' }, { op: 'remove', id: 's-2' }]);
  const it = find(r.show, 'i-1');
  assert.deepEqual([it.cues.length, it.isCue, it.label], [0, false, '1']);
  assert.equal(r.show.parts[0].scenes.length, 1);
});

test('move: 순서 바꾸기, 다른 부모로, 큐를 다른 문단으로', () => {
  const s = backstage();
  const sc = s.parts[0].scenes;
  let r = applyOps(s, [{ op: 'move', id: sc[0].id, after: sc[2].id }]);
  assert.deepEqual(r.show.parts[0].scenes.slice(0, 3).map(x => x.id), [sc[1].id, sc[2].id, sc[0].id]);
  r = applyOps(s, [{ op: 'move', id: sc[3].id, after: 'first' }]);
  assert.equal(r.show.parts[0].scenes[0].id, sc[3].id);
  r = applyOps(s, [{ op: 'move', id: sc[0].id }]);
  assert.equal(r.show.parts[0].scenes.at(-1).id, sc[0].id, 'after 없으면 맨 뒤');
  // 문단을 다른 씬 맨 앞으로 (번호는 고정)
  const it = sc[1].items[0];
  r = applyOps(s, [{ op: 'move', id: it.id, parent: sc[2].id, after: 'first' }]);
  assert.equal(r.show.parts[0].scenes[2].items[0].id, it.id);
  assert.equal(r.show.parts[0].scenes[2].items[0].label, it.label);
  // 큐를 큐 없는 문단으로 → 그 문단에 사이 번호, 원래 문단은 isCue false
  const src = items(s).find(i => i.cues.length === 1);
  const plainItem = items(s).find(i => !i.cues.length && i.label == null);
  r = applyOps(s, [{ op: 'move', id: src.cues[0].id, parent: plainItem.id }]);
  const moved = find(r.show, plainItem.id);
  assert.equal(moved.cues.length, 1); assert.equal(moved.isCue, true); assert.match(moved.label, /^\d+\.1$/);
  assert.equal(find(r.show, src.id).isCue, false);
  assert.deepEqual(validateShow(r.show).errors, []);
  rejects(() => applyOps(s, [{ op: 'move', id: it.id, parent: s.parts[0].id }]), 'not_found', /is a part, not a scene/);
  rejects(() => applyOps(s, [{ op: 'move', id: 'tr-1', after: 'first' }]), 'bad_op', /ordered by "no"/);
});

test('이미 있던 오류는 막지 않는다 (사이트에서 사람을 지워 남은 참조)', () => {
  const s = docExample();
  s.people = s.people.filter(p => p.id !== 'p-daehoon'); // q-3 cast.personId, s-2 cast 가 끊김
  assert.ok(validateShow(s).errors.length >= 2);
  const r = applyOps(s, [{ op: 'set', id: 'i-1', fields: { text: '(암전 — 천천히)' } }]);
  assert.equal(r.preexistingErrors, validateShow(s).errors.length);
  // 같은 종류의 오류를 새로 만들면 막힌다
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { personId: 'p-ghost' } } }]), 'bad_field', /known: p-yejun=조예준/);
});

test('큰 공연(backstage-part1) 전체에 여러 op — 결과 검증 통과, 경고 없음', () => {
  const s = backstage();
  // 픽스처에서 고른다: 번호 붙은 큐 문단(뒤에도 번호 붙은 문단이 있는 것) 하나와, 화자 있는 대사 하나
  const all = s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items.map(it => ({ sc, it }))));
  const labeled = all.filter(x => x.it.label != null && x.it.cues.length);
  const at = labeled[0];
  const line = all.find(x => x.it.kind === 'line' && x.it.speaker);
  const r = applyOps(s, [
    { op: 'add', kind: 'item', parent: at.sc.id, after: at.it.id, data: { text: '(테이블 세팅)', cues: [{ dept: 'stage', stage: { text: '테이블' } }] } },
    { op: 'set', id: line.it.id, fields: { text: line.it.text + '!' } },
    { op: 'add', kind: 'comment', parent: at.sc.id, data: { author: '연출', text: '전환 시간 확인' } }
  ]);
  assert.deepEqual(validateShow(r.show).errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.labels.length, 1);
  assert.match(r.labels[0].label, new RegExp(`^${String(at.it.label).split('.')[0]}\\.\\d+$`));
});

test('표기 규칙(docs/cue-format.md): 괄호 지문 (…) 을 어기는 수정은 저장하되 action-format 경고로 알린다', () => {
  const s = docExample();
  // "(암전)" 뒤에 글자를 붙이면 ")" 로 끝나지 않는다 — 편집기처럼 괄호를 덧씌우지 않고(이미 "(" 로 시작) 경고만
  let r = applyOps(s, [{ op: 'set', id: 'i-1', fields: { text: '(암전) 천천히' } }]);
  assert.equal(find(r.show, 'i-1').text, '(암전) 천천히');
  assert.ok(r.warnings.some(w => w.code === 'action-format'), JSON.stringify(r.warnings));
  // "(" 없이 쓴 지문은 편집기(isActHead)와 같이 괄호를 씌워 규칙에 맞춘다
  r = applyOps(s, [{ op: 'add', kind: 'item', parent: 's-1', data: { kind: 'action', text: '탑햇 세팅' } }]);
  assert.equal(r.show.parts[0].scenes[0].items.at(-1).text, '(탑햇 세팅)');
  assert.ok(!r.warnings.some(w => w.code === 'action-format'));
  // 여러 줄 지문(Shift+Enter): 첫 줄로 판단 — 첫 줄이 비고 둘째 줄이 "(" 면 지문 머리가 아니다
  r = applyOps(s, [{ op: 'add', kind: 'item', parent: 's-1', data: { kind: 'action', text: '(조명 전환\n— 천천히)' } }]);
  assert.equal(r.show.parts[0].scenes[0].items.at(-1).text, '(조명 전환\n— 천천히)');
  r = applyOps(s, [{ op: 'add', kind: 'item', parent: 's-1', data: { text: '\n(둘째 줄)' } }]);
  assert.equal(r.show.parts[0].scenes[0].items.at(-1).kind, 'line', '첫 줄이 지문 머리가 아니면 대사');
});

test('사이트가 불러와도(index.html migrate) op 결과가 그대로다', () => {
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  const { migrate } = vm.runInNewContext(html.slice(a, b) + '\n;({ migrate })', {});
  const s = backstage();
  const sc = s.parts[0].scenes;
  const r = applyOps(s, [
    { op: 'add', kind: 'scene', parent: s.parts[0].id, after: sc[2].id, data: { type: 'mc', cast: ['p-yejun'], items: [{ kind: 'line', speaker: 'p-yejun', text: '다음 순서!', cues: [{ dept: 'light', light: { channels: [{ ch: 'front', action: 'fadeIn', dim: 70, timeSec: 2 }] } }, { dept: 'sound', sound: { track: 2, action: 'volume' } }] }], comments: [{ author: '연출', text: '멘트 길이 확인' }] } },
    { op: 'add', kind: 'person', data: { name: '스태프', role: 'stage' } },
    { op: 'add', kind: 'track', data: { title: '엔딩', loop: true } },
    { op: 'set', id: sc[3].id, fields: { setup: '테이블 두 개' } },
    { op: 'move', id: sc[1].items[0].id, after: 'first' }
  ]);
  const m = JSON.parse(JSON.stringify(migrate(r.show)));
  const strip = x => { x = JSON.parse(JSON.stringify(x)); delete x.updatedAt; return x; };
  assert.deepEqual(strip(m), strip(r.show));
});

test('상속된 이름(constructor·toString·__proto__ …)은 필드·op 로 통과하지 않고 bad_field/bad_op', () => {
  const s = docExample(), before = JSON.stringify(s);
  for (const k of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    const f = JSON.parse(`{"${k}": "x"}`); // JSON.parse 는 __proto__ 도 자기 속성으로 만든다 (네트워크로 오는 인자와 같다)
    rejects(() => applyOps(s, [{ op: 'set', id: 'i-1', fields: f }]), 'bad_field', new RegExp(`unknown field "${k}" for item`));
    rejects(() => applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: f } }]), 'bad_field', new RegExp(`unknown field "sound\\.${k}"`));
    rejects(() => applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { channels: [f] } } }]), 'bad_field', /unknown field "light\.channels\[0\]/);
    rejects(() => applyOps(s, [{ op: 'add', kind: 'person', data: JSON.parse(`{"name": "A", "${k}": "x"}`) }]), 'bad_field', new RegExp(`unknown field "${k}" for person`));
    rejects(() => applyOps(s, [{ op: k, id: 'i-1' }]), 'bad_op', /one of set\|add\|remove\|move/);
  }
  assert.equal(JSON.stringify(s), before);
  assert.equal(({}).polluted, undefined);
});

test('트랙 번호(track.no, sound.track)는 1 이상의 정수', () => {
  const s = docExample();
  for (const no of [0, -1, 1.5, '2.5', 'x']) {
    rejects(() => applyOps(s, [{ op: 'set', id: 'tr-1', fields: { no } }]), 'bad_field', /whole number ≥ 1/);
    rejects(() => applyOps(s, [{ op: 'add', kind: 'track', data: { no } }]), 'bad_field', /whole number ≥ 1/);
    rejects(() => applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { track: no } } }]), 'bad_field', /sound\.track" must be a whole number ≥ 1/);
  }
  rejects(() => applyOps(s, [{ op: 'set', id: 'tr-1', fields: { no: null } }]), 'bad_field', /whole number ≥ 1/);
  assert.equal(find(applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { track: null } } }]).show, 'q-2').sound.track, null, '음향 큐는 트랙 미정(null) 가능');
  assert.equal(applyOps(s, [{ op: 'set', id: 'tr-1', fields: { no: '3' } }]).show.tracks[0].no, 3);
});

test('지문 판정(isActHead)이 index.html 과 같다', () => {
  const vm = require('vm');
  const { isActHead } = require('../lib/ops');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const re = html.match(/^const ACT_RE = .*$/m), fn = html.match(/^function isActHead\(raw\) \{.*\}$/m);
  assert.ok(re && fn, 'index.html 에서 ACT_RE / isActHead 한 줄 정의를 찾지 못했습니다 (모양이 바뀌었으면 이 테스트를 고치세요)');
  const fe = vm.runInNewContext(`${re[0]}\n${fn[0]}\n;isActHead`, {});
  for (const t of ['(암전)', '* 조예준 인', '— 암전', '-- x', '（전각）', '대사', '', '  (공백 뒤)', '(첫 줄\n둘째)', '\n(둘째 줄)', '대사\n(괄호)', null]) {
    assert.equal(isActHead(t), fe(t), JSON.stringify(t));
  }
});
