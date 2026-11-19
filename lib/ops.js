// 큐시트 부분 수정 — MCP edit_show 가 쓴다. 입출력 없음(순수 함수).
//
//   applyOps(show, ops) → { show, changes, labels, warnings }   실패하면 OpError (아무것도 바뀌지 않음)
//
// op 네 가지 (자세한 규칙은 docs/mcp.md):
//   { op:"set",    id, kind?, fields }               준 필드만 바꾼다. kind:"show" 면 id 없이 공연 제목·preShowProps 등
//   { op:"add",    kind, parent?, after?, data }     새 항목. parent = 담는 항목 id, after = 형제 id | "first" | null(맨 뒤)
//   { op:"remove", id, kind?, force? }               지운다. 다른 곳이 가리키는 사람·소품·트랙은 force 없으면 거부
//   { op:"move",   id, kind?, parent?, after? }      순서 바꾸기 / 다른 부모로 옮기기 (같은 종류 단계 안에서)
//
// 모든 op 를 적용한 뒤 큐 번호를 1부터 연속으로 맞추고(lib/labels.js relabel — 사이트 저장과 같다) show 전체를 validateShow 로 검사한다.
// op 가 새로 만든 오류가 하나라도 있으면 전부 취소한다. 원래 있던 오류(예: 사이트에서 사람을 지워 남은 참조)는 막지 않는다.
// v5~v10 공연은 사이트가 불러올 때(index.html migrate)처럼 현재 형식(v11)으로 올린다: props·preShowProps 빈 배열, 무대 큐 stage.props 빈 배열,
// 큐 memo · cast.text · stage.text → note, 객석 채널은 on/off 로 접는다(지운 값은 note 에 흔적). v8 → v9 는 version 만 바뀐다(PLAY 시작 볼륨).
// v9 → v10: 출연 큐 { personId, move } → { people: [{ personId, move }] } (한 큐에 여러 사람)
// v10 → v11: 이름 붙인 조명 — show.lights: [] 를 붙이고 조명 큐에 light.looks: [] (채널 큐는 그대로, 바꾸지 않는다)
// v11 → v12: 트리거 — 문단에 붙은 큐를 그 문단 바로 뒤의 큐(kind:'cue' 문단, trigger · offsetSec)로 옮긴다 (upgradeTriggers — index.html migrate legacyCues 와 같은 규칙).
//   큐(문단)의 트리거는 { type:'line', itemId, at } | { type:'cue', cueId, mode } | { type:'signal', text } (+ offsetSec). 옛 글 트리거("암전 후")도 받아 같은 규칙으로 옮긴다.
//   대사·큐를 지울 때 그것을 트리거로 쓰던 큐는 기본으로 남기고 신호로 바꾼다(converted) — remove 의 mode 로 함께 지울 수 있다
const { validateShow, castRows, lookRows, CONST, SHOW_VER } = require('./validate');
const { relabel, showItems, renumberLabels } = require('./labels');
const { cueItemHead, lineQuote } = require('./cuehead');

const { DEPTS, CH, L_ACT, S_ACT, MOVES, PROP_ACTS, HOUSE_ACTS, LOOK_ACTS, ROLES, ACT_RE } = CONST;
// index.html 의 isActHead 와 같다: 지문 여부는 첫 줄(Shift+Enter 줄바꿈 전)의 앞 기호로 본다
function isActHead(raw) { const t = String(raw || ''), i = t.indexOf('\n'); return ACT_RE.test(i < 0 ? t : t.slice(0, i)); }
const SCENE_TYPES = ['mc', 'act'];
const ITEM_KINDS = ['line', 'action', 'cue']; // cue = 큐 (v12: 본문 없이 트리거 + 부서 동작 cues)
const STATUS = ['set', 'tbd'];

const KINDS = ['part', 'scene', 'item', 'cue', 'comment', 'person', 'prop', 'look', 'track'];
// index.html 의 uid() 접두어와 같다
const PREFIX = { part: 'pt', scene: 's', item: 'i', cue: 'q', comment: 'c', person: 'p', prop: 'pr', look: 'lk', track: 'tr' };
// 담는 항목 종류 (없으면 show 바로 아래)
const PARENTS = { part: null, person: null, prop: null, look: null, track: null, scene: ['part'], item: ['scene'], cue: ['item'], comment: ['scene', 'item'] };
// 부모 안의 배열 이름
const CHILD_KEY = { part: 'parts', person: 'people', prop: 'props', look: 'lights', track: 'tracks', scene: 'scenes', item: 'items', cue: 'cues', comment: 'comments' };
// add 의 data 에 함께 넣을 수 있는 자식 배열
const CHILDREN = { part: ['scenes'], scene: ['comments', 'items'], item: ['cues', 'comments'] };
const NEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OPS = 500;

class OpError extends Error {
  // code: bad_op | not_found | ambiguous | bad_field | referenced | invalid
  constructor(code, message, extra) { super(message); this.name = 'OpError'; this.code = code; Object.assign(this, extra); }
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const L = (o, k) => (isObj(o) && Array.isArray(o[k]) ? o[k] : []);
// 사용자가 준 키는 자기 속성으로만 찾는다 (constructor·toString·__proto__ 같은 상속 이름이 필드로 통과하지 않게)
const has = (o, k) => Object.hasOwn(o, k);
const clone = o => JSON.parse(JSON.stringify(o));
const j = v => JSON.stringify(v);
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
function uid(p) { return (p || 'x') + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

// ---- 필드 형식. 각 함수는 (값, ctx) → 정규화한 값, 틀리면 throw ctx.bad(설명)
const F = {
  str: (v, c) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw c.bad('a string');
  },
  strN: (v, c) => (v == null || v === '' ? null : F.str(v, c)),
  num: (v, c) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (!Number.isFinite(n)) throw c.bad('a number or null');
    return n;
  },
  numReq: (v, c) => { const n = F.num(v, c); if (n == null) throw c.bad('a number'); return n; },
  // 트랙 번호: 1 이상의 정수 (음향 큐의 sound.track 은 null 도 됨)
  trackNo: (v, c) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; if (n == null || !Number.isInteger(n) || n < 1) throw c.bad('a whole number ≥ 1 (track no)'); return n; },
  trackNoN: (v, c) => (v == null || v === '' ? null : F.trackNo(v, c)),
  bool: (v, c) => { if (typeof v === 'boolean') return v; if (v === 'true' || v === 'false') return v === 'true'; throw c.bad('true or false'); },
  oneOf: list => (v, c) => { if (!list.includes(v)) throw c.bad(`one of ${list.join('|')}`); return v; },
  person: (v, c) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') throw c.bad('a person id string (people[].id) or null');
    if (!c.people.has(v)) {
      const byName = c.peopleArr.find(p => p && p.name === v.trim());
      throw c.bad(byName ? `a person id — "${v}" is a name, use id "${byName.id}"`
        : `a person id from people[] (known: ${c.peopleArr.map(p => `${p.id}=${p.name}`).join(', ') || 'none — add the person first'})`);
    }
    return v;
  },
  people: (v, c) => {
    if (!Array.isArray(v)) throw c.bad('an array of person ids');
    return Array.from(new Set(v.map((x, i) => F.person(x, Object.assign({}, c, { bad: m => c.bad(`[${i}] ${m}`) }))).filter(Boolean)));
  },
  // 소품 참조 (v6): 사람처럼 props[].id 만 받는다. 빈 값은 브라우저 saveCue 처럼 거부
  prop: (v, c) => {
    if (typeof v !== 'string' || !v) throw c.bad('a prop id string (props[].id)');
    if (!c.props.has(v)) {
      const byName = c.propsArr.find(p => p && p.name === v.trim());
      throw c.bad(byName ? `a prop id — "${v}" is a name, use id "${byName.id}"`
        : `a prop id from props[] (known: ${c.propsArr.map(p => `${p.id}=${p.name}`).join(', ') || 'none — add the prop first with {"op":"add","kind":"prop"}'})`);
    }
    return v;
  },
  // 이름 붙인 조명 참조 (v11): lights[].id 만 받는다
  look: (v, c) => {
    if (typeof v !== 'string' || !v) throw c.bad('a look id string (lights[].id)');
    if (!c.looks.has(v)) {
      const byName = c.looksArr.find(p => p && p.name === v.trim());
      throw c.bad(byName ? `a look id — "${v}" is a name, use id "${byName.id}"`
        : `a look id from lights[] (known: ${c.looksArr.map(p => `${p.id}=${p.name}`).join(', ') || 'none — add the look first with {"op":"add","kind":"look"}'})`);
    }
    return v;
  }
};
// 무대 큐 소품 동작 / 공연 전 무대 소품 (index.html saveCue · pre-prop-add 와 같은 모양)
const PROP_ACT = { propId: F.prop, action: F.oneOf(PROP_ACTS), at: F.str };
const PROP_ACT_BLANK = () => ({ propId: null, action: 'in', at: '' });
const PRE_PROP = { propId: F.prop, at: F.str };
const PRE_PROP_BLANK = () => ({ propId: null, at: '' });
const FIELDS = {
  show: { title: F.str, preShowSetup: F.str, revision: F.str, preShowProps: null },
  person: { name: F.str, role: F.oneOf(ROLES), note: F.str },
  prop: { name: F.str, note: F.str },
  look: { name: F.str, note: F.str },
  track: { no: F.trackNo, title: F.str, durationSec: F.num, note: F.str, loop: F.bool },
  part: { name: F.str },
  scene: { type: F.oneOf(SCENE_TYPES), title: F.str, cast: F.people, durationSec: F.num, setup: F.str },
  // trigger · offsetSec 은 큐(kind:'cue' 문단)에만 (v12). trigger 는 아래 trigIn 이 읽는다
  item: { kind: F.oneOf(ITEM_KINDS), speaker: F.person, text: F.str, trigger: null, offsetSec: F.num },
  cue: { dept: F.oneOf(DEPTS), note: F.str, status: F.oneOf(STATUS), light: null, sound: null, stage: null, cast: null },
  comment: { author: F.str, text: F.str, resolved: F.bool, resolvedBy: F.strN }
};
const SUB = {
  // v11: looks = [{ lookId, action: on|off }] 통째로 (이름 붙인 조명 켜기·끄기). channels = 채널 상세 (같이 있어도 된다)
  light: { looks: null, channels: null, anim: F.str },
  sound: { track: F.trackNoN, action: F.oneOf(S_ACT), timeSec: F.num, level: F.num },
  stage: { props: null },
  // v10: people = [{ personId, move }] 통째로. personId · move 는 v9 까지의 한 사람 입력 — 사람이 0·1명인 큐에만 (그 한 줄을 고친다)
  cast: { people: null, personId: F.person, move: F.oneOf(MOVES) }
};
const CAST_ROW = { personId: F.person, move: F.oneOf(MOVES) };
const LOOK_ROW = { lookId: F.look, action: F.oneOf(LOOK_ACTS) };
// v8 에서 없어진 필드 → 거부할 때 알려 줄 곳
const GONE = { 'cue.memo': 'note', 'stage.text': 'note (the cue\'s common detail field)', 'cast.text': 'note (the cue\'s common detail field)' };
const CHANNEL = { ch: F.oneOf(CH), action: F.oneOf(L_ACT), dim: F.num, color: F.strN, colorName: F.strN, timeSec: F.num };

