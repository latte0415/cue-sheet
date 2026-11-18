// lib/merge.js — 409 때 브라우저가 쓸 3-way 병합 (기준 · 내 것 · 서버 것)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { mergeShows, hasAllIds } = require('../lib/merge');
const { applyOps } = require('../lib/ops');
const { validateShow } = require('../lib/validate');

// 다른 테스트와 같은 방식: index.html 의 "상수" ~ "상태" 구간(migrate·relabel)을 떼어 브라우저와 같은 정규화·번호 매기기를 쓴다
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('/* ================= 상수'), b = html.indexOf('/* ================= 상태');
  assert.ok(a > 0 && b > a, 'index.html 에서 상수~상태 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)');
  return vm.runInNewContext(html.slice(a, b) + '\n;({ relabel, labelsInOrder, migrate })', {});
}
const FE = frontend();
const plain = o => JSON.parse(JSON.stringify(o));
const migrate = s => plain(FE.migrate(s));
const relabel = s => FE.relabel(s); // 브라우저 save 처럼 큐 번호를 1부터 연속으로
const inOrder = s => FE.labelsInOrder(s);
const backstage = () => migrate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8')));
const merge = (b, l, r) => mergeShows(b, l, r, { relabel });

const scenes = s => s.parts.flatMap(p => p.scenes);
const items = s => scenes(s).flatMap(sc => sc.items);
function find(s, id) {
  for (const k of ['people', 'props', 'tracks']) { const x = (s[k] || []).find(y => y.id === id); if (x) return x; }
  for (const p of s.parts) {
    if (p.id === id) return p;
    for (const sc of p.scenes) {
      if (sc.id === id) return sc;
      for (const c of sc.comments) if (c.id === id) return c;
      for (const it of sc.items) {
        if (it.id === id) return it;
        for (const c of it.cues.concat(it.comments)) if (c.id === id) return c;
      }
    }
  }
  return null;
}
const parentOf = (s, id) => { for (const sc of scenes(s)) for (const it of sc.items) { if (it.cues.some(c => c.id === id)) return it.id; } return null; };
const ids = sc => sc.items.map(i => i.id);
// 서버 쪽 편집은 MCP 와 같게 applyOps 로 만들고, 브라우저가 받을 때처럼 migrate 를 거친다
const remoteOps = (base, ops) => migrate(applyOps(base, ops).show);
const newItem = (id, text, extra) => Object.assign({ id, kind: 'line', speaker: null, text, label: null, isCue: false, cues: [], comments: [] }, extra);
const soundCue = (id, track) => ({ id, dept: 'sound', trigger: '', offsetSec: null, memo: '', status: 'set', sound: { track, action: 'play', timeSec: null, level: null } });

test('바뀐 게 없으면 그대로, 한쪽만 바뀌면 그쪽', () => {
  const base = backstage();
  let r = merge(base, plain(base), plain(base));
  assert.ok(r.ok); assert.deepEqual(r.conflicts, []); assert.ok(r.sameAsRemote);
  assert.deepEqual(r.show, base);
  const remote = remoteOps(base, [{ op: 'set', id: 'i-k', fields: { text: '안녕하세요 서버' } }]);
  r = merge(base, plain(base), remote);
  assert.deepEqual(r.show, remote); assert.ok(r.sameAsRemote);
  const local = plain(base); find(local, 'i-k').text = '안녕하세요 로컬';
  r = merge(base, local, plain(base));
  assert.equal(find(r.show, 'i-k').text, '안녕하세요 로컬'); assert.ok(!r.sameAsRemote);
});

test('입력은 바꾸지 않고, 같은 입력이면 같은 결과', () => {
  const base = backstage(), local = plain(base), remote = remoteOps(base, [{ op: 'add', kind: 'item', parent: 's-v', after: 'i-l', data: { text: '서버 문단' } }]);
  local.parts[0].scenes[3].items.splice(1, 0, newItem('i-L1', '로컬 문단'));
  const snap = JSON.stringify([base, local, remote]);
  const a = merge(base, local, remote), b = merge(base, local, remote);
  assert.equal(JSON.stringify([base, local, remote]), snap);
  assert.deepEqual(a.show, b.show);
});

test('서로 다른 항목·필드를 고치면 충돌 없이 합친다', () => {
  const base = backstage();
  const remote = remoteOps(base, [
    { op: 'set', id: 'q-5', fields: { trigger: '서버 시점', sound: { timeSec: 4 } } },
    { op: 'set', id: 's-v', fields: { title: '서버 제목' } },
    { op: 'set', id: 'i-l', fields: { speaker: 'p-daehoon' } }
  ]);
  const local = plain(base);
  find(local, 'i-k').text = '로컬 본문';
  find(local, 'q-5').sound.track = 2;
  find(local, 'i-l').text = '로컬이 고친 i-l';
  find(local, 's-v').setup = '로컬 세팅';
  const r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  const m = r.show;
  assert.equal(find(m, 'i-k').text, '로컬 본문');
  assert.equal(find(m, 'q-5').trigger, '서버 시점');
  // 서버 쪽 level 100 은 ops 의 정리(volume 이면 level 없을 때 100) — 이 기기는 level 을 안 건드렸으니 서버 것
  assert.deepEqual(find(m, 'q-5').sound, { track: 2, action: 'volume', timeSec: 4, level: 100 }, '부서 객체는 안쪽 필드까지');
  assert.equal(find(m, 's-v').title, '서버 제목'); assert.equal(find(m, 's-v').setup, '로컬 세팅');
  assert.equal(find(m, 'i-l').speaker, 'p-daehoon'); assert.equal(find(m, 'i-l').text, '로컬이 고친 i-l');
  assert.deepEqual(validateShow(m).errors, []);
});

