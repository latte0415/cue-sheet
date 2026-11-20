// lib/ops.js — edit_show 의 op 적용 (순수 함수)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { applyOps, OpError } = require('../lib/ops');
const { validateShow } = require('../lib/validate');
const { fillLabels } = require('../lib/labels');

// 실공연 v5 원본의 고정 사본(test/fixtures) — v5→v8 업그레이드와 원본 id 를 직접 쓰는 테스트가 있다. cues/ 의 현재 데이터는 정리되며 바뀐다
const backstage = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backstage-part1-v5.json'), 'utf8'));
// v11 문서 예시의 고정 사본(test/fixtures/doc-example-v11.json — 문단에 붙은 큐). label 이 null — 사이트에 한 번 올라간 상태처럼 번호(1, 2)를 매겨 둔다.
// op 를 적용하면 v12 로 올라가 i-1 → i-1 + i-1-q(q-1) + i-1-q2(q-2, 암전 후 +7), i-2 → i-2 + i-2-q(q-3 · q-5, 대사 끝) + i-2-q2(q-4, 대사 끝)
const docExample = () => { const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'doc-example-v11.json'), 'utf8')); fillLabels(s); return s; };
const addedCue = r => { const c = r.changes.filter(x => x.op === 'add' && x.kind === 'cue').at(-1); return c && find(r.show, c.id); };
const inOrderOf = sh => { const q = items(sh).filter(i => i.cues.length); return q.every((i, k) => i.label === String(k + 1)) && items(sh).filter(i => !i.cues.length).every(i => i.label == null); };
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
  let r = applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { level: 120, action: 'volume' }, note: '천천히' } }]);
  assert.deepEqual(find(r.show, 'q-2').sound, { track: 1, action: 'volume', timeSec: 3, level: 100 }, 'track·timeSec 유지, level 은 0–100 으로');
  assert.equal(find(r.show, 'q-2').note, '천천히');
  r = applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { channels: [{ ch: 'front', action: 'fadeIn', dim: 80, color: '파랑' }] } } }]);
  const l = find(r.show, 'q-1').light;
  assert.equal(l.channels.length, 1, 'channels 는 통째로 바뀐다');
  assert.deepEqual(l.channels[0], { ch: 'front', action: 'fadeIn', dim: 80, color: null, colorName: '파랑', timeSec: null });
  assert.ok(r.warnings.some(w => /colorName/.test(w.msg)));
  r = applyOps(s, [{ op: 'set', id: 'q-4', fields: { dept: 'cast', cast: { personId: 'p-yejun', move: 'out' } } }]);
  const c = find(r.show, 'q-4');
  assert.equal(c.dept, 'cast'); assert.equal(c.stage, undefined);
  assert.deepEqual(c.cast, { people: [{ personId: 'p-yejun', move: 'out' }] }, '옛 한 사람 입력은 v10 사람 줄 하나로');
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { sound: { track: 1 } } }]), 'bad_field', /stage cue.*dept:"sound"/);
});

test('음향 level: play 시작 볼륨·fadeIn 도착 볼륨은 남고, stop·fadeOut 은 경고와 함께 지운다', () => {
  const s = docExample();
  let r = applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { action: 'play', level: 50 } } }]);
  assert.deepEqual(find(r.show, 'q-2').sound, { track: 1, action: 'play', timeSec: 3, level: 50 }, 'play 의 level 은 시작 볼륨으로 남는다');
  assert.ok(!r.warnings.some(w => /sound\.level/.test(w.msg)), JSON.stringify(r.warnings));
  assert.deepEqual(validateShow(r.show).warnings, []);
  r = applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { action: 'play', level: 49.6 } } }]);
  assert.equal(find(r.show, 'q-2').sound.level, 50, '정수로');
  r = applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { action: 'play', level: null } } }]);
  assert.equal(find(r.show, 'q-2').sound.level, null, 'play 는 비워 두면 기본 볼륨 — volume 처럼 100 을 채우지 않는다');
  r = applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { action: 'fadeIn', level: 70 } } }]);
  assert.equal(find(r.show, 'q-2').sound.level, 70);
  for (const action of ['stop', 'fadeOut']) {
    r = applyOps(s, [{ op: 'set', id: 'q-2', fields: { sound: { action, level: 50 } } }]);
    assert.equal(find(r.show, 'q-2').sound.level, null, action);
    assert.ok(r.warnings.some(w => /sound\.level is only kept for play\/fadeIn\/volume/.test(w.msg)), action);
  }
  // v8 공연에 op 를 적용하면 v9 로 — 모양은 그대로, version 만
  const v8 = docExample(); v8.version = 8;
  r = applyOps(v8, [{ op: 'set', id: 'q-2', fields: { sound: { action: 'play', level: 50 } } }]);
  assert.equal(r.show.version, 13);
  assert.equal(find(r.show, 'q-2').sound.level, 50);
  // 새 큐로 만들어도 같다
  r = applyOps(s, [{ op: 'add', kind: 'cue', parent: 'i-1', data: { dept: 'sound', sound: { track: 1, action: 'play', level: 50 } } }]);
  assert.equal(addedCue(r).sound.level, 50);
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

test('코멘트 snapshot(사이트가 남기는 코멘트 당시 문단)은 op 를 거쳐도 그대로, op 로 새로 쓰지는 못한다', () => {
  const s = docExample();
  const it = s.parts[0].scenes[0].items[0];
  const snapshot = { kind: it.kind, speaker: it.speaker, text: it.text + ' (옛)', cues: JSON.parse(JSON.stringify(it.cues)) };
  it.comments.push({ id: 'c-snap', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null, snapshot });
  const r = applyOps(s, [
    { op: 'set', id: 'c-snap', fields: { text: '확인 (수정)', resolved: true } },
    { op: 'set', id: it.id, fields: { text: '바뀐 문장' } }
  ]);
  const c = r.show.parts[0].scenes[0].items[0].comments[0];
  assert.equal(c.text, '확인 (수정)');
  assert.deepEqual(c.snapshot, Object.assign({}, snapshot, { cues: [] }), 'v12: 글 문단의 snapshot 에는 큐가 없다(옛 큐는 버린다) — 나머지는 그대로');
  assert.deepEqual(validateShow(r.show).errors, []);
  rejects(() => applyOps(s, [{ op: 'set', id: 'c-snap', fields: { snapshot: null } }]), 'bad_field', /unknown field "snapshot"/);
});

