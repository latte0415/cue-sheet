// 구조화된 큐 트리거 (show v12) — 옛 데이터 옮기기(index.html migrate = lib/ops.js upgradeShow) · 검증 코드 · 트리거 글(사이트 = lib/cuehead.js) ·
// MCP op(구조 트리거 · 옛 글 트리거 · 지울 때 mode) · 병합(트리거는 통째 값)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateShow } = require('../lib/validate');
const { applyOps, upgradeShow, OpError } = require('../lib/ops');
const { mergeShows } = require('../lib/merge');
const LIB = require('../lib/cuehead');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const FE = (() => { const a = HTML.indexOf('/* ================= 상수'), b = HTML.indexOf('/* ================= 상태'); return vm.runInNewContext(HTML.slice(a, b) + '\n;({ migrate, relabel })', {}); })();
const sec = (from, to) => { const a = HTML.indexOf('/* ================= ' + from), b = HTML.indexOf('/* ================= ' + to); assert.ok(a > 0 && b > a, from); return HTML.slice(a, b); };
const TXT = vm.runInNewContext(sec('상수', '유틸') + sec('큐 요약', '문단 문법') + '\n;({ triggerText, cueItemHead, cueRefText, josaGwa })', {});
const plain = o => JSON.parse(JSON.stringify(o));
const items = s => s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items));
const byId = (s, id) => items(s).find(i => i.id === id);
const migrate = s => plain(FE.migrate(plain(s)));

// v11 모양 작은 공연
const P = [{ id: 'p-a', name: '조예준', role: 'mc', note: '' }];
const cast = (id, trigger, offsetSec, extra) => Object.assign({ id, dept: 'cast', trigger, offsetSec: offsetSec == null ? null : offsetSec, note: '', status: 'set', cast: { people: [{ personId: 'p-a', move: 'in' }] } }, extra);
const light = (id, trigger, offsetSec) => ({ id, dept: 'light', trigger, offsetSec: offsetSec == null ? null : offsetSec, note: '', status: 'set', light: { looks: [], channels: ['back', 'top', 'front', 'house'].map(ch => ({ ch, action: 'off', dim: null, color: null, colorName: null, timeSec: null })), anim: '' } });
const v11 = its => ({ id: 'show-t', title: 't', version: 11, people: P, props: [], preShowProps: [], lights: [], tracks: [], parts: [{ id: 'pt', name: '1부', scenes: [{ id: 's1', type: 'mc', title: 'x', cast: ['p-a'], durationSec: null, setup: '', comments: [], items: its }] }] });
const it = (id, kind, text, cues, extra) => Object.assign({ id, kind, speaker: kind === 'line' ? 'p-a' : null, text, label: null, isCue: !!(cues && cues.length), cues: cues || [], comments: [] }, extra);