test('같은 필드: 같게 고치면 그대로, 다르게 고치면 충돌(결과는 서버 것) — 본문은 통째', () => {
  const base = backstage();
  const remote = remoteOps(base, [{ op: 'set', id: 'i-k', fields: { text: '서버 본문' } }, { op: 'set', id: 'i-m', fields: { text: '같은 값' } }]);
  const local = plain(base);
  find(local, 'i-k').text = find(base, 'i-k').text + ' 로컬 덧붙임';
  find(local, 'i-m').text = '같은 값';
  const r = merge(base, local, remote);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.equal(c.kind, 'item'); assert.equal(c.id, 'i-k'); assert.equal(c.type, 'field'); assert.deepEqual(c.fields, ['text']);
  assert.match(c.text, /예준 인사 멘트 › 「.+」 — 본문: 양쪽에서 다르게 고침/);
  assert.equal(find(r.show, 'i-k').text, '서버 본문');
  assert.equal(find(r.show, 'i-m').text, '같은 값');
});

test('추가: 양쪽 다 남고, 이 기기에서 넣은 것은 이 기기 이웃 옆에', () => {
  const base = backstage();
  const remote = remoteOps(base, [
    { op: 'add', kind: 'item', parent: 's-v', after: 'i-m', data: { id: 'i-R1', text: '서버 중간' } },
    { op: 'add', kind: 'item', parent: 's-v', data: { id: 'i-R2', text: '서버 끝' } }
  ]);
  const local = plain(base), sv = find(local, 's-v');
  sv.items.splice(1, 0, newItem('i-L1', '로컬 앞쪽'), newItem('i-L2', '로컬 앞쪽 2'));
  sv.items.push(newItem('i-L3', '로컬 끝'));
  const r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(ids(find(r.show, 's-v')), ['i-k', 'i-L1', 'i-L2', 'i-l', 'i-m', 'i-R1', 'i-n', 'i-p', 'i-q', 'i-s', 'i-u', 'i-L3', 'i-R2']);
});

test('삭제: 다른 쪽이 그대로면 삭제, 다른 쪽이 고쳤으면 충돌', () => {
  const base = backstage();
  // 서버가 지움 + 이 기기 그대로 → 삭제 / 이 기기가 지움 + 서버 그대로 → 삭제
  let remote = remoteOps(base, [{ op: 'remove', id: 'i-k' }]);
  let local = plain(base); find(local, 's-v').items = find(local, 's-v').items.filter(i => i.id !== 'i-n');
  let r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.equal(find(r.show, 'i-k'), null); assert.equal(find(r.show, 'i-n'), null);

  // 서버가 지움 + 이 기기가 본문 고침 → 충돌, 서버 쪽으로 정하면 지운 채
  local = plain(base); find(local, 'i-k').text = '로컬이 고침';
  r = merge(base, local, remote);
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].type, 'delete-remote');
  assert.match(r.conflicts[0].text, /다른 곳\(에이전트 등\)에서 지웠는데 이 기기에서 고침/);
  assert.equal(find(r.show, 'i-k'), null);

  // 이 기기가 지움 + 서버가 고침 → 충돌, 서버 쪽으로 정하면 서버 내용으로 되살림
  remote = remoteOps(base, [{ op: 'set', id: 'q-o', fields: { memo: '서버 메모' } }]);
  local = plain(base); find(local, 's-v').items = find(local, 's-v').items.filter(i => i.id !== 'i-p');
  r = merge(base, local, remote);
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].type, 'delete-local'); assert.equal(r.conflicts[0].id, 'i-p');
  assert.equal(find(r.show, 'q-o').memo, '서버 메모');
  assert.deepEqual(ids(find(r.show, 's-v')), ids(find(base, 's-v')), '제자리로');

  // 순서만 바꾼 것은 고친 것이 아니다
  remote = remoteOps(base, [{ op: 'remove', id: 'i-k' }]);
  local = plain(base); const sv = find(local, 's-v'); sv.items.push(sv.items.shift());
  r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []); assert.equal(find(r.show, 'i-k'), null);
});