test('add: 브라우저와 같은 id 접두어·기본값, 자식 포함, 위치(after/first/끝), 새 큐 문단에 번호', () => {
  const s = docExample();
  const r = applyOps(s, [
    { op: 'add', kind: 'item', parent: 's-1', after: 'i-1', data: { text: '(탑햇 세팅)', cues: [{ dept: 'stage', note: '탑햇테이블에', stage: { props: [{ propId: 'pr-tophat' }] } }] } },
    { op: 'add', kind: 'item', parent: 's-1', after: 'first', data: { kind: 'action', text: '하우스 오픈', cues: [{ dept: 'sound', sound: { track: 1, action: 'play' } }] } },
    { op: 'add', kind: 'cue', parent: 'i-2', data: { dept: 'light', trigger: '멘트 후', light: { channels: [{ ch: 'top' }] } } },
    { op: 'add', kind: 'person', data: { name: '라태형', role: 'performer' } },
    { op: 'add', kind: 'track', data: { title: '오프닝' } },
    { op: 'add', kind: 'scene', parent: 'pt-1', data: { type: 'act', title: '링앤로프', items: [{ text: '(링 세팅)' }, { kind: 'line', speaker: 'p-yejun', text: '박수!', cues: [{ dept: 'cast', cast: { personId: 'p-daehoon', move: 'out' } }] }] } },
    { op: 'add', kind: 'comment', parent: 'i-1', data: { author: '조명', text: '페이드 시간 확인' } }
  ]);
  const sc = r.show.parts[0].scenes[0], texts = sc.items.filter(i => i.kind !== 'cue');
  assert.deepEqual(texts.map(i => i.text), ['(하우스 오픈)', '(공연 시작)', '(탑햇 세팅)', '소개합니다 박대훈'], 'first/after 위치, action 은 괄호');
  const [opened, , mid] = texts;
  // 옛 방식(cues 를 가진 대사·지문)은 그 문단 바로 뒤의 큐 문단으로 — 트리거 = 그 문단 끝 (트리거 글이 비었으니)
  const openedQ = sc.items[sc.items.indexOf(opened) + 1], midQ = sc.items[sc.items.indexOf(mid) + 1];
  assert.match(opened.id, /^i-[a-z0-9]+$/); assert.match(openedQ.cues[0].id, /^q-/); assert.match(openedQ.id, /^i-/);
  assert.deepEqual(Object.keys(mid), ['id', 'kind', 'speaker', 'text', 'label', 'isCue', 'cues', 'comments']);
  assert.equal(mid.kind, 'action', '"(" 로 시작하면 action');
  assert.deepEqual([mid.isCue, mid.cues, mid.label], [false, [], null]);
  assert.deepEqual(Object.keys(midQ), ['id', 'kind', 'speaker', 'text', 'label', 'isCue', 'trigger', 'offsetSec', 'cues', 'comments']);
  assert.deepEqual(midQ.trigger, { type: 'line', itemId: mid.id, at: 'end' });
  assert.deepEqual(midQ.cues[0], { id: midQ.cues[0].id, dept: 'stage', note: '탑햇테이블에', status: 'set', stage: { props: [{ propId: 'pr-tophat', action: 'in', at: '' }] } }); // saveCue 와 같은 v12 모양
  assert.ok(r.warnings.some(w => /legacy: cues on paragraph/.test(w.msg)));
  // 번호: 늘 1부터 연속 (큐 문단만)
  assert.ok(inOrderOf(r.show));
  assert.equal(r.labels.filter(l => l.was == null).length, 3, '새 큐 셋에 번호');
  // "멘트 후" 를 대사 i-2 에 → 대사 끝 큐(i-2-q) 와 같은 트리거라 거기에 합친다
  const lc = addedCue(r) && items(r.show).flatMap(i => i.cues).find(c => c.dept === 'light' && c.light.channels[0] && c.light.channels[0].ch === 'top');
  assert.equal(lc.light.channels[0].action, 'on', '채널 기본값');
  assert.deepEqual(lc.light.looks, [], 'v11: 채널만 준 조명 큐도 looks 는 빈 배열');
  assert.ok(find(r.show, 'i-2-q').cues.includes(lc));
  const p = r.show.people[2];
  assert.match(p.id, /^p-/); assert.deepEqual([p.name, p.role, p.note], ['라태형', 'performer', '']);
  const t = r.show.tracks[1];
  assert.match(t.id, /^tr-/); assert.equal(t.no, 2, '다음 번호'); assert.equal(t.fileKey, null); assert.equal(t.loop, false);
  const ns = r.show.parts[0].scenes[2];
  assert.match(ns.id, /^s-/); assert.equal(ns.items.length, 3); assert.deepEqual(ns.items[2].cues[0].cast, { people: [{ personId: 'p-daehoon', move: 'out' }] });
  const cm = find(r.show, 'i-1').comments[0];
  assert.match(cm.id, /^c-/); assert.equal(cm.author, '조명'); assert.equal(cm.resolved, false); assert.ok(!isNaN(Date.parse(cm.createdAt)));
  assert.deepEqual(validateShow(r.show).errors, []);
  // 바뀐 내용 요약
  assert.ok(r.changes.some(c => c.op === 'label' && c.label === '1' && c.was == null));
  assert.ok(r.changes.some(c => c.op === 'label' && c.id === 'i-2-q' && /renumbered Q3 → Q\d/.test(c.text)), JSON.stringify(r.changes.filter(c => c.op === 'label')));
  assert.ok(r.changes.some(c => c.op === 'add' && c.kind === 'scene' && /3 items, 1 cues/.test(c.text)));
});