// 브라우저가 새로 만들 때 쓰는 값 (index.html: part-add, scene-add, newItem, saveCue, comment-add, person-save, prop-save, track-add, migrate)
function blank(kind, show) {
  switch (kind) {
    case 'part': return { name: '', scenes: [] };
    case 'scene': return { type: 'act', title: '', cast: [], durationSec: null, setup: '', comments: [], items: [] };
    case 'item': return { kind: 'line', speaker: null, text: '', label: null, isCue: false, cues: [], comments: [] };
    case 'cue': return { dept: null, note: '', status: 'set' };
    case 'comment': return { author: '익명', text: '', createdAt: new Date().toISOString(), resolved: false, resolvedBy: null, resolvedAt: null };
    case 'person': return { name: '', role: 'other', note: '' };
    case 'prop': return { name: '', note: '' };
    case 'look': return { name: '', note: '' };
    case 'track': {
      const max = (show.tracks || []).reduce((m, t) => Math.max(m, (t && typeof t.no === 'number' && t.no) || 0), 0);
      return { no: max + 1, title: '', durationSec: null, fileName: null, fileKey: null, note: '', loop: false };
    }
  }
}
const DEPT_BLANK = {
  light: () => ({ looks: [], channels: [], anim: '' }),
  sound: () => ({ track: null, action: 'play', timeSec: null, level: null }),
  stage: () => ({ props: [] }),
  cast: () => ({ people: [] })
};
const CHANNEL_BLANK = () => ({ ch: 'front', action: 'on', dim: null, color: null, colorName: null, timeSec: null });

// index.html migrate 의 cueNote · houseTrace 와 같은 규칙 (v8)
function cueNote(c, dept) {
  const body = isObj(c[dept]) ? c[dept] : {};
  const parts = [c.note, dept === 'cast' || dept === 'stage' ? body.text : null, c.memo].map(v => (v == null ? '' : String(v).trim())).filter(Boolean);
  return Array.from(new Set(parts)).join(' / ');
}
const L_ACT_L = { on: 'ON', off: 'OFF', fadeIn: 'FADE IN', fadeOut: 'FADE OUT', anim: 'ANIM' };
const houseOnOff = a => (a === 'off' || a === 'fadeOut' ? 'off' : 'on');
function houseTrace(x) {
  const v = [x.dim != null ? x.dim + '%' : '', x.colorName || x.color || '', x.timeSec != null ? x.timeSec + 's' : ''].filter(Boolean);
  if ((x.action === 'on' || x.action === 'off') && !v.length) return '';
  return '객석: 원래 ' + [L_ACT_L[x.action] || x.action].concat(v).join(' ');
}
// 큐 하나를 v8 모양으로 (값은 그대로, 옮기기만). 키 순서도 migrate 와 같게: id, dept, trigger, offsetSec, note, status, <dept>
function upgradeCue(c) {
  if (!isObj(c)) return c;
  const d = c.dept, out = {};
  let note = cueNote(c, d);
  const body = isObj(c[d]) ? Object.assign({}, c[d]) : c[d];
  if (d === 'light' && isObj(body) && Array.isArray(body.channels)) {
    const traces = [];
    body.channels = body.channels.map(x => {
      if (!isObj(x) || x.ch !== 'house') return x;
      const t = houseTrace(x); if (t) traces.push(t);
      return { ch: 'house', action: houseOnOff(x.action), dim: null, color: null, colorName: null, timeSec: null };
    });
    if (traces.length) note = [note, '(' + traces.join(', ') + ')'].filter(Boolean).join(' / ');
  }
  if ((d === 'stage' || d === 'cast') && isObj(body)) delete body.text;
  if (d === 'stage' && isObj(body) && !Array.isArray(body.props)) body.props = [];
  for (const k of Object.keys(c)) {
    if (k === 'memo' || k === 'note') continue;
    if (k === 'status' && !has(out, 'note')) out.note = note;
    out[k] = k === d ? body : c[k];
  }
  if (!has(out, 'note')) out.note = note;
  return out;
}
// v5~v8 → 현재 형식 (lib/validate.js SHOW_VER — 서버 스키마·index.html 과 같은 값): index.html migrate 가 불러올 때 하는 모양 바꾸기를 미리 한다.
// 소품 배열을 붙이고, 큐(코멘트 snapshot 안의 큐 포함)를 upgradeCue 로. 키 순서도 migrate 와 같게
function upgradeShow(show) {
  if (!CONST.SHOW_VERS.includes(show.version)) return show; // 더 옛 형식은 사이트의 변환(번호 다시 매기기 등)에 맡긴다
  const from = show.version;
  show.version = SHOW_VER;
  if (!Array.isArray(show.props) || !Array.isArray(show.preShowProps)) {
    const props = Array.isArray(show.props) ? show.props : [], pre = Array.isArray(show.preShowProps) ? show.preShowProps : [];
    const out = {};
    for (const k of Object.keys(show)) {
      if (k === 'props' || k === 'preShowProps') continue;
      if (k === 'tracks' || k === 'parts') { if (!has(out, 'props')) { out.props = props; out.preShowProps = pre; } }
      out[k] = show[k];
    }
    if (!has(out, 'props')) { out.props = props; out.preShowProps = pre; }
    show = out;
  }
  // v11: 이름 붙인 조명 목록 — preShowProps 뒤 (index.html migrate 의 키 순서)
  if (!Array.isArray(show.lights)) {
    const out = {};
    for (const k of Object.keys(show)) {
      if (k === 'lights') continue;
      if ((k === 'tracks' || k === 'parts') && !has(out, 'lights')) out.lights = [];
      out[k] = show[k];
    }
    if (!has(out, 'lights')) out.lights = [];
    show = out;
  }
  // 큐 목록마다 (문단의 cues · 코멘트 snapshot 안의 cues)
  const eachCues = fn => {
    const cmts = o => { if (isObj(o) && Array.isArray(o.comments)) o.comments.forEach(cm => { if (isObj(cm) && isObj(cm.snapshot) && Array.isArray(cm.snapshot.cues)) cm.snapshot.cues = cm.snapshot.cues.map(fn); }); };
    (Array.isArray(show.parts) ? show.parts : []).forEach(p => (isObj(p) && Array.isArray(p.scenes) ? p.scenes : []).forEach(sc => {
      cmts(sc);
      (isObj(sc) && Array.isArray(sc.items) ? sc.items : []).forEach(it => { if (!isObj(it)) return; cmts(it); if (Array.isArray(it.cues)) it.cues = it.cues.map(fn); });
    }));
  };
  if (from < 8) eachCues(upgradeCue); // v8 → v9 는 version 만 (PLAY 의 sound.level = 시작 볼륨, 모양은 같다)
  eachCues(upgradeCast); // v10: 출연 큐 people (v10 인데 옛 모양으로 올라온 큐도 같이)
  eachCues(upgradeLight); // v11: 조명 큐 light.looks
  if (upgradeTriggers(show) || from < 12) renumberLabels(show); // v12: 큐 문단 (v12 인데 옛 모양으로 올라온 큐도 같이)
  return show;
}
// ---- v12 트리거 (index.html migrate 의 legacyCues 와 같은 규칙)
const LEGACY_LINE_END = /^(이\s*)?(대사|멘트)\s*(끝|끝에|끝나면|끝나고|후|뒤|즈음|때)?$/;
const LEGACY_NOTE = '옮기기 전 글: ';
// 옮기며 남길 옛 글 — 빈 글 · "이전 큐 후" · "대사 끝" 꼴은 그 말 그대로라 남기지 않는다
const legacyKeep = text => { const t = String(text == null ? '' : text).trim(); return t && t !== '이전 큐 후' && !LEGACY_LINE_END.test(t) ? t : ''; };
// 옛 글 트리거 → 트리거. holder = 그 큐가 붙어 있던 대사·지문(없으면 null), prev = 앞 문단까지의 마지막 큐 id
// 대사·지문에 붙은 큐는 글과 상관없이 그 문단 끝 (결정 1) — 남길 글이 있으면 migrated:true · was:글 (점검 참고 "옮기며 대사 끝으로 정한 큐")
function legacyTrig(text, holder, prev) {
  const t = String(text == null ? '' : text).trim();
  if (t === '이전 큐 후' && prev) return { type: 'cue', cueId: prev, mode: 'after' };
  if (holder) { const k = legacyKeep(t); return k ? { type: 'line', itemId: holder.id, at: 'end', migrated: true, was: k } : { type: 'line', itemId: holder.id, at: 'end' }; }
  return { type: 'signal', text: t };
}
// 대사·지문에서 옮긴 동작의 메모에 "옮기기 전 글: …" (이미 있으면 그대로)
function legacyNote(c, text) {
  const k = legacyKeep(text); if (!k || !isObj(c)) return c;
  const add = LEGACY_NOTE + k, n = typeof c.note === 'string' ? c.note.trim() : '';
  if (n.split(' / ').includes(add)) return c;
  return Object.assign({}, c, { note: n ? n + ' / ' + add : add });
}
const stripTrig = c => { if (!isObj(c)) return c; const o = {}; for (const k of Object.keys(c)) if (k !== 'trigger' && k !== 'offsetSec') o[k] = c[k]; return o; };
// v11 → v12: 문단에 붙은 큐 → 그 문단 + 바로 뒤 큐 문단들. 바뀐 것이 있으면 true (번호는 부르는 쪽이 다시 매긴다)
function upgradeTriggers(show) {
  let changed = false, last = null;
  const used = new Set();
  L(show, 'parts').forEach(p => L(p, 'scenes').forEach(s => L(s, 'items').forEach(i => { if (isObj(i) && i.id != null && i.id !== '') used.add(String(i.id)); })));
  const fresh = base => { let v = base, k = 1; while (used.has(v)) v = base + '-' + (++k); used.add(v); return v; };
  const snaps = o => L(o, 'comments').forEach(cm => {
    if (!isObj(cm) || !isObj(cm.snapshot)) return;
    if (cm.snapshot.kind !== 'cue') { if (Array.isArray(cm.snapshot.cues) && cm.snapshot.cues.length) { cm.snapshot.cues = []; changed = true; } }
    else if (Array.isArray(cm.snapshot.cues)) cm.snapshot.cues = cm.snapshot.cues.map(stripTrig);
  });
  L(show, 'parts').forEach(p => L(p, 'scenes').forEach(s => {
    if (!isObj(s) || !Array.isArray(s.items)) return;
    s.items = s.items.flatMap(it => {
      if (!isObj(it)) return [it];
      snaps(it);
      const prev = last, raw = L(it, 'cues').filter(isObj), isPt = it.kind === 'cue';
      if (isPt && isObj(it.trigger)) { last = it.id; if (raw.some(c => has(c, 'trigger') || has(c, 'offsetSec'))) { it.cues = it.cues.map(stripTrig); changed = true; } return [it]; }
      if (!raw.length) return [it];
      changed = true;
      const groups = [];
      raw.forEach(c => { const t = String(c.trigger == null ? '' : c.trigger).trim(), off = typeof c.offsetSec === 'number' ? c.offsetSec : null, g = groups.find(x => x.t === t && x.off === off); if (g) g.cues.push(c); else groups.push({ t, off, cues: [c] }); });
      const out = [];
      if (!isPt) { it.cues = []; it.isCue = false; it.label = null; out.push(it); }
      groups.forEach((g, k) => {
        const id = isPt && !k ? it.id : fresh(String(it.id) + (k ? '-q' + (k + 1) : '-q'));
        out.push({ id, kind: 'cue', speaker: null, text: '', label: isPt && !k ? it.label : null, isCue: true, trigger: legacyTrig(g.t, isPt ? null : it, g.t === '이전 큐 후' ? prev : null), offsetSec: g.off, cues: g.cues.map(stripTrig).map(c => (isPt ? c : legacyNote(c, g.t))), comments: isPt && !k ? (Array.isArray(it.comments) ? it.comments : []) : [] });
        last = id;
      });
      return out;
    });
  }));
  return changed;
}
// 조명 큐 하나를 v11 모양으로: looks 가 없으면 [] 를 앞에 (index.html migrate 의 { looks, channels, anim } 순서). 채널은 그대로
function upgradeLight(c) {
  if (!isObj(c) || c.dept !== 'light' || !isObj(c.light) || Array.isArray(c.light.looks)) return c;
  const out = Object.assign({}, c);
  out.light = Object.assign({ looks: [] }, c.light);
  return out;
}
// 출연 큐 하나를 v10 모양으로: { personId(또는 name), move } → { people: [{ personId, move }] }. index.html migrate 와 같이
// 사람이 비어 있어도 그 줄은 남긴다("출연자 미정 OUT" 의 OUT 을 잃지 않게)
function upgradeCast(c) {
  if (!isObj(c) || c.dept !== 'cast' || !isObj(c.cast) || Array.isArray(c.cast.people)) return c;
  const out = Object.assign({}, c);
  out.cast = { people: castRows(c.cast).map(x => ({ personId: x.personId, move: MOVES.includes(x.move) ? x.move : 'in' })) };
  if (!out.cast.people.length) out.cast.people.push({ personId: null, move: 'in' });
  return out;
}