test('씬 삭제 vs 그 안의 편집: 자식 단위 변경도 충돌, 충돌은 맨 위 항목 하나로', () => {
  const base = backstage();
  // 서버가 씬을 지움 + 이 기기가 그 씬의 문단에 큐 추가 → 충돌 1개(씬), 서버 쪽으로 정하면 씬과 새 큐 모두 없음
  let remote = remoteOps(base, [{ op: 'remove', id: 's-v', force: true }]);
  let local = plain(base); find(local, 'i-k').cues.push(soundCue('q-L1', 1)); find(local, 'i-l').text = '로컬';
  let r = merge(base, local, remote);
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].id, 's-v'); assert.equal(r.conflicts[0].type, 'delete-remote');
  assert.equal(find(r.show, 's-v'), null); assert.equal(find(r.show, 'q-L1'), null);
  // 이 기기가 씬을 지움 + 서버가 그 씬에 문단 추가 → 서버 쪽으로 정하면 씬 전체(원래 문단 포함)가 서버 내용으로
  remote = remoteOps(base, [{ op: 'add', kind: 'item', parent: 's-v', data: { id: 'i-R1', text: '서버 문단' } }]);
  local = plain(base); local.parts[0].scenes = local.parts[0].scenes.filter(s => s.id !== 's-v');
  r = merge(base, local, remote);
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].type, 'delete-local'); assert.equal(r.conflicts[0].id, 's-v');
  assert.deepEqual(ids(find(r.show, 's-v')), ids(find(remote, 's-v')));
  // 지우기 전에 다른 씬으로 옮겨 둔 문단: 서버는 그 문단까지 지운 것이므로 "지움 vs 옮김" 충돌(문단 하나), 씬 삭제 자체는 깨끗
  remote = remoteOps(base, [{ op: 'remove', id: 's-v', force: true }]);
  local = plain(base);
  const moved = find(local, 's-v').items.splice(0, 1)[0]; find(local, 's-11').items.push(moved);
  r = merge(base, local, remote);
  assert.deepEqual(r.conflicts.map(c => [c.id, c.type]), [['i-k', 'delete-remote']]);
  assert.equal(find(r.show, 's-v'), null);
  assert.equal(find(r.show, 'i-k'), null, '서버 쪽으로 정하면 지운 채');
});

test('순서: 양쪽이 다른 항목을 옮기면 둘 다, 같은 항목을 옮기면 서버 위치', () => {
  const base = backstage();
  // 서버: i-u 를 맨 앞으로 / 이 기기: i-m 을 맨 뒤로
  const remote = remoteOps(base, [{ op: 'move', id: 'i-u', after: 'first' }]);
  const local = plain(base), sv = find(local, 's-v');
  sv.items.push(sv.items.splice(2, 1)[0]);
  let r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(ids(find(r.show, 's-v')), ['i-u', 'i-k', 'i-l', 'i-n', 'i-p', 'i-q', 'i-s', 'i-m']);
  // 같은 항목(i-u)을 이 기기는 i-l 뒤로
  const local2 = plain(base), sv2 = find(local2, 's-v');
  const u = sv2.items.pop(); sv2.items.splice(2, 0, u);
  r = merge(base, local2, remote);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(ids(find(r.show, 's-v')), ids(find(remote, 's-v')));
});

test('다른 부모로 옮기기는 부모 필드 — 내용 편집과 합쳐지고, 서로 다른 곳으로 옮기면 충돌', () => {
  const base = backstage();
  // 이 기기: q-o 를 i-q 로 옮김 / 서버: q-o 메모 고침
  let remote = remoteOps(base, [{ op: 'set', id: 'q-o', fields: { memo: '서버 메모' } }]);
  let local = plain(base);
  const q = find(local, 'i-p').cues.pop(); find(local, 'i-p').isCue = false;
  find(local, 'i-q').cues.push(q); find(local, 'i-q').isCue = true;
  let r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.equal(parentOf(r.show, 'q-o'), 'i-q'); assert.equal(find(r.show, 'q-o').memo, '서버 메모');
  assert.equal(find(r.show, 'i-q').isCue, true);
  // 서버는 i-s 로 옮김 → 충돌, 서버 위치
  remote = remoteOps(base, [{ op: 'move', id: 'q-o', parent: 'i-s' }]);
  r = merge(base, local, remote);
  assert.equal(r.conflicts.length, 1); assert.deepEqual(r.conflicts[0].fields, ['parent']);
  assert.equal(parentOf(r.show, 'q-o'), 'i-s');
  // 씬을 다른 파트로: 서버가 파트를 하나 더 만들고 씬을 옮김 + 이 기기가 씬 제목 고침
  remote = remoteOps(base, [{ op: 'add', kind: 'part', data: { id: 'pt-2', name: '2부' } }, { op: 'move', id: 's-3o', parent: 'pt-2' }]);
  local = plain(base); find(local, 's-3o').title = '로컬 엔딩';
  r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(find(r.show, 'pt-2').scenes.map(s => [s.id, s.title]), [['s-3o', '로컬 엔딩']]);
});

