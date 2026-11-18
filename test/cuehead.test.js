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
    q('stage', { props: [{ propId: 'pr-a', action: 'out', at: '' }, { propId: 'pr-gone', action: 'in', at: '테이블' }] }, { note: '천천히' }),
    q('stage', { text: '', props: [] }, { status: 'tbd' }),
    q('cast', { personId: 'p-gone', move: 'move' }, { trigger: '암전 후', offsetSec: 3, memo: '확인' }),
    q('cast', { personId: null, move: 'out', text: '' })
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
