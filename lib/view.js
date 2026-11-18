// MCP 읽기 도구용 보기 — 개요(outline)·부분 JSON·검색. 입출력 없음.
// 개요는 큰 공연에서도 토큰을 적게 쓰도록 한 줄씩, 긴 글은 자른다. 모든 줄에 id 가 있어 edit_show 에 그대로 쓴다.
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const L = (o, k) => (isObj(o) && Array.isArray(o[k]) ? o[k] : []);
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const TEXT_MAX = 70;

function peopleMap(show) { return new Map(L(show, 'people').filter(isObj).map(p => [p.id, p])); }
function pname(pm, id) { if (!id) return ''; const p = pm.get(id); return p ? p.name : `(삭제된 사람 ${id})`; }

// index.html 의 cueSummary 와 같은 내용을 짧게 (채널 이름은 키 그대로)
function lightText(l) {
  const groups = [];
  L(l, 'channels').forEach(c => {
    if (!isObj(c)) return;
    const key = [c.action, c.dim, c.color, c.colorName, c.timeSec].join('|');
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.chs.push(c.ch); else groups.push({ key, chs: [c.ch], c });
  });
  let s = groups.map(g => {
    const c = g.c;
    let t = g.chs.join('·') + ' ' + c.action;
    if (c.action === 'anim' && l.anim) t += ` "${cut(l.anim, 30)}"`;
    if (c.dim != null && c.action !== 'off') t += ' ' + c.dim + '%';
    const col = c.colorName || (c.color ? String(c.color).toUpperCase() : '');
    if (col) t += ' ' + col;
    if (c.timeSec != null) t += ' ' + c.timeSec + 's';
    return t;
  }).join(' · ');
  if (l.anim && !L(l, 'channels').some(x => isObj(x) && x.action === 'anim')) s += (s ? ' · ' : '') + `anim "${cut(l.anim, 30)}"`;
  return s;
}
function cueSummary(c, pm) {
  const d = c.dept, b = isObj(c[d]) ? c[d] : {};
  let s;
  if (d === 'light') s = lightText(b) || '(no channels)';
  else if (d === 'sound') {
    s = `BGM ${b.track == null ? '?' : b.track} ${b.action || ''}`;
    if (b.timeSec != null) s += ' ' + b.timeSec + 's';
    if (b.level != null) s += ' → ' + b.level + '%';
  } else if (d === 'stage') s = cut(b.text, 50) || '(empty)';
  else if (d === 'cast') s = `${pname(pm, b.personId) || '(no person)'} ${b.move || ''}${b.text ? ` (${cut(b.text, 30)})` : ''}`;
  else s = '';
  const trig = [c.trigger ? `"${cut(c.trigger, 30)}"` : '', c.offsetSec != null ? `+${c.offsetSec}s` : ''].filter(Boolean).join(' ');
  return `${d} ${s}${trig ? ' @ ' + trig : ''}${c.status === 'tbd' ? ' [tbd]' : ''}${c.memo ? ` memo: ${cut(c.memo, 40)}` : ''}`;
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
  const pm = peopleMap(show);
  const sel = select(show, opts.partId, opts.sceneId);
  const out = [];
  out.push(`show ${opts.showId || show.id || ''} rev ${opts.rev != null ? opts.rev : '?'} "${cut(show.title, 60)}"${show.revision ? ` (${cut(show.revision, 40)})` : ''}${opts.updatedAt ? ` updated ${opts.updatedAt}` : ''}`);
  out.push(`people: ${L(show, 'people').filter(isObj).map(p => `${p.id}=${p.name}(${p.role || 'other'})`).join(', ') || '(none)'}`);
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
        out.push(`  ${it.id}${it.label != null ? ' Q' + it.label : ''} ${who}${cut(it.text, TEXT_MAX) || '(empty)'}`);
        L(it, 'cues').forEach(c => { if (isObj(c)) out.push(`     ${c.id} ${cueSummary(c, pm)}`); });
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
  const pm = peopleMap(show);
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
        if (it.speaker) check(ib, 'speaker', pname(pm, it.speaker));
        L(it, 'cues').filter(isObj).forEach(c => {
          const cb = { kind: 'cue', id: c.id, itemId: it.id, where: `${iw} ${c.dept}` };
          check(cb, 'trigger', c.trigger); check(cb, 'memo', c.memo);
          const b = isObj(c[c.dept]) ? c[c.dept] : {};
          if (c.dept === 'stage') check(cb, 'stage.text', b.text);
          if (c.dept === 'light') { check(cb, 'light.anim', b.anim); L(b, 'channels').filter(isObj).forEach(h => check(cb, 'light.colorName', h.colorName)); }
          if (c.dept === 'cast') { check(cb, 'cast.text', b.text); if (b.personId) check(cb, 'cast.person', pname(pm, b.personId)); }
          if (c.dept === 'sound' && b.track != null) { const t = L(show, 'tracks').find(x => isObj(x) && x.no === b.track); if (t) check(cb, 'sound.trackTitle', t.title); }
        });
        L(it, 'comments').filter(isObj).forEach(c => { const b = { kind: 'comment', id: c.id, itemId: it.id, where: iw }; check(b, 'text', c.text); check(b, 'author', c.author); });
      });
    });
  });
  return { total, matches };
}

module.exports = { outline, search, select, cueSummary };