test('큐 여러 개의 부모 변경(Q 묶음 통째로 이동): 서버 편집과 합쳐지고, 서버가 그중 하나를 딴 데로 옮겼으면 그 큐만 충돌', () => {
  const base = backstage();
  // 이 기기: i-7 의 큐 전부(q-5 음향, q-6 조명)를 본문은 두고 i-k 로 — 브라우저 relocateCueGroup + save 와 같은 결과
  const groupMove = () => {
    const l = plain(base), a = find(l, 'i-7'), b = find(l, 'i-k');
    b.cues.push(...a.cues.splice(0)); a.isCue = false; b.isCue = true;
    relabel(l);
    return l;
  };
  // 서버: q-6 메모 + 원래 문단 i-7 에 새 큐 + i-k 본문 고침
  let remote = remoteOps(base, [
    { op: 'set', id: 'q-6', fields: { memo: '서버 메모' } },
    { op: 'add', kind: 'cue', parent: 'i-7', data: { id: 'q-R7', dept: 'stage', stage: { text: '서버 무대' } } },
    { op: 'set', id: 'i-k', fields: { text: '서버 본문' } },
  ]);
  let r = merge(base, groupMove(), remote);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(find(r.show, 'i-k').cues.map(c => c.id), ['q-5', 'q-6'], '옮긴 큐는 원래 순서대로 새 문단에');
  assert.equal(find(r.show, 'q-6').memo, '서버 메모');
  assert.equal(find(r.show, 'i-k').text, '서버 본문');
  assert.deepEqual(find(r.show, 'i-7').cues.map(c => c.id), ['q-R7'], '서버가 원래 문단에 단 큐는 그 자리에');
  assert.equal(find(r.show, 'i-7').isCue, true); assert.equal(find(r.show, 'i-k').isCue, true);
  assert.ok(inOrder(r.show), '번호는 1부터 연속');
  assert.deepEqual(validateShow(r.show).errors, []);
  // 서버는 q-5 하나만 i-l 로 옮김 → q-5 부모만 충돌(서버 위치), q-6 은 이 기기대로 i-k
  remote = remoteOps(base, [{ op: 'move', id: 'q-5', parent: 'i-l' }]);
  r = merge(base, groupMove(), remote);
  assert.equal(r.conflicts.length, 1); assert.deepEqual(r.conflicts[0].fields, ['parent']);
  assert.equal(parentOf(r.show, 'q-5'), 'i-l');
  assert.equal(parentOf(r.show, 'q-6'), 'i-k');
  assert.equal(find(r.show, 'i-7').isCue, false);
  assert.ok(inOrder(r.show));
});

test('큐 번호: 병합 뒤에도 늘 1부터 연속 — 양쪽이 같은 번호를 새로 매겨도 대본 순서대로 다시 매긴다 (충돌 아님)', () => {
  const base = backstage();
  const last = items(base).filter(i => i.label).length;
  // 서버(MCP): 마지막 씬 끝에 큐 달린 새 문단 → Q(last+1)
  const remote = remoteOps(base, [{ op: 'add', kind: 'item', parent: 's-3o', data: { id: 'i-R1', text: '(서버 퇴장)', cues: [{ dept: 'light', status: 'tbd' }] } }]);
  assert.equal(find(remote, 'i-R1').label, String(last + 1));
  // 이 기기: i-3k 에 큐, 마지막 씬 끝에 큐 달린 새 문단 (브라우저 save 처럼 relabel) → 이 기기에서도 끝 문단이 Q(last+1)
  const local = plain(base);
  find(local, 'i-3k').cues.push(soundCue('q-L1', 1)); find(local, 'i-3k').isCue = true;
  local.parts[0].scenes.at(-1).items.push(newItem('i-L9', '로컬 끝', { cues: [soundCue('q-L9', 2)], isCue: true }));
  relabel(local);
  const r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.ok(inOrder(r.show), '병합 결과 번호가 1부터 연속, 큐 없는 문단은 null');
  // 병합 순서는 [… i-3n, i-L9, i-R1] (이 기기 것이 이웃 i-3n 바로 뒤) — 끝의 두 문단이 차례로 마지막 두 번호
  const n = items(r.show).filter(i => i.cues.length).length;
  assert.deepEqual([find(r.show, 'i-L9').label, find(r.show, 'i-R1').label], [String(n - 1), String(n)]);
  assert.equal(r.sameAsRemote, false);
  // 같은 문단에 양쪽이 다른 (옛 소수) 번호를 매겼어도 결과는 자리 순서 번호
  const b2 = plain(base), l2 = plain(base), r2 = plain(base);
  find(l2, 'i-k').cues.push(soundCue('q-x', 1)); find(l2, 'i-k').label = '7.1';
  find(r2, 'i-k').cues.push(soundCue('q-x', 1)); find(r2, 'i-k').label = '7.2';
  const m2 = merge(b2, l2, r2);
  assert.deepEqual(m2.conflicts, []); assert.ok(inOrder(m2.show));
  assert.equal(find(m2.show, 'i-k').label, String(items(m2.show).filter(i => i.cues.length).findIndex(i => i.id === 'i-k') + 1));
});

