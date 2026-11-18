// 대본 큐 블록의 한 줄 문구 (index.html 의 cueLine) — 부서 + 무엇을 하는지, 시점·메모·미정
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// index.html 의 "상수" 구간과 "큐 요약" 구간만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cut = (from, to) => {
    const a = html.indexOf('/* ================= ' + from), b = html.indexOf('/* ================= ' + to);
    assert.ok(a > 0 && b > a, `index.html 에서 ${from}~${to} 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)`);
    return html.slice(a, b);
  };
  return vm.runInNewContext(cut('상수', '유틸') + cut('큐 요약', '문단 문법') + '\n;({ cueLine, lightLine, soundLine, isBlackout })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o)); // vm 쪽 객체는 프로토타입이 달라 deepEqual 전에 평범한 객체로
const look = { person: id => ({ 'p-yejun': '조예준', 'p-daehoon': '박대훈' })[id] || '', track: no => ({ 3: '멘탈', 1: '하우스 음악' })[no] || '' };
const ch = (c, action, extra) => Object.assign({ ch: c, action, dim: null, color: null, colorName: null, timeSec: null }, extra);
const cue = (dept, body, extra) => Object.assign({ dept, trigger: '', offsetSec: null, memo: '', status: 'set', [dept]: body }, extra);

test('네 채널 모두 off → 암전', () => {
  const l = { channels: ['back', 'top', 'front', 'house'].map(c => ch(c, 'off')), anim: '' };
  assert.equal(FE.isBlackout(l), true);
  assert.deepEqual(plain(FE.cueLine(cue('light', l), look)), { dept: '조명', text: '암전 (전체 Off)', when: '', memo: '', tbd: false });
});

test('세 채널만 off 거나 하나가 on 이면 암전이 아니다', () => {
  const three = { channels: ['back', 'top', 'front'].map(c => ch(c, 'off')), anim: '' };
  assert.equal(FE.isBlackout(three), false);
  assert.equal(FE.lightLine(three), '백·탑·프론트 Off');
  const mixed = { channels: [ch('back', 'off'), ch('top', 'off'), ch('front', 'off'), ch('house', 'on')], anim: '' };
  assert.equal(FE.isBlackout(mixed), false);
  assert.equal(FE.lightLine(mixed), '백·탑·프론트 Off, 관객석 On');
});

test('암전 페이드 시간이 모두 같으면 시간을 붙인다', () => {
  const l = { channels: ['back', 'top', 'front', 'house'].map(c => ch(c, 'off', { timeSec: 3 })), anim: '' };
  assert.equal(FE.lightLine(l), '암전 (전체 Off 3s)');
});

test('조명: 객석 On, 전체 페이드인 밝기·색', () => {
  assert.equal(FE.lightLine({ channels: [ch('house', 'on')], anim: '' }), '관객석 On');
  const all = { channels: ['back', 'top', 'front', 'house'].map(c => ch(c, 'fadeIn', { dim: 80, colorName: '앰버', timeSec: 5 })), anim: '' };
  assert.equal(FE.lightLine(all), '전체 페이드인 80% 앰버 5s');
});

test('조명 상세 미정: 채널 없음 + tbd', () => {
  const L = FE.cueLine(cue('light', { channels: [], anim: '' }, { status: 'tbd', trigger: '암전 후', offsetSec: 7, memo: '조명 상세 미정' }), look);
  assert.deepEqual(plain(L), { dept: '조명', text: '상세 미정', when: '암전 후 +7s', memo: '조명 상세 미정', tbd: true });
});

test('음향: 트랙 번호와 제목, 동작', () => {
  assert.equal(FE.cueLine(cue('sound', { track: 3, action: 'play', timeSec: null, level: null }), look).text, '#3 멘탈 — 재생');
  assert.equal(FE.cueLine(cue('sound', { track: 1, action: 'fadeOut', timeSec: null, level: null }), look).text, '#1 하우스 음악 — 페이드아웃 3s');
  assert.equal(FE.cueLine(cue('sound', { track: 1, action: 'volume', timeSec: 2, level: 60 }), look).text, '#1 하우스 음악 — 볼륨 60% 2s');
  assert.equal(FE.cueLine(cue('sound', { track: 9, action: 'fadeIn', timeSec: 4, level: 70 }), look).text, '#9 — 페이드인 4s → 70%');
  assert.equal(FE.cueLine(cue('sound', { track: null, action: 'stop', timeSec: null, level: null }), look).text, '음원 — 정지');
});

test('출연: 사람 이름 + 인/아웃, 보충은 — 뒤에', () => {
  assert.equal(FE.cueLine(cue('cast', { personId: 'p-yejun', move: 'out', text: '' }), look).text, '조예준 아웃');
  assert.equal(FE.cueLine(cue('cast', { personId: 'p-daehoon', move: 'in', text: '마이크 들고' }), look).text, '박대훈 인 — 마이크 들고');
  assert.equal(FE.cueLine(cue('cast', { personId: null, move: 'in', text: '' }, { status: 'tbd' }), look).text, '(사람 미정) 인');
});

test('무대: 작업 내용 그대로, 시점은 when 으로', () => {
  const L = FE.cueLine(cue('stage', { text: '컵 빼고, 카드 매니용 빈 탑햇 넣기' }, { trigger: '이 대사 즈음' }), look);
  assert.deepEqual(plain(L), { dept: '무대', text: '컵 빼고, 카드 매니용 빈 탑햇 넣기', when: '이 대사 즈음', memo: '', tbd: false });
  assert.equal(FE.cueLine(cue('stage', { text: '' }, { status: 'tbd' }), look).text, '상세 미정');
});