function legacyShow() {
  return v11([
    it('i-0', 'cue', '', [light('q-0', '공연 시작')]),
    it('i-1', 'line', '소개합니다 다음 공연자 라태형', [light('q-1', ''), cast('q-2', '이전 큐 후', 3), cast('q-3', '대사 끝'), cast('q-4', '암전 후', 7)],
      { comments: [{ id: 'c-1', author: 'a', text: '확인', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null }] }),
    it('i-2', 'action', '(로프로 묶음)', [cast('q-5', '대사 끝'), cast('q-6', '')]),
    it('i-3', 'cue', '', [cast('q-7', '박수 끝'), cast('q-8', '박수 끝'), cast('q-9', '이전 큐 후', 2)],
      { comments: [{ id: 'c-3', author: 'a', text: '지점 코멘트', createdAt: '2026-11-01T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null }] }),
    it('i-4', 'line', '이 대사 즈음', [cast('q-10', '이 대사 즈음')]),
    it('i-5', 'line', '그냥 대사')
  ]);
}

test('v11 → v12 migrate: 묶음(트리거 글 · offsetSec) 하나 = 큐 하나, 대사·지문의 큐는 글과 상관없이 그 끝(결정 1) · 이전 큐 후 · 큐 지점은 신호, id 고정, 코멘트 자리', () => {
  const m = migrate(legacyShow());
  assert.equal(m.version, 13);
  const row = i => [i.id, i.kind, i.label, i.kind === 'cue' ? i.trigger : null, i.kind === 'cue' ? i.offsetSec : undefined, i.cues.map(c => c.id)];
  assert.deepEqual(items(m).map(row), [
    ['i-0', 'cue', '1', { type: 'signal', text: '공연 시작' }, null, ['q-0']],
    ['i-1', 'line', null, null, undefined, []],
    ['i-1-q', 'cue', '2', { type: 'line', itemId: 'i-1', at: 'end' }, null, ['q-1']], // 빈 글 → 그 대사 끝
    ['i-1-q2', 'cue', '3', { type: 'cue', cueId: 'i-0', mode: 'after' }, 3, ['q-2']], // "이전 큐 후" → 앞 문단까지의 마지막 큐
    ['i-1-q3', 'cue', '4', { type: 'line', itemId: 'i-1', at: 'end' }, null, ['q-3']], // "대사 끝" (대사 문단)
    ['i-1-q4', 'cue', '5', { type: 'line', itemId: 'i-1', at: 'end', migrated: true, was: '암전 후' }, 7, ['q-4']], // 대사에 붙은 큐는 글과 상관없이 그 대사 끝 — 옛 글은 표시·메모로
    ['i-2', 'action', null, null, undefined, []],
    ['i-2-q', 'cue', '6', { type: 'line', itemId: 'i-2', at: 'end' }, null, ['q-5']], // 지문의 "대사 끝" 도 그 지문 끝 (문단 종류와 상관없는 규칙)
    ['i-2-q2', 'cue', '7', { type: 'line', itemId: 'i-2', at: 'end' }, null, ['q-6']], // 지문이라도 빈 글은 그 지문 끝
    ['i-3', 'cue', '8', { type: 'signal', text: '박수 끝' }, null, ['q-7', 'q-8']], // 큐 지점: 첫 묶음이 옛 id
    ['i-3-q2', 'cue', '9', { type: 'cue', cueId: 'i-2-q2', mode: 'after' }, 2, ['q-9']],
    ['i-4', 'line', null, null, undefined, []],
    ['i-4-q', 'cue', '10', { type: 'line', itemId: 'i-4', at: 'end' }, null, ['q-10']], // "이 대사 즈음"
    ['i-5', 'line', null, null, undefined, []]
  ]);
  // 옮기기 전 글: 남길 만한 글(빈 글 · "대사 끝" 꼴 · "이전 큐 후" 가 아닌 것)만 동작 메모에, 큐 지점의 신호 글은 메모에 넣지 않는다
  const notes = items(m).flatMap(i => i.cues).filter(c => c.note).map(c => [c.id, c.note]);
  assert.deepEqual(notes, [['q-4', '옮기기 전 글: 암전 후']]);
  assert.deepEqual(byId(m, 'i-1').comments.map(c => c.id), ['c-1'], '코멘트는 글 문단에');
  assert.deepEqual(byId(m, 'i-3').comments.map(c => c.id), ['c-3'], '큐 지점 코멘트는 첫 큐에');
  assert.deepEqual(byId(m, 'i-3-q2').comments, []);
  assert.ok(items(m).flatMap(i => i.cues).every(c => !('trigger' in c) && !('offsetSec' in c)), '부서 큐에는 시점이 없다');
  assert.deepEqual(migrate(m), m, '다시 읽어도 그대로');
  const v = validateShow(m);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.map(w => w.code).filter(Boolean), [], JSON.stringify(v.warnings));
});

test('migrate: "이전 큐 후" 가 맨 앞이면 신호 · 파생 id 가 이미 있으면 겹치지 않게 · 같은 글이라도 offsetSec 이 다르면 다른 큐', () => {
  const s = v11([
    it('i-1', 'line', 'a', [cast('q-1', '이전 큐 후', 2), cast('q-2', '', 3), cast('q-3', '', null)]),
    it('i-1-q', 'line', '원래 있던 id')
  ]);
  const m = migrate(s);
  assert.deepEqual(items(m).map(i => [i.id, i.kind === 'cue' ? i.trigger.type : i.kind, i.offsetSec]), [
    ['i-1', 'line', undefined], ['i-1-q-2', 'line', 2], ['i-1-q2', 'line', 3], ['i-1-q3', 'line', null], ['i-1-q', 'line', undefined]
  ]);
  // 대사에 붙은 "이전 큐 후" 인데 앞 큐가 없으면 그 대사 끝 (그 말은 남길 것이 없다 — 표시·메모 없음)
  assert.deepEqual(byId(m, 'i-1-q-2').trigger, { type: 'line', itemId: 'i-1', at: 'end' });
  assert.ok(!byId(m, 'i-1-q-2').cues[0].note);
});

test('실데이터(backstage-part1 v9 → v12): 대사·지문의 큐는 모두 그 끝, 큐 지점만 신호 · 연결 0 · 오류 0 · 옮기기 전 글은 표시와 메모로', () => {
  const src = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
  for (const [name, m] of [['upgradeShow', upgradeShow(plain(src))], ['migrate', migrate(plain(src))]]) {
    const qs = items(m).filter(i => i.kind === 'cue'), by = t => qs.filter(q => q.trigger.type === t);
    assert.deepEqual([qs.length, by('line').length, by('cue').length, by('signal').length], [35, 12, 0, 23], name);
    const ids = new Set(items(m).map(i => i.id));
    // 큐 지점(옛 kind:'cue')에서 온 큐만 신호 — 글 문단 바로 뒤에 만든 "<id>-q…" 큐는 모두 그 문단 끝
    const pts = new Set(items(src).filter(i => i.kind === 'cue').map(i => i.id));
    assert.ok(by('signal').every(q => pts.has(q.id.replace(/-q\d*$/, ''))), name);
    assert.ok(by('line').every(q => !pts.has(q.id.replace(/-q\d*$/, ''))), name);
    assert.ok(by('line').every(q => ids.has(q.trigger.itemId) && q.trigger.at === 'end'), name);
    const mig = by('line').filter(q => q.trigger.migrated);
    assert.equal(mig.length, 11, name);
    assert.ok(mig.every(q => q.trigger.was && q.cues.every(c => String(c.note).split(' / ').includes('옮기기 전 글: ' + q.trigger.was))), name + ' — 메모에도');
    const v = validateShow(m);
    assert.deepEqual(v.errors, [], name);
    assert.deepEqual(v.warnings, [], name);
  }
});

test('index.html migrate 와 lib/ops.js upgradeShow 는 같은 큐 문단을 만든다 (작은 공연 · 문서 예시 v11 · 실데이터 v5 · v9)', () => {
  const shape = s => items(s).map(i => [i.id, i.kind, i.label == null ? null : String(i.label), i.kind === 'cue' ? plain(i.trigger) : null, i.kind === 'cue' ? (i.offsetSec == null ? null : i.offsetSec) : null, i.cues.map(c => c.id), (i.comments || []).map(c => c.id)]);
  const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, ...f), 'utf8'));
  for (const [name, s] of [['작은 공연', legacyShow()], ['문서 예시 v11', read(['fixtures', 'doc-example-v11.json'])], ['실데이터 v5', read(['fixtures', 'backstage-part1-v5.json'])], ['실데이터 v9', read(['..', 'cues', 'backstage-part1.json'])]]) {
    const a = migrate(s), b = upgradeShow(plain(s));
    assert.equal(b.version, 13, name);
    assert.deepEqual(shape(b), shape(a), name);
    assert.deepEqual(items(b).flatMap(i => i.cues.map(c => c.note)), items(a).flatMap(i => i.cues.map(c => c.note)), name + ' — 동작 메모(옮기기 전 글)도 같다');
  }
});