test('코멘트 snapshot(v7): 병합해도 버리지 않는다 — 이 기기·서버 어느 쪽에서 달린 것이든, 문단이 바뀌어도 그대로', () => {
  const base = backstage();
  const it = items(base).find(i => i.cues.length >= 1 && i.kind === 'line');
  const snapOf = i => ({ kind: i.kind, speaker: i.speaker, text: i.text, cues: plain(i.cues) });
  const cmt = (id, i) => ({ id, author: '검토', text: '원래대로', createdAt: '2026-11-18T00:00:00.000Z', resolved: false, resolvedBy: null, resolvedAt: null, snapshot: snapOf(i) });
  // 기준에 이미 있던 snapshot 코멘트
  find(base, it.id).comments.push(cmt('c-base', it));
  const local = plain(base), remote = plain(base);
  // 이 기기: 같은 문단에 snapshot 코멘트를 새로 달고 문장을 고침
  const li = find(local, it.id); li.comments.push(cmt('c-local', li)); li.text = li.text + ' (로컬)';
  // 서버: 다른 문단 문장을 고치고, 같은 문단에 snapshot 코멘트를 닮
  const other = items(remote).find(i => i.id !== it.id && i.kind === 'line');
  other.text = other.text + ' (서버)';
  find(remote, it.id).comments.push(cmt('c-remote', find(remote, it.id)));
  const r = merge(migrate(base), migrate(local), migrate(remote));
  assert.deepEqual(r.conflicts, []);
  const cs = find(r.show, it.id).comments;
  assert.deepEqual(cs.map(c => c.id).sort(), ['c-base', 'c-local', 'c-remote']);
  cs.forEach(c => assert.deepEqual(c.snapshot, snapOf(it), c.id + ' snapshot 그대로'));
  assert.equal(find(r.show, it.id).text, it.text + ' (로컬)');
  assert.equal(find(r.show, other.id).text, other.text);
  assert.equal(r.show.version, 7);
  assert.deepEqual(validateShow(r.show).errors, []);
  assert.deepEqual(migrate(r.show), r.show, '사이트가 다시 읽어도 그대로');
});

test('사람·트랙·씬 출연자', () => {
  const base = backstage();
  const remote = remoteOps(base, [
    { op: 'add', kind: 'person', data: { id: 'p-new', name: '새 사람' } },
    { op: 'set', id: 'p-yejun', fields: { note: '서버 메모' } },
    { op: 'set', id: 's-11', fields: { cast: ['p-daehoon', 'p-new'] } },
    { op: 'add', kind: 'track', data: { id: 'tr-R', title: '서버 곡' } }
  ]);
  assert.equal(find(remote, 'tr-R').no, 8);
  const local = plain(base);
  find(local, 'p-daehoon').role = 'mc';
  find(local, 's-11').cast.push('p-yejun');
  local.people = local.people.filter(p => p.id !== 'p-taehyung'); // 사용처는 그대로 두는 브라우저 삭제와 같게(여기선 사람만)
  local.tracks.push({ id: 'tr-L', no: 8, title: '로컬 곡', durationSec: null, fileName: null, fileKey: null, note: '', loop: false });
  find(local, 'tr-3').title = '로컬 제목';
  const r = merge(base, local, remote);
  assert.deepEqual(r.show.people.map(p => p.id), ['p-yejun', 'p-daehoon', 'p-new']);
  assert.equal(find(r.show, 'p-yejun').note, '서버 메모'); assert.equal(find(r.show, 'p-daehoon').role, 'mc');
  assert.deepEqual(find(r.show, 's-11').cast, ['p-daehoon', 'p-new', 'p-yejun'], '출연자는 집합으로 합침');
  assert.equal(find(r.show, 'tr-3').title, '로컬 제목');
  // 양쪽이 BGM 8 을 새로 만듦 → 충돌. 서버 쪽으로 정하면 이 기기 트랙이 9 로
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].type, 'track-no'); assert.equal(r.conflicts[0].id, 'tr-L');
  assert.deepEqual(r.show.tracks.map(t => t.id + ':' + t.no).slice(-2), ['tr-R:8', 'tr-L:9']);
});

