// 씬 시간표 (index.html 의 showTimeline / spanSec / fmtSpan) — 내비 시작 시각·파트 합계·전체 합계, 런 "다음 내 큐까지 약 n분"
// + 내비 출연자 요약 (shortNames / castShort)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// index.html 의 "씬 시간 · 짧은 이름" 구간만 떼어 Node 에서 돌린다
function frontend() {
  const a = HTML.indexOf('/* ================= 씬 시간'), b = HTML.indexOf('/* =================', a + 10);
  assert.ok(a > 0 && b > a, 'index.html 에서 "씬 시간" 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  return vm.runInNewContext(HTML.slice(a, b) + '\n;({ fmtDur, sceneDur, showTimeline, spanSec, fmtSpan, shortNames, castShort })', {});
}
const FE = frontend();
const backstage = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
const sc = (id, durationSec) => ({ id, durationSec });
const show = (...parts) => ({ parts: parts.map((scenes, i) => ({ id: 'pt' + i, scenes })) });
const plain = o => JSON.parse(JSON.stringify(o)); // vm 안에서 만든 배열은 프로토타입이 달라 deepEqual 전에 옮긴다
const starts = tl => plain(tl.list.map(x => (x.approx ? '~' : '') + FE.fmtDur(x.start)));

test('누적: 시작 시각 = 앞 씬 길이의 합, 파트를 넘어 이어진다', () => {
  const tl = FE.showTimeline(show([sc('a', 60), sc('b', 150)], [sc('c', 90), sc('d', 30)]));
  assert.deepEqual(plain(tl.list.map(x => x.start)), [0, 60, 210, 300]);
  assert.deepEqual(starts(tl), ['0:00', '1:00', '3:30', '5:00']);
  assert.equal(tl.scenes.get('c').start, 210);
  assert.equal(tl.total.sum, 330);
  assert.equal(tl.total.missing, 0);
  assert.equal(FE.fmtSpan(tl.total.sum, tl.total.missing), '5:30');
});

test('비어 있는 길이: 0으로 세고, 그 뒤 씬부터 approx — 그 씬 자체의 시작은 정확', () => {
  const tl = FE.showTimeline(show([sc('a', 60), sc('b', null), sc('c', 120), sc('d', 30)]));
  assert.deepEqual(starts(tl), ['0:00', '1:00', '~1:00', '~3:00']);
  assert.equal(tl.scenes.get('b').dur, null);
  assert.equal(tl.scenes.get('b').approx, false);
  assert.equal(tl.scenes.get('c').approx, true);
  assert.deepEqual(plain(tl.total), { sum: 210, missing: 1, count: 4 });
});

test('잘못된 길이(음수·문자·NaN·undefined)는 빈 길이로', () => {
  for (const v of [-5, '60', NaN, undefined, Infinity]) assert.equal(FE.sceneDur({ durationSec: v }), null, String(v));
  assert.equal(FE.sceneDur({ durationSec: 0 }), 0);
  const tl = FE.showTimeline(show([sc('a', 0), sc('b', 30)]));
  assert.deepEqual(starts(tl), ['0:00', '0:00']); // 0 은 "비어 있음"이 아니다
});

test('파트 합계: 파트마다 길이 합 · 빈 씬 수 · 시작 시각, 앞 파트의 빈 씬은 다음 파트 시작을 approx 로', () => {
  const tl = FE.showTimeline(show([sc('a', 600), sc('b', null)], [sc('c', 300), sc('d', null), sc('e', null)], []));
  assert.equal(tl.parts.length, 3);
  const p = tl.parts.map(x => [x.start, x.approx, x.sum, x.missing, x.count]);
  assert.deepEqual(plain(p), [[0, false, 600, 1, 2], [600, true, 300, 2, 3], [900, true, 0, 0, 0]]);
  assert.equal(FE.fmtSpan(tl.parts[0].sum, tl.parts[0].missing), '10:00 + 미정 1씬');
  assert.equal(FE.fmtSpan(tl.parts[1].sum, tl.parts[1].missing), '5:00 + 미정 2씬');
  // 전체 = 파트 합의 합
  assert.equal(tl.total.sum, tl.parts.reduce((n, x) => n + x.sum, 0));
  assert.equal(tl.total.missing, tl.parts.reduce((n, x) => n + x.missing, 0));
});

test('fmtSpan / fmtDur 표기', () => {
  assert.equal(FE.fmtSpan(0, 0), '0:00');
  assert.equal(FE.fmtSpan(0, 3), '미정 3씬');
  assert.equal(FE.fmtSpan(1140, 0), '19:00');
  assert.equal(FE.fmtSpan(1140, 8), '19:00 + 미정 8씬');
  assert.equal(FE.fmtDur(4350), '72:30'); // 60분을 넘어도 분으로
  assert.equal(FE.fmtDur(null), '—');
});

test('spanSec: list[from] ~ list[to-1] 합 — 런 "다음 내 큐까지 약 n분" 과 내비 시작 시각 차이가 같다', () => {
  const tl = FE.showTimeline(show([sc('a', 60), sc('b', 120)], [sc('c', null), sc('d', 45), sc('e', 30)]));
  assert.deepEqual(plain(FE.spanSec(tl, 0, 2)), { sum: 180, missing: 0, known: true });
  assert.deepEqual(plain(FE.spanSec(tl, 2, 3)), { sum: 0, missing: 1, known: false });
  assert.deepEqual(plain(FE.spanSec(tl, 1, 5)), { sum: 195, missing: 1, known: true });
  assert.deepEqual(plain(FE.spanSec(tl, 3, 3)), { sum: 0, missing: 0, known: false });
  for (let i = 0; i < tl.list.length; i++) for (let j = i; j < tl.list.length; j++) {
    assert.equal(FE.spanSec(tl, i, j).sum, tl.list[j].start - tl.list[i].start, `${i}→${j}`);
  }
});

test('실데이터 backstage-part1: 길이 있는 액트 5개 = 12:00, 빈 씬 8개', () => {
  const s = backstage(), tl = FE.showTimeline(s);
  assert.equal(tl.total.count, 13);
  assert.equal(tl.total.sum, 60 + 180 + 180 + 180 + 120);
  assert.equal(tl.total.missing, 8);
  assert.equal(FE.fmtSpan(tl.parts[0].sum, tl.parts[0].missing), '12:00 + 미정 8씬');
  // 첫 씬(하우스 오픈)부터 길이가 비어 있으니 둘째 씬부터 전부 approx
  assert.deepEqual(starts(tl), ['0:00', '~0:00', '~0:00', '~1:00', '~1:00', '~4:00', '~4:00', '~7:00', '~7:00', '~10:00', '~10:00', '~12:00', '~12:00']);
});

test('shortNames: 한글 세 글자는 성을 빼고, 두·네 글자는 그대로, 띄어 쓴 이름은 한 단어', () => {
  const m = FE.shortNames([{ id: 'a', name: '박대훈' }, { id: 'b', name: '이훈' }, { id: 'c', name: '남궁민수' }, { id: 'd', name: 'Alex Kim' }, { id: 'e', name: '최 서연' }, { id: 'f', name: ' 조예준 ' }, { id: 'g', name: 'MC' }]);
  assert.deepEqual(Object.fromEntries(m), { a: '대훈', b: '이훈', c: '남궁민수', d: 'Alex', e: '서연', f: '예준', g: 'MC' });
});

test('shortNames: 줄인 이름이 겹치면 원래 이름, 원래 이름까지 같으면 순번', () => {
  const m = FE.shortNames([{ id: 'a', name: '김민수' }, { id: 'b', name: '이민수' }, { id: 'c', name: '박대훈' }]);
  assert.deepEqual(Object.fromEntries(m), { a: '김민수', b: '이민수', c: '대훈' });
  // 다른 사람의 원래 이름과 겹쳐도 원래 이름으로
  const m2 = FE.shortNames([{ id: 'a', name: '민수' }, { id: 'b', name: '김민수' }]);
  assert.deepEqual(Object.fromEntries(m2), { a: '민수', b: '김민수' });
  const m3 = FE.shortNames([{ id: 'a', name: '김민수' }, { id: 'b', name: '김민수' }, { id: 'c', name: '라태형' }]);
  assert.deepEqual(Object.fromEntries(m3), { a: '김민수(1)', b: '김민수(2)', c: '태형' });
});

test('castShort: 둘까지 "·", 셋 이상은 "+n", 나를 맨 앞으로, 모르는 id 는 ?', () => {
  const names = FE.shortNames(backstage().people);
  assert.equal(FE.castShort([], names), '');
  assert.equal(FE.castShort(['p-daehoon'], names), '대훈');
  assert.equal(FE.castShort(['p-daehoon', 'p-yejun'], names), '대훈·예준');
  assert.equal(FE.castShort(['p-yejun', 'p-taehyung', 'p-daehoon'], names), '예준·태형 +1');
  assert.equal(FE.castShort(['p-yejun', 'p-taehyung', 'p-daehoon'], names, 'p-daehoon'), '대훈·예준 +1');
  assert.equal(FE.castShort(['p-yejun', 'x'], names), '예준·?');
});