test('add: 같은 호출 안에서 data.id 로 만든 항목을 이어서 가리킬 수 있다', () => {
  const r = applyOps(docExample(), [
    { op: 'add', kind: 'item', parent: 's-2', data: { id: 'i-new', text: '(카드 세팅)' } },
    { op: 'add', kind: 'cue', parent: 'i-new', data: { dept: 'stage', stage: { props: [{ propId: 'pr-table', action: 'clean' }] } } }
  ]);
  assert.equal(items(r.show).find(i => i.kind === 'cue' && i.trigger.itemId === 'i-new').label, '5', '대사에 단 큐(옛 방식) → 그 대사 끝이 트리거인 새 큐');
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'item', parent: 's-2', data: { id: 'i-1' } }]), 'bad_field', /already used/);
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'cue', parent: 'i-1', data: { trigger: 'x' } }]), 'bad_field', /needs "dept"/);
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'item', data: { text: 'x' } }]), 'bad_op', /"parent" is required/);
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'item', parent: 'pt-1', data: {} }]), 'not_found', /is a part, not a scene/);
  rejects(() => applyOps(docExample(), [{ op: 'add', kind: 'item', parent: 's-1', after: 'i-zz', data: {} }]), 'not_found', /after "i-zz"/);
  // after 가 형제면 parent 생략 가능
  const r2 = applyOps(docExample(), [{ op: 'add', kind: 'item', after: 'i-1', data: { kind: 'line', speaker: 'p-yejun', text: '자!' } }]);
  assert.deepEqual(r2.show.parts[0].scenes[0].items.filter(i => i.kind !== 'cue').map(i => i.text), ['(공연 시작)', '자!', '소개합니다 박대훈']);
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
  assert.deepEqual(find(r3.show, 'i-2-q').cues.map(c => c.id), ['q-5']);
});

test('remove: 문단·큐·씬 — 큐를 다 지우면 isCue false, 번호도 없어지고 뒤 번호가 당겨진다', () => {
  const r = applyOps(docExample(), [{ op: 'remove', id: 'q-1' }, { op: 'remove', id: 'q-2', kind: 'cue' }]);
  const it = find(r.show, 'i-1');
  assert.deepEqual([it.cues.length, it.isCue, it.label], [0, false, null]);
  assert.equal(find(r.show, 'i-1-q'), null, '동작이 0개가 된 큐는 사라진다');
  assert.equal(find(r.show, 'i-2-q').label, '1');
  assert.ok(r.changes.some(c => /removed empty cue item i-1-q2/.test(c.text)));
  const r2 = applyOps(docExample(), [{ op: 'remove', id: 's-2' }]);
  assert.equal(r2.show.parts[0].scenes.length, 1);
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
  const inOrder = sh => items(sh).filter(i => i.cues.length).map(i => i.label).join() === items(sh).filter(i => i.cues.length).map((_, k) => String(k + 1)).join();
  assert.ok(inOrder(r.show), '씬을 옮겨도 번호는 1부터 연속');
  // 문단을 다른 씬 맨 앞으로 — 번호는 새 자리 순서대로
  const it = sc[1].items[0];
  r = applyOps(s, [{ op: 'move', id: it.id, parent: sc[2].id, after: 'first' }]);
  assert.equal(r.show.parts[0].scenes[2].items[0].id, it.id);
  assert.ok(inOrder(r.show));
  // 동작을 다른 큐로 → 비은 큐는 사라지고 번호는 1부터 연속 (소수 없음). 대사(글 문단)로는 옮길 수 없다(v12)
  const up = require('../lib/ops').upgradeShow(JSON.parse(JSON.stringify(s)));
  const qs = items(up).filter(i => i.kind === 'cue');
  const src = qs.find(i => i.cues.length === 1), dst = qs.find(i => i !== src); // v12: 대사·지문에서 옮긴 큐는 모두 대사 끝이라 신호가 없을 수 있다
  r = applyOps(s, [{ op: 'move', id: src.cues[0].id, parent: dst.id }]);
  assert.equal(find(r.show, dst.id).cues.length, dst.cues.length + 1);
  assert.equal(find(r.show, src.id), null);
  assert.ok(inOrder(r.show));
  rejects(() => applyOps(s, [{ op: 'move', id: src.cues[0].id, parent: items(up).find(i => i.kind === 'line').id }]), 'bad_op', /actions live in cue items/);
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
  const s = require('../lib/ops').upgradeShow(backstage()); // v12 로 올린 뒤 고른다 (큐는 큐 문단)
  // 픽스처에서 고른다: 번호 붙은 큐 문단(뒤에도 번호 붙은 문단이 있는 것) 하나와, 화자 있는 대사 하나
  const all = s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items.map(it => ({ sc, it }))));
  const labeled = all.filter(x => x.it.label != null && x.it.cues.length);
  const at = labeled[0];
  const line = all.find(x => x.it.kind === 'line' && x.it.speaker);
  const r = applyOps(s, [
    { op: 'add', kind: 'prop', data: { id: 'pr-table', name: '테이블' } },
    { op: 'add', kind: 'item', parent: at.sc.id, after: at.it.id, data: { id: 'i-clap', text: '(관객이 박수 치는 동안)' } },
    { op: 'add', kind: 'item', after: 'i-clap', data: { kind: 'cue', trigger: { type: 'line', itemId: 'i-clap' }, cues: [{ dept: 'stage', stage: { props: [{ propId: 'pr-table' }] } }] } },
    { op: 'set', id: line.it.id, fields: { text: line.it.text + '!' } },
    { op: 'add', kind: 'comment', parent: at.sc.id, data: { author: '연출', text: '전환 시간 확인' } }
  ]);
  assert.deepEqual(validateShow(r.show).errors, []);
  assert.deepEqual(r.warnings, [], '원래 있던 경고(소품 없는 옛 무대 큐)는 새 경고로 치지 않는다');
  // 사이에 끼운 큐 문단은 다음 번호, 그 뒤 번호는 하나씩 밀린다 (소수 없음)
  const added = r.labels.find(l => l.was == null);
  assert.equal(added.label, String(Number(at.it.label) + 1));
  assert.equal(r.labels.length, labeled.length - labeled.indexOf(at)); // 새 문단 + 그 뒤 번호 붙은 문단 전부
  assert.ok(r.labels.filter(l => l.was != null).every(l => Number(l.label) === Number(l.was) + 1));
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