test('소품(v6): props 항목은 id 단위, preShowProps 는 통째', () => {
  const base = backstage();
  const remote = remoteOps(base, [
    { op: 'add', kind: 'prop', data: { id: 'pr-hat', name: '탑햇' } },
    { op: 'add', kind: 'prop', data: { id: 'pr-table', name: '테이블' } },
    { op: 'set', kind: 'show', fields: { preShowProps: [{ propId: 'pr-table', at: '중앙' }] } },
    { op: 'set', id: 'q-13', fields: { stage: { props: [{ propId: 'pr-hat', action: 'in', at: '' }] } } }
  ]);
  // 다음 기준: 서버 내용. 이 기기는 소품 메모 + 무대 큐 글, 서버는 소품 이름 + preShowProps 바꿈
  const base2 = remote;
  const local = plain(base2);
  find(local, 'pr-hat').note = '로컬 메모';
  find(local, 'q-13').stage.text = '로컬 무대 작업';
  local.props.push({ id: 'pr-L', name: '로컬 소품', note: '' });
  local.preShowProps = [{ propId: 'pr-table', at: '왼쪽' }];
  const remote2 = remoteOps(base2, [
    { op: 'set', id: 'pr-hat', fields: { name: '검은 탑햇' } },
    { op: 'set', kind: 'show', fields: { preShowProps: [{ propId: 'pr-table', at: '오른쪽' }] } }
  ]);
  const r = merge(base2, local, remote2);
  assert.deepEqual(find(r.show, 'pr-hat'), { id: 'pr-hat', name: '검은 탑햇', note: '로컬 메모' });
  assert.deepEqual(r.show.props.map(p => p.id), ['pr-hat', 'pr-table', 'pr-L']);
  assert.equal(find(r.show, 'q-13').stage.text, '로컬 무대 작업');
  assert.deepEqual(find(r.show, 'q-13').stage.props, [{ propId: 'pr-hat', action: 'in', at: '' }]);
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].kind, 'show'); assert.deepEqual(r.conflicts[0].fields, ['preShowProps']);
  assert.match(r.conflicts[0].text, /^공연 정보 — 공연 전 무대 소품/);
  assert.deepEqual(r.show.preShowProps, [{ propId: 'pr-table', at: '오른쪽' }]);
  // 서버가 소품을 지움 + 이 기기는 그 소품을 안 고침 → 삭제
  const remote3 = remoteOps(base2, [{ op: 'remove', id: 'pr-table', force: true }]);
  const local3 = plain(base2); find(local3, 'pr-hat').note = 'x';
  const r3 = merge(base2, local3, remote3);
  assert.deepEqual(r3.conflicts, []); assert.equal(find(r3.show, 'pr-table'), null); assert.deepEqual(r3.show.preShowProps, []);
});

test('show 메타: updatedAt·version 은 서버 것, revision 은 한쪽만 바뀌면 그쪽', () => {
  const base = backstage();
  const remote = plain(base); remote.updatedAt = '2026-11-18T01:00:00.000Z'; remote.title = '서버 제목';
  const local = plain(base); local.updatedAt = '2026-11-18T02:00:00.000Z'; local.revision = '3차'; local.preShowSetup = '로컬 세팅';
  const r = merge(base, local, remote);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.show.updatedAt, remote.updatedAt); assert.equal(r.show.revision, '3차');
  assert.equal(r.show.title, '서버 제목'); assert.equal(r.show.preShowSetup, '로컬 세팅');
  remote.revision = '4차';
  assert.equal(merge(base, local, remote).show.revision, '4차', '둘 다 바꾸면 조용히 서버 것');
});

test('서버가 지운 곳으로 이 기기가 옮겨 넣은 항목: 서버에 아직 있으면 서버 쪽 자리로 되돌린다', () => {
  const base = backstage();
  // 이 기기: 큐 q-1(i-3) 을 i-k 로 옮김 / 서버: i-k 를 지움 → 충돌(i-k), 서버 쪽으로 정하면 q-1 은 서버처럼 i-3 에
  let remote = remoteOps(base, [{ op: 'remove', id: 'i-k' }]);
  let local = plain(base);
  find(local, 'i-k').cues.push(find(local, 'i-3').cues.shift());
  let r = merge(base, local, remote);
  assert.deepEqual(r.conflicts.map(c => [c.id, c.type]), [['i-k', 'delete-remote']]);
  assert.equal(find(r.show, 'i-k'), null);
  assert.equal(parentOf(r.show, 'q-1'), 'i-3');
  assert.deepEqual(find(r.show, 'i-3').cues.map(c => c.id), find(remote, 'i-3').cues.map(c => c.id), '서버 순서 그대로');
  // 이 기기: 문단 i-x(s-11) 를 s-v 로 옮김 / 서버: s-v 를 지움 → i-x 는 s-11 의 서버 자리에
  remote = remoteOps(base, [{ op: 'remove', id: 's-v', force: true }]);
  local = plain(base);
  find(local, 's-v').items.push(find(local, 's-11').items.shift());
  r = merge(base, local, remote);
  assert.deepEqual(r.conflicts.map(c => [c.id, c.type]), [['s-v', 'delete-remote']]);
  assert.deepEqual(ids(find(r.show, 's-11')), ids(find(remote, 's-11')));
  assert.deepEqual(validateShow(r.show).errors, []);
  // 서버가 그 항목도 지웠으면(서버에 없음) 그대로 버린다
  remote = remoteOps(base, [{ op: 'remove', id: 's-v', force: true }, { op: 'remove', id: 'i-x' }]);
  r = merge(base, local, remote);
  assert.equal(find(r.show, 'i-x'), null);
});

