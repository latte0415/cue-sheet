// 큐 머리글 사본(lib/cuehead.js)이 사이트(index.html "큐 요약" 구간)와 같은 문구를 내는지 대조한다.
// MCP 개요(lib/view.js)가 이 사본을 쓴다 — 한쪽만 고치면 여기서 걸린다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const LIB = require('../lib/cuehead');

function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cut = (from, to) => {
    const a = html.indexOf('/* ================= ' + from), b = html.indexOf('/* ================= ' + to);
    assert.ok(a > 0 && b > a, `index.html 에서 ${from}~${to} 구간 표시를 찾지 못했습니다`);
    return html.slice(a, b);
  };
  return vm.runInNewContext(cut('상수', '유틸') + cut('큐 요약', '문단 문법') + '\n;({ cueHead, cueDetail, cueText })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));

function corpus() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
  const s = raw.show || raw;
  const cues = s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items.flatMap(i => i.cues)));
  const ch = (c, action, x) => Object.assign({ ch: c, action, dim: null, color: null, colorName: null, timeSec: null }, x);
  const q = (dept, body, x) => Object.assign({ id: 'x', dept, trigger: '', offsetSec: null, note: '', status: 'set', [dept]: body }, x);
  // 사이트 데이터에 아직 없는 모양들
  cues.push(
    q('light', { channels: [ch('back', 'fadeIn', { dim: 70, color: '#ffaa00', timeSec: 2 }), ch('top', 'off'), ch('front', 'fadeIn', { dim: 70, color: '#ffaa00', timeSec: 2 })], anim: '체이스' }),
    q('light', { channels: [ch('front', 'anim')], anim: '스파클' }),
    q('light', { channels: [], anim: '' }, { status: 'tbd', note: '조명 상세 미정' }),
    q('light', { channels: ['back', 'top', 'front', 'house'].map(c => ch(c, 'off', { timeSec: 4 })), anim: '' }),
    q('sound', { track: 9, action: 'fadeIn', timeSec: 4, level: 70 }),
    q('sound', { track: null, action: 'stop', timeSec: null, level: null }, { status: 'tbd' }),
    q('sound', { track: 1, action: 'volume', timeSec: null, level: null }),
    q('sound', { track: 1, action: 'play', timeSec: null, level: 50 }),
    q('sound', { track: 1, action: 'play', timeSec: null, level: 100 }),
    q('sound', { track: null, action: 'play', timeSec: null, level: 30 }, { status: 'tbd' }),
    q('stage', { props: [{ propId: 'pr-a', action: 'out', at: '' }, { propId: 'pr-gone', action: 'in', at: '테이블' }] }, { note: '천천히' }),
    q('stage', { text: '', props: [] }, { status: 'tbd' }),
    q('cast', { personId: 'p-gone', move: 'move' }, { trigger: '암전 후', offsetSec: 3, memo: '확인' }),
    q('cast', { personId: null, move: 'out', text: '' }),
    // v10: 한 큐에 여러 사람
    q('cast', { people: [{ personId: 'p-yejun', move: 'in' }] }),
    q('cast', { people: [{ personId: 'p-yejun', move: 'in' }, { personId: 'p-taehyung', move: 'in' }] }),
    q('cast', { people: [{ personId: 'p-yejun', move: 'out' }, { personId: 'p-taehyung', move: 'in' }, { personId: 'p-daehoon', move: 'in' }] }, { note: '교대' }),
    q('cast', { people: [{ personId: 'p-gone', move: 'move' }, { personId: null, move: 'in' }] }, { status: 'tbd' }),
    q('cast', { people: [] }),
    q('cast', { people: [] }, { status: 'tbd' })
  );
  const P = new Map(s.people.map(p => [p.id, p.name])), T = new Map(s.tracks.map(t => [t.no, t.title]));
  const look = { person: id => P.get(id) || '(삭제된 사람)', track: no => T.get(no) || '', prop: id => ({ 'pr-a': '탑햇' })[id] || '(삭제된 소품)' };
  return { cues, look };
}