// ---- show v6: 소품 (props · preShowProps · stage.props)
test('v6: 관계없는 op 를 적용해도 props·preShowProps·stage.props 는 그대로', () => {
  const s = docExample(), before = JSON.stringify(s);
  const r = applyOps(s, [
    { op: 'set', id: 'i-2', fields: { text: '(조대훈 등장 — 천천히)' } },
    { op: 'set', id: 'q-4', fields: { note: '확인' } },
    { op: 'move', id: 'q-4', after: 'first' },
    { op: 'add', kind: 'person', data: { name: '스태프', role: 'stage' } }
  ]);
  assert.equal(JSON.stringify(s), before, '입력은 그대로');
  assert.equal(r.show.version, 13);
  assert.deepEqual(r.show.props, s.props);
  assert.deepEqual(r.show.preShowProps, s.preShowProps);
  assert.deepEqual(find(r.show, 'q-4').stage, { props: [{ propId: 'pr-tophat', action: 'in', at: '테이블 위' }] });
  assert.equal(find(r.show, 'q-4').note, '확인');
  assert.deepEqual(validateShow(r.show).errors, []);
  assert.deepEqual(r.warnings, []);
});

test('v8: v5 공연은 migrate 처럼 v8 로 — 빈 props·preShowProps, 무대 큐 stage.props:[], 무대 글은 note 로', () => {
  const s = backstage();
  assert.equal(s.version, 5);
  const stageBefore = items(s).flatMap(i => i.cues).filter(c => c.dept === 'stage').map(c => c.stage.text);
  const r = applyOps(s, [{ op: 'set', kind: 'show', fields: { revision: 'v6 테스트' } }]);
  assert.equal(r.show.version, 13);
  assert.deepEqual(r.show.props, []);
  assert.deepEqual(r.show.preShowProps, []);
  assert.deepEqual(Object.keys(r.show).slice(Object.keys(r.show).indexOf('people')), ['people', 'props', 'preShowProps', 'lights', 'tracks', 'parts'], 'migrate 와 같은 키 순서');
  const st = items(r.show).flatMap(i => i.cues).filter(c => c.dept === 'stage');
  const bare = n => String(n).split(' / ').filter(x => !x.startsWith('옮기기 전 글: ')).join(' / '); // v12: 대사·지문에서 옮긴 큐의 옛 시점 글은 메모 끝에
  assert.deepEqual(st.map(c => bare(c.note)), stageBefore);
  assert.ok(st.length && st.every(c => Array.isArray(c.stage.props) && !c.stage.props.length && !('text' in c.stage)));
  assert.ok(items(r.show).flatMap(i => i.cues).every(c => !('memo' in c) && typeof c.note === 'string' && Object.keys(c).indexOf('note') === 2), 'memo 없음, note 는 migrate 와 같은 자리 (v12: 부서 큐에 trigger · offsetSec 없음)');
  assert.deepEqual(r.warnings, []);
});

test('v6: set 으로 stage.props 통째 교체 — 빠진 필드는 기본값, 항목 필드 검증', () => {
  const s = docExample();
  let r = applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: [{ propId: 'pr-table', action: 'out' }, { propId: 'pr-tophat', at: '객석 쪽' }] } } }]);
  assert.deepEqual(find(r.show, 'q-4').stage, { props: [{ propId: 'pr-table', action: 'out', at: '' }, { propId: 'pr-tophat', action: 'in', at: '객석 쪽' }] });
  assert.deepEqual(r.warnings, []);
  // v8: 소품 없는 확정 무대 큐로 만드는 op 는 거부 (브라우저 saveCue 와 같다). 미정이면 된다
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { status: 'set', stage: { props: [] } } }]), 'bad_field', /needs at least one stage\.props row/);
  r = applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: [] } } }]);
  assert.deepEqual(r.warnings, [], 'q-4 는 미정');
  rejects(() => applyOps(s, [{ op: 'add', kind: 'cue', parent: 'i-1', data: { dept: 'stage', note: '탑햇 세팅' } }]), 'bad_field', /props are required/);
  // 없어진 필드는 어디로 갔는지 알려 주며 거부
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { text: '탑햇' } } }]), 'bad_field', /"stage\.text" was removed in show v8 — use note/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { text: '천천히' } } }]), 'bad_field', /"cast\.text" was removed/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { memo: 'x' } }]), 'bad_field', /"memo" was merged into "note"/);
  // clean (v8)
  r = applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: [{ propId: 'pr-tophat', action: 'clean' }] } } }]);
  assert.equal(find(r.show, 'q-4').stage.props[0].action, 'clean');
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: [{ propId: 'pr-ghost' }] } } }]), 'bad_field', /stage\.props\[0\]\.propId" must be a prop id from props\[\] \(known: pr-tophat=탑햇, pr-table=탑햇테이블\)/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: [{ propId: '탑햇' }] } } }]), 'bad_field', /"탑햇" is a name, use id "pr-tophat"/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: [{ action: 'in' }] } } }]), 'bad_field', /stage\.props\[0\]\.propId" is required/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: [{ propId: 'pr-table', action: 'enter' }] } } }]), 'bad_field', /action" must be one of in\|out\|move\|clean/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: [{ propId: 'pr-table', name: 'x' }] } } }]), 'bad_field', /unknown field "stage\.props\[0\]\.name"/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-4', fields: { stage: { props: { propId: 'pr-table' } } } }]), 'bad_field', /"stage\.props" must be an array/);
  // 새 무대 큐 기본값은 브라우저 saveCue 와 같다
  r = applyOps(s, [{ op: 'add', kind: 'cue', parent: 'i-1', data: { dept: 'stage', stage: { props: [{ propId: 'pr-table', action: 'move', at: '왼쪽' }] } } }]);
  const q = addedCue(r);
  assert.deepEqual(q.stage, { props: [{ propId: 'pr-table', action: 'move', at: '왼쪽' }] });
  assert.deepEqual(r.warnings.map(w => w.msg.replace(/i-[a-z0-9]+\b/g, 'ID')), ['legacy: cue added to paragraph ID — put in cue item ID (show v12: cues are their own items after the line)'], '대사에 단 큐는 옛 방식 경고만');
  // 부서를 stage 로 바꾸면 기본값 { props:[] } 에서 시작 — 소품을 함께 줘야 한다
  r = applyOps(s, [{ op: 'set', id: 'q-3', fields: { dept: 'stage', stage: { props: [{ propId: 'pr-table' }] } } }]);
  assert.deepEqual(find(r.show, 'q-3').stage, { props: [{ propId: 'pr-table', action: 'in', at: '' }] });
});