test('hasAllIds: migrate 전 원본에 id 없는 항목이 있으면 false (브라우저는 그때 병합하지 않는다)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cues', 'backstage-part1.json'), 'utf8'));
  assert.equal(hasAllIds(raw), true);
  for (const strip of [s => delete s.people[0].id, s => delete s.tracks[0].id, s => delete s.parts[0].scenes[3].items[0].id,
    s => delete s.parts[0].scenes[1].items[0].cues[0].id, s => { s.parts[0].scenes[3].items[0].comments.push({ text: 'x' }); }, s => delete s.parts[0].id]) {
    const t = plain(raw); strip(t);
    assert.equal(hasAllIds(t), false);
  }
  assert.equal(hasAllIds({}), false);
});

test('id 가 겹치거나 없으면 병합하지 않는다', () => {
  const base = backstage(), local = plain(base);
  find(local, 's-v').items.push(newItem('i-k', '중복 id'));
  const r = merge(base, local, plain(base));
  assert.equal(r.ok, false); assert.match(r.error, /i-k/);
  const local2 = plain(base); delete find(local2, 'i-k').id;
  assert.equal(merge(base, local2, plain(base)).ok, false);
});

test('실제 흐름: backstage-part1 — 서버는 MCP ops, 이 기기는 편집기 편집 → 둘 다 들어가고 검증 통과', () => {
  const base = backstage();
  assert.deepEqual(validateShow(base).errors, []);
  // 에이전트가 MCP edit_show 로 한 수정
  const ops = [
    { op: 'add', kind: 'item', parent: 's-1k', after: 'i-1a', data: { id: 'i-mcp1', text: '(테이블 정리)', cues: [{ dept: 'stage', stage: { text: '테이블 치우기' } }] } },
    { op: 'set', id: 'q-1i', fields: { trigger: '퇴장 직후', memo: '에이전트가 고침' } },
    { op: 'add', kind: 'cue', parent: 'i-3n', data: { id: 'q-mcp2', dept: 'sound', sound: { track: 7, action: 'fadeOut', timeSec: 5 } } },
    { op: 'set', id: 'tr-3', fields: { title: '멘탈 BGM' } },
    { op: 'add', kind: 'prop', data: { id: 'pr-mcp', name: '카드 덱' } },
    { op: 'remove', id: 'i-2j' },
    { op: 'add', kind: 'comment', parent: 's-2k', data: { text: '에이전트: 확인 필요', author: 'agent' } }
  ];
  const res = applyOps(base, ops);
  const remote = migrate(res.show);
  // 브라우저에서 한 편집: 본문 고침, 새 문단(+큐), 문단 순서 바꿈, 큐 지움, 사람 메모, 코멘트 해결, 판 표시
  const local = plain(base);
  find(local, 'i-k').text = find(local, 'i-k').text + ' (로컬 수정)';
  const sv = find(local, 's-v'); sv.items.splice(sv.items.findIndex(i => i.id === 'i-q') + 1, 0, newItem('i-loc1', '(관객 박수 유도)', { kind: 'action', cues: [soundCue('q-loc1', 2)], isCue: true }));
  const s2k = find(local, 's-2k'); const mv = s2k.items.splice(s2k.items.findIndex(i => i.id === 'i-1o'), 1)[0]; s2k.items.splice(3, 0, mv);
  find(local, 'i-1h').cues = find(local, 'i-1h').cues.filter(c => c.id !== 'q-1g');
  find(local, 'p-daehoon').note = '로컬 메모';
  const cm = find(local, 's-3i').comments[0]; Object.assign(cm, { resolved: true, resolvedBy: '나', resolvedAt: '2026-11-18T03:00:00.000Z' });
  local.revision = '리허설 2';
  local.updatedAt = new Date().toISOString();
  relabel(local);

  const r = merge(base, local, remote);
  assert.ok(r.ok);
  assert.deepEqual(r.conflicts, [], JSON.stringify(r.conflicts));
  const m = r.show;
  // 서버 쪽 편집
  assert.equal(find(m, 'i-mcp1').text, '(테이블 정리)');
  assert.equal(ids(find(m, 's-1k'))[ids(find(m, 's-1k')).indexOf('i-1a') + 1], 'i-mcp1');
  assert.equal(find(m, 'q-1i').memo, '에이전트가 고침');
  assert.equal(parentOf(m, 'q-mcp2'), 'i-3n');
  assert.equal(find(m, 'tr-3').title, '멘탈 BGM');
  assert.equal(find(m, 'pr-mcp').name, '카드 덱');
  assert.equal(find(m, 'i-2j'), null);
  assert.ok(find(m, 's-2k').comments.some(c => c.text === '에이전트: 확인 필요'));
  // 이 기기 편집
  assert.match(find(m, 'i-k').text, /\(로컬 수정\)$/);
  assert.equal(ids(find(m, 's-v'))[ids(find(m, 's-v')).indexOf('i-q') + 1], 'i-loc1');
  assert.equal(ids(find(m, 's-2k')).indexOf('i-1o'), 3);
  assert.equal(find(m, 'q-1g'), null);
  assert.equal(find(m, 'p-daehoon').note, '로컬 메모');
  assert.equal(find(m, cm.id).resolved, true);
  assert.equal(m.revision, '리허설 2');
  // 번호: 병합 결과도 1부터 연속 (서버·이 기기에서 새로 단 큐 문단 모두 번호가 있다)
  assert.ok(inOrder(m));
  assert.ok(find(m, 'i-mcp1').label && find(m, 'i-loc1').label);
  // 검증·사이트 정규화
  const v = validateShow(m);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(migrate(m), m, 'migrate 를 다시 거쳐도 그대로 (사이트가 그대로 읽음)');
  // 병합 결과를 다음 저장으로 보내고, 서버가 다시 그 위에 고쳐도 또 합쳐진다
  const remote2 = remoteOps(m, [{ op: 'set', id: 'i-loc1', fields: { text: '(관객 박수 크게 유도)' } }]);
  const local2 = plain(m); find(local2, 'i-l').text = '두 번째 로컬';
  const r2 = merge(m, local2, remote2);
  assert.deepEqual(r2.conflicts, []);
  assert.equal(find(r2.show, 'i-loc1').text, '(관객 박수 크게 유도)'); assert.equal(find(r2.show, 'i-l').text, '두 번째 로컬');
});

