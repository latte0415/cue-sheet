// 큐시트 표 열 너비·접기 (index.html "상수" 구간) — 이 기기 prefs csColW · csFold 정리와 표 레이아웃 계산
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// test/labels.test.js 와 같은 방식: index.html 의 "상수" ~ "상태" 구간만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  return vm.runInNewContext(html.slice(a, b) + '\n;({ CS_COLS, CS_COL_W, CS_W_MAX, CS_Q_FILL, CS_STRIP_W, csClampW, csColWPrefs, csFoldPrefs, csLayout })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));

test('csClampW: 열마다 최소~최대로 자르고 반올림, 숫자가 아니거나 모르는 열이면 null', () => {
  assert.equal(FE.csClampW('cast', 10), FE.CS_COL_W.cast[1]);
  assert.equal(FE.csClampW('num', 0), FE.CS_COL_W.num[1]);
  assert.equal(FE.csClampW('memo', 99999), FE.CS_W_MAX);
  assert.equal(FE.csClampW('light', 151.6), 152);
  assert.equal(FE.csClampW('light', NaN), null);
  assert.equal(FE.csClampW('light', Infinity), null);
  assert.equal(FE.csClampW('light', '200'), null, '문자열 숫자는 받지 않는다');
  assert.equal(FE.csClampW('nope', 200), null);
});

test('csColWPrefs: 아는 열 키의 숫자만 남기고 범위 안으로, 객체가 아니면 빈 객체', () => {
  assert.deepEqual(plain(FE.csColWPrefs({ q: 400, cast: 5, sound: 'x', memo: null, bogus: 300, stage: 2000 })), { q: 400, cast: 60, stage: FE.CS_W_MAX });
  for (const bad of [null, undefined, 3, 'a', [1, 2], true]) assert.deepEqual(plain(FE.csColWPrefs(bad)), {});
});

test('csFoldPrefs: 부서 키만, 중복 없이 부서 순서대로', () => {
  assert.deepEqual(plain(FE.csFoldPrefs(['stage', 'sound', 'stage', 'memo', 1])), ['sound', 'stage']);
  assert.deepEqual(plain(FE.csFoldPrefs('sound')), []);
  assert.deepEqual(plain(FE.csFoldPrefs(null)), []);
});

test('csLayout: 기본은 큐 열이 남는 폭(fill) — 최소 너비 = 나머지 기본 합 + 큐 최소', () => {
  const L = FE.csLayout({}, []);
  assert.equal(L.fill, true);
  assert.equal(L.w.q, null);
  const others = FE.CS_COLS.filter(k => k !== 'q').reduce((n, k) => n + FE.CS_COL_W[k][0], 0);
  assert.equal(L.total, others + FE.CS_Q_FILL);
});

test('csLayout: 접힌 열은 띠 너비(저장된 너비보다 우선), 큐 열을 정하면 표 너비 = 열 합', () => {
  const L = FE.csLayout({ sound: 300, q: 500 }, ['sound', 'stage']);
  assert.equal(L.w.sound, FE.CS_STRIP_W);
  assert.equal(L.w.stage, FE.CS_STRIP_W);
  assert.equal(L.fill, false);
  assert.equal(L.total, Object.values(plain(L.w)).reduce((n, v) => n + v, 0));
});