test('검증(v12): 트리거 코드 — 끊긴 대사 · 끊긴 앞 큐 · 고리(한 고리 한 경고, 사슬) · 빈 신호 · 신호로 바뀜 · 옛 모양', () => {
  const s = migrate(legacyShow());
  const set = (id, t) => { byId(s, id).trigger = t; };
  set('i-1-q', { type: 'line', itemId: 'nope', at: 'end' });
  set('i-1-q2', { type: 'cue', cueId: 'gone', mode: 'after' });
  set('i-2-q', { type: 'cue', cueId: 'i-2-q2', mode: 'after' }); set('i-2-q2', { type: 'cue', cueId: 'i-3', mode: 'with' }); set('i-3', { type: 'cue', cueId: 'i-2-q', mode: 'after' });
  set('i-4-q', { type: 'signal', text: '  ' });
  set('i-1-q4', { type: 'signal', text: '조예준 “…라태형” 후', converted: 'line' });
  byId(s, 'i-5').cues = [cast('q-x', '대사 끝')]; // v12 파일의 옛 모양
  byId(s, 'i-0').cues[0].trigger = '옛 글';
  const v = validateShow(s);
  assert.deepEqual(v.errors, []);
  const w = v.warnings.map(x => [x.code, x.path.replace(/^parts\[0\]\.scenes\[0\]\./, '')]);
  assert.deepEqual(w.filter(x => x[0] && x[0].startsWith('trigger-')).sort(), [
    ['trigger-converted', 'items[5].trigger'],
    ['trigger-cue-missing', 'items[3].trigger.cueId'],
    ['trigger-line-missing', 'items[2].trigger.itemId'],
    ['trigger-loop', 'items[7].trigger'],
    ['trigger-signal-empty', 'items[12].trigger.text']
  ].sort());
  // 사슬은 사이트 트리거 고르기 칸과 같은 "<머리글>(Qn)" 꼴
  assert.match(v.warnings.find(x => x.code === 'trigger-loop').msg, /— 조예준 IN\(Q6\) → 조예준 IN\(Q7\) → 조예준 IN…\(Q8\) → 조예준 IN\(Q6\) \(화살표/);
  assert.deepEqual(w.filter(x => x[0] === 'legacy-field').map(x => x[1]).sort(), ['items[0].cues[0].trigger', 'items[13].cues', 'items[13].cues[0].trigger'].sort());
  // 트리거 type 이 틀리면 오류
  set('i-0', { type: 'later' });
  assert.match(validateShow(s).errors[0].msg, /line\|cue\|signal/);
});

test('트리거 글: 사이트(index.html)와 lib/cuehead.js 가 같다 — 대사 인용(끝·시작·짧게) · 큐 머리글+번호 · 후/함께 · 와/과 · 초 · 끊김 · 신호', () => {
  const s = migrate(v11([
    it('l1', 'line', '그럼 준비되셨을까요? 오늘 1부의 다음 공연자를 소개합니다 박대훈'),
    it('l2', 'action', '(짧은 지문)'),
    it('l3', 'line', '짧은 대사', [], { speaker: null })
  ]));
  const sc = s.parts[0].scenes[0];
  const Q = (id, trigger, offsetSec, cues) => ({ id, kind: 'cue', speaker: null, text: '', label: null, isCue: true, trigger, offsetSec, cues: cues || [light('a-' + id, '')], comments: [] });
  const many = [light('m1', ''), cast('m2', '')];
  for (let k = 1; k <= 12; k++) sc.items.push(Q('c' + k, { type: 'signal', text: '신호 ' + k }, null, k === 2 ? many : undefined));
  FE.relabel(s);
  const look = { person: id => ({ 'p-a': '조예준' })[id] || '', track: () => '', prop: () => '', light: () => '' };
  const ctx = { item: id => byId(s, id), q: id => (byId(s, id) || {}).label, person: look.person, look };
  const cases = [
    [{ type: 'line', itemId: 'l1', at: 'end' }, null, true, '조예준 “…공연자를 소개합니다 박대훈” 끝에'], // 뒤에서 16자 안쪽 낱말
    [{ type: 'line', itemId: 'l1', at: 'start' }, 3, true, '조예준 “그럼 준비되셨을까요? 오늘…” 시작에, 3초 뒤'],
    [{ type: 'line', itemId: 'l1', at: 'end' }, null, false, '대사 끝에'],
    [{ type: 'line', itemId: 'l2', at: 'end' }, null, false, '지문 끝에'],
    [{ type: 'line', itemId: 'l2', at: 'end' }, null, true, '지문 “(짧은 지문)” 끝에'],
    [{ type: 'line', itemId: 'l3', at: 'end' }, null, true, '“짧은 대사” 끝에'],
    [{ type: 'line', itemId: 'gone', at: 'end' }, null, true, '트리거 대사가 지워짐'],
    [{ type: 'cue', cueId: 'c1', mode: 'after' }, 7, true, 'BLACKOUT(Q1) 후 7초'],
    [{ type: 'cue', cueId: 'c2', mode: 'after' }, null, true, 'BLACKOUT…(Q2) 후'],
    [{ type: 'cue', cueId: 'c2', mode: 'with' }, null, true, 'BLACKOUT…(Q2)와 함께'],
    [{ type: 'cue', cueId: 'c3', mode: 'with' }, 2, true, 'BLACKOUT(Q3)과 함께, 2초 뒤'],
    [{ type: 'cue', cueId: 'c10', mode: 'with' }, null, true, 'BLACKOUT(Q10)과 함께'],
    [{ type: 'cue', cueId: 'c12', mode: 'with' }, null, true, 'BLACKOUT(Q12)와 함께'],
    [{ type: 'cue', cueId: 'nope', mode: 'after' }, null, true, '앞 큐가 지워짐'],
    [{ type: 'signal', text: '박대훈 손 들면' }, 5, true, '박대훈 손 들면, 5초 뒤'],
    [{ type: 'signal', text: ' ' }, null, true, '신호 비어 있음']
  ];
  cases.forEach(([t, off, full, want]) => {
    const c = { id: 'x', trigger: t, offsetSec: off, cues: [] };
    const a = LIB.triggerText(c, ctx, full), b = plain(TXT.triggerText(c, ctx, full));
    assert.deepEqual(b, a, JSON.stringify(t));
    assert.equal(a.s, want, JSON.stringify(t));
    assert.equal(a.bad, /지워짐|비어 있음/.test(want));
  });
  // 와/과: 끝자리 읽기 (0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔 → 과)
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 20].map(n => LIB.josaGwa(n)), ['과', '과', '와', '과', '와', '와', '과', '과', '과', '와', '와', '과']);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 20].map(n => TXT.josaGwa(n)), ['과', '과', '와', '과', '와', '와', '과', '과', '과', '와', '와', '과']);
});