test('무작위: 양쪽에 MCP 식 편집을 섞어도 항상 병합되고, 충돌이 없으면 검증 통과·양쪽 결과를 모두 담는다', () => {
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  function randomOps(show, tag, narrow) {
    // narrow: 두 씬에만 몰아 충돌이 자주 나게
    const ops = [], its = items(show).filter(i => !narrow || ['s-v', 's-11'].some(s => find(show, s).items.includes(i))), scs = scenes(show).map(s => s.id);
    const cues = its.flatMap(i => i.cues.map(c => c.id));
    const removed = new Set();
    for (let n = 0; n < 4; n++) {
      const it = pick(its.filter(i => !removed.has(i.id))).id, k = Math.floor(rnd() * 7);
      if (k === 0) ops.push({ op: 'set', id: it, fields: { text: `${tag} ${n} 본문` } });
      else if (k === 1) ops.push({ op: 'add', kind: 'item', after: it, data: { id: `i-${tag}${n}`, text: `${tag} 새 문단 ${n}` } });
      else if (k === 2) { ops.push({ op: 'remove', id: it }); removed.add(it); }
      else if (k === 3) ops.push({ op: 'move', id: it, parent: pick(scs), after: 'first' });
      else if (k === 4) ops.push({ op: 'add', kind: 'cue', parent: it, data: { id: `q-${tag}${n}`, dept: 'cast', cast: { personId: 'p-yejun', move: 'out' } } });
      else if (k === 5 && cues.length) ops.push({ op: 'set', id: pick(cues), fields: { memo: `${tag} 메모 ${n}` } });
      else ops.push({ op: 'move', id: it, after: pick(its.filter(i => !removed.has(i.id) && i.id !== it)).id });
    }
    return ops;
  }
  const allIds = s => { const out = []; JSON.stringify(s, (k, v) => { if (v && typeof v === 'object' && typeof v.id === 'string') out.push(v.id); return v; }); return out; };
  let clean = 0, conflicted = 0;
  for (let round = 0; round < 60; round++) {
    const base = backstage();
    let local, remote;
    const narrow = round % 2 === 1;
    try { local = migrate(applyOps(base, randomOps(base, 'L', narrow)).show); remote = migrate(applyOps(base, randomOps(base, 'R', narrow)).show); } catch (e) { continue; }
    const r = merge(base, local, remote);
    assert.ok(r.ok, r.error);
    const got = allIds(r.show);
    assert.equal(new Set(got).size, got.length, `round ${round}: id 중복`);
    const labels = items(r.show).map(i => i.label).filter(Boolean);
    assert.equal(new Set(labels).size, labels.length, `round ${round}: 번호 중복`);
    assert.ok(inOrder(r.show), `round ${round}: 번호 1부터 연속`);
    // 충돌을 서버 쪽으로 정한 결과도 사이트가 읽을 수 있어야 한다("충돌만 서버 것으로" 선택지)
    assert.deepEqual(validateShow(r.show).errors, [], `round ${round}`);
    r.conflicts.forEach(c => assert.ok(c.text && c.key, `round ${round}: 충돌 설명`));
    if (r.conflicts.length) { conflicted++; continue; }
    clean++;
    // 양쪽이 모두 남긴 id 와 한쪽이 새로 만든 id 는 결과에 있다
    const b = new Set(allIds(base)), l = new Set(allIds(local)), rr = new Set(allIds(remote)), g = new Set(got);
    l.forEach(id => { if (rr.has(id) || !b.has(id)) assert.ok(g.has(id), `round ${round}: ${id} 빠짐`); });
    rr.forEach(id => { if (l.has(id) || !b.has(id)) assert.ok(g.has(id), `round ${round}: ${id} 빠짐`); });
  }
  assert.ok(clean > 20, `충돌 없는 경우가 너무 적다 (${clean})`);
  assert.ok(conflicted > 3, `충돌 난 경우가 너무 적다 (${conflicted}) — 시드를 바꿨으면 확인`);
});