// ---- 색인: id → [{ kind, obj, arr, parent, parentKind, where }]
function buildIndex(show) {
  const byId = new Map();
  const put = (kind, obj, arr, parent, parentKind, where) => {
    if (!isObj(obj) || obj.id == null || obj.id === '') return;
    const id = String(obj.id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ kind, obj, arr, parent, parentKind, where });
  };
  const L = (o, k) => (isObj(o) && Array.isArray(o[k]) ? o[k] : []);
  L(show, 'people').forEach(p => put('person', p, show.people, show, 'show', `사람 ${isObj(p) ? p.name : ''}`));
  L(show, 'props').forEach(p => put('prop', p, show.props, show, 'show', `소품 ${isObj(p) ? p.name : ''}`));
  L(show, 'lights').forEach(p => put('look', p, show.lights, show, 'show', `조명 ${isObj(p) ? p.name : ''}`));
  L(show, 'tracks').forEach(t => put('track', t, show.tracks, show, 'show', `BGM ${isObj(t) ? t.no : ''}`));
  L(show, 'parts').forEach((p, pi) => {
    const pn = isObj(p) && p.name ? p.name : `파트 ${pi + 1}`;
    put('part', p, show.parts, show, 'show', pn);
    L(p, 'scenes').forEach((s, si) => {
      const sn = `${pn} › ${isObj(s) && s.title ? cut(s.title, 20) : `씬 ${si + 1}`}`;
      put('scene', s, p.scenes, p, 'part', sn);
      L(s, 'comments').forEach(c => put('comment', c, s.comments, s, 'scene', `${sn} 코멘트`));
      L(s, 'items').forEach((it, ii) => {
        const iw = `${sn} › ${isObj(it) && it.label != null ? 'Q' + it.label : '#' + (ii + 1)}${isObj(it) && it.kind === 'cue' ? ' cue' : isObj(it) && it.text ? ` "${cut(it.text, 20)}"` : ''}`;
        put('item', it, s.items, s, 'scene', iw);
        L(it, 'cues').forEach(c => put('cue', c, it.cues, it, 'item', `${iw} ${isObj(c) ? c.dept : ''} action`));
        L(it, 'comments').forEach(c => put('comment', c, it.comments, it, 'item', `${iw} 코멘트`));
      });
    });
  });
  return byId;
}

