// lib/labels.js — index.html 의 assignLabels 와 같은 번호를 매기는지 실제 브라우저 함수와 대조한다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { assignLabels } = require('../lib/labels');

// test/validate.test.js 와 같은 방식: index.html 의 "상수" ~ "상태" 구간(라벨 함수 포함)만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  return vm.runInNewContext(html.slice(a, b) + '\n;({ assignLabels, sampleShow, migrate })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));
const items = s => s.parts.flatMap(p => p.scenes.flatMap(sc => sc.items));
const backstage = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));

// 같은 입력에 두 함수를 돌려 반환값과 결과 라벨이 같은지
function same(show, msg) {
  const a = plain(show), b = plain(show);
  const ra = assignLabels(a), rb = FE.assignLabels(b);
  assert.equal(ra, rb, msg + ' (반환값)');
  assert.deepEqual(items(a).map(i => i.label), items(b).map(i => i.label), msg);
  return items(a).map(i => i.label);
}
// 결정적 의사 난수 (테스트가 매번 같게)
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

test('backstage-part1: 그대로 / 라벨 전부 지움 / 일부 지움', () => {
  const s = backstage();
  same(s, '그대로');
  const cleared = backstage(); items(cleared).forEach(i => { i.label = null; });
  const labels = same(cleared, '전부 지움');
  assert.deepEqual(labels.filter(Boolean).slice(0, 3), ['1', '2', '3']);
  const r = rng(7);
  for (let k = 0; k < 20; k++) {
    const t = backstage();
    items(t).forEach(i => { if (r() < 0.3) i.label = null; });
    same(t, `일부 지움 #${k}`);
  }
});

test('사이에 끼운 큐 문단: 앞 번호 + .k, 맨 앞은 0.k, 맨 뒤는 다음 정수', () => {
  const r = rng(42);
  for (let k = 0; k < 20; k++) {
    const t = backstage();
    t.parts[0].scenes.forEach(sc => {
      const at = Math.floor(r() * (sc.items.length + 1));
      if (r() < 0.6) sc.items.splice(at, 0, { id: 'new-' + sc.id, kind: 'action', speaker: null, text: '(새 큐)', label: null, isCue: true, cues: [{ id: 'nq-' + sc.id, dept: 'stage', stage: { text: 'x' } }], comments: [] });
    });
    same(t, `끼우기 #${k}`);
  }
  const t = backstage();
  const first = t.parts[0].scenes[0];
  first.items.unshift({ id: 'n0', label: null, cues: [{ id: 'n0q', dept: 'stage' }] });
  first.items.unshift({ id: 'n00', label: null, cues: [{ id: 'n00q', dept: 'stage' }] });
  const labels = same(t, '맨 앞 두 개');
  assert.deepEqual(labels.slice(0, 2), ['0.1', '0.2']);
});

test('프런트 샘플과 문서 예시', () => {
  const s = plain(FE.migrate(FE.sampleShow()));
  items(s).forEach(i => { i.label = null; });
  same(s, '샘플 라벨 지움');
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'cue-format.md'), 'utf8');
  const ex = JSON.parse(/```json\n([\s\S]*?)```/.exec(md)[1]);
  assert.deepEqual(same(ex, '문서 예시'), ['1', '2']);
});

test('번호가 다 있으면 false, 큐 없는 문단의 옛 라벨은 그대로', () => {
  const s = backstage();
  assert.equal(assignLabels(s), false);
  const it = items(s).find(i => i.cues.length);
  it.cues = [];
  assert.equal(assignLabels(s), false);
  assert.ok(it.label != null, '큐를 다 지워도 번호는 남는다');
});
