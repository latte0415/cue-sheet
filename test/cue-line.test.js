// 큐 문구 한 벌 (index.html 의 cueHead · cueDetail) — 머리글 = 대상 + 고정 액션(영문 대문자), 값 · 상세 · 시점 · 메모는 따로
// (큐를 다시 적은 지문 판정 actionEcho 는 lib/validate.js 의 action-echo 경고 — test/validate.test.js)
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
  return vm.runInNewContext(cut('상수', '유틸') + cut('큐 요약', '문단 문법') + '\n;({ cueHead, cueDetail, cueText, isBlackout })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o)); // vm 쪽 객체는 프로토타입이 달라 deepEqual 전에 평범한 객체로
const look = {
  person: id => ({ 'p-yejun': '조예준', 'p-daehoon': '박대훈' })[id] || '',
  track: no => ({ 3: '멘탈', 1: '하우스 음악', 4: '카드 매니 음원' })[no] || '',
  prop: id => ({ 'pr-hat': '탑햇', 'pr-cup': '컵', 'pr-card': '카드' })[id] || ''
};
const ch = (c, action, extra) => Object.assign({ ch: c, action, dim: null, color: null, colorName: null, timeSec: null }, extra);
const cue = (dept, body, extra) => Object.assign({ dept, trigger: '', offsetSec: null, note: '', status: 'set', [dept]: body }, extra);
const head = (c, lk) => FE.cueHead(c, lk || look).head;
const val = (c, lk) => FE.cueDetail(c, lk || look).val;

test('조명: 네 채널 모두 OFF → BLACKOUT, 페이드 시간이 같으면 값으로', () => {
  const l = { channels: ['back', 'top', 'front', 'house'].map(c => ch(c, 'off')), anim: '' };
  assert.equal(FE.isBlackout(l), true);
  assert.deepEqual(plain(FE.cueHead(cue('light', l), look)), { dept: '조명', head: 'BLACKOUT', miss: false, tbd: false });
  const t = { channels: ['back', 'top', 'front', 'house'].map(c => ch(c, 'off', { timeSec: 3 })), anim: '' };
  assert.equal(val(cue('light', t)), '3s');
});

test('조명: 같은 액션끼리 묶고 덩어리는 / 로, 객석은 늘 따로 ON/OFF 만', () => {
  const three = { channels: ['back', 'top', 'front'].map(c => ch(c, 'off')), anim: '' };
  assert.equal(FE.isBlackout(three), false);
  assert.equal(head(cue('light', three)), '백·탑·프론트 OFF');
  const mixed = { channels: [ch('back', 'off'), ch('top', 'on'), ch('front', 'off'), ch('house', 'on')], anim: '' };
  assert.equal(head(cue('light', mixed)), '백·프론트 OFF / 탑 ON / 객석 ON', '떨어져 있어도 같은 액션이면 한 덩어리, 객석은 따로');
  assert.equal(head(cue('light', { channels: [ch('house', 'on')], anim: '' })), '객석 ON');
  const all = { channels: ['back', 'top', 'front'].map(c => ch(c, 'fadeIn', { dim: 80, colorName: '앰버', timeSec: 5 })).concat(ch('house', 'off')), anim: '' };
  assert.equal(head(cue('light', all)), '백·탑·프론트 FADE IN / 객석 OFF');
  assert.equal(val(cue('light', all)), '백·탑·프론트 80% 앰버 5s', '객석에는 값이 없다');
  // 옛 데이터의 객석 페이드·밝기는 ON/OFF 로 읽고 값은 보이지 않는다
  assert.equal(head(cue('light', { channels: [ch('house', 'fadeIn', { dim: 40, timeSec: 3 })], anim: '' })), '객석 ON');
  assert.equal(val(cue('light', { channels: [ch('house', 'fadeIn', { dim: 40, timeSec: 3 })], anim: '' })), '');
  assert.equal(head(cue('light', { channels: [ch('house', 'fadeOut', { timeSec: 3 })], anim: '' })), '객석 OFF');
  assert.equal(head(cue('light', { channels: ['back', 'top', 'front', 'house'].map(c => ch(c, 'fadeIn')), anim: '' })), '백·탑·프론트 FADE IN / 객석 ON');
  const two = { channels: [ch('back', 'on', { dim: 50 }), ch('top', 'off')], anim: '' };
  assert.equal(val(cue('light', two)), '백 50%', '덩어리가 여럿이면 값 앞에 채널 이름');
  assert.equal(head(cue('light', { channels: [], anim: '스파클' })), 'ANIM');
});

test('조명 상세 미정: 대상 없음 → 빨간 "조명 미정", 메모가 미정만 다시 적으면 걸러낸다', () => {
  const c = cue('light', { channels: [], anim: '' }, { status: 'tbd', trigger: '암전 후', offsetSec: 7, memo: '조명 상세 미정' });
  assert.deepEqual(plain(FE.cueHead(c, look)), { dept: '조명', head: '조명 미정', miss: true, tbd: true });
  assert.deepEqual(plain(FE.cueDetail(c, look)), { val: '', note: '', when: '암전 후 +7s', memo: '' });
  const keep = cue('light', { channels: [ch('house', 'on')], anim: '' }, { status: 'tbd', memo: '시점·밝기 공연장에서 확정' });
  assert.equal(FE.cueDetail(keep, look).memo, '시점·밝기 공연장에서 확정', '정보가 있는 메모는 남긴다');
  assert.equal(head(cue('light', { channels: [], anim: '' })), '조명 미지정', '확정 큐는 "미지정"');
});

test('음향: BGM 번호 + 액션, 트랙 제목·시간·볼륨은 값', () => {
  const s = (track, action, timeSec, level) => cue('sound', { track, action, timeSec, level });
  assert.equal(head(s(3, 'play')), 'BGM 3 PLAY');
  assert.equal(val(s(3, 'play')), '멘탈');
  assert.equal(head(s(1, 'fadeOut')), 'BGM 1 FADE OUT');
  assert.equal(val(s(1, 'fadeOut')), '하우스 음악 · 3s', '빈 페이드 시간은 기본 3초');
  assert.equal(val(s(1, 'volume', 2, 60)), '하우스 음악 · 60% 2s');
  assert.equal(head(s(9, 'fadeIn', 4, 70)), 'BGM 9 FADE IN');
  assert.equal(val(s(9, 'fadeIn', 4, 70)), '4s · → 70%');
  assert.equal(head(s(1, 'stop')), 'BGM 1 STOP');
  assert.equal(head(s(1, 'volume')), 'BGM 1 VOL');
  const none = FE.cueHead(cue('sound', { track: null, action: 'play', timeSec: null, level: null }, { status: 'tbd' }), look);
  assert.deepEqual([none.head, none.miss], ['BGM 미정 PLAY', true]);
});

test('출연: 사람 IN/OUT/MOVE, 설명은 상세', () => {
  assert.equal(head(cue('cast', { personId: 'p-yejun', move: 'out', text: '' })), '조예준 OUT');
  assert.equal(head(cue('cast', { personId: 'p-yejun', move: 'move', text: '' })), '조예준 MOVE');
  const c = cue('cast', { personId: 'p-daehoon', move: 'in', text: '마이크 들고' }, { trigger: '액트 후' });
  assert.equal(head(c), '박대훈 IN');
  assert.deepEqual(plain(FE.cueDetail(c, look)), { val: '', note: '마이크 들고', when: '액트 후', memo: '' });
  assert.equal(FE.cueText(c, look), '박대훈 IN — 마이크 들고');
  const none = FE.cueHead(cue('cast', { personId: null, move: 'in', text: '' }, { status: 'tbd' }), look);
  assert.deepEqual([none.head, none.miss, none.tbd], ['출연자 미정 IN', true, true]);
});

test('무대: 소품마다 소품 액션, 위치는 값', () => {
  const props = [{ propId: 'pr-hat', action: 'out', at: '' }, { propId: 'pr-cup', action: 'in', at: '탑햇테이블' }];
  assert.equal(head(cue('stage', { text: '', props })), '탑햇 OUT · 컵 IN');
  assert.equal(val(cue('stage', { text: '', props })), '컵 → 탑햇테이블');
  assert.equal(val(cue('stage', { text: '', props: [props[1]] })), '→ 탑햇테이블', '하나면 이름 없이');
  assert.equal(head(cue('stage', { text: '', props: [{ propId: 'pr-x', action: 'move', at: '' }] }), { person: look.person, track: look.track }), 'pr-x MOVE', 'look.prop 이 없으면 id 그대로');
});

test('상세(note)가 있으면 그것이 상세 — 같은 문장은 한 번만', () => {
  const c = cue('cast', { personId: 'p-yejun', move: 'in' }, { note: '마이크 들고' });
  assert.equal(FE.cueDetail(c, look).note, '마이크 들고');
  const tbd = cue('light', { channels: [], anim: '' }, { status: 'tbd', note: '조명 상세 미정' });
  assert.equal(FE.cueDetail(tbd, look).note, '', '미정만 다시 적은 상세도 거른다');
});
