// 큐 번호(item.label)
//  - 사이트(index.html "큐 번호" 구간): 늘 1부터 연속. 편집 저장 때 relabel, 불러오기·렌더는 빠진 번호만 채움(fillLabels)
//  - 서버 MCP(lib/labels.js): 같은 함수를 옮긴 것 — op 적용 뒤 relabel. 아래에서 브라우저 함수와 결과를 대조한다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const LIB = require('../lib/labels');

// test/validate.test.js 와 같은 방식: index.html 의 "상수" ~ "상태" 구간(번호 함수·migrate 포함)만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  return vm.runInNewContext(html.slice(a, b) + '\n;({ relabel, fillLabels, labelsInOrder, renumberLabels, sampleShow, migrate })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));
const items = s => s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items));
const cueLabels = s => items(s).filter(i => i.cues.length).map(i => i.label);
const backstage = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
// 예전 규칙(번호 고정·사이에 끼우면 소수)으로 저장된 데이터 흉내: 앞 문단 번호 + ".1"
function legacyDecimal(show) {
  let prev = '0';
  items(show).forEach(i => { if (!i.cues.length) return; if (i.label == null) i.label = prev.split('.')[0] + '.1'; prev = i.label; });
}
const seq = n => Array.from({ length: n }, (_, k) => String(k + 1));
const newCueItem = id => ({ id, kind: 'action', speaker: null, text: '(새 큐)', label: null, isCue: true, cues: [{ id: id + 'q', dept: 'stage', trigger: '', offsetSec: null, memo: '', status: 'set', stage: { text: 'x', props: [] } }], comments: [] });

test('사이트: 이미 1부터 연속이면 relabel 은 아무것도 바꾸지 않는다', () => {
  const s = backstage();
  assert.equal(FE.labelsInOrder(s), true);
  const before = JSON.stringify(s);
  assert.equal(FE.relabel(s), false);
  assert.equal(JSON.stringify(s), before);
});

test('사이트: 큐를 끼우거나·지우거나·옮기거나·소수 번호가 있으면 relabel 이 1부터 연속으로', () => {
  // 사이에 끼움 (번호 없음)
  const a = backstage(); a.parts[0].scenes[1].items.splice(1, 0, newCueItem('n1'));
  assert.equal(FE.relabel(a), true);
  assert.deepEqual(cueLabels(a), seq(cueLabels(a).length));
  // 큐를 다 지운 문단: 번호도 없앤다
  const b = backstage(); const it = items(b).find(i => i.cues.length); it.cues = []; it.isCue = false;
  assert.equal(FE.relabel(b), true);
  assert.equal(it.label, null);
  assert.deepEqual(cueLabels(b), seq(cueLabels(b).length));
  // 큐를 다른 문단으로 (패널 이동과 같은 데이터 변경): 순서가 바뀌면 다시 매김
  const c = backstage(); const all = items(c); const src = all.find(i => i.cues.length >= 2); const dst = all[0].cues.length ? all.find(i => !i.cues.length) : all[0];
  dst.cues.push(src.cues.pop()); dst.isCue = true;
  FE.relabel(c);
  assert.equal(FE.labelsInOrder(c), true);
  // 서버 MCP 가 매긴 소수 번호
  const d = backstage(); d.parts[0].scenes[2].items.splice(0, 0, newCueItem('n2'));
  legacyDecimal(d);
  assert.ok(cueLabels(d).some(l => l.includes('.')), '예전 규칙의 소수 번호');
  FE.relabel(d);
  assert.deepEqual(cueLabels(d), seq(cueLabels(d).length));
  assert.ok(!items(d).some(i => !i.cues.length && i.label != null));
});

test('사이트: 불러오기·렌더(migrate·fillLabels)는 저장된 번호를 다시 매기지 않는다 — 빠진 번호가 있을 때만 채운다', () => {
  // 예전 규칙의 소수 번호가 남은 공연을 그대로 연다 → 번호 그대로 (열기만 해서 서버 이력에 변경이 생기지 않게)
  const d = backstage(); d.parts[0].scenes[2].items.splice(0, 0, newCueItem('n2')); legacyDecimal(d);
  const want = cueLabels(d);
  const m = plain(FE.migrate(plain(d)));
  assert.deepEqual(cueLabels(m), want);
  assert.equal(FE.fillLabels(m), false);
  assert.deepEqual(cueLabels(m), want);
  // 번호 없이 올린 파일(문서 예시처럼 label:null) → 화면용으로 1부터
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'cue-format.md'), 'utf8');
  const ex = JSON.parse(/```json\n([\s\S]*?)```/.exec(md)[1]);
  assert.deepEqual(cueLabels(plain(FE.migrate(ex))), ['1', '2']);
  // 샘플은 처음부터 연속
  assert.equal(FE.labelsInOrder(plain(FE.migrate(FE.sampleShow()))), true);
});

// 결정적 의사 난수 (테스트가 매번 같게)
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
// 같은 입력에 브라우저 함수와 lib 함수를 돌려 반환값과 결과 번호가 같은지
function same(show, msg) {
  for (const fn of ['labelsInOrder', 'relabel', 'fillLabels']) {
    const a = plain(show), b = plain(show);
    assert.equal(LIB[fn](a), FE[fn](b), `${msg} — ${fn} 반환값`);
    assert.deepEqual(items(a).map(i => i.label), items(b).map(i => i.label), `${msg} — ${fn} 결과`);
  }
}

test('lib/labels.js 는 브라우저 함수와 같다: 그대로 · 끼우기 · 지우기 · 옮기기 · 번호 지움 · 소수 번호', () => {
  same(backstage(), '그대로');
  const r = rng(7);
  for (let k = 0; k < 40; k++) {
    const t = backstage(), all = items(t);
    t.parts[0].scenes.forEach(sc => { if (r() < 0.3) sc.items.splice(Math.floor(r() * (sc.items.length + 1)), 0, newCueItem('n-' + sc.id)); });
    all.forEach(i => { if (i.cues.length && r() < 0.1) { i.cues = []; i.isCue = false; } });
    all.forEach(i => { if (r() < 0.15) i.label = null; });
    if (r() < 0.5) legacyDecimal(t);
    const sc = t.parts[0].scenes[Math.floor(r() * t.parts[0].scenes.length)];
    if (sc.items.length > 1) sc.items.push(sc.items.shift()); // 문단 순서 바꾸기
    same(t, `무작위 #${k}`);
  }
  same(plain(FE.migrate(FE.sampleShow())), '프런트 샘플');
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'cue-format.md'), 'utf8');
  same(JSON.parse(/```json\n([\s\S]*?)```/.exec(md)[1]), '문서 예시');
});

test('큐 지점(kind:"cue")도 큐가 있는 문단이라 번호 대상 — 사이트와 lib 가 같다', () => {
  const t = backstage();
  const sc = t.parts[0].scenes[1];
  sc.items.splice(1, 0, Object.assign(newCueItem('pt'), { kind: 'cue', text: '' }));
  same(t, '큐 지점 끼우기');
  FE.relabel(t);
  assert.ok(items(t).find(i => i.id === 'pt').label != null);
  assert.deepEqual(cueLabels(t), seq(cueLabels(t).length));
});

test('lib/labels.js: 배열이 빠진 서버 데이터도 던지지 않는다', () => {
  const s = { parts: [{ scenes: [{ items: [{ id: 'a', label: '3', cues: [{}] }, { id: 'b', label: '9' }, null] }, {}] }, {}] };
  assert.equal(LIB.relabel(s), true);
  assert.deepEqual(s.parts[0].scenes[0].items.slice(0, 2).map(i => i.label), ['1', null]);
});