test('MCP op: 구조 트리거로 큐 만들기·고치기, 옛 글 트리거 받기, 고리·끊긴 연결 거부, 지울 때 mode', () => {
  const base = upgradeShow(plain(legacyShow()));
  let r = applyOps(base, [
    { op: 'add', kind: 'item', after: 'i-5', data: { id: 'n1', kind: 'cue', trigger: { type: 'line', itemId: 'i-5' }, cues: [{ dept: 'cast', cast: { people: [{ personId: 'p-a', move: 'out' }] } }] } },
    { op: 'add', kind: 'item', after: 'n1', data: { id: 'n2', kind: 'cue', trigger: { type: 'cue', cueId: 'n1', mode: 'with' }, offsetSec: 4, cues: [{ dept: 'stage', status: 'tbd' }] } },
    { op: 'set', id: 'i-0', fields: { trigger: { type: 'signal', text: '객석 오픈' }, offsetSec: 1 } }
  ]);
  assert.deepEqual(byId(r.show, 'n1').trigger, { type: 'line', itemId: 'i-5', at: 'end' });
  assert.deepEqual([byId(r.show, 'n2').trigger, byId(r.show, 'n2').offsetSec], [{ type: 'cue', cueId: 'n1', mode: 'with' }, 4]);
  assert.deepEqual(byId(r.show, 'i-0').trigger, { type: 'signal', text: '객석 오픈' });
  // 옛 글 트리거: 큐 문단에 "이전 큐 후" → 바로 앞 큐, "대사 끝" → 바로 앞 대사 끝 (경고로 알린다)
  r = applyOps(r.show, [{ op: 'set', id: 'n2', fields: { trigger: '이전 큐 후' } }]);
  assert.deepEqual(byId(r.show, 'n2').trigger, { type: 'cue', cueId: 'n1', mode: 'after' });
  assert.ok(r.warnings.some(w => /legacy text trigger "이전 큐 후"/.test(w.msg)));
  r = applyOps(r.show, [{ op: 'set', id: 'n2', fields: { trigger: '대사 끝' } }]);
  assert.deepEqual(byId(r.show, 'n2').trigger, { type: 'line', itemId: 'i-5', at: 'end' });
  // 동작(부서 큐)의 trigger 글 → 그 큐의 트리거 (옛 방식, 경고)
  r = applyOps(r.show, [{ op: 'set', id: 'q-0', fields: { trigger: '박수 끝', offsetSec: 2 } }]);
  assert.deepEqual([byId(r.show, 'i-0').trigger, byId(r.show, 'i-0').offsetSec], [{ type: 'signal', text: '박수 끝' }, 2]);
  const show = r.show;
  const rejects = (ops, code, re) => assert.throws(() => applyOps(show, ops), e => e instanceof OpError && e.code === code && re.test(e.message));
  rejects([{ op: 'set', id: 'n1', fields: { trigger: { type: 'cue', cueId: 'n2' } } }, { op: 'set', id: 'n2', fields: { trigger: { type: 'cue', cueId: 'n1' } } }], 'invalid', /서로 기다리는 큐/);
  rejects([{ op: 'set', id: 'n1', fields: { trigger: { type: 'line', itemId: 'nope' } } }], 'invalid', /트리거 대사 "nope"/);
  rejects([{ op: 'set', id: 'n1', fields: { trigger: { type: 'cue', cueId: 'i-5' } } }], 'invalid', /앞 큐 "i-5"/);
  rejects([{ op: 'set', id: 'n1', fields: { trigger: { type: 'later' } } }], 'bad_field', /line\|cue\|signal/);
  rejects([{ op: 'set', id: 'n1', fields: { trigger: { type: 'line', itemId: 'i-5', when: 1 } } }], 'bad_field', /unknown field "trigger\.when"/);
  rejects([{ op: 'set', id: 'i-5', fields: { trigger: { type: 'signal', text: 'x' } } }], 'bad_field', /belong to cue items/);
  rejects([{ op: 'add', kind: 'cue', parent: 'n1', data: { dept: 'cast', trigger: '대사 끝' } }], 'bad_field', /moved to the cue item/);
  rejects([{ op: 'remove', id: 'i-5', mode: 'only' }], 'bad_op', /keep-cues\|with-cues/);
  // 지우기: 대사 — 기본(keep-cues)은 큐를 남기고 신호(converted), with-cues 는 그 큐와 연속 큐까지
  r = applyOps(show, [{ op: 'remove', id: 'i-5' }]);
  assert.deepEqual(byId(r.show, 'n1').trigger, { type: 'signal', text: '조예준 “그냥 대사” 후', converted: 'line' });
  assert.ok(byId(r.show, 'n2'));
  r = applyOps(show, [{ op: 'remove', id: 'i-5', mode: 'with-cues' }]);
  assert.equal(byId(r.show, 'n1'), undefined); assert.equal(byId(r.show, 'n2'), undefined, '연속 큐도');
  // 큐 — 기본(only)은 따라가던 큐를 신호 "<머리글> 후", with-followers 는 함께
  const chain = applyOps(show, [{ op: 'set', id: 'n2', fields: { trigger: { type: 'cue', cueId: 'n1', mode: 'with' } } }]).show;
  r = applyOps(chain, [{ op: 'remove', id: 'n1' }]);
  assert.deepEqual(byId(r.show, 'n2').trigger, { type: 'signal', text: '조예준 OUT 때', converted: 'cue' });
  r = applyOps(chain, [{ op: 'remove', id: 'n1', mode: 'with-followers' }]);
  assert.equal(byId(r.show, 'n2'), undefined);
  // 마지막 동작을 지워 큐가 사라져도 따라가던 큐는 신호로
  r = applyOps(chain, [{ op: 'remove', id: byId(chain, 'n1').cues[0].id }]);
  assert.equal(byId(r.show, 'n1'), undefined);
  assert.equal(byId(r.show, 'n2').trigger.converted, 'cue');
});