test('lib/cuehead.js 는 index.html 과 같은 머리글 · 값 · 상세를 낸다', () => {
  const { cues, look } = corpus();
  assert.ok(cues.length > 40);
  for (const c of cues) {
    assert.deepEqual(LIB.cueHead(c, look), plain(FE.cueHead(c, look)), JSON.stringify(c));
    assert.deepEqual(LIB.cueDetail(c, look), plain(FE.cueDetail(c, look)), JSON.stringify(c));
    assert.equal(LIB.cueText(c, look), FE.cueText(c, look));
  }
});

test('PLAY 시작 볼륨: 값 자리에 "50%" — 비우거나 100 이면 표시하지 않는다 (사이트 · 사본 같게)', () => {
  const look = { person: () => '', track: no => (no === 1 ? '하우스 음악' : ''), prop: () => '' };
  const q = level => ({ id: 'x', dept: 'sound', trigger: '', offsetSec: null, note: '', status: 'set', sound: { track: 1, action: 'play', timeSec: null, level } });
  for (const F of [LIB, FE]) {
    assert.equal(F.cueText(q(50), look), 'BGM 1 PLAY 하우스 음악 · 50%');
    assert.equal(F.cueDetail(q(50), look).val, '하우스 음악 · 50%');
    assert.equal(F.cueText(q(0), look), 'BGM 1 PLAY 하우스 음악 · 0%');
    assert.equal(F.cueText(q(null), look), 'BGM 1 PLAY 하우스 음악');
    assert.equal(F.cueText(q(100), look), 'BGM 1 PLAY 하우스 음악');
  }
});

test('v10 출연 머리글: 한 사람은 그대로, 같은 액션끼리 "·" 로 묶고 섞이면 " · " (사이트 · 사본 같게)', () => {
  const look = { person: id => ({ 'p-a': '조예준', 'p-b': '라태형', 'p-c': '박대훈' })[id] || '(삭제된 사람)', track: () => '', prop: () => '' };
  const q = (people, x) => Object.assign({ id: 'x', dept: 'cast', trigger: '', offsetSec: null, note: '', status: 'set', cast: { people } }, x);
  const r = (personId, move) => ({ personId, move });
  for (const F of [LIB, FE]) {
    const H = c => plain(F.cueHead(c, look));
    assert.equal(H(q([r('p-a', 'in')])).head, '조예준 IN');
    assert.equal(H({ id: 'x', dept: 'cast', status: 'set', cast: { personId: 'p-a', move: 'out' } }).head, '조예준 OUT', '옛 모양(서버 원본)도 같은 머리글');
    assert.equal(H(q([r('p-a', 'in'), r('p-b', 'in')])).head, '조예준·라태형 IN');
    assert.equal(H(q([r('p-a', 'out'), r('p-b', 'out'), r('p-c', 'out')])).head, '조예준·라태형·박대훈 OUT');
    assert.equal(H(q([r('p-a', 'in'), r('p-b', 'out')])).head, '조예준 IN · 라태형 OUT');
    // 둘 IN + 하나 OUT, 섞인 순서: 묶음은 처음 나온 액션 순서
    assert.equal(H(q([r('p-a', 'in'), r('p-c', 'out'), r('p-b', 'in')])).head, '조예준·라태형 IN · 박대훈 OUT');
    assert.equal(H(q([r('p-c', 'out'), r('p-a', 'in'), r('p-b', 'move')])).head, '박대훈 OUT · 조예준 IN · 라태형 MOVE');
    // 사람이 빈 줄 · 빈 목록 · 미정
    assert.deepEqual(H(q([r('p-a', 'in'), r(null, 'out')])), { dept: '출연', head: '조예준 IN · 출연자 미지정 OUT', miss: true, tbd: false });
    assert.deepEqual(H(q([])), { dept: '출연', head: '출연자 미지정', miss: true, tbd: false });
    assert.deepEqual(H(q([], { status: 'tbd' })), { dept: '출연', head: '출연자 미정', miss: true, tbd: true });
    assert.equal(F.cueText(q([r('p-a', 'out'), r('p-b', 'in')], { note: '마이크 건넴' }), look), '조예준 OUT · 라태형 IN — 마이크 건넴');
  }
});