test('v6: kind:"prop" add/set/move/remove — 사람과 같은 방식, 같은 호출에서 새 소품을 무대 큐에', () => {
  const s = docExample();
  let r = applyOps(s, [
    { op: 'add', kind: 'prop', data: { id: 'pr-cup', name: '컵', note: '유리' } },
    { op: 'add', kind: 'prop', data: { name: '카드' } },
    { op: 'set', id: 'q-4', fields: { stage: { props: [{ propId: 'pr-cup', action: 'in', at: '테이블' }] } } },
    { op: 'set', kind: 'prop', id: 'pr-tophat', fields: { name: '검은 탑햇' } },
    { op: 'move', id: 'pr-cup', after: 'first' }
  ]);
  assert.deepEqual(r.show.props.map(p => p.name), ['컵', '검은 탑햇', '탑햇테이블', '카드']);
  assert.match(r.show.props[3].id, /^pr-/);
  assert.deepEqual(r.show.props[3], { id: r.show.props[3].id, name: '카드', note: '' });
  assert.deepEqual(validateShow(r.show).errors, []);
  rejects(() => applyOps(s, [{ op: 'add', kind: 'prop', data: { note: 'x' } }]), 'bad_field', /a new prop needs a "name"/);
  rejects(() => applyOps(s, [{ op: 'add', kind: 'prop', parent: 's-1', data: { name: 'x' } }]), 'bad_op', /has no parent/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'pr-table', fields: { role: 'x' } }]), 'bad_field', /unknown field "role" for prop/);
  rejects(() => applyOps(s, [{ op: 'set', kind: 'show', fields: { props: [] } }]), 'bad_field', /kind:"prop"/);

  // 무대 큐·공연 전 무대가 쓰는 소품은 force 없으면 거부, 사용처를 알려 준다
  const e = rejects(() => applyOps(s, [{ op: 'remove', id: 'pr-table' }]), 'referenced', /preShowProps\[0\]/);
  assert.equal(e.references.length, 1);
  rejects(() => applyOps(s, [{ op: 'remove', id: 'pr-tophat' }]), 'referenced', /stage cue q-4/);
  // force: 브라우저 prop-del 처럼 preShowProps 에서는 빼고 무대 큐 행은 남긴다 ("(삭제된 소품)" 경고)
  r = applyOps(s, [{ op: 'remove', id: 'pr-table', force: true }, { op: 'remove', id: 'pr-tophat', force: true }]);
  assert.deepEqual(r.show.props, []);
  assert.deepEqual(r.show.preShowProps, []);
  assert.deepEqual(find(r.show, 'q-4').stage.props, [{ propId: 'pr-tophat', action: 'in', at: '테이블 위' }]);
  assert.deepEqual(validateShow(r.show).errors, []);
  assert.ok(r.warnings.some(w => /pr-tophat" 가 props 에 없습니다/.test(w.msg)), JSON.stringify(r.warnings));
  // 안 쓰는 소품은 그냥 지워진다
  r = applyOps(s, [{ op: 'add', kind: 'prop', data: { id: 'pr-x', name: 'x' } }, { op: 'remove', id: 'pr-x' }]);
  assert.deepEqual(r.show.props, s.props);
});