test('병합: 큐의 trigger 는 통째 값 — 한쪽만 바꾸면 그쪽, 다르게 바꾸면 충돌(서버 것), 새 큐 문단은 id 로', () => {
  const base = migrate(legacyShow());
  const merge = (b, l, r) => mergeShows(b, l, r, { relabel: FE.relabel });
  // 한쪽만: 그 값 통째
  let local = plain(base); byId(local, 'i-1-q4').trigger = { type: 'cue', cueId: 'i-1-q', mode: 'after' };
  let remote = plain(base); byId(remote, 'i-1-q4').offsetSec = 9;
  let m = merge(base, local, remote);
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual([byId(m.show, 'i-1-q4').trigger, byId(m.show, 'i-1-q4').offsetSec], [{ type: 'cue', cueId: 'i-1-q', mode: 'after' }, 9]);
  // 다르게: 안쪽 필드가 섞이지 않고 서버 것 (대사 · 큐로 각자 바꿈)
  local = plain(base); byId(local, 'i-1-q4').trigger = { type: 'cue', cueId: 'i-0', mode: 'with' };
  remote = plain(base); byId(remote, 'i-1-q4').trigger = { type: 'line', itemId: 'i-1', at: 'start' };
  m = merge(base, local, remote);
  assert.equal(m.conflicts.length, 1);
  assert.deepEqual(m.conflicts[0].fields, ['trigger']);
  assert.match(m.conflicts[0].text, /큐 Q5 — 트리거: 양쪽에서 다르게 고침/);
  assert.deepEqual(byId(m.show, 'i-1-q4').trigger, { type: 'line', itemId: 'i-1', at: 'start' });
  // 새 큐 문단(양쪽) — id 로 둘 다
  local = plain(base); local.parts[0].scenes[0].items.push({ id: 'L', kind: 'cue', speaker: null, text: '', label: null, isCue: true, trigger: { type: 'signal', text: 'l' }, offsetSec: null, cues: [{ id: 'qL', dept: 'stage', note: '', status: 'tbd', stage: { props: [] } }], comments: [] });
  remote = plain(base); remote.parts[0].scenes[0].items.push({ id: 'R', kind: 'cue', speaker: null, text: '', label: null, isCue: true, trigger: { type: 'cue', cueId: 'i-0', mode: 'after' }, offsetSec: 2, cues: [{ id: 'qR', dept: 'stage', note: '', status: 'tbd', stage: { props: [] } }], comments: [] });
  m = merge(base, local, remote);
  assert.deepEqual(m.conflicts, []);
  assert.ok(byId(m.show, 'L') && byId(m.show, 'R'));
  assert.deepEqual(validateShow(m.show).errors, []);
});
