// 공연 전 점검 규칙 (index.html 의 checkCollect / checkFilter / checkNav) — 역할 필터, 심각도, 씬 경계 IN/OUT, 소품 미등록, 음원 묶기
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// index.html 의 "상수"·"유틸" 구간과 "점검: 규칙" 구간만 떼어 Node 에서 돌린다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cut = (from) => {
    const a = html.indexOf('/* ================= ' + from), b = html.indexOf('/* =================', a + 10);
    assert.ok(a > 0 && b > a, `index.html 에서 ${from} 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)`);
    return html.slice(a, b);
  };
  return vm.runInNewContext(cut('상수') + cut('유틸') + cut('점검: 규칙') + '\n;({ checkCollect, checkFilter, checkNav, ckNavIndex, CK_GROUPS })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o)); // vm 쪽 객체는 프로토타입이 달라 deepEqual 전에 평범한 객체로

// 작은 공연 하나: show 와 entries(문서 순서)를 만들고 checkCollect 의 입력을 꾸린다
let n = 0;
const cue = (dept, body, extra) => Object.assign({ id: 'q' + (++n), dept, trigger: '대사 끝', offsetSec: null, memo: '', status: 'set', [dept]: body }, extra);
const castCue = (pid, move, extra) => cue('cast', { personId: pid, move, text: '' }, extra);
const item = (cues, comments) => ({ id: 'i' + (++n), kind: 'action', text: '', cues: cues || [], comments: comments || [] });
const scene = (id, type, cast, items, comments) => ({ id, type, title: id, cast, items, comments: comments || [] });
const people = { a: '박대훈', b: '조예준', c: '라태형' };
function input(show, over) {
  const entries = [];
  let q = 0;
  show.parts.forEach(p => p.scenes.forEach(s => s.items.forEach(it => entries.push({ item: it, scene: s, q: it.cues.length ? String(++q) : null }))));
  return Object.assign({
    show, entries, sceneTitle: s => s.title, pname: id => people[id] || '?', hasPerson: id => id in people,
    cueText: c => c.dept === 'cast' ? c.cast.personId + ' ' + c.cast.move : 'x', trackByNo: no => show.tracks.find(t => t.no === no) || null,
    hasFile: t => !!t.fileKey, useCount: () => 1, propIssues: () => [], fileWhere: '서버에'
  }, over || {});
}
const showOf = (scenes, extra) => Object.assign({ parts: [{ id: 'p1', name: '1부', scenes }], tracks: [], props: [] }, extra);
const keys = v => plain(Object.fromEntries(v.groups.filter(g => g.list.length).map(g => [g.k, g.list.length])));

test('역할 필터: 부서는 자기 부서 + 공통, 공연자는 자기 IN/OUT + 자기가 나오는 씬의 공통 항목', () => {
  const s = showOf([
    scene('s1', 'act', ['a'], [
      item([cue('light', { channels: [], anim: '' }, { status: 'tbd' }), cue('sound', { track: 1, action: 'play' }, { status: 'tbd' })]),
      item([castCue('a', 'in'), castCue('a', 'in')], [{ id: 'c1', author: '연출', text: '확인', resolved: false }])
    ]),
    scene('s2', 'act', ['b'], [item([cue('stage', { text: '테이블', props: [] }, { trigger: '' })])], [{ id: 'c2', author: '연출', text: '씬 코멘트', resolved: false }]),
    scene('s3', 'act', ['c'], [])
  ], { tracks: [{ id: 't1', no: 1, title: '음악', fileKey: null }] });
  const r = FE.checkCollect(input(s));
  assert.deepEqual(keys(FE.checkFilter(r, 'all')), { cast: 1, tbd: 2, trig: 1, files: 1, empty: 1, cmt: 2 });
  assert.deepEqual(keys(FE.checkFilter(r, 'light')), { tbd: 1, empty: 1, cmt: 2 });
  assert.deepEqual(keys(FE.checkFilter(r, 'sound')), { tbd: 1, files: 1, empty: 1, cmt: 2 });
  assert.deepEqual(keys(FE.checkFilter(r, 'stage')), { trig: 1, empty: 1, cmt: 2 });
  // 박대훈(a): 자기 IN 반복 + s1 의 문단 코멘트. s2 씬 코멘트·s3 빈 액트는 남의 씬
  assert.deepEqual(keys(FE.checkFilter(r, 'p:a')), { cast: 1, cmt: 1 });
  assert.deepEqual(keys(FE.checkFilter(r, 'p:c')), { empty: 1 });
  // 전체 보기: 역할은 그대로 두고 목록만 전부
  const all = FE.checkFilter(r, 'light', true);
  assert.equal(all.filtered, false);
  assert.deepEqual(keys(all), keys(FE.checkFilter(r, 'all')));
});

test('심각도: 막힘 → 확인 → 참고 순, 건수는 막힘+확인(참고 제외)이고 음원 파일은 몇 곡이든 한 건', () => {
  const sev = plain(FE.CK_GROUPS.map(g => g.sev));
  assert.deepEqual(sev, [...sev].sort((x, y) => ['block', 'check', 'info'].indexOf(x) - ['block', 'check', 'info'].indexOf(y)));
  const bySev = k => FE.CK_GROUPS.find(g => g.k === k).sev;
  assert.deepEqual(plain(['track', 'light', 'cast', 'props'].map(bySev)), ['block', 'block', 'block', 'block']);
  assert.deepEqual(['tbd', 'trig', 'noprops', 'files'].map(bySev), ['check', 'check', 'check', 'check']);
  assert.deepEqual(['empty', 'cmt'].map(bySev), ['info', 'info']);
  const s = showOf([
    scene('s1', 'act', [], [item([cue('light', { channels: [], anim: '' }), cue('sound', { track: 9, action: 'play' }, { status: 'tbd' })], [{ id: 'c', author: 'x', text: 'y', resolved: false }])]),
    scene('s2', 'act', [], [])
  ], { tracks: [1, 2, 3].map(i => ({ id: 't' + i, no: i, title: '', fileKey: i === 2 ? 'k' : null })) });
  const v = FE.checkFilter(FE.checkCollect(input(s)), 'all');
  assert.deepEqual(keys(v), { track: 1, light: 1, tbd: 1, files: 2, empty: 1, cmt: 1 });
  assert.equal(v.block, 2);
  assert.equal(v.total, 4); // 막힘 2 + 미정 1 + 음원 묶음 1
  assert.equal(v.info, 2);
  assert.deepEqual({ ...v.files }, { have: 1, total: 3 });
});

test('씬 경계: 마지막 큐의 IN 이 다음 씬 출연에 있으면, 첫 큐의 OUT 이 앞 씬 출연에 있으면 뺀다', () => {
  const s = showOf([
    scene('mc1', 'mc', ['b'], [item([castCue('b', 'in')]), item([castCue('a', 'in')]), item()]), // a: 마지막 큐 문단의 IN → 다음 씬(act1) 출연에 있음
    scene('act1', 'act', ['a'], [item([castCue('b', 'out')]), item([castCue('c', 'in')]), item([cue('light', { channels: [{ ch: 'top', action: 'on' }], anim: '' })])]),
    scene('mc2', 'mc', ['c'], [item([castCue('a', 'out')]), item([castCue('c', 'out')])])
  ]);
  const v = FE.checkFilter(FE.checkCollect(input(s)), 'all');
  const cl = plain(v.groups.find(g => g.k === 'castlist').list.map(x => x.text));
  // b OUT: act1 첫 큐 문단이고 앞 씬(mc1) 출연에 b → 뺌
  // c IN: act1 의 마지막 큐 문단이 아님(뒤에 조명 큐) → 남음
  // a OUT: mc2 첫 큐 문단, 앞 씬(act1) 출연에 a → 뺌
  assert.deepEqual(cl, ['Q4 · act1 — 라태형 IN 큐가 있지만 씬 출연에 없음']);
  assert.equal(v.groups.find(g => g.k === 'castlist').list[0].fix.person, 'c');
  // 다음 씬 출연에 없으면 경계라도 남긴다
  const s2 = showOf([scene('x', 'mc', [], [item([castCue('a', 'in')])]), scene('y', 'act', ['b'], [])]);
  assert.equal(keys(FE.checkFilter(FE.checkCollect(input(s2)), 'all')).castlist, 1);
});

test('소품: 목록이 비어 있는데 무대 큐가 있으면 검사하지 않고 propsSkip, 목록이 있으면 검사', () => {
  let called = 0;
  const issues = () => { called++; return [{ e: null, text: '컵 IN 인데 이미 무대에 있음' }]; };
  const sc = [scene('s', 'act', [], [item([cue('stage', { text: '', props: [{ propId: 'x', action: 'in' }] })])])];
  const r1 = FE.checkCollect(input(showOf(sc), { propIssues: issues }));
  assert.equal(r1.propsSkip, true);
  assert.equal(called, 0);
  assert.equal(FE.checkFilter(r1, 'stage').propsSkip, true);
  assert.equal(FE.checkFilter(r1, 'light').propsSkip, false); // 조명 화면에는 안 보인다
  const r2 = FE.checkCollect(input(showOf(sc, { props: [{ id: 'x', name: '컵' }] }), { propIssues: issues }));
  assert.equal(r2.propsSkip, false);
  assert.deepEqual(plain(r2.groups.find(g => g.k === 'props').list.map(x => [x.text, !!x.pv])), [['공연 전 무대 — 컵 IN 인데 이미 무대에 있음', true]]);
});

test('음원 묶기: "다음" 순서에서 파일 없는 트랙은 한 줄, 트랙 key 는 그 줄 위치로, 접힌 그룹은 건너뜀', () => {
  const s = showOf([scene('s', 'act', [], [item([cue('light', { channels: [], anim: '' }, { status: 'tbd' })])]), scene('e', 'act', [], [])], { tracks: [1, 2].map(i => ({ id: 't' + i, no: i, title: 'T' + i, fileKey: null })) });
  const v = FE.checkFilter(FE.checkCollect(input(s)), 'all');
  const nav = FE.checkNav(v, {});
  assert.deepEqual(plain(nav.map(x => x.key.split('|')[0])), ['tbd', 'files']); // 빈 액트는 기본으로 접혀 있다
  assert.deepEqual(plain(FE.checkNav(v, { empty: true }).map(x => x.key.split('|')[0])), ['tbd', 'files', 'empty']);
  assert.equal(nav[1].bundle, true);
  assert.equal(nav[1].track, 't1');
  const t2 = v.groups.find(g => g.k === 'files').list[1];
  assert.equal(t2.track, 't2');
  assert.equal(FE.ckNavIndex(nav, t2.key), 1);
  assert.equal(FE.ckNavIndex(nav, 'nope'), -1);
});

test('실제 공연 데이터(backstage-part1): 씬 경계 IN 3건이 빠지고 역할별 건수가 갈린다', () => {
  const show = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
  const r = FE.checkCollect(input(show, { pname: id => (show.people.find(p => p.id === id) || {}).name, hasPerson: id => show.people.some(p => p.id === id) }));
  const all = FE.checkFilter(r, 'all');
  // 2026-11-18 배포본(rev 84) 기준: 미정은 조명 2(암전 7초 뒤 조명 On ×2) + 음향 1(하우스 음악 VOLUME "확인 필요").
  // 객석 조명 4개는 현장에서 확정(set)으로 바뀌어 빠졌다
  assert.deepEqual(keys(all), { tbd: 3, files: 7, empty: 4, cmt: 1 });
  assert.equal(all.total, 4);
  assert.equal(all.info, 5);
  // 소품 8개를 등록하고 무대 큐 3개에 소품을 지정했다 — 소품 검사가 켜지고, 소품 미지정 무대 큐는 없다
  assert.equal(r.propsSkip, false);
  assert.deepEqual(plain(r.groups.find(g => g.k === 'noprops').list), []);
  assert.equal(FE.checkFilter(r, 'light').total, 2);
  assert.equal(FE.checkFilter(r, 'sound').total, 2);
  assert.equal(FE.checkFilter(r, 'stage').total, 0);
  assert.equal(FE.checkFilter(r, 'p:p-daehoon').total, 0);
});

test('소품 미지정 무대 큐(v8): 확정 무대 큐에 소품이 없으면 "확인" 항목, 미정·소품 있는 큐는 아님, 소품 목록이 비면 propsSkip 에 흡수', () => {
  const stage = (props, extra) => cue('stage', { props }, extra);
  const sc = [scene('s', 'mc', [], [
    item([stage([], { note: '컵 빼고' })]),
    item([stage([], { status: 'tbd' })]),
    item([stage([{ propId: 'x', action: 'clean', at: '' }])])
  ])];
  const r = FE.checkCollect(input(showOf(sc, { props: [{ id: 'x', name: '카드' }] })));
  assert.equal(r.propsSkip, false);
  const g = r.groups.find(x => x.k === 'noprops');
  assert.equal(g.sev, 'check');
  assert.deepEqual(plain(g.list.map(x => [x.dept, x.item])), [['stage', sc[0].items[0].id]], '클릭하면 그 문단(item)으로');
  assert.equal(FE.checkFilter(r, 'stage').total, 2, '소품 미지정 1 + 미정 1');
  assert.equal(FE.checkFilter(r, 'light').total, 0);
  // 소품 목록이 비면 그 한 줄로 흡수
  const r2 = FE.checkCollect(input(showOf(sc)));
  assert.equal(r2.propsSkip, true);
  assert.deepEqual(plain(r2.groups.find(x => x.k === 'noprops').list), []);
});