test('v6: preShowProps 는 set kind:"show" 로 배열 통째 교체', () => {
  const s = docExample();
  const r = applyOps(s, [{ op: 'set', kind: 'show', fields: { preShowProps: [{ propId: 'pr-tophat', at: '테이블 위' }, { propId: 'pr-table' }] } }]);
  assert.deepEqual(r.show.preShowProps, [{ propId: 'pr-tophat', at: '테이블 위' }, { propId: 'pr-table', at: '' }]);
  assert.deepEqual(r.warnings, []);
  rejects(() => applyOps(s, [{ op: 'set', kind: 'show', fields: { preShowProps: [{ propId: 'pr-table', action: 'in' }] } }]), 'bad_field', /unknown field "preShowProps\[0\]\.action"/);
  rejects(() => applyOps(s, [{ op: 'set', kind: 'show', fields: { preShowProps: [{ propId: 'nope' }] } }]), 'bad_field', /preShowProps\[0\]\.propId" must be a prop id/);
  assert.deepEqual(applyOps(s, [{ op: 'set', kind: 'show', fields: { preShowProps: [] } }]).show.preShowProps, []);
});

test('v6: 사이트가 불러와도(index.html migrate) 소품 op 결과가 그대로다', () => {
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  const { migrate } = vm.runInNewContext(html.slice(a, b) + '\n;({ migrate })', {});
  // 실데이터(v5) 에 소품을 처음 붙여 본다
  const s = backstage();
  const cues = items(s).flatMap(i => i.cues.map(c => ({ c, i })));
  const st = cues.find(x => x.c.dept === 'stage'), lt = cues.find(x => x.c.dept === 'light');
  const r = applyOps(s, [
    { op: 'add', kind: 'prop', data: { id: 'pr-cup', name: '컵' } },
    { op: 'set', kind: 'show', fields: { preShowProps: [{ propId: 'pr-cup' }] } },
    { op: 'set', id: st.c.id, fields: { stage: { props: [{ propId: 'pr-cup', action: 'out', at: '퇴장 쪽' }] } } },
    { op: 'add', kind: 'cue', parent: st.i.id, data: { dept: 'stage', stage: { props: [{ propId: 'pr-cup', action: 'in' }] } } },
    { op: 'set', id: lt.c.id, fields: { dept: 'stage', note: '의자', stage: { props: [{ propId: 'pr-cup', action: 'clean' }] } } }
  ]);
  assert.equal(r.show.version, 13);
  const strip = x => { x = JSON.parse(JSON.stringify(x)); delete x.updatedAt; return x; };
  assert.deepEqual(strip(migrate(r.show)), strip(r.show));
});

test('v6: 개요·검색에 소품', () => {
  const { outline, search } = require('../lib/view');
  const s = docExample();
  const o = outline(s, { rev: 1 });
  assert.match(o, /^props: pr-tophat=탑햇, pr-table=탑햇테이블$/m);
  assert.match(o, /^preShowProps: 탑햇테이블 in @무대 중앙$/m);
  assert.match(o, /q-4 stage 탑햇 IN \| → 테이블 위 — 시점 리허설 때 확정 @ "이 대사 즈음" \[tbd\]/, '사이트와 같은 머리글(lib/cuehead.js) — v11 원본은 옛 시점 글 그대로');
  const r = search(s, '탑햇');
  assert.ok(r.matches.some(m => m.kind === 'prop' && m.id === 'pr-tophat'));
  assert.ok(r.matches.some(m => m.kind === 'cue' && m.id === 'q-4' && m.field === 'stage.prop'));
  assert.ok(search(s, '무대 중앙').matches.some(m => m.field === 'preShowProps.at'));
  // 지운 소품은 "(삭제된 소품 id)"
  const g = JSON.parse(JSON.stringify(s)); g.props = [];
  assert.match(outline(g, {}), /preShowProps: \(삭제된 소품 pr-table\) in/);
  assert.match(outline(g, {}), /q-4 stage \(삭제된 소품 pr-tophat\) IN/);
});

// ---- 큐 (kind:"cue", v12) — 본문 없이 트리거 하나 + 부서 동작
test('큐(v12): add 는 트리거·동작과 함께, 동작이 0개가 되면 큐가 사라진다, 글 문단 ↔ 큐는 바꿀 수 없다', () => {
  const s = docExample();
  let r = applyOps(s, [{ op: 'add', kind: 'item', parent: 's-1', after: 'i-1', data: { id: 'i-pt', kind: 'cue', trigger: { type: 'line', itemId: 'i-1' }, offsetSec: 2, cues: [{ dept: 'cast', cast: { personId: 'p-yejun', move: 'out' } }] } }]);
  const pt = find(r.show, 'i-pt');
  assert.deepEqual([pt.kind, pt.text, pt.speaker, pt.label, pt.isCue, pt.offsetSec], ['cue', '', null, '1', true, 2]);
  assert.deepEqual(pt.trigger, { type: 'line', itemId: 'i-1', at: 'end' });
  assert.deepEqual(Object.keys(pt), ['id', 'kind', 'speaker', 'text', 'label', 'isCue', 'trigger', 'offsetSec', 'cues', 'comments']);
  assert.deepEqual(validateShow(r.show).errors, []); assert.deepEqual(r.warnings, []);
  rejects(() => applyOps(s, [{ op: 'add', kind: 'item', parent: 's-1', data: { kind: 'cue' } }]), 'bad_field', /needs at least one action/);
  rejects(() => applyOps(s, [{ op: 'add', kind: 'item', parent: 's-1', data: { kind: 'cue', text: '(x)', cues: [{ dept: 'cast', cast: { personId: 'p-yejun' } }] } }]), 'bad_field', /has no text/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-1', fields: { kind: 'cue' } }]), 'bad_field', /cannot become a cue item/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-1', fields: { trigger: { type: 'signal', text: 'x' } } }]), 'bad_field', /belong to cue items/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'i-1', fields: { text: 'x' }, textToNote: true }]), 'bad_op', /unknown key "textToNote"/);
  // 동작을 지우거나 옮겨 비면 큐가 사라진다 (번호도 다시)
  r = applyOps(s, [{ op: 'remove', id: 'q-1' }, { op: 'move', id: 'q-2', parent: 'i-2-q' }]);
  assert.equal(find(r.show, 'i-1-q'), null); assert.equal(find(r.show, 'i-1-q2'), null);
  assert.ok(r.changes.some(c => /removed empty cue item i-1-q /.test(c.text)));
  assert.deepEqual(items(r.show).filter(i => i.label).map(i => [i.id, i.label]), [['i-2-q', '1'], ['i-2-q2', '2']]);
  // 코멘트가 있으면 빈 지문으로 남긴다 (트리거는 버린다)
  const up = applyOps(s, [{ op: 'set', kind: 'show', fields: { revision: 'x' } }]).show;
  find(up, 'i-1-q').comments.push({ id: 'c-x', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null });
  r = applyOps(up, [{ op: 'remove', id: 'q-1' }]);
  assert.equal(find(r.show, 'i-1-q').kind, 'action'); assert.equal('trigger' in find(r.show, 'i-1-q'), false);
  // 개요: 큐 줄에 트리거 (사이트와 같은 글)
  const { outline } = require('../lib/view');
  assert.match(outline(up, {}), /i-1-q Q1 cue ← line: 지문 “\(공연 시작\)” 끝에 \(i-1\) \[migrated, was "하우스 페이드 아웃 후"\]/); // v12: 지문에 붙어 있던 큐는 그 끝, 옛 글은 표시로
  assert.match(outline(up, {}), /i-2-q Q3 cue ← line: 조예준 “소개합니다 박대훈” 끝에 \(i-2\)/);
});

