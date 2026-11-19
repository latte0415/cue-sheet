// MCP 읽기 도구용 보기 — 개요(outline)·부분 JSON·검색. 입출력 없음.
// 개요는 큰 공연에서도 토큰을 적게 쓰도록 한 줄씩, 긴 글은 자른다. 모든 줄에 id 가 있어 edit_show 에 그대로 쓴다.
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const L = (o, k) => (isObj(o) && Array.isArray(o[k]) ? o[k] : []);
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const TEXT_MAX = 70;
const { cueHead, cueDetail, castRows, lookRows, triggerText } = require('./cuehead');

function peopleMap(show) { return new Map(L(show, 'people').filter(isObj).map(p => [p.id, p])); }
function pname(pm, id) { if (!id) return ''; const p = pm.get(id); return p ? p.name : `(삭제된 사람 ${id})`; }
// 소품 (v6) — 모르는 id 는 사이트처럼 "(삭제된 소품)"
function propMap(show) { return new Map(L(show, 'props').filter(isObj).map(p => [p.id, p])); }
function prname(rm, id) { if (!id) return ''; const p = rm.get(id); return p ? p.name : `(삭제된 소품 ${id})`; }
// 이름 붙인 조명 (v11) — 모르는 id 는 사이트처럼 "(삭제된 조명)"
function lookMap(show) { return new Map(L(show, 'lights').filter(isObj).map(p => [p.id, p])); }
function lkname(lm, id) { if (!id) return ''; const p = lm.get(id); return p ? p.name : `(삭제된 조명 ${id})`; }
// 무대 큐 소품 동작 한 줄: "탑햇 in @탑햇테이블 위, 컵 out" (index.html propActsText 의 +/−/→ 대신 동작 이름 그대로)
function propActsText(a, rm) {
  return (Array.isArray(a) ? a : []).filter(x => isObj(x) && x.propId).map(x => `${prname(rm, x.propId)} ${x.action || 'in'}${x.at ? ` @${cut(x.at, 24)}` : ''}`).join(', ');
}

