// 큐시트 3-way 병합 (순수 함수) — 브라우저 저장이 409 일 때 (기준 → 내 것) 과 (기준 → 서버 것) 을 id 단위로 합친다.
// 브라우저(<script src>)에서는 window.CueMerge, Node 에서는 require('./lib/merge'). 빌드 단계 없음. docs/mcp.md "동시 편집"
//
// mergeShows(base, local, remote, opts?) → { ok, show, conflicts, sameAsRemote } (ok:false 면 { ok, error })
//   base   = 마지막으로 서버와 맞춘 내용, local = 이 기기의 지금 내용, remote = 409 응답의 서버 내용.
//   세 값 모두 index.html migrate() 를 거친 모양이라고 본다(빠진 필드가 다르면 "바뀐 것"으로 보일 수 있다). 입력은 바꾸지 않는다.
//   show 는 충돌을 모두 서버 쪽으로 정한 결과 — 충돌이 없으면 그대로 저장하면 되고, 있으면 "충돌만 서버 것으로" 선택지에 쓴다.
//   opts.relabel: 병합 뒤 큐 번호를 1부터 연속으로 맞출 함수(index.html relabel = lib/labels.js relabel). Node 에서 안 주면 lib/labels.js 것.
//
// 규칙
// - 항목(사람·소품·트랙·파트·씬·문단·큐·코멘트)은 종류+id 로 맞춘다. 필드 단위: 한쪽만 바꿈 → 그쪽, 같게 바꿈 → 그대로,
//   다르게 바꿈 → 충돌(서버 것). 큐의 부서 객체(light·sound·stage·cast)는 안쪽 필드까지, 배열(채널·소품 동작·preShowProps)은 통째.
//   문단 본문(text)도 통째 — 글자 단위 병합은 하지 않는다.
// - 씬 출연자(scene.cast)는 id 집합으로 합친다(양쪽 추가 모두 유지, 한쪽 삭제 반영 — 충돌 없음).
// - 추가는 양쪽 모두 유지. 한쪽 삭제 + 다른 쪽 그대로 → 삭제. 한쪽 삭제 + 다른 쪽이 그 항목이나 그 안(자식)을 고침/추가/옮겨 넣음
//   → 충돌. 서버 쪽으로 정하면 서버가 지운 것은 지운 채로, 서버가 고친 것은 그 아래 전체를 서버 내용으로 되살린다.
//   순서만 바꾼 것은 고친 것으로 치지 않는다(삭제가 이긴다).
// - 다른 부모로 옮기기(큐를 다른 문단으로 등)는 "부모" 필드를 바꾼 것으로 본다.
// - 순서: 서버 순서에서 시작해, 이 기기에서 새로 넣거나 옮긴 항목을 이 기기 목록에서 가장 가까운 남은 이웃 뒤(없으면 앞)에
//   다시 끼운다. 양쪽이 같은 항목을 옮겼으면 서버 위치. 트랙은 항상 no 순.
// - 파생 값: 문단 label(큐 번호)·isCue 는 충돌로 치지 않는다. 번호는 사이트·MCP 와 같이 늘 1부터 연속이라 병합 뒤 opts.relabel 로
//   대본 순서대로 다시 맞춘다(이미 연속이면 그대로). isCue 는 큐가 있으면 true.
// - 그 밖의 필드는 이름을 가리지 않고 3-way 로 합친다 — 코멘트 snapshot(v7) 같은 새 필드도 버리지 않는다.
// - show 의 id·version·updatedAt 은 서버 것. revision(판 표시)은 한쪽만 바뀌면 그쪽, 둘 다 바뀌면 서버 것(충돌 아님).
// - 트랙 번호(no)가 병합 뒤 겹치면 충돌. 서버 쪽으로 정할 때 이 기기에서 온 번호를 맨 뒤 번호로 옮긴다(그 번호를 쓰는 음향 큐는 그대로).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CueMerge = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 종류별 자식 목록 이름 → 자식 종류
  const CHILDREN = {
    show: { people: 'person', props: 'prop', tracks: 'track', parts: 'part' },
    part: { scenes: 'scene' },
    scene: { comments: 'comment', items: 'item' },
    item: { cues: 'cue', comments: 'comment' }
  };
  const ROOT = 'show';
  // 파생 값 — 고쳤는지 판단·충돌에서 뺀다
  const DERIVED = { item: ['label', 'isCue'] };
  // 서버 것을 그대로 쓰는 값 / 둘 다 바뀌면 조용히 서버 것
  const TAKE_REMOTE = { show: ['id', 'version', 'updatedAt'] };
  const QUIET = { show: ['revision'], item: ['label', 'isCue'] };
  // 집합으로 합치는 문자열 배열
  const SET_FIELDS = { scene: ['cast'] };

  const KIND_L = { show: '공연 정보', person: '사람', prop: '소품', track: '트랙', part: '파트', scene: '씬', item: '문단', cue: '큐', comment: '코멘트' };
  const FIELD_L = {
    title: '제목', preShowSetup: '공연 전 세팅', preShowProps: '공연 전 무대 소품', name: '이름', role: '역할', note: '메모',
    no: '번호', durationSec: '길이', fileName: '음원 파일', fileKey: '음원 파일', loop: '반복', type: '종류', setup: '세팅',
    kind: '종류', speaker: '화자', text: '본문', dept: '부서', trigger: '시점', offsetSec: '지연', memo: '메모', status: '상태',
    light: '조명', sound: '음향', stage: '무대', cast: '출연', author: '작성자', resolved: '해결', resolvedBy: '해결', resolvedAt: '해결',
    createdAt: '작성 시각', snapshot: '코멘트 당시 문단', parent: '위치'
  };
  // 같은 이름이 종류마다 다른 뜻일 때 (사람·소품·트랙의 note = 메모, 큐의 note = 상세 — v8)
  const FIELD_KIND_L = { cue: { note: '상세' } };
  const DEPT_L = { cast: '출연', light: '조명', sound: '음향', stage: '무대' };

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  // 키 순서와 무관한 깊은 비교 (undefined 키는 없는 것으로)
  function eq(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!has(b, k) || !eq(a[k], b[k])) return false;
    return true;
  }
  const without = (o, keys) => { if (!o || !keys) return o; const c = Object.assign({}, o); keys.forEach(k => { delete c[k]; }); return c; };

  /* ---- 색인: key = "종류:id", parent = "부모key#목록이름" (최상위는 "show#목록이름") ---- */
  function index(show, side) {
    const ent = new Map(), order = new Map();
    if (!isObj(show) || !Array.isArray(show.parts)) return { error: `${side}: show 가 올바르지 않습니다` };
    let error = null;
    function own(kind, node) {
      const o = {}, ch = CHILDREN[kind] || {};
      Object.keys(node).forEach(k => { if (!has(ch, k) && node[k] !== undefined) o[k] = node[k]; });
      return o;
    }
    function walk(kind, key, node) {
      const ch = CHILDREN[kind]; if (!ch) return;
      Object.keys(ch).forEach(c => {
        const ref = key + '#' + c, list = [];
        (Array.isArray(node[c]) ? node[c] : []).forEach(x => {
          if (error) return;
          const ck = ch[c];
          if (!isObj(x) || typeof x.id !== 'string' || !x.id) { error = `${side}: id 없는 ${KIND_L[ck]}이 있습니다`; return; }
          const k = ck + ':' + x.id;
          if (ent.has(k)) { error = `${side}: ${KIND_L[ck]} id "${x.id}" 가 겹칩니다`; return; }
          ent.set(k, { kind: ck, id: x.id, key: k, node: x, parent: ref, own: own(ck, x) });
          list.push(k);
          walk(ck, k, x);
        });
        order.set(ref, list);
      });
    }
    ent.set(ROOT, { kind: ROOT, id: null, key: ROOT, node: show, parent: null, own: own(ROOT, show) });
    walk(ROOT, ROOT, show);
    return error ? { error } : { ent, order, show };
  }
  const parentKey = ref => (ref == null ? null : ref.slice(0, ref.lastIndexOf('#')));

  // 3-way. onConflict(path, l, r) 가 불리면 서버 값(r)을 쓴다. 객체는 안쪽 필드까지, 배열·값은 통째
  function merge3(b, l, r, path, onConflict) {
    if (eq(l, r)) return clone(l);
    if (eq(b, l)) return clone(r);
    if (eq(b, r)) return clone(l);
    if (isObj(b) && isObj(l) && isObj(r)) {
      const out = {};
      unionKeys(r, l, b).forEach(k => { const v = merge3(b[k], l[k], r[k], path.concat(k), onConflict); if (v !== undefined) out[k] = v; });
      return out;
    }
    onConflict(path, l, r);
    return clone(r);
  }
  function unionKeys() { const s = []; Array.prototype.forEach.call(arguments, o => { if (o) Object.keys(o).forEach(k => { if (!s.includes(k)) s.push(k); }); }); return s; }
  // 문자열 집합 배열 3-way: 서버 순서 + 이 기기에서 더한 것, 한쪽에서 뺀 것은 뺀다
  function mergeSet(b, l, r) {
    b = Array.isArray(b) ? b : []; l = Array.isArray(l) ? l : []; r = Array.isArray(r) ? r : [];
    const keep = x => !(b.includes(x) && (!l.includes(x) || !r.includes(x)));
    const out = [];
    r.concat(l).forEach(x => { if (keep(x) && !out.includes(x)) out.push(x); });
    return out;
  }

  // 순서가 바뀌지 않은 공통 원소 (LCS)
  function lcsSet(a, b) {
    const n = a.length, m = b.length, dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = new Set(); let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { out.add(a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
    return out;
  }
  // side 목록에서 기준 대비 자리가 바뀐 원소
  function movedIn(baseList, sideList) {
    const bs = new Set(baseList), ss = new Set(sideList);
    const a = baseList.filter(x => ss.has(x)), b = sideList.filter(x => bs.has(x));
    const stay = lcsSet(a, b);
    return new Set(b.filter(x => !stay.has(x)));
  }

  function mergeShows(base, local, remote, opts) {
    opts = opts || {};
    const B = index(base, '기준'), L = index(local, '내 것'), R = index(remote, '서버');
    const bad = B.error || L.error || R.error;
    if (bad) return { ok: false, error: bad, show: null, conflicts: [] };

    const conflicts = new Map(); // key → { key, kind, id, type, fields[] }
    const addConflict = (key, type, field) => {
      let c = conflicts.get(key);
      if (!c) { const e = R.ent.get(key) || L.ent.get(key) || B.ent.get(key); c = { key, kind: e.kind, id: e.id, type, fields: [] }; conflicts.set(key, c); }
      if (field && !c.fields.includes(field)) c.fields.push(field);
      return c;
    };

    const keys = [];
    const seen = new Set();
    [R, L, B].forEach(X => X.ent.forEach((_, k) => { if (!seen.has(k)) { seen.add(k); keys.push(k); } }));

    const fin = new Map(); // key → { kind, id, own, parent }
    const delCand = new Map(); // key → 지운 쪽 'local' | 'remote'

    function mergeOwn(kind, key, b, l, r) {
      const quiet = QUIET[kind] || [], take = TAKE_REMOTE[kind] || [], sets = SET_FIELDS[kind] || [];
      const out = {};
      unionKeys(r, l, b || {}).forEach(k => {
        const bv = b ? b[k] : undefined;
        let v;
        if (take.includes(k)) v = clone(r[k] !== undefined ? r[k] : l[k]);
        else if (sets.includes(k)) v = mergeSet(bv, l[k], r[k]);
        else v = merge3(bv, l[k], r[k], [k], () => { if (!quiet.includes(k)) addConflict(key, 'field', k); });
        if (v !== undefined) out[k] = v;
      });
      return out;
    }

    keys.forEach(k => {
      if (k === ROOT) {
        fin.set(k, { kind: ROOT, id: null, own: mergeOwn(ROOT, k, B.ent.get(k).own, L.ent.get(k).own, R.ent.get(k).own), parent: null });
        return;
      }
      const b = B.ent.get(k), l = L.ent.get(k), r = R.ent.get(k);
      const e = r || l || b;
      if (l && r) {
        const own = mergeOwn(e.kind, k, b && b.own, l.own, r.own);
        const parent = merge3(b ? b.parent : undefined, l.parent, r.parent, ['parent'], () => addConflict(k, 'field', 'parent'));
        fin.set(k, { kind: e.kind, id: e.id, own, parent });
      } else if (!b) {
        const x = l || r;
        fin.set(k, { kind: e.kind, id: e.id, own: clone(x.own), parent: x.parent });
      } else if (l || r) delCand.set(k, l ? 'remote' : 'local');
    });

    // 한쪽에서 지운 항목: 남긴 쪽의 트리에서 지운 것들의 맨 위(root)마다, 그 아래에서 남긴 쪽이 고친 게 있는지 본다
    const sideOf = s => (s === 'remote' ? L : R); // 남긴 쪽
    function modified(X, k) {
      const x = X.ent.get(k), b = B.ent.get(k);
      if (!b) return true;
      const d = DERIVED[x.kind];
      return x.parent !== b.parent || !eq(without(x.own, d), without(b.own, d));
    }
    function subtree(X, k, out) {
      out.push(k);
      const x = X.ent.get(k), ch = CHILDREN[x.kind];
      if (ch) Object.keys(ch).forEach(c => (X.order.get(k + '#' + c) || []).forEach(ck => subtree(X, ck, out)));
      return out;
    }
    const covered = new Set(); // 서버 삭제로 버린 이 기기 항목 (충돌 하나로 이미 알림)
    delCand.forEach((side, k) => {
      const O = sideOf(side);
      const p = parentKey(O.ent.get(k).parent);
      if (p && delCand.get(p) === side) return; // root 아님
      const sub = subtree(O, k, []);
      const dirty = sub.some(x => modified(O, x));
      const members = sub.filter(x => delCand.get(x) === side);
      if (!dirty) return; // 깨끗한 삭제 — 아무것도 남기지 않는다
      addConflict(k, side === 'remote' ? 'delete-remote' : 'delete-local');
      if (side === 'remote') sub.forEach(x => covered.add(x));
      else members.forEach(x => { const r = R.ent.get(x); fin.set(x, { kind: r.kind, id: r.id, own: clone(r.own), parent: r.parent }); });
    });

    // 부모가 사라진 항목: 서버에 아직 있으면 서버 쪽 부모 아래로 되돌리고(이 기기에서 서버가 지운 곳으로 옮겨 넣은 큐·문단 등),
    // 서버에도 없으면 버린다(서버 삭제가 이긴 충돌 아래에 이 기기에서 새로 넣은 것)
    for (let changed = true; changed;) {
      changed = false;
      fin.forEach((v, k) => {
        if (k === ROOT) return;
        const p = parentKey(v.parent);
        if (p === ROOT || fin.has(p)) return;
        const r = R.ent.get(k);
        if (r && r.parent !== v.parent) {
          const rp = parentKey(r.parent);
          if (rp === ROOT || fin.has(rp)) { v.parent = r.parent; changed = true; return; }
        }
        fin.delete(k); changed = true;
        if (!covered.has(k) && L.ent.has(k)) {
          let a = p; while (a && a !== ROOT && !B.ent.has(a)) a = parentKey((L.ent.get(a) || R.ent.get(a)).parent);
          addConflict(a && a !== ROOT ? a : k, 'delete-remote');
          covered.add(k);
        }
      });
    }

    // 목록 순서
    const byParent = new Map();
    fin.forEach((v, k) => { if (k === ROOT) return; if (!byParent.has(v.parent)) byParent.set(v.parent, new Set()); byParent.get(v.parent).add(k); });
    function orderOf(ref) {
      const members = byParent.get(ref); if (!members) return [];
      const lb = B.order.get(ref) || [], ll = L.order.get(ref) || [], lr = R.order.get(ref) || [];
      const rList = lr.filter(k => members.has(k));
      const inR = new Set(rList);
      const lMoved = movedIn(lb, ll), rMoved = movedIn(lb, lr);
      const reposition = new Set();
      members.forEach(k => { if (!inR.has(k)) reposition.add(k); });
      rList.forEach(k => { if (lMoved.has(k) && !rMoved.has(k) && L.ent.has(k) && L.ent.get(k).parent === ref) reposition.add(k); });
      const out = rList.filter(k => !reposition.has(k));
      const placed = new Set(out);
      // 이웃으로 삼을 수 있는 것: 이미 놓인 것 중 서버가 옮기지 않은 것(서버가 옮긴 항목은 이 기기 기준 이웃이 아니다)
      const anchor = x => placed.has(x) && (reposition.has(x) || !rMoved.has(x));
      ll.forEach((k, i) => {
        if (!reposition.has(k) || placed.has(k)) return;
        let at = -1;
        for (let j = i - 1; j >= 0 && at < 0; j--) if (anchor(ll[j])) at = out.indexOf(ll[j]) + 1;
        for (let j = i + 1; j < ll.length && at < 0; j++) if (anchor(ll[j]) && !reposition.has(ll[j])) at = out.indexOf(ll[j]);
        if (at < 0) at = out.length;
        out.splice(at, 0, k); placed.add(k);
      });
      Array.from(reposition).filter(k => !placed.has(k)).sort().forEach(k => { out.push(k); placed.add(k); });
      return out;
    }

    // 트리 만들기 (필드 순서는 서버 → 내 것 → 기준 노드를 따른다)
    function build(k) {
      const f = fin.get(k), ch = CHILDREN[f.kind] || {};
      const tmpl = (R.ent.get(k) || L.ent.get(k) || B.ent.get(k)).node;
      const node = {};
      unionKeys(tmpl, f.own).forEach(name => {
        if (has(ch, name)) node[name] = orderOf(k + '#' + name).map(build);
        else if (f.own[name] !== undefined) node[name] = f.own[name];
      });
      Object.keys(ch).forEach(name => { if (!has(node, name)) node[name] = orderOf(k + '#' + name).map(build); });
      return node;
    }
    const show = build(ROOT);
    show.tracks.sort((a, b) => (a.no || 0) - (b.no || 0));

    // 트랙 번호 겹침
    const byNo = new Map();
    show.tracks.forEach(t => { if (t.no == null) return; if (!byNo.has(t.no)) byNo.set(t.no, []); byNo.get(t.no).push(t); });
    byNo.forEach(list => {
      if (list.length < 2) return;
      const fromLocal = t => { const r = R.ent.get('track:' + t.id); return !r || r.own.no !== t.no; };
      const mine = list.filter(fromLocal);
      if (!mine.length) return; // 서버에 원래 겹쳐 있던 번호 — 병합 탓이 아니다
      mine.forEach(t => addConflict('track:' + t.id, 'track-no', 'no'));
      let max = Math.max.apply(null, show.tracks.map(t => t.no || 0));
      mine.forEach(t => { t.no = ++max; });
    });
    show.tracks.sort((a, b) => (a.no || 0) - (b.no || 0));

    fixLabels(show, opts.relabel);

    const list = Array.from(conflicts.values()).map(c => Object.assign(c, { text: describe(c, { B, L, R }) }));
    return { ok: true, show, conflicts: list, sameAsRemote: eq(show, remote) };
  }

  /* ---- 큐 번호(label)·isCue: 병합 뒤 정리 — 번호 정책은 lib/labels.js(= index.html "큐 번호" 구간) 하나 ---- */
  // 필드 단계의 label(QUIET: 한쪽만 바뀌면 그쪽, 아니면 서버 것)은 임시 값이다. 병합으로 큐 문단이 늘거나 줄거나 순서가 바뀌면
  // 번호가 어긋나므로 relabel(늘 1부터 연속, 큐 없는 문단은 null)로 다시 맞춘다. 브라우저는 index.html 의 relabel 을 넘긴다
  function fixLabels(show, relabel) {
    // 큐 지점(kind:'cue')은 큐가 0개면 없다 — 한쪽이 큐를 다 옮기거나 지워 비었으면 정리 (코멘트가 있으면 빈 지문으로 남긴다)
    show.parts.forEach(p => p.scenes.forEach(s => {
      s.items = s.items.filter(i => {
        if (!isObj(i) || i.kind !== 'cue' || (Array.isArray(i.cues) && i.cues.length)) return true;
        if (Array.isArray(i.comments) && i.comments.length) { i.kind = 'action'; return true; }
        return false;
      });
    }));
    show.parts.forEach(p => p.scenes.forEach(s => s.items.forEach(i => { if (Array.isArray(i.cues) && i.cues.length) i.isCue = true; })));
    const fn = typeof relabel === 'function' ? relabel : nodeRelabel();
    if (fn) fn(show);
  }
  // Node(서버·테스트)에서 opts.relabel 이 없으면 lib/labels.js 의 것. 브라우저에는 require 가 없다
  function nodeRelabel() {
    try { return typeof require === 'function' ? require('./labels').relabel : null; } catch (e) { return null; }
  }

  /* ---- 충돌 설명 한 줄 ---- */
  const snip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  function describe(c, X) {
    const get = k => X.R.ent.get(k) || X.L.ent.get(k) || X.B.ent.get(k);
    const name = e => {
      const o = e.own;
      switch (e.kind) {
        case 'part': return o.name || '(파트)';
        case 'scene': return o.title || (o.type === 'mc' ? 'MC 구간' : '(제목 없는 씬)');
        case 'item': return (o.label != null ? 'Q' + o.label + ' ' : '') + (o.kind === 'cue' ? '큐 지점' : '「' + snip(o.text, 16) + '」');
        case 'cue': return DEPT_L[o.dept] ? DEPT_L[o.dept] + ' 큐' + (o.trigger ? ' (' + snip(o.trigger, 12) + ')' : '') : '큐';
        case 'comment': return '코멘트 「' + snip(o.text, 16) + '」';
        case 'person': case 'prop': return KIND_L[e.kind] + ' ' + (o.name || e.id);
        case 'track': return 'BGM ' + (o.no != null ? o.no : '?') + (o.title ? ' ' + snip(o.title, 16) : '');
        default: return KIND_L[e.kind] || e.kind;
      }
    };
    const path = [];
    for (let e = get(c.key); e && e.key !== ROOT; e = get(parentKey(e.parent))) path.unshift(name(e));
    const where = path.length ? path.join(' › ') : '공연 정보';
    const kl = FIELD_KIND_L[c.kind] || {};
    const fields = Array.from(new Set(c.fields.map(f => kl[f] || FIELD_L[f] || f)));
    if (c.type === 'delete-remote') return `${where} — 다른 곳(에이전트 등)에서 지웠는데 이 기기에서 고침`;
    if (c.type === 'delete-local') return `${where} — 이 기기에서 지웠는데 다른 곳에서 고침`;
    if (c.type === 'track-no') return `${where} — 같은 BGM 번호를 양쪽에서 다른 트랙에 씀`;
    return `${where} — ${fields.join('·') || '내용'}: 양쪽에서 다르게 고침`;
  }

  // 모든 항목에 id 가 있는지 (migrate 전의 원본으로 본다). 없으면 migrate 가 쪽마다 다른 임시 id 를 만들어 같은 항목이 둘로 보이므로
  // 병합하면 안 된다 — 서버는 id 를 강제하지 않는다(POST/PUT 은 basicInvalid 만 본다)
  function hasAllIds(show) {
    if (!isObj(show) || !Array.isArray(show.parts)) return false;
    const okId = v => (typeof v === 'string' && v !== '') || (typeof v === 'number' && isFinite(v));
    function walk(kind, node) {
      const ch = CHILDREN[kind]; if (!ch) return true;
      return Object.keys(ch).every(c => node[c] == null || (Array.isArray(node[c]) && node[c].every(x => !isObj(x) || (okId(x.id) && walk(ch[c], x)))));
    }
    return walk(ROOT, show);
  }

  return { mergeShows, eq, hasAllIds };
});