// ---- show v8: 상세 note · 소품 필수 · clean · 객석 on/off
test('v8: note 편집, 객석 채널은 on/off 만 받는다', () => {
  const s = docExample();
  let r = applyOps(s, [{ op: 'set', id: 'q-3', fields: { note: '마이크 들고' } }]);
  assert.equal(find(r.show, 'q-3').note, '마이크 들고');
  assert.deepEqual(r.warnings, []);
  r = applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { channels: [{ ch: 'back', action: 'fadeIn', dim: 60, timeSec: 2 }, { ch: 'house', action: 'off' }] } } }]);
  assert.deepEqual(find(r.show, 'q-1').light.channels[1], { ch: 'house', action: 'off', dim: null, color: null, colorName: null, timeSec: null });
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { channels: [{ ch: 'house', action: 'fadeIn' }] } } }]), 'bad_field', /house channel \(객석\) is on\/off only/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { channels: [{ ch: 'house', action: 'on', dim: 50 }] } } }]), 'bad_field', /on\/off only/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-1', fields: { light: { channels: [{ ch: 'house', action: 'off', timeSec: 3 }] } } }]), 'bad_field', /on\/off only/);
});

test('v8: v7 공연은 migrate 와 같게 올린다 — memo · text → note, 객석은 on/off 로 접고 흔적, snapshot 안의 큐도', () => {
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  const { migrate } = vm.runInNewContext(html.slice(a, b) + '\n;({ migrate })', {});
  const s = docExample();
  s.version = 7;
  const [i1, i2] = s.parts[0].scenes[0].items;
  i1.cues[0].light.channels[3] = { ch: 'house', action: 'fadeOut', dim: null, color: null, colorName: null, timeSec: 4 };
  i2.cues.forEach(c => { c.memo = c.note; delete c.note; });
  i2.cues[0].cast.text = '천천히';
  i2.cues[1].stage.text = '탑햇테이블에 탑햇 세팅';
  i2.comments.push({ id: 'c-s', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null, snapshot: { kind: i2.kind, speaker: i2.speaker, text: i2.text, cues: JSON.parse(JSON.stringify(i2.cues)) } });
  const r = applyOps(s, [{ op: 'set', kind: 'show', fields: { revision: 'v8' } }]);
  assert.equal(r.show.version, 13);
  const q1 = find(r.show, 'q-1'), q3 = find(r.show, 'q-3'), q4 = find(r.show, 'q-4');
  assert.deepEqual(q1.light.channels[3], { ch: 'house', action: 'off', dim: null, color: null, colorName: null, timeSec: null });
  assert.equal(q1.note, '(객석: 원래 FADE OUT 4s) / 옮기기 전 글: 하우스 페이드 아웃 후'); // v12: 지문에 붙어 있던 큐 — 옛 시점 글은 메모 끝에
  assert.equal(q3.note, '천천히');
  assert.deepEqual(q3.cast, { people: [{ personId: 'p-daehoon', move: 'in' }] });
  assert.equal(q4.note, '탑햇테이블에 탑햇 세팅 / 시점 리허설 때 확정');
  assert.deepEqual(Object.keys(q4), ['id', 'dept', 'note', 'status', 'stage'], 'migrate 와 같은 키 순서 (v12: trigger · offsetSec 은 큐 문단에)');
  assert.deepEqual(find(r.show, 'i-2').comments[0].snapshot.cues, [], 'v12: 글 문단 snapshot 의 큐는 버린다');
  const strip = x => { x = JSON.parse(JSON.stringify(x)); delete x.updatedAt; delete x.id; items(x).forEach(i => delete i.isCue); return x; }; // 문서 예시엔 isCue 가 없다
  assert.deepEqual(strip(migrate(r.show)), strip(r.show), '사이트가 불러와도 그대로');
  assert.deepEqual(validateShow(r.show).warnings, []);
});