// 큐 한 줄: "<부서 키> <머리글> | <값> — <상세> @ "<시점>" [tbd] memo: …" — 머리글·값·상세는 사이트와 같은 문구(lib/cuehead.js)
function cueSummary(c, pm, rm, tm, lm) {
  const look = { person: id => pname(pm, id), track: no => (tm && tm.get(no)) || '', prop: id => prname(rm || new Map(), id), light: id => lkname(lm || new Map(), id) };
  let H, D;
  try { H = cueHead(c, look); D = cueDetail(c, look); } catch (e) { H = { head: '(unreadable cue)', tbd: c.status === 'tbd' }; D = { val: '', note: '', memo: '' }; }
  // v11 이하 원본의 부서 큐 시점 글 (v12 는 큐 문단의 트리거 — 개요의 큐 줄에)
  const trig = typeof c.trigger === 'string' ? [c.trigger ? `"${cut(c.trigger, 30)}"` : '', c.offsetSec != null ? `+${c.offsetSec}s` : ''].filter(Boolean).join(' ') : '';
  return `${c.dept} ${H.head}${D.val ? ' | ' + cut(D.val, 50) : ''}${D.note ? ' — ' + cut(D.note, 50) : ''}${trig ? ' @ ' + trig : ''}${H.tbd ? ' [tbd]' : ''}${D.memo ? ` memo: ${cut(D.memo, 40)}` : ''}`;
}
function commentLine(c) {
  return `${c.id} comment ${cut(c.author, 12) || '익명'}: ${cut(c.text, 60)}${c.resolved ? ' [resolved]' : ''}`;
}
function sceneName(s, pm) {
  if (s.title) return `"${cut(s.title, 40)}"`;
  return s.type === 'mc' ? `(mc: ${L(s, 'cast').map(id => pname(pm, id)).join(', ') || 'MC'})` : '(untitled)';
}
const fmtDur = sec => (sec == null ? '' : sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60 ? (sec % 60) + 's' : ''}` : `${sec}s`);

// 선택: partId 또는 sceneId 로 좁힌다. 없는 id 면 throw
function select(show, partId, sceneId) {
  const parts = L(show, 'parts');
  if (sceneId) {
    for (const p of parts) for (const s of L(p, 'scenes')) if (isObj(s) && s.id === sceneId) return { parts: [Object.assign({}, p, { scenes: [s] })], scope: 'scene', node: s };
    throw new Error(`no scene with id "${sceneId}"`);
  }
  if (partId) {
    const p = parts.find(x => isObj(x) && x.id === partId);
    if (!p) throw new Error(`no part with id "${partId}"`);
    return { parts: [p], scope: 'part', node: p };
  }
  return { parts, scope: 'show', node: show };
}

function outline(show, opts) {
  opts = opts || {};
  const pm = peopleMap(show), rm = propMap(show), lm = lookMap(show), tm = new Map(L(show, 'tracks').filter(isObj).map(t => [t.no, t.title || '']));
  const sel = select(show, opts.partId, opts.sceneId);
  const out = [];
  // 트리거 글 (사이트와 같은 문구 — lib/cuehead.js triggerText): 큐는 "BLACKOUT(Q15) 후 7초", 대사는 인용
  const items = new Map();
  L(show, 'parts').forEach(p => L(p, 'scenes').forEach(s => L(s, 'items').forEach(i => { if (isObj(i) && i.id != null) items.set(i.id, i); })));
  const tctx = { item: id => items.get(id) || null, q: id => { const i = items.get(id); return i ? i.label : null; }, person: id => pname(pm, id), look: { person: id => pname(pm, id), track: no => tm.get(no) || '', prop: id => prname(rm, id), light: id => lkname(lm, id) } };
  out.push(`show ${opts.showId || show.id || ''} rev ${opts.rev != null ? opts.rev : '?'} "${cut(show.title, 60)}"${show.revision ? ` (${cut(show.revision, 40)})` : ''}${opts.updatedAt ? ` updated ${opts.updatedAt}` : ''}`);
  out.push(`people: ${L(show, 'people').filter(isObj).map(p => `${p.id}=${p.name}(${p.role || 'other'})`).join(', ') || '(none)'}`);
  if (Array.isArray(show.props)) out.push(`props: ${L(show, 'props').filter(isObj).map(p => `${p.id}=${cut(p.name, 24)}`).join(', ') || '(none)'}`);
  if (Array.isArray(show.lights)) out.push(`lights: ${L(show, 'lights').filter(isObj).map(p => `${p.id}=${cut(p.name, 24)}${p.note ? ` (${cut(p.note, 40)})` : ''}`).join(', ') || '(none)'}`);
  if (L(show, 'preShowProps').length && sel.scope === 'show') out.push(`preShowProps: ${propActsText(L(show, 'preShowProps').map(x => (isObj(x) ? { propId: x.propId, action: 'in', at: x.at } : null)), rm)}`);
  out.push(`tracks: ${L(show, 'tracks').filter(isObj).map(t => `BGM ${t.no}=${cut(t.title, 24) || '(untitled)'}${t.loop ? ' loop' : ''}${t.fileKey ? ' [file]' : ''} [${t.id}]`).join(', ') || '(none)'}`);
  if (show.preShowSetup && sel.scope === 'show') out.push(`preShowSetup: ${cut(show.preShowSetup, 120)}`);
  sel.parts.forEach(p => {
    if (!isObj(p)) return;
    out.push(`== part ${p.id} "${cut(p.name, 40)}"`);
    L(p, 'scenes').forEach(s => {
      if (!isObj(s)) return;
      const meta = [s.type, L(s, 'cast').length ? 'cast ' + L(s, 'cast').map(id => pname(pm, id)).join(', ') : '', fmtDur(s.durationSec), s.setup ? 'setup: ' + cut(s.setup, 50) : ''].filter(Boolean).join(' · ');
      out.push(`-- scene ${s.id} ${sceneName(s, pm)} ${meta}`);
      L(s, 'comments').forEach(c => { if (isObj(c)) out.push(`   ${commentLine(c)}`); });
      L(s, 'items').forEach(it => {
        if (!isObj(it)) return;
        const who = it.kind === 'line' && it.speaker ? pname(pm, it.speaker) + ': ' : it.kind === 'line' ? '(no speaker) ' : '';
        let trig = '';
        if (it.kind === 'cue' && isObj(it.trigger)) { try { const T = triggerText(it, tctx, true); trig = ` ← ${it.trigger.type}: ${T.s}${T.bad ? ' [broken]' : ''}${it.trigger.type === 'line' ? ` (${it.trigger.itemId}${it.trigger.at === 'start' ? ' start' : ''})` : it.trigger.type === 'cue' ? ` (${it.trigger.cueId}${it.trigger.mode === 'with' ? ' with' : ''})` : it.trigger.converted ? ' [converted]' : ''}`; } catch (e) { trig = ' ← (unreadable trigger)'; } }
        out.push(`  ${it.id}${it.label != null ? ' Q' + it.label : ''} ${it.kind === 'cue' ? 'cue' + trig : who + (cut(it.text, TEXT_MAX) || '(empty)')}`);
        L(it, 'cues').forEach(c => { if (isObj(c)) out.push(`     ${c.id} ${cueSummary(c, pm, rm, tm, lm)}`); });
        L(it, 'comments').forEach(c => { if (isObj(c)) out.push(`     ${commentLine(c)}`); });
      });
    });
  });
  return out.join('\n');
}

// 검색: 대소문자 무시 부분 일치. 큐 번호는 "Q12" / "12" 처럼 정확히 같을 때
function search(show, query, limit) {
  limit = limit || 50;
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { total: 0, matches: [] };
  const labelQ = /^q?\d+(\.\d+)?$/i.test(q) ? q.replace(/^q/i, '') : null;
  const pm = peopleMap(show), rm = propMap(show), lm = lookMap(show);
  const matches = [];
  let total = 0;
  const snip = (v, k) => { const s = String(v).replace(/\s+/g, ' '); const a = Math.max(0, k - 30); return (a ? '…' : '') + s.slice(a, k + q.length + 40) + (k + q.length + 40 < s.length ? '…' : ''); };
  const check = (base, field, v) => {
    if (v == null || typeof v === 'object') return;
    const k = String(v).replace(/\s+/g, ' ').toLowerCase().indexOf(q);
    if (k < 0) return;
    total++;
    if (matches.length < limit) matches.push(Object.assign({}, base, { field, snippet: snip(v, k) }));
  };
  L(show, 'people').filter(isObj).forEach(p => { const b = { kind: 'person', id: p.id, where: 'people' }; check(b, 'name', p.name); check(b, 'note', p.note); });
  L(show, 'props').filter(isObj).forEach(p => { const b = { kind: 'prop', id: p.id, where: 'props' }; check(b, 'name', p.name); check(b, 'note', p.note); });
  L(show, 'lights').filter(isObj).forEach(p => { const b = { kind: 'look', id: p.id, where: 'lights' }; check(b, 'name', p.name); check(b, 'note', p.note); });
  L(show, 'preShowProps').filter(isObj).forEach((x, i) => { const b = { kind: 'show', id: show.id || null, where: `preShowProps[${i}]` }; if (x.propId) check(b, 'preShowProps.prop', prname(rm, x.propId)); check(b, 'preShowProps.at', x.at); });
  L(show, 'tracks').filter(isObj).forEach(t => { const b = { kind: 'track', id: t.id, where: `BGM ${t.no}` }; check(b, 'title', t.title); check(b, 'note', t.note); });
  check({ kind: 'show', id: show.id || null, where: 'show' }, 'title', show.title);
  check({ kind: 'show', id: show.id || null, where: 'show' }, 'preShowSetup', show.preShowSetup);
  L(show, 'parts').filter(isObj).forEach(p => {
    check({ kind: 'part', id: p.id, where: p.name }, 'name', p.name);
    L(p, 'scenes').filter(isObj).forEach((s, si) => {
      const sw = `${p.name || 'part'} › ${s.title ? cut(s.title, 20) : 'scene ' + (si + 1)}`;
      const sb = { kind: 'scene', id: s.id, where: sw };
      check(sb, 'title', s.title); check(sb, 'setup', s.setup);
      L(s, 'comments').filter(isObj).forEach(c => { const b = { kind: 'comment', id: c.id, sceneId: s.id, where: sw }; check(b, 'text', c.text); check(b, 'author', c.author); });
      L(s, 'items').filter(isObj).forEach((it, ii) => {
        const iw = `${sw} › ${it.label != null ? 'Q' + it.label : '#' + (ii + 1)}`;
        const ib = { kind: 'item', id: it.id, sceneId: s.id, where: iw };
        if (labelQ && it.label != null && String(it.label).toLowerCase() === labelQ) { total++; if (matches.length < limit) matches.push(Object.assign({}, ib, { field: 'label', snippet: `Q${it.label} ${cut(it.text, 60)}` })); }
        check(ib, 'text', it.text);
        if (it.kind === 'cue' && isObj(it.trigger) && it.trigger.type === 'signal') check(ib, 'trigger', it.trigger.text);
        if (it.speaker) check(ib, 'speaker', pname(pm, it.speaker));
        L(it, 'cues').filter(isObj).forEach(c => {
          const cb = { kind: 'cue', id: c.id, itemId: it.id, where: `${iw} ${c.dept}` };
          check(cb, 'trigger', c.trigger); check(cb, 'note', c.note); check(cb, 'memo', c.memo); // memo · */text: v7 이하 원본
          const b = isObj(c[c.dept]) ? c[c.dept] : {};
          if (c.dept === 'stage') { check(cb, 'stage.text', b.text); L(b, 'props').filter(isObj).forEach(x => { if (x.propId) check(cb, 'stage.prop', prname(rm, x.propId)); check(cb, 'stage.propAt', x.at); }); }
          if (c.dept === 'light') { check(cb, 'light.anim', b.anim); L(b, 'channels').filter(isObj).forEach(h => check(cb, 'light.colorName', h.colorName)); lookRows(b).forEach(x => { if (x.lookId) check(cb, 'light.look', lkname(lm, x.lookId)); }); }
          if (c.dept === 'cast') { check(cb, 'cast.text', b.text); castRows(b).forEach(x => { if (x.personId) check(cb, 'cast.person', pname(pm, x.personId)); }); }
          if (c.dept === 'sound' && b.track != null) { const t = L(show, 'tracks').find(x => isObj(x) && x.no === b.track); if (t) check(cb, 'sound.trackTitle', t.title); }
        });
        L(it, 'comments').filter(isObj).forEach(c => { const b = { kind: 'comment', id: c.id, itemId: it.id, where: iw }; check(b, 'text', c.text); check(b, 'author', c.author); });
      });
    });
  });
  return { total, matches };
}

module.exports = { outline, search, select, cueSummary };