function applyOps(input, ops) {
  if (!isObj(input) || !Array.isArray(input.parts)) throw new OpError('bad_op', 'show 가 올바르지 않습니다 (parts 배열 없음)');
  if (!Array.isArray(ops) || !ops.length) throw new OpError('bad_op', 'ops must be a non-empty array of operations');
  if (ops.length > MAX_OPS) throw new OpError('bad_op', `too many ops (${ops.length}); send at most ${MAX_OPS} per call`);
  const before = input;
  const show = upgradeShow(clone(input));
  if (!Array.isArray(show.people)) show.people = [];
  if (!Array.isArray(show.props)) show.props = [];
  if (!Array.isArray(show.preShowProps)) show.preShowProps = [];
  if (!Array.isArray(show.lights)) show.lights = [];
  if (!Array.isArray(show.tracks)) show.tracks = [];
  const changes = [], warnings = [];
  const forcedPeople = new Set();
  const legacy = []; // 옛 글 트리거를 받은 큐 — 자리를 잡은 뒤 legacyTrig 로 옮긴다 { obj, text, holder }
  let idx = buildIndex(show);
  let opi = 0, opName = '';
  const fail = (code, msg, extra) => new OpError(code, `ops[${opi}] ${opName}: ${msg}`, Object.assign({ opIndex: opi }, extra));
  const warn = msg => warnings.push({ path: `ops[${opi}]`, msg });
  const peopleSet = () => new Set(show.people.filter(isObj).map(p => String(p.id)));
  const propSet = () => new Set(show.props.filter(isObj).map(p => String(p.id)));
  const lookSet = () => new Set(show.lights.filter(isObj).map(p => String(p.id)));
  const allIds = () => idx;

  function resolve(id, kinds, what) {
    if (typeof id !== 'string' || !id) throw fail('bad_op', `${what || 'id'} must be a non-empty string id`);
    let es = idx.get(id) || [];
    if (kinds) es = es.filter(e => kinds.includes(e.kind));
    if (!es.length) {
      const other = (idx.get(id) || []).map(e => e.kind);
      throw fail('not_found', other.length ? `id "${id}" is a ${other.join('/')}, not a ${kinds.join('/')}`
        : `no ${kinds ? kinds.join('/') : 'item'} with id "${id}" — call get_show (outline) to see current ids`);
    }
    if (es.length > 1) throw fail('ambiguous', `id "${id}" matches ${es.map(e => `${e.kind} (${e.where})`).join(', ')} — add "kind" to say which`);
    return es[0];
  }
  function ctxFor(field) {
    return { bad: m => fail('bad_field', `field "${field}" must be ${m}`), people: peopleSet(), peopleArr: show.people.filter(isObj), props: propSet(), propsArr: show.props.filter(isObj), looks: lookSet(), looksArr: show.lights.filter(isObj) };
  }
  function checkKeys(o, allowed, what) {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) throw fail('bad_op', `unknown key "${k}" in ${what} — allowed: ${allowed.join(', ')}`);
  }

  // 큐(문단)의 트리거 입력: 구조 { type, … } 또는 옛 글("암전 후", "이전 큐 후", "대사 끝") — 글은 자리를 잡은 뒤 legacyTrig 로 옮긴다
  function trigIn(v, obj) {
    if (typeof v === 'string') { legacy.push({ obj, text: v }); return { type: 'signal', text: v }; }
    const shape = '{"type":"line","itemId":"<line id>","at":"end"|"start"} | {"type":"cue","cueId":"<cue item id>","mode":"after"|"with"} | {"type":"signal","text":"박수 끝"} (or a legacy text like "암전 후")';
    if (!isObj(v)) throw fail('bad_field', `field "trigger" must be ${shape}`);
    const allowed = { line: ['type', 'itemId', 'at'], cue: ['type', 'cueId', 'mode'], signal: ['type', 'text'] }[v.type];
    if (!allowed) throw fail('bad_field', `field "trigger.type" must be line|cue|signal — ${shape}`);
    for (const k of Object.keys(v)) if (!allowed.includes(k)) throw fail('bad_field', `unknown field "trigger.${k}" for a ${v.type} trigger. Allowed: ${allowed.join(', ')}`);
    if (v.type === 'line') {
      if (typeof v.itemId !== 'string' || !v.itemId) throw fail('bad_field', 'field "trigger.itemId" must be the id of a line/action item (the cue goes at its end, or start with at:"start")');
      if (v.at != null && v.at !== 'end' && v.at !== 'start') throw fail('bad_field', 'field "trigger.at" must be end|start (default end)');
      return { type: 'line', itemId: v.itemId, at: v.at === 'start' ? 'start' : 'end' };
    }
    if (v.type === 'cue') {
      if (typeof v.cueId !== 'string' || !v.cueId) throw fail('bad_field', 'field "trigger.cueId" must be the id of another cue item (kind:"cue")');
      if (v.mode != null && v.mode !== 'after' && v.mode !== 'with') throw fail('bad_field', 'field "trigger.mode" must be after|with (default after)');
      return { type: 'cue', cueId: v.cueId, mode: v.mode === 'with' ? 'with' : 'after' };
    }
    return { type: 'signal', text: F.str(v.text, ctxFor('trigger.text')) };
  }
  // 흐름에서 이 문단보다 앞의 마지막 큐 · 마지막 대사(글 문단)
  function prevOf(obj) {
    let cue = null, line = null;
    for (const p of L(show, 'parts')) for (const s of L(p, 'scenes')) for (const it of L(s, 'items')) { if (it === obj) return { cue, line }; if (!isObj(it)) continue; if (it.kind === 'cue') cue = it; else line = it; }
    return { cue: null, line: null };
  }
  function resolveLegacy() {
    legacy.splice(0).forEach(x => {
      if (x.obj.kind !== 'cue') return;
      const pv = prevOf(x.obj), holder = x.holder || (pv.line && String(x.text).trim() !== '이전 큐 후' && (String(x.text).trim() === '' || LEGACY_LINE_END.test(String(x.text).trim())) ? pv.line : null);
      x.obj.trigger = legacyTrig(x.text, holder, pv.cue ? pv.cue.id : null);
      warn(`legacy text trigger "${cut(x.text, 30)}" on cue item ${x.obj.id} → ${j(x.obj.trigger)}`);
    });
  }

  // fields 를 obj 에 덮어쓴다. cue 의 light/sound/stage/cast 는 한 단계 얕게 합친다(channels 배열은 통째로 바뀜)
  function patch(kind, obj, fields, isAdd) {
    if (!isObj(fields)) throw fail('bad_op', `"${isAdd ? 'data' : 'fields'}" must be an object`);
    const spec = FIELDS[kind];
    const keys = Object.keys(fields);
    for (const k of keys) {
      if (k === 'id') { if (isAdd) continue; throw fail('bad_field', 'ids cannot be changed (remove and add instead)'); }
      if (isAdd && CHILDREN[kind] && CHILDREN[kind].includes(k)) continue;
      if (!has(spec, k)) {
        if (kind === 'cue' && k === 'memo') throw fail('bad_field', `field "memo" was merged into "note" in show v8 — send note instead. Allowed: ${Object.keys(spec).join(', ')}`);
        if (kind === 'cue' && (k === 'trigger' || k === 'offsetSec')) throw fail('bad_field', `field "${k}" moved to the cue item in show v12 — a cue item (item kind:"cue") has one trigger shared by all its actions. Send {"op":"set","id":"<cue item id>","fields":{"${k}":…}}. Allowed: ${Object.keys(spec).join(', ')}`);
        const hint = CHILDREN[kind] && CHILDREN[kind].includes(k) ? ` — "${k}" is a child list; use add/remove/move ops on its entries` : kind === 'show' && (k === 'props' || k === 'people' || k === 'tracks' || k === 'lights') ? ` — use add/set/remove/move ops with kind:"${{ props: 'prop', people: 'person', tracks: 'track', lights: 'look' }[k]}" on its entries` : k === 'label' ? ' — cue numbers are assigned automatically: always 1, 2, 3 … in script order, renumbered after every edit' : k === 'isCue' ? ' — isCue follows cues automatically' : (k === 'fileName' || k === 'fileKey') ? ' — audio files are managed in the web app' : '';
        throw fail('bad_field', `unknown field "${k}" for ${kind}${hint}. Allowed: ${Object.keys(spec).join(', ')}`);
      }
    }
    if (kind === 'cue') {
      // dept 를 먼저: 바뀌면 이전 부서 내용은 버리고 새 부서 기본값에서 시작
      const dept = has(fields, 'dept') ? F.oneOf(DEPTS)(fields.dept, ctxFor('dept')) : obj.dept;
      if (!dept) throw fail('bad_field', `field "dept" is required for a cue — one of ${DEPTS.join('|')}`);
      if (dept !== obj.dept) { if (obj.dept) delete obj[obj.dept]; obj.dept = dept; }
      for (const d of DEPTS) if (d !== dept && has(fields, d)) throw fail('bad_field', `this is a ${dept} cue, so it has no "${d}" content — to change the department send dept:"${d}" too`);
      if (!isObj(obj[dept])) obj[dept] = DEPT_BLANK[dept]();
      for (const k of keys) {
        if (k === 'id' || k === 'dept') continue;
        if (DEPTS.includes(k)) patchDept(k, obj[k], fields[k]);
        else obj[k] = spec[k](fields[k], ctxFor(k));
      }
      return;
    }
    for (const k of keys) {
      if (k === 'id' || !has(spec, k) || (kind === 'comment' && (k === 'resolved' || k === 'resolvedBy'))) continue;
      if (kind === 'show' && k === 'preShowProps') obj.preShowProps = propRows(fields.preShowProps, 'preShowProps', PRE_PROP, PRE_PROP_BLANK);
      else if (kind === 'item' && k === 'trigger') obj.trigger = trigIn(fields.trigger, obj);
      else obj[k] = spec[k](fields[k], ctxFor(k));
    }
    // 코멘트 해결: 브라우저 comment-resolve 와 같이 해결자·시각을 함께 (해제하면 둘 다 null)
    if (kind === 'comment' && (has(fields, 'resolved') || has(fields, 'resolvedBy'))) {
      const was = !!obj.resolved;
      const now = has(fields, 'resolved') ? F.bool(fields.resolved, ctxFor('resolved')) : was;
      const by = has(fields, 'resolvedBy') ? F.strN(fields.resolvedBy, ctxFor('resolvedBy')) : undefined;
      obj.resolved = now;
      if (!now) { obj.resolvedBy = null; obj.resolvedAt = null; }
      else {
        if (!was) obj.resolvedAt = new Date().toISOString();
        obj.resolvedBy = by || (was ? obj.resolvedBy : null) || '익명';
      }
    }
  }
  function patchDept(dept, body, val) {
    if (!isObj(val)) throw fail('bad_field', `field "${dept}" must be an object like ${j(DEPT_BLANK[dept]())}`);
    const spec = SUB[dept];
    for (const k of Object.keys(val)) {
      if (GONE[`${dept}.${k}`]) throw fail('bad_field', `field "${dept}.${k}" was removed in show v8 — use ${GONE[`${dept}.${k}`]}. Allowed in ${dept}: ${Object.keys(spec).join(', ') || '(none)'}`);
      if (!has(spec, k)) throw fail('bad_field', `unknown field "${dept}.${k}". Allowed: ${Object.keys(spec).join(', ')}`);
      if (dept === 'light' && k === 'channels') {
        if (!Array.isArray(val.channels)) throw fail('bad_field', 'field "light.channels" must be an array of { ch, action, dim, color, colorName, timeSec }');
        body.channels = val.channels.map((ch, i) => {
          if (!isObj(ch)) throw fail('bad_field', `light.channels[${i}] must be an object`);
          const out = CHANNEL_BLANK();
          for (const ck of Object.keys(ch)) {
            if (!has(CHANNEL, ck)) throw fail('bad_field', `unknown field "light.channels[${i}].${ck}". Allowed: ${Object.keys(CHANNEL).join(', ')}`);
            out[ck] = CHANNEL[ck](ch[ck], ctxFor(`light.channels[${i}].${ck}`));
          }
          // v8: 객석은 켠다/끈다만 (브라우저 편집 모달과 같다)
          if (out.ch === 'house' && (!HOUSE_ACTS.includes(out.action) || out.dim != null || out.color != null || out.colorName != null || out.timeSec != null)) {
            throw fail('bad_field', `light.channels[${i}]: the house channel (객석) is on/off only — action ${HOUSE_ACTS.join('|')}, no dim/color/colorName/timeSec (fine control is for back/top/front)`);
          }
          // index.html migrate 와 같이: #rrggbb 가 아닌 색은 colorName 으로
          if (out.color != null && !/^#[0-9a-fA-F]{6}$/.test(out.color)) {
            if (!out.colorName) out.colorName = out.color;
            warn(`light.channels[${i}].color "${out.color}" is not #rrggbb — kept as colorName`);
            out.color = null;
          }
          return out;
        });
      } else if (dept === 'light' && k === 'looks') body.looks = lookRowsIn(val.looks);
      else if (dept === 'stage' && k === 'props') body.props = propRows(val.props, 'stage.props', PROP_ACT, PROP_ACT_BLANK);
      else if (dept === 'cast') continue; // 아래에서 한 번에
      else body[k] = spec[k](val[k], ctxFor(`${dept}.${k}`));
    }
    if (dept === 'cast') patchCast(body, val);
  }
  // 출연 큐 (v10): people = [{ personId, move }] 를 통째로, 또는 옛 한 사람 입력 personId · move (사람이 0·1명인 큐만 — 그 줄을 고친다)
  function patchCast(body, val) {
    const old = has(val, 'personId') || has(val, 'move');
    if (has(val, 'people') && old) throw fail('bad_field', 'send either "cast.people" (the whole list) or the single-person "cast.personId"/"cast.move", not both');
    if (!Array.isArray(body.people)) body.people = castRows(body).map(x => ({ personId: x.personId, move: MOVES.includes(x.move) ? x.move : 'in' }));
    delete body.personId; delete body.move; delete body.name;
    if (has(val, 'people')) {
      if (!Array.isArray(val.people)) throw fail('bad_field', 'field "cast.people" must be an array of { personId, move: in|out|move } — one row per person, in order');
      const seen = new Map();
      body.people = val.people.map((x, i) => {
        if (!isObj(x)) throw fail('bad_field', `cast.people[${i}] must be an object { personId, move }`);
        const out = { personId: null, move: 'in' };
        for (const k of Object.keys(x)) {
          if (!has(CAST_ROW, k)) throw fail('bad_field', `unknown field "cast.people[${i}].${k}". Allowed: ${Object.keys(CAST_ROW).join(', ')}`);
          out[k] = CAST_ROW[k](x[k], ctxFor(`cast.people[${i}].${k}`));
        }
        if (out.personId == null) throw fail('bad_field', `field "cast.people[${i}].personId" is required — a person id from people[]`);
        if (seen.has(out.personId)) throw fail('bad_field', `cast.people[${i}]: person ${out.personId} is already in cast.people[${seen.get(out.personId)}] — one row per person`);
        seen.set(out.personId, i);
        return out;
      });
      return;
    }
    if (!old) return;
    if (body.people.length > 1) throw fail('bad_field', `this cast cue has ${body.people.length} people — "cast.personId"/"cast.move" only edit a one-person cue. Send "cast.people" with the whole list instead, e.g. ${j({ people: body.people })}`);
    const row = body.people[0] || { personId: null, move: 'in' };
    if (has(val, 'personId')) row.personId = F.person(val.personId, ctxFor('cast.personId'));
    if (has(val, 'move')) row.move = F.oneOf(MOVES)(val.move, ctxFor('cast.move'));
    body.people = [row];
  }
  // 이름 붙인 조명 줄 (v11): light.looks = [{ lookId, action: on|off }] 통째로. 같은 조명 두 줄은 거부 (브라우저 편집 모달처럼 한 조명은 한 줄)
  function lookRowsIn(val) {
    if (!Array.isArray(val)) throw fail('bad_field', 'field "light.looks" must be an array of { lookId, action: on|off } — one row per named look, in order');
    const seen = new Map();
    return val.map((x, i) => {
      if (!isObj(x)) throw fail('bad_field', `light.looks[${i}] must be an object { lookId, action }`);
      const out = { lookId: null, action: 'on' };
      for (const k of Object.keys(x)) {
        if (!has(LOOK_ROW, k)) throw fail('bad_field', `unknown field "light.looks[${i}].${k}". Allowed: ${Object.keys(LOOK_ROW).join(', ')} (fades and levels go in the look's note or in light.channels)`);
        out[k] = LOOK_ROW[k](x[k], ctxFor(`light.looks[${i}].${k}`));
      }
      if (out.lookId == null) throw fail('bad_field', `field "light.looks[${i}].lookId" is required — a look id from lights[] (add the look first with {"op":"add","kind":"look"})`);
      if (seen.has(out.lookId)) throw fail('bad_field', `light.looks[${i}]: look ${out.lookId} is already in light.looks[${seen.get(out.lookId)}] — one row per look`);
      seen.set(out.lookId, i);
      return out;
    });
  }
  // 소품 행 배열(stage.props, preShowProps) — light.channels 처럼 통째로 바꾸고 빠진 필드는 기본값, propId 는 꼭
  function propRows(val, field, spec, blankFn) {
    if (!Array.isArray(val)) throw fail('bad_field', `field "${field}" must be an array of { ${Object.keys(spec).join(', ')} }`);
    return val.map((x, i) => {
      if (!isObj(x)) throw fail('bad_field', `${field}[${i}] must be an object`);
      const out = blankFn();
      for (const k of Object.keys(x)) {
        if (!has(spec, k)) throw fail('bad_field', `unknown field "${field}[${i}].${k}". Allowed: ${Object.keys(spec).join(', ')}`);
        out[k] = spec[k](x[k], ctxFor(`${field}[${i}].${k}`));
      }
      if (out.propId == null) throw fail('bad_field', `field "${field}[${i}].propId" is required — a prop id from props[] (add the prop first with {"op":"add","kind":"prop"})`);
      return out;
    });
  }
  // 저장 전 정리 — 브라우저 편집기·saveCue 가 하는 것과 같게
  // strict = 이 op 가 큐를 새로 만들었거나 부서·무대 내용·상태를 바꿨다 → 소품 없는 확정 무대 큐는 거부 (브라우저 saveCue 와 같다).
  // 다른 필드만 고친 옛 큐(소품 없는 v7 무대 큐)는 경고만
  function tidy(kind, obj, strict) {
    if (kind === 'item') {
      // 큐(v12): 본문·화자 없음, 동작(cues)은 하나 이상, 트리거 하나 (브라우저 큐 추가와 같다 — 동작과 함께 생기고 동작이 0개면 사라진다)
      if (obj.kind === 'cue') {
        if (String(obj.text || '').trim()) throw fail('bad_field', `a cue item (kind:"cue") has no text — put details in its actions' "note"`);
        obj.text = ''; obj.speaker = null;
        if (!Array.isArray(obj.cues) || !obj.cues.length) throw fail('bad_field', `a cue item (kind:"cue") needs at least one action — add it with data.cues ([{dept, …}])`);
        if (!isObj(obj.trigger)) obj.trigger = { type: 'signal', text: '' };
        if (!has(obj, 'offsetSec')) obj.offsetSec = null;
        if (obj.offsetSec != null && obj.offsetSec < 0) throw fail('bad_field', 'field "offsetSec" must be ≥ 0 (seconds after the trigger)');
        // 키 순서를 사이트(index.html migrate)와 같게: id, kind, speaker, text, label, isCue, trigger, offsetSec, cues, comments
        const o = {}; ['id', 'kind', 'speaker', 'text', 'label', 'isCue', 'trigger', 'offsetSec', 'cues', 'comments'].forEach(k => { if (has(obj, k)) o[k] = obj[k]; });
        Object.keys(obj).forEach(k => { if (!has(o, k)) o[k] = obj[k]; });
        Object.keys(obj).forEach(k => delete obj[k]); Object.assign(obj, o);
      } else {
        if (has(obj, 'trigger') || has(obj, 'offsetSec')) { if (obj.trigger != null || obj.offsetSec != null) warn(`trigger/offsetSec only belong to cue items (kind:"cue") — cleared on ${obj.id}`); delete obj.trigger; delete obj.offsetSec; }
        if (Array.isArray(obj.cues) && obj.cues.length) throw fail('bad_field', `a ${obj.kind} item holds no cues in show v12 — add a cue item after it: {"op":"add","kind":"item","after":"${obj.id}","data":{"kind":"cue","trigger":{"type":"line","itemId":"${obj.id}"},"cues":[…]}}`);
      }
      if (obj.kind === 'action') {
        if (obj.speaker != null) { warn(`action paragraphs have no speaker — speaker cleared on ${obj.id}`); obj.speaker = null; }
        if (obj.text && !isActHead(obj.text)) { obj.text = '(' + obj.text + ')'; warn(`action text must be a "(…)" stage direction — wrapped in parentheses on ${obj.id}`); }
      }
    } else if (kind === 'cue') {
      const d = obj.dept, b = obj[d] || {};
      if (d === 'sound') {
        if (b.level != null) b.level = Math.round(Math.max(0, Math.min(100, b.level)));
        if (b.action === 'volume' && b.level == null) b.level = 100;
        // level = play 시작 볼륨(선택) · fadeIn 도착 볼륨(선택) · volume 목표 볼륨(기본 100). stop·fadeOut 에는 뜻이 없어 지운다
        if (b.level != null && (b.action === 'stop' || b.action === 'fadeOut')) { warn(`sound.level is only kept for play/fadeIn/volume — cleared on ${obj.id}`); b.level = null; }
      }
      if (obj.status !== 'tbd') {
        if (d === 'stage' && !(Array.isArray(b.props) && b.props.some(x => isObj(x) && x.propId))) {
          const msg = `stage cue ${obj.id} needs at least one stage.props row — props are required for stage cues in show v8 (register the prop with {"op":"add","kind":"prop"} first, put the free text in "note"), or set status:"tbd"`;
          if (strict) throw fail('bad_field', msg);
          warn(msg);
        } else {
          const empty = d === 'light' ? !lookRows(b).some(x => x.lookId) && !(b.channels || []).length && !String(b.anim || '').trim() : d === 'sound' ? b.track == null : d === 'cast' ? !castRows(b).some(x => x.personId) : false;
          if (empty) warn(`${d} cue ${obj.id} has no content yet — fill it in or set status:"tbd"`);
        }
      }
    }
  }
  // 큐가 바뀐 문단의 isCue (브라우저 saveCue·deleteCue·moveCueTo 와 같이)
  const syncCue = it => { if (isObj(it)) it.isCue = Array.isArray(it.cues) && it.cues.length > 0; };
  function newId(kind, wanted) {
    if (wanted != null) {
      if (typeof wanted !== 'string' || !NEW_ID_RE.test(wanted)) throw fail('bad_field', `data.id must match ${NEW_ID_RE} (or leave it out to get a generated id)`);
      if (allIds().has(wanted)) throw fail('bad_field', `id "${wanted}" is already used`);
      return wanted;
    }
    let v; do { v = uid(PREFIX[kind]); } while (allIds().has(v));
    return v;
  }
  // data 로 새 항목을 만든다 (자식 배열도 재귀로)
  function build(kind, data) {
    if (!isObj(data)) throw fail('bad_op', `"data" must be an object with the new ${kind}'s fields`);
    const obj = Object.assign({ id: newId(kind, data.id) }, blank(kind, show));
    idx.set(obj.id, [{ kind, obj, where: `new ${kind}` }]); // 같은 호출 안의 자식 id 와 겹치지 않게
    if (kind === 'item' && !has(data, 'kind') && typeof data.text === 'string' && isActHead(data.text)) obj.kind = 'action';
    if (kind === 'cue' && data.dept == null) throw fail('bad_field', `a new cue needs "dept" — one of ${DEPTS.join('|')}`);
    // 옛 방식(v11): 대사·지문에 cues — 자리를 잡은 뒤 그 문단 바로 뒤의 큐 문단으로 옮긴다(expandLegacy). 큐 문단의 동작에 trigger 글 — 큐의 트리거로
    let legacyCues = null;
    if (kind === 'item' && data.kind !== 'cue' && Array.isArray(data.cues) && data.cues.length) { legacyCues = data.cues; data = Object.assign({}, data, { cues: [] }); }
    if (kind === 'item' && data.kind === 'cue' && Array.isArray(data.cues) && data.cues.some(c => isObj(c) && (has(c, 'trigger') || has(c, 'offsetSec')))) {
      const c0 = data.cues.find(c => isObj(c) && (has(c, 'trigger') || has(c, 'offsetSec')));
      data = Object.assign({}, data, { cues: data.cues.map(stripTrig) });
      if (!has(data, 'trigger') && typeof c0.trigger === 'string') data.trigger = c0.trigger;
      if (!has(data, 'offsetSec') && has(c0, 'offsetSec')) data.offsetSec = c0.offsetSec;
      warn(`legacy trigger/offsetSec on the actions of new cue item — moved to the cue item (one trigger per cue)`);
    }
    patch(kind, obj, data, true);
    if (legacyCues) Object.defineProperty(obj, '__legacy', { value: legacyCues, enumerable: false, configurable: true });
    if (kind === 'person' && !obj.name.trim()) throw fail('bad_field', 'a new person needs a "name"');
    if (kind === 'prop' && !obj.name.trim()) throw fail('bad_field', 'a new prop needs a "name"');
    if (kind === 'look' && !obj.name.trim()) throw fail('bad_field', 'a new look needs a "name" — what the lighting crew calls it (e.g. "무대 A")');
    if (kind === 'comment' && !obj.text.trim()) throw fail('bad_field', 'a new comment needs "text"');
    if (kind === 'comment' && !obj.author.trim()) obj.author = '익명';
    for (const ck of CHILDREN[kind] || []) {
      if (data[ck] == null) continue;
      if (!Array.isArray(data[ck])) throw fail('bad_op', `data.${ck} must be an array`);
      const childKind = { scenes: 'scene', items: 'item', cues: 'cue', comments: 'comment' }[ck];
      obj[ck] = data[ck].map(d => build(childKind, d));
    }
    tidy(kind, obj, true);
    if (kind === 'item') syncCue(obj);
    return obj;
  }
  // 옛 방식으로 cues 를 받은 대사·지문(__legacy) → 그 문단 + 바로 뒤 큐 문단들 (upgradeTriggers 와 같은 묶음 · 트리거 규칙)
  function expandLegacy() {
    let last = null;
    for (const p of L(show, 'parts')) for (const sc of L(p, 'scenes')) {
      if (!Array.isArray(sc.items)) continue;
      sc.items = sc.items.flatMap(it => {
        if (!isObj(it)) return [it];
        if (!it.__legacy) { if (it.kind === 'cue') last = it.id; return [it]; }
        const raw = it.__legacy.filter(isObj), groups = [];
        delete it.__legacy;
        raw.forEach(c => { const t = String(c.trigger == null ? '' : c.trigger).trim(), off = c.offsetSec == null || c.offsetSec === '' ? null : F.num(c.offsetSec, ctxFor('offsetSec')), g = groups.find(x => x.t === t && x.off === off); if (g) g.cues.push(c); else groups.push({ t, off, cues: [c] }); });
        const out = [it];
        groups.forEach(g => {
          const ci = { id: newId('item'), kind: 'cue', speaker: null, text: '', label: null, isCue: true, trigger: legacyTrig(g.t, it, last), offsetSec: g.off, cues: [], comments: [] };
          idx.set(ci.id, [{ kind: 'item', obj: ci, where: 'new cue item' }]);
          ci.cues = g.cues.map(c => build('cue', legacyNote(stripTrig(c), g.t)));
          out.push(ci); last = ci.id;
          changes.push({ op: 'add', kind: 'item', id: ci.id, parent: sc.id, text: `added cue item ${ci.id} after ${it.id} (legacy: cues on a paragraph) — trigger ${j(ci.trigger)}` });
        });
        warn(`legacy: cues on paragraph ${it.id} moved to ${groups.length} cue item(s) right after it (show v12: cues are their own items)`);
        return out;
      });
    }
  }
  function insert(arr, obj, after, kind, where) {
    if (after === undefined || after === null) arr.push(obj);
    else if (after === 'first') arr.unshift(obj);
    else {
      const k = arr.findIndex(x => isObj(x) && x.id === after);
      if (k < 0) throw fail('not_found', `after "${after}" is not a ${kind} in ${where} — use a sibling id, "first", or null for the end`);
      arr.splice(k + 1, 0, obj);
    }
  }
  // add/move 의 목적지 배열
  function target(kind, parent, after, selfId) {
    if (!PARENTS[kind]) {
      if (parent != null) throw fail('bad_op', `a ${kind} has no parent — leave "parent" out`);
      return { arr: show[CHILD_KEY[kind]] || (show[CHILD_KEY[kind]] = []), owner: null, where: 'the show' };
    }
    let owner;
    if (parent != null) owner = resolve(parent, PARENTS[kind], 'parent');
    else if (after != null && after !== 'first' && after !== selfId) {
      const sib = resolve(after, [kind], 'after');
      owner = { kind: sib.parentKind, obj: sib.parent, where: sib.where };
    } else throw fail('bad_op', `"parent" is required: the id of the ${PARENTS[kind].join(' or ')} that holds this ${kind}`);
    const key = CHILD_KEY[kind];
    if (!Array.isArray(owner.obj[key])) owner.obj[key] = [];
    return { arr: owner.obj[key], owner, where: `${owner.kind} ${owner.obj.id}` };
  }
  function refsToPerson(pid) {
    const out = [];
    for (const [, es] of idx) for (const e of es) {
      if (e.kind === 'item' && e.obj.speaker === pid) out.push(`speaker of item ${e.obj.id} (${e.where})`);
      if (e.kind === 'scene' && Array.isArray(e.obj.cast) && e.obj.cast.includes(pid)) out.push(`cast of scene ${e.obj.id} (${e.where})`);
      if (e.kind === 'cue' && e.obj.dept === 'cast' && castRows(e.obj.cast).some(x => x.personId === pid)) out.push(`cast cue ${e.obj.id} (${e.where})`);
    }
    return out;
  }
  function refsToProp(pid) {
    const out = [];
    show.preShowProps.forEach((x, i) => { if (isObj(x) && x.propId === pid) out.push(`preShowProps[${i}]${x.at ? ` (at ${cut(x.at, 20)})` : ''}`); });
    for (const [, es] of idx) for (const e of es) {
      if (e.kind === 'cue' && e.obj.dept === 'stage' && isObj(e.obj.stage) && Array.isArray(e.obj.stage.props) && e.obj.stage.props.some(x => isObj(x) && x.propId === pid)) out.push(`stage cue ${e.obj.id} (${e.where})`);
    }
    return out;
  }
  function refsToLook(lid) {
    const out = [];
    for (const [, es] of idx) for (const e of es) {
      if (e.kind === 'cue' && e.obj.dept === 'light' && lookRows(e.obj.light).some(x => x.lookId === lid)) out.push(`light cue ${e.obj.id} (${e.where})`);
    }
    return out;
  }
  function soundCues(no) {
    const out = [];
    for (const [, es] of idx) for (const e of es) if (e.kind === 'cue' && e.obj.dept === 'sound' && e.obj.sound && e.obj.sound.track === no) out.push(e);
    return out;
  }
  const sortTracks = () => show.tracks.sort((x, y) => ((x && x.no) || 0) - ((y && y.no) || 0));
  const count = o => {
    let items = 0, cues = 0;
    const walk = (x, k) => { if (!isObj(x)) return; if (k === 'item') { items++; cues += (x.cues || []).length; } (x.scenes || []).forEach(s => walk(s, 'scene')); (x.items || []).forEach(i => walk(i, 'item')); };
    walk(o, ''); return { items, cues };
  };
  const label = (kind, o) => kind === 'item' ? cut(o.text || '(empty)', 30) : kind === 'cue' ? o.dept : kind === 'scene' ? (o.title || o.type) : kind === 'part' || kind === 'person' || kind === 'prop' || kind === 'look' ? o.name : kind === 'track' ? `BGM ${o.no}` : cut(o.text, 30);

  const OP_KEYS = { set: ['op', 'id', 'kind', 'fields'], add: ['op', 'kind', 'parent', 'after', 'data'], remove: ['op', 'id', 'kind', 'force', 'mode'], move: ['op', 'id', 'kind', 'parent', 'after'] };
  // 큐(문단)의 묶음 끝 — 대사·큐 바로 뒤에 붙은, 그것을 트리거로 하는 큐들의 끝 (index.html cueBlockEnd)
  function blockEnd(arr, anchorId) {
    const i = arr.findIndex(x => isObj(x) && x.id === anchorId); if (i < 0) return arr.length;
    const block = new Set([anchorId]); let k = i + 1;
    while (k < arr.length) { const x = arr[k], t = isObj(x) && isObj(x.trigger) ? x.trigger : {}; if (!isObj(x) || x.kind !== 'cue' || !((t.type === 'line' && block.has(t.itemId)) || (t.type === 'cue' && block.has(t.cueId)))) break; block.add(x.id); k++; }
    return k;
  }
  const descOf = id => { const all = []; for (const [, es] of idx) for (const e of es) if (e.kind === 'item' && e.obj.kind === 'cue') all.push(e); const out = [], seen = new Set([id]); for (let q = [id]; q.length;) { const x = q.shift(); all.forEach(e => { const t = e.obj.trigger; if (isObj(t) && t.type === 'cue' && t.cueId === x && !seen.has(e.obj.id)) { seen.add(e.obj.id); out.push(e); q.push(e.obj.id); } }); } return out; };
  const lineRefs = id => { const out = []; for (const [, es] of idx) for (const e of es) if (e.kind === 'item' && e.obj.kind === 'cue' && isObj(e.obj.trigger) && e.obj.trigger.type === 'line' && e.obj.trigger.itemId === id) out.push(e); return out; };
  const dropEntry = e => { const k = e.arr.indexOf(e.obj); if (k >= 0) e.arr.splice(k, 1); };
  for (opi = 0; opi < ops.length; opi++) {
    const o = ops[opi];
    opName = isObj(o) && typeof o.op === 'string' ? `${o.op}${o.id ? ' ' + o.id : o.kind ? ' ' + o.kind : ''}` : '?';
    if (!isObj(o) || typeof o.op !== 'string' || !has(OP_KEYS, o.op)) throw fail('bad_op', `each op needs "op": one of set|add|remove|move`);
    checkKeys(o, OP_KEYS[o.op], `a ${o.op} op`);
    if (o.kind != null && !KINDS.includes(o.kind) && !(o.op === 'set' && o.kind === 'show')) throw fail('bad_op', `"kind" must be one of ${KINDS.join('|')}${o.op === 'set' ? '|show' : ''}`);
    const kinds = o.kind ? [o.kind] : null;

    if (o.op === 'set') {
      if (o.kind === 'show') {
        if (o.id != null && o.id !== show.id) throw fail('bad_op', 'kind "show" takes no id');
        patch('show', show, o.fields, false);
        if (typeof show.revision === 'string' && show.revision.trim().length > 40) throw fail('bad_field', 'field "revision" is at most 40 characters');
        changes.push({ op: 'set', kind: 'show', id: show.id || null, text: `show: ${Object.keys(o.fields).join(', ')}` });
        continue;
      }
      const e = resolve(o.id, kinds);
      const oldNo = e.kind === 'track' ? e.obj.no : null;
      if (e.kind === 'item' && isObj(o.fields) && has(o.fields, 'kind') && (o.fields.kind === 'cue') !== (e.obj.kind === 'cue')) throw fail('bad_field', o.fields.kind === 'cue' ? `a line/action item cannot become a cue item in show v12 — add a cue item after it: {"op":"add","kind":"item","after":"${e.obj.id}","data":{"kind":"cue","trigger":{"type":"line","itemId":"${e.obj.id}"},"cues":[…]}}` : 'a cue item cannot become a line/action — remove it and add the paragraph');
      if (e.kind === 'item' && isObj(o.fields) && (has(o.fields, 'trigger') || has(o.fields, 'offsetSec')) && e.obj.kind !== 'cue') throw fail('bad_field', `trigger/offsetSec belong to cue items (kind:"cue") — ${e.obj.id} is a ${e.obj.kind}`);
      // 옛 방식: 부서 큐(동작)의 trigger · offsetSec → 그 동작이 든 큐(문단)의 트리거로 (같은 큐의 다른 동작에도 적용된다)
      let fields = o.fields;
      if (e.kind === 'cue' && isObj(fields) && (has(fields, 'trigger') || has(fields, 'offsetSec')) && isObj(e.parent) && e.parent.kind === 'cue') {
        fields = Object.assign({}, fields);
        if (has(fields, 'trigger')) { if (typeof fields.trigger !== 'string') throw fail('bad_field', 'an action\'s "trigger" is only accepted as legacy text — set the structured trigger on the cue item'); legacy.push({ obj: e.parent, text: fields.trigger }); delete fields.trigger; }
        if (has(fields, 'offsetSec')) { e.parent.offsetSec = F.num(fields.offsetSec, ctxFor('offsetSec')); delete fields.offsetSec; }
        warn(`legacy trigger/offsetSec on action ${e.obj.id} applied to its cue item ${e.parent.id} (shared by all its actions)`);
      }
      patch(e.kind, e.obj, fields, false);
      if (e.kind === 'track' && e.obj.no !== oldNo) {
        if (show.tracks.some(t => t !== e.obj && isObj(t) && t.no === e.obj.no)) throw fail('bad_field', `track number ${e.obj.no} is already used by another track`);
        const cs = oldNo == null ? [] : soundCues(oldNo);
        cs.forEach(c => { c.obj.sound.track = e.obj.no; });
        sortTracks();
        changes.push({ op: 'set', kind: 'track', id: e.obj.id, text: `BGM ${oldNo} → ${e.obj.no}${cs.length ? `, ${cs.length} sound cue(s) updated` : ''}` });
      }
      tidy(e.kind, e.obj, e.kind === 'cue' && isObj(o.fields) && ['dept', 'stage', 'status'].some(k => has(o.fields, k)));
      resolveLegacy();
      changes.push({ op: 'set', kind: e.kind, id: e.obj.id, text: `${e.kind} ${e.obj.id}: ${Object.keys(o.fields).join(', ')} (${e.where})` });
    } else if (o.op === 'add') {
      if (!o.kind) throw fail('bad_op', `"kind" is required — one of ${KINDS.join('|')}`);
      if (o.kind === 'track' && o.after != null) throw fail('bad_op', 'tracks are always ordered by "no" — leave "after" out');
      let t = target(o.kind, o.parent, o.after);
      // 옛 방식(v11): 부서 큐를 대사·지문에 — 그 대사 바로 뒤의 큐(같은 트리거면 거기, 아니면 새 큐)에 넣는다
      let data = o.data, lt = null;
      if (o.kind === 'cue' && t.owner && t.owner.obj.kind !== 'cue') {
        if (!isObj(data)) throw fail('bad_op', '"data" must be an object with the new cue\'s fields');
        const holder = t.owner.obj, sc = t.owner.kind === 'item' ? (idx.get(holder.id) || [])[0] : null;
        if (!sc) throw fail('bad_op', 'cannot find the paragraph that holds this cue');
        data = Object.assign({}, data); const text = has(data, 'trigger') ? data.trigger : ''; const off = has(data, 'offsetSec') ? F.num(data.offsetSec, ctxFor('offsetSec')) : null; delete data.trigger; delete data.offsetSec;
        if (text != null && typeof text !== 'string') throw fail('bad_field', 'legacy "trigger" on a cue added to a paragraph must be text');
        data = legacyNote(data, text);
        const prev = prevOf(holder).cue, trig = legacyTrig(text, holder, String(text || '').trim() === '이전 큐 후' ? (prev ? prev.id : null) : null);
        const arr = sc.arr, end = blockEnd(arr, holder.id);
        let ci = null;
        for (let k = arr.indexOf(holder) + 1; k < end; k++) if (JSON.stringify(arr[k].trigger) === JSON.stringify(trig) && (arr[k].offsetSec == null ? null : arr[k].offsetSec) === off) { ci = arr[k]; break; }
        if (!ci) { ci = { id: newId('item'), kind: 'cue', speaker: null, text: '', label: null, isCue: true, trigger: trig, offsetSec: off, cues: [], comments: [] }; arr.splice(end, 0, ci); idx.set(ci.id, [{ kind: 'item', obj: ci, arr, parent: sc.parent, parentKind: 'scene', where: `new cue item` }]); changes.push({ op: 'add', kind: 'item', id: ci.id, parent: sc.parent.id, text: `added cue item ${ci.id} after ${holder.id} (legacy: cue added to a paragraph) — trigger ${j(trig)}` }); }
        warn(`legacy: cue added to paragraph ${holder.id} — put in cue item ${ci.id} (show v12: cues are their own items after the line)`);
        t = { arr: ci.cues, owner: { kind: 'item', obj: ci }, where: `item ${ci.id}` }; lt = ci;
      }
      const obj = build(o.kind, data);
      if (o.kind === 'track') {
        if (show.tracks.some(x => isObj(x) && x.no === obj.no)) throw fail('bad_field', `track number ${obj.no} is already used`);
        show.tracks.push(obj); sortTracks();
      } else insert(t.arr, obj, lt ? null : o.after, o.kind, t.where);
      if (o.kind === 'cue') syncCue(t.owner.obj);
      // 옛 방식: 큐(문단)에 넣는 부서 큐의 trigger 글은 그 큐의 트리거로
      if (o.kind === 'cue' && !lt && isObj(o.data) && (has(o.data, 'trigger') || has(o.data, 'offsetSec')) && t.owner.obj.kind === 'cue') throw fail('bad_field', `"trigger"/"offsetSec" moved to the cue item in show v12 — set them on ${t.owner.obj.id} with {"op":"set","id":"${t.owner.obj.id}","fields":{"trigger":…}}`);
      expandLegacy();
      resolveLegacy();
      const n = count(obj);
      changes.push({ op: 'add', kind: o.kind, id: obj.id, parent: t.owner ? t.owner.obj.id : null, text: `added ${o.kind} ${obj.id} in ${t.where}: ${label(o.kind, obj)}${(o.kind === 'part' || o.kind === 'scene') && n.items ? ` (${n.items} items, ${n.cues} cues)` : o.kind === 'item' && n.cues ? ` (${n.cues} cues)` : ''}` });
    } else if (o.op === 'remove') {
      const e = resolve(o.id, kinds);
      if (o.force != null && typeof o.force !== 'boolean') throw fail('bad_op', '"force" must be true or false');
      // v12: 대사를 지울 때 그 대사가 트리거인 큐 — mode "keep-cues"(기본: 남기고 트리거를 그 대사를 인용한 신호로) | "with-cues"(함께, 그 연속 큐까지)
      //      큐를 지울 때 따라가는 큐 — mode "only"(기본: 바로 따라가던 큐를 신호 "<머리글> 후" 로) | "with-followers"(함께, 연속 큐의 연속 큐까지)
      const isLine = e.kind === 'item' && e.obj.kind !== 'cue', isCueItem = e.kind === 'item' && e.obj.kind === 'cue';
      const MODES = isLine ? ['keep-cues', 'with-cues'] : isCueItem ? ['only', 'with-followers'] : [];
      if (o.mode != null && !MODES.includes(o.mode)) throw fail('bad_op', MODES.length ? `"mode" for removing a ${isLine ? 'line/action' : 'cue item'} must be ${MODES.join('|')}` : '"mode" only goes with removing a line/action item (keep-cues|with-cues) or a cue item (only|with-followers)');
      if (isLine && o.mode === 'with-cues') { const gone = new Set(); lineRefs(e.obj.id).forEach(x => { gone.add(x); descOf(x.obj.id).forEach(y => gone.add(y)); }); gone.forEach(x => { dropEntry(x); changes.push({ op: 'remove', kind: 'item', id: x.obj.id, text: `removed cue item ${x.obj.id} with its trigger line ${e.obj.id} (${x.where})` }); }); }
      if (isCueItem && o.mode === 'with-followers') descOf(e.obj.id).forEach(x => { dropEntry(x); changes.push({ op: 'remove', kind: 'item', id: x.obj.id, text: `removed cue item ${x.obj.id} following ${e.obj.id} (${x.where})` }); });
      if (e.kind === 'person') {
        const refs = refsToPerson(e.obj.id);
        if (refs.length && !o.force) {
          throw fail('referenced', `person ${e.obj.id} (${e.obj.name}) is still used in ${refs.length} place(s): ${refs.slice(0, 10).join('; ')}${refs.length > 10 ? '; …' : ''}. Change those first, or send force:true to remove anyway (scene cast entries and rows in multi-person cast cues are dropped; speakers and one-person cast cues then show "(삭제된 사람)")`, { references: refs });
        }
        if (refs.length) {
          for (const [, es] of idx) for (const x of es) if (x.kind === 'scene' && Array.isArray(x.obj.cast)) x.obj.cast = x.obj.cast.filter(p => p !== e.obj.id);
          // 여러 사람 출연 큐(v10)에서는 그 사람의 줄만 뺀다 — 사이트 사람 삭제(index.html dropPerson)와 같다. 한 사람 큐는 그대로("(삭제된 사람)")
          for (const [, es] of idx) for (const x of es) {
            const b = x.kind === 'cue' && x.obj.dept === 'cast' && isObj(x.obj.cast) && Array.isArray(x.obj.cast.people) ? x.obj.cast : null;
            if (!b || b.people.length < 2) continue;
            const left = b.people.filter(r => !(isObj(r) && r.personId === e.obj.id));
            if (left.length && left.length < b.people.length) { b.people = left; warn(`removed person ${e.obj.id} from multi-person cast cue ${x.obj.id}`); }
          }
          forcedPeople.add(e.obj.id);
        }
      }
      if (e.kind === 'prop') {
        const refs = refsToProp(e.obj.id);
        if (refs.length && !o.force) {
          throw fail('referenced', `prop ${e.obj.id} (${e.obj.name}) is still used in ${refs.length} place(s): ${refs.slice(0, 10).join('; ')}${refs.length > 10 ? '; …' : ''}. Change those first, or send force:true to remove anyway (preShowProps entries are dropped; stage cue rows then show "(삭제된 소품)")`, { references: refs });
        }
        // 브라우저 prop-del 과 같이: 공연 전 무대 목록에서는 빼고, 무대 큐의 소품 동작은 남긴다
        show.preShowProps = show.preShowProps.filter(x => !(isObj(x) && x.propId === e.obj.id));
      }
      if (e.kind === 'look') {
        const refs = refsToLook(e.obj.id);
        if (refs.length && !o.force) {
          throw fail('referenced', `look ${e.obj.id} (${e.obj.name}) is still used in ${refs.length} light cue(s): ${refs.slice(0, 10).join('; ')}${refs.length > 10 ? '; …' : ''}. Change those first, or send force:true to remove anyway (its rows are dropped from light cues that have other rows; a cue whose only row is this look then shows "(삭제된 조명)")`, { references: refs });
        }
        // 사이트 조명 삭제(index.html dropLook)와 같다: 다른 줄(조명·채널)이 남는 큐에서는 그 줄만 빼고, 그 조명뿐인 큐는 그대로 둔다
        for (const [, es] of idx) for (const x of es) {
          const b = x.kind === 'cue' && x.obj.dept === 'light' && isObj(x.obj.light) && Array.isArray(x.obj.light.looks) ? x.obj.light : null;
          if (!b) continue;
          const left = b.looks.filter(r => !(isObj(r) && r.lookId === e.obj.id));
          if (left.length === b.looks.length || (!left.length && !(Array.isArray(b.channels) && b.channels.length))) continue;
          b.looks = left; warn(`removed look ${e.obj.id} from light cue ${x.obj.id}`);
        }
      }
      if (e.kind === 'track') {
        const cs = e.obj.no == null ? [] : soundCues(e.obj.no);
        if (cs.length && !o.force) {
          throw fail('referenced', `BGM ${e.obj.no} is used by ${cs.length} sound cue(s): ${cs.slice(0, 10).map(c => `${c.obj.id} (${c.where})`).join('; ')}. Point them at another track first, or send force:true to remove anyway`, { references: cs.map(c => c.obj.id) });
        }
        if (e.obj.fileKey) warn(`BGM ${e.obj.no} had an uploaded audio file; the file stays on the server (delete it in the web app if needed)`);
      }
      const k = e.arr.indexOf(e.obj);
      e.arr.splice(k, 1);
      if (e.kind === 'cue') syncCue(e.parent);
      const n = count(e.obj);
      changes.push({ op: 'remove', kind: e.kind, id: e.obj.id, text: `removed ${e.kind} ${e.obj.id} (${e.where})${(e.kind === 'part' || e.kind === 'scene') && n.items ? ` with ${n.items} items, ${n.cues} cues` : e.kind === 'item' && n.cues ? ` with ${n.cues} cues` : ''}` });
    } else {
      const e = resolve(o.id, kinds);
      if (e.kind === 'track') throw fail('bad_op', 'tracks are always ordered by "no" — change "no" with a set op instead');
      if (e.kind === 'cue' && o.parent != null) { const pe = (idx.get(o.parent) || []).find(x => x.kind === 'item'); if (pe && pe.obj.kind !== 'cue') throw fail('bad_op', `actions live in cue items in show v12 — "${o.parent}" is a ${pe.obj.kind}; move it to a cue item (kind:"cue"), or add a cue item after the line first`); }
      if (o.after === e.obj.id) throw fail('bad_op', '"after" cannot be the item itself');
      // parent 를 안 주면: after 가 형제 id 면 그 형제의 부모로, 아니면(맨 앞/맨 뒤) 지금 부모 안에서
      const stay = o.parent === undefined && PARENTS[e.kind] && (o.after == null || o.after === 'first');
      const t = stay ? { arr: e.arr, owner: { kind: e.parentKind, obj: e.parent }, where: `${e.parentKind} ${e.parent.id}` } : target(e.kind, o.parent, o.after, e.obj.id);
      e.arr.splice(e.arr.indexOf(e.obj), 1);
      insert(t.arr, e.obj, o.after, e.kind, t.where); // 실패하면 throw — show 사본은 버려진다
      if (e.kind === 'cue') { syncCue(e.parent); syncCue(t.owner.obj); }
      changes.push({ op: 'move', kind: e.kind, id: e.obj.id, parent: t.owner ? t.owner.obj.id : null, text: `moved ${e.kind} ${e.obj.id} to ${t.where}${o.after === 'first' ? ' (first)' : o.after ? ` after ${o.after}` : ' (end)'}` });
    }
    idx = buildIndex(show);
  }
  opi = ops.length; opName = 'result';

  // 동작이 0개가 된 큐는 사라진다 (브라우저: 동작 삭제·이동으로 비면 큐도 지운다). 코멘트가 있으면 빈 지문으로 남긴다
  for (const p of L(show, 'parts')) for (const sc of L(p, 'scenes')) {
    if (!Array.isArray(sc.items)) continue;
    for (let i = sc.items.length - 1; i >= 0; i--) {
      const it = sc.items[i];
      if (!isObj(it) || it.kind !== 'cue' || (Array.isArray(it.cues) && it.cues.length)) continue;
      if (Array.isArray(it.comments) && it.comments.length) { it.kind = 'action'; it.isCue = false; delete it.trigger; delete it.offsetSec; changes.push({ op: 'set', kind: 'item', id: it.id, text: `cue item ${it.id} has no actions left — kept as an empty action paragraph (it has comments)` }); }
      else { sc.items.splice(i, 1); changes.push({ op: 'remove', kind: 'item', id: it.id, text: `removed empty cue item ${it.id} (its last action was removed or moved)` }); }
    }
  }
  // 지운 대사·큐를 트리거로 쓰던 큐는 남기고 신호로 (사이트의 "대사만 삭제" · "이 큐만" 과 같다 — converted, 점검 확인)
  {
    const beforeShow = upgradeShow(clone(before)), bIdx = buildIndex(beforeShow), aIdx = buildIndex(show);
    const nameOf = (arr, id) => { const x = L(beforeShow, arr).find(p => isObj(p) && p.id === id); return x ? x.name : ''; };
    const tTitle = no => { const x = L(beforeShow, 'tracks').find(t => isObj(t) && t.no === no); return x ? x.title || '' : ''; };
    const look = { person: id => nameOf('people', id) || '(삭제된 사람)', prop: id => nameOf('props', id) || '(삭제된 소품)', light: id => nameOf('lights', id) || '(삭제된 조명)', track: tTitle };
    const qctx = { item: () => null, q: () => null, person: look.person, look };
    const alive = (id, cue) => (aIdx.get(id) || []).some(x => x.kind === 'item' && (x.obj.kind === 'cue') === cue);
    const was = id => (bIdx.get(id) || []).find(x => x.kind === 'item');
    for (const [, es] of aIdx) for (const x of es) {
      if (x.kind !== 'item' || x.obj.kind !== 'cue' || !isObj(x.obj.trigger)) continue;
      const t = x.obj.trigger;
      if (t.type === 'line' && !alive(t.itemId, false)) {
        const w = was(t.itemId); if (!w || w.obj.kind === 'cue') continue;
        x.obj.trigger = { type: 'signal', text: lineQuote(w.obj, t.at, qctx) + (t.at === 'start' ? ' 시작에' : ' 후'), converted: 'line' };
        changes.push({ op: 'set', kind: 'item', id: x.obj.id, text: `cue item ${x.obj.id}: its trigger line ${t.itemId} was removed — trigger is now the signal "${x.obj.trigger.text}" (check it)` });
      } else if (t.type === 'cue' && !alive(t.cueId, true)) {
        const w = was(t.cueId); if (!w || w.obj.kind !== 'cue') continue;
        x.obj.trigger = { type: 'signal', text: cueItemHead(w.obj, look) + (t.mode === 'with' ? ' 때' : ' 후'), converted: 'cue' };
        changes.push({ op: 'set', kind: 'item', id: x.obj.id, text: `cue item ${x.obj.id}: the cue it followed (${t.cueId}) was removed — trigger is now the signal "${x.obj.trigger.text}" (check it)` });
      }
    }
  }

  // 큐 번호: 사이트와 같이 늘 1부터 연속 — 어긋나 있으면(큐 추가·삭제·이동, 문단 이동, 옛 소수 번호) 전부 다시 매긴다.
  // labels = 번호가 바뀐 문단 { id, label, was } (label null = 큐가 없어져 번호도 없어짐)
  const oldLabels = new Map(showItems(upgradeShow(clone(before))).filter(isObj).map(i => [i.id, i.label == null ? null : i.label]));
  relabel(show);
  const labels = [];
  showItems(show).filter(isObj).forEach(i => {
    const was = oldLabels.has(i.id) ? oldLabels.get(i.id) : null, now = i.label == null ? null : i.label;
    if (now === was) return;
    labels.push({ id: i.id, label: now, was });
    const text = was == null ? `cue number Q${now} assigned to item ${i.id}` : now == null ? `cue number Q${was} cleared from item ${i.id} (no cues left)` : `item ${i.id} renumbered Q${was} → Q${now}`;
    changes.push({ op: 'label', kind: 'item', id: i.id, label: now, was, text });
  });

  // 전체 검사: op 가 새로 만든 오류만 막는다
  // 기준도 현재 형식으로 올린 뒤 검사한다 — 옛 형식(v9 출연 큐 personId)의 오류 경로가 v10(people[0].personId)과 달라 "새 오류"로 보이지 않게
  const vb = validateShow(upgradeShow(clone(before))), va = validateShow(show);
  const shape = p => String(p).replace(/\[\d+\]/g, '[]');
  const diff = (after, base) => {
    const pool = new Map();
    base.forEach(x => { const k = shape(x.path) + '|' + x.msg; pool.set(k, (pool.get(k) || 0) + 1); });
    return after.filter(x => { const k = shape(x.path) + '|' + x.msg; const n = pool.get(k) || 0; if (n) { pool.set(k, n - 1); return false; } return true; });
  };
  let newErrors = diff(va.errors, vb.errors);
  // v12 트리거: op 가 새로 만든 끊긴 연결·고리는 막는다 (사이트 편집 창이 고리를 못 만들게 하는 것과 같다)
  const TRIG_BAD = ['trigger-line-missing', 'trigger-cue-missing', 'trigger-loop'];
  newErrors = newErrors.concat(diff(va.warnings.filter(w => TRIG_BAD.includes(w.code)), vb.warnings.filter(w => TRIG_BAD.includes(w.code))));
  // force 로 지운 사람을 가리키는 대사·출연 큐는 브라우저처럼 "(삭제된 사람)" 으로 남긴다 → 경고로
  forcedPeople.forEach(pid => {
    const n = newErrors.length;
    newErrors = newErrors.filter(x => !x.msg.includes(`"${pid}" 가 people 에 없습니다`));
    if (n > newErrors.length) warnings.push({ path: 'people', msg: `${n - newErrors.length} speaker/cast-cue reference(s) to removed person ${pid} remain — the web app shows them as "(삭제된 사람)"` });
  });
  if (newErrors.length) {
    throw new OpError('invalid', `the result would be invalid, nothing was changed:\n${newErrors.slice(0, 20).map(x => `- ${x.path}: ${x.msg}${x.where ? ` [${x.where}]` : ''}`).join('\n')}`, { errors: newErrors });
  }
  diff(va.warnings, vb.warnings).filter(x => !TRIG_BAD.includes(x.code)).forEach(x => warnings.push(x));
  return { show, changes, labels, warnings, preexistingErrors: va.errors.length };
}

module.exports = { applyOps, OpError, KINDS, PREFIX, buildIndex, uid, isActHead, upgradeShow, upgradeTriggers, legacyTrig };