// ---- v10: 출연 큐 하나에 여러 사람 — cast.people [{ personId, move }]
test('v10 출연 큐: people 통째로 (여러 사람 · 사람마다 액션), 옛 한 사람 입력 personId·move 도 0·1명 큐에서는 그대로', () => {
  const s = docExample(); // q-3 = 출연 박대훈 IN (문서 예시 v10 모양)
  const three = [{ personId: 'p-yejun', move: 'in' }, { personId: 'p-daehoon', move: 'in' }, { personId: 'p-yejun2', move: 'out' }];
  s.people.push({ id: 'p-yejun2', name: '라태형', role: 'performer', note: '' });
  let r = applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: three } } }]);
  assert.deepEqual(find(r.show, 'q-3').cast, { people: three });
  assert.deepEqual(validateShow(r.show).errors, []);
  assert.ok(!r.warnings.length, JSON.stringify(r.warnings));
  // move 를 빼면 in, 순서 그대로
  r = applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [{ personId: 'p-yejun2' }, { personId: 'p-yejun', move: 'out' }] } } }]);
  assert.deepEqual(find(r.show, 'q-3').cast.people, [{ personId: 'p-yejun2', move: 'in' }, { personId: 'p-yejun', move: 'out' }]);
  // 옛 입력: 한 사람 큐의 그 줄만 고친다 (move 하나만 줘도)
  r = applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { move: 'out' } } }]);
  assert.deepEqual(find(r.show, 'q-3').cast, { people: [{ personId: 'p-daehoon', move: 'out' }] });
  r = applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { personId: 'p-yejun' } } }]);
  assert.deepEqual(find(r.show, 'q-3').cast, { people: [{ personId: 'p-yejun', move: 'in' }] });
  // add: 두 모양 모두
  r = applyOps(s, [
    { op: 'add', kind: 'cue', parent: 'i-1', data: { id: 'q-old', dept: 'cast', cast: { personId: 'p-yejun', move: 'in' } } },
    { op: 'add', kind: 'cue', parent: 'i-1', data: { id: 'q-new', dept: 'cast', cast: { people: three.slice(0, 2) } } },
    { op: 'add', kind: 'cue', parent: 'i-1', data: { id: 'q-blank', dept: 'cast', status: 'tbd' } }
  ]);
  assert.deepEqual(find(r.show, 'q-old').cast, { people: [{ personId: 'p-yejun', move: 'in' }] });
  assert.deepEqual(find(r.show, 'q-new').cast, { people: three.slice(0, 2) });
  assert.deepEqual(find(r.show, 'q-blank').cast, { people: [] }, '새 출연 큐 기본값');
  // 빈 확정 큐는 경고
  r = applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [] } } }]);
  assert.ok(r.warnings.some(w => /cast cue q-3 has no content yet/.test(w.msg)));
  // 여러 사람 큐에 옛 입력 → 거부(어느 줄인지 모름), 통째 목록을 알려 준다
  const multi = applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: three } } }]).show;
  rejects(() => applyOps(multi, [{ op: 'set', id: 'q-3', fields: { cast: { move: 'out' } } }]), 'bad_field', /has 3 people.*cast\.people.*"personId":"p-yejun"/);
  // 거부: 같은 사람 두 줄, personId 없음, 이름, 틀린 move, 두 모양 함께, 배열 아님, 모르는 필드
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [{ personId: 'p-yejun' }, { personId: 'p-yejun', move: 'out' }] } } }]), 'bad_field', /already in cast\.people\[0\]/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [{ move: 'in' }] } } }]), 'bad_field', /cast\.people\[0\]\.personId" is required/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [{ personId: '조예준' }] } } }]), 'bad_field', /"조예준" is a name, use id "p-yejun"/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [{ personId: 'p-yejun', move: 'enter' }] } } }]), 'bad_field', /cast\.people\[0\]\.move.*in\|out\|move/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [], personId: 'p-yejun' } } }]), 'bad_field', /not both/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: 'p-yejun' } } }]), 'bad_field', /must be an array/);
  rejects(() => applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [{ personId: 'p-yejun', at: '왼쪽' }] } } }]), 'bad_field', /unknown field "cast\.people\[0\]\.at"/);
});

test('v10 출연 큐: v9 공연에 op 를 적용하면 출연 큐가 people 한 줄로 (사이트 migrate 와 같게), 사람 참조 검사·삭제도 여러 사람 큐에서', () => {
  const s = docExample();
  s.version = 9;
  s.parts[0].scenes[0].items[1].cues[0].cast = { personId: 'p-daehoon', move: 'in' }; // v9 모양
  let r = applyOps(s, [{ op: 'set', id: 's-1', fields: { title: 'x' } }]);
  assert.equal(r.show.version, 13);
  assert.deepEqual(find(r.show, 'q-3').cast, { people: [{ personId: 'p-daehoon', move: 'in' }] });
  assert.deepEqual(r.warnings, [], '형식만 바뀐 것은 경고가 아니다');
  // v9 의 끊긴 사람 참조(원래 오류)는 op 를 막지 않는다 — 경로가 cast.personId → cast.people[0].personId 로 바뀌어도
  const broken = JSON.parse(JSON.stringify(s));
  broken.parts[0].scenes[0].items[1].cues[0].cast.personId = 'p-ghost';
  r = applyOps(broken, [{ op: 'set', id: 's-1', fields: { title: 'y' } }]);
  assert.equal(r.preexistingErrors, 1);
  // 여러 사람 큐의 둘째 사람도 "쓰이는 곳" 으로 센다
  const m = applyOps(s, [{ op: 'set', id: 'q-3', fields: { cast: { people: [{ personId: 'p-daehoon', move: 'out' }, { personId: 'p-yejun', move: 'in' }] } } }]).show;
  rejects(() => applyOps(m, [{ op: 'remove', id: 'p-yejun' }]), 'referenced', /cast cue q-3/);
  r = applyOps(m, [{ op: 'remove', id: 'p-yejun', force: true }]);
  assert.deepEqual(find(r.show, 'q-3').cast.people, [{ personId: 'p-daehoon', move: 'out' }], '여러 사람 출연 큐에서는 그 사람 줄만 빠진다 (사이트 dropPerson 과 같게)');
  assert.ok(r.warnings.some(w => /removed person p-yejun from multi-person cast cue q-3/.test(w.msg)));
  // 한 사람 출연 큐는 그대로 (삭제된 사람)
  r = applyOps(s, [{ op: 'remove', id: 'p-daehoon', force: true }]);
  assert.deepEqual(find(r.show, 'q-3').cast.people, [{ personId: 'p-daehoon', move: 'in' }]);
  assert.ok(r.warnings.some(w => /cast-cue reference\(s\) to removed person p-daehoon/.test(w.msg)));
});
