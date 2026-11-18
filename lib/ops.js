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
// v5~v7 공연은 사이트가 불러올 때(index.html migrate)처럼 v8 로 올린다: props·preShowProps 빈 배열, 무대 큐 stage.props 빈 배열,
// 큐 memo · cast.text · stage.text → note, 객석 채널은 on/off 로 접는다(지운 값은 note 에 흔적).
const { validateShow, CONST, SHOW_VER } = require('./validate');
const { relabel, showItems } = require('./labels');

const { DEPTS, CH, L_ACT, S_ACT, MOVES, PROP_ACTS, HOUSE_ACTS, ROLES, ACT_RE } = CONST;
// index.html 의 isActHead 와 같다: 지문 여부는 첫 줄(Shift+Enter 줄바꿈 전)의 앞 기호로 본다
function isActHead(raw) { const t = String(raw || ''), i = t.indexOf('\n'); return ACT_RE.test(i < 0 ? t : t.slice(0, i)); }
const SCENE_TYPES = ['mc', 'act'];
const ITEM_KINDS = ['line', 'action'];
const STATUS = ['set', 'tbd'];

const KINDS = ['part', 'scene', 'item', 'cue', 'comment', 'person', 'prop', 'track'];
// index.html 의 uid() 접두어와 같다
const PREFIX = { part: 'pt', scene: 's', item: 'i', cue: 'q', comment: 'c', person: 'p', prop: 'pr', track: 'tr' };
// 담는 항목 종류 (없으면 show 바로 아래)
const PARENTS = { part: null, person: null, prop: null, track: null, scene: ['part'], item: ['scene'], cue: ['item'], comment: ['scene', 'item'] };
// 부모 안의 배열 이름
const CHILD_KEY = { part: 'parts', person: 'people', prop: 'props', track: 'tracks', scene: 'scenes', item: 'items', cue: 'cues', comment: 'comments' };
// add 의 data 에 함께 넣을 수 있는 자식 배열
const CHILDREN = { part: ['scenes'], scene: ['comments', 'items'], item: ['cues', 'comments'] };
const NEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OPS = 500;

class OpError extends Error {
  // code: bad_op | not_found | ambiguous | bad_field | referenced | invalid
  constructor(code, message, extra) { super(message); this.name = 'OpError'; this.code = code; Object.assign(this, extra); }
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
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
  track: { no: F.trackNo, title: F.str, durationSec: F.num, note: F.str, loop: F.bool },
  part: { name: F.str },
  scene: { type: F.oneOf(SCENE_TYPES), title: F.str, cast: F.people, durationSec: F.num, setup: F.str },
  item: { kind: F.oneOf(ITEM_KINDS), speaker: F.person, text: F.str },
  cue: { dept: F.oneOf(DEPTS), trigger: F.str, offsetSec: F.num, note: F.str, status: F.oneOf(STATUS), light: null, sound: null, stage: null, cast: null },
  comment: { author: F.str, text: F.str, resolved: F.bool, resolvedBy: F.strN }
};
const SUB = {
  light: { channels: null, anim: F.str },
  sound: { track: F.trackNoN, action: F.oneOf(S_ACT), timeSec: F.num, level: F.num },
  stage: { props: null },
  cast: { personId: F.person, move: F.oneOf(MOVES) }
};
// v8 에서 없어진 필드 → 거부할 때 알려 줄 곳
const GONE = { 'cue.memo': 'note', 'stage.text': 'note (the cue\'s common detail field)', 'cast.text': 'note (the cue\'s common detail field)' };
const CHANNEL = { ch: F.oneOf(CH), action: F.oneOf(L_ACT), dim: F.num, color: F.strN, colorName: F.strN, timeSec: F.num };

// 브라우저가 새로 만들 때 쓰는 값 (index.html: part-add, scene-add, newItem, saveCue, comment-add, person-save, prop-save, track-add, migrate)
function blank(kind, show) {
  switch (kind) {
    case 'part': return { name: '', scenes: [] };
    case 'scene': return { type: 'act', title: '', cast: [], durationSec: null, setup: '', comments: [], items: [] };
    case 'item': return { kind: 'line', speaker: null, text: '', label: null, isCue: false, cues: [], comments: [] };
    case 'cue': return { dept: null, trigger: '', offsetSec: null, note: '', status: 'set' };
    case 'comment': return { author: '익명', text: '', createdAt: new Date().toISOString(), resolved: false, resolvedBy: null, resolvedAt: null };
    case 'person': return { name: '', role: 'other', note: '' };
    case 'prop': return { name: '', note: '' };
    case 'track': {
      const max = (show.tracks || []).reduce((m, t) => Math.max(m, (t && typeof t.no === 'number' && t.no) || 0), 0);
      return { no: max + 1, title: '', durationSec: null, fileName: null, fileKey: null, note: '', loop: false };
    }
  }
}
const DEPT_BLANK = {
  light: () => ({ channels: [], anim: '' }),
  sound: () => ({ track: null, action: 'play', timeSec: null, level: null }),
  stage: () => ({ props: [] }),
  cast: () => ({ personId: null, move: 'in' })
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
// v5~v7 → v8 (lib/validate.js SHOW_VER — 서버 스키마·index.html 과 같은 값): index.html migrate 가 불러올 때 하는 모양 바꾸기를 미리 한다.
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
  if (from >= 8) return show;
  const cmts = o => { if (isObj(o) && Array.isArray(o.comments)) o.comments.forEach(cm => { if (isObj(cm) && isObj(cm.snapshot) && Array.isArray(cm.snapshot.cues)) cm.snapshot.cues = cm.snapshot.cues.map(upgradeCue); }); };
  (Array.isArray(show.parts) ? show.parts : []).forEach(p => (isObj(p) && Array.isArray(p.scenes) ? p.scenes : []).forEach(sc => {
    cmts(sc);
    (isObj(sc) && Array.isArray(sc.items) ? sc.items : []).forEach(it => { if (!isObj(it)) return; cmts(it); if (Array.isArray(it.cues)) it.cues = it.cues.map(upgradeCue); });
  }));
  return show;
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
  L(show, 'tracks').forEach(t => put('track', t, show.tracks, show, 'show', `BGM ${isObj(t) ? t.no : ''}`));
  L(show, 'parts').forEach((p, pi) => {
    const pn = isObj(p) && p.name ? p.name : `파트 ${pi + 1}`;
    put('part', p, show.parts, show, 'show', pn);
    L(p, 'scenes').forEach((s, si) => {
      const sn = `${pn} › ${isObj(s) && s.title ? cut(s.title, 20) : `씬 ${si + 1}`}`;
      put('scene', s, p.scenes, p, 'part', sn);
      L(s, 'comments').forEach(c => put('comment', c, s.comments, s, 'scene', `${sn} 코멘트`));
      L(s, 'items').forEach((it, ii) => {
        const iw = `${sn} › ${isObj(it) && it.label != null ? 'Q' + it.label : '#' + (ii + 1)}${isObj(it) && it.text ? ` "${cut(it.text, 20)}"` : ''}`;
        put('item', it, s.items, s, 'scene', iw);
        L(it, 'cues').forEach(c => put('cue', c, it.cues, it, 'item', `${iw} ${isObj(c) ? c.dept : ''} 큐`));
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
  if (!Array.isArray(show.tracks)) show.tracks = [];
  const changes = [], warnings = [];
  const forcedPeople = new Set();
  let idx = buildIndex(show);
  let opi = 0, opName = '';
  const fail = (code, msg, extra) => new OpError(code, `ops[${opi}] ${opName}: ${msg}`, Object.assign({ opIndex: opi }, extra));
  const warn = msg => warnings.push({ path: `ops[${opi}]`, msg });
  const peopleSet = () => new Set(show.people.filter(isObj).map(p => String(p.id)));
  const propSet = () => new Set(show.props.filter(isObj).map(p => String(p.id)));
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
    return { bad: m => fail('bad_field', `field "${field}" must be ${m}`), people: peopleSet(), peopleArr: show.people.filter(isObj), props: propSet(), propsArr: show.props.filter(isObj) };
  }
  function checkKeys(o, allowed, what) {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) throw fail('bad_op', `unknown key "${k}" in ${what} — allowed: ${allowed.join(', ')}`);
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
        const hint = CHILDREN[kind] && CHILDREN[kind].includes(k) ? ` — "${k}" is a child list; use add/remove/move ops on its entries` : kind === 'show' && (k === 'props' || k === 'people' || k === 'tracks') ? ` — use add/set/remove ops with kind:"${{ props: 'prop', people: 'person', tracks: 'track' }[k]}" on its entries` : k === 'label' ? ' — cue numbers are assigned automatically: always 1, 2, 3 … in script order, renumbered after every edit' : k === 'isCue' ? ' — isCue follows cues automatically' : (k === 'fileName' || k === 'fileKey') ? ' — audio files are managed in the web app' : '';
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
      } else if (dept === 'stage' && k === 'props') body.props = propRows(val.props, 'stage.props', PROP_ACT, PROP_ACT_BLANK);
      else body[k] = spec[k](val[k], ctxFor(`${dept}.${k}`));
    }
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
      if (obj.kind === 'action') {
        if (obj.speaker != null) { warn(`action paragraphs have no speaker — speaker cleared on ${obj.id}`); obj.speaker = null; }
        if (obj.text && !isActHead(obj.text)) { obj.text = '(' + obj.text + ')'; warn(`action text must be a "(…)" stage direction — wrapped in parentheses on ${obj.id}`); }
      }
    } else if (kind === 'cue') {
      const d = obj.dept, b = obj[d] || {};
      if (d === 'sound') {
        if (b.level != null) b.level = Math.round(Math.max(0, Math.min(100, b.level)));
        if (b.action === 'volume' && b.level == null) b.level = 100;
        if (b.level != null && b.action !== 'volume' && b.action !== 'fadeIn') { warn(`sound.level is only kept for volume/fadeIn — cleared on ${obj.id}`); b.level = null; }
      }
      if (obj.status !== 'tbd') {
        if (d === 'stage' && !(Array.isArray(b.props) && b.props.some(x => isObj(x) && x.propId))) {
          const msg = `stage cue ${obj.id} needs at least one stage.props row — props are required for stage cues in show v8 (register the prop with {"op":"add","kind":"prop"} first, put the free text in "note"), or set status:"tbd"`;
          if (strict) throw fail('bad_field', msg);
          warn(msg);
        } else {
          const empty = d === 'light' ? !b.channels.length && !String(b.anim || '').trim() : d === 'sound' ? b.track == null : d === 'cast' ? !b.personId : false;
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
    patch(kind, obj, data, true);
    if (kind === 'person' && !obj.name.trim()) throw fail('bad_field', 'a new person needs a "name"');
    if (kind === 'prop' && !obj.name.trim()) throw fail('bad_field', 'a new prop needs a "name"');
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
      if (e.kind === 'cue' && e.obj.dept === 'cast' && e.obj.cast && e.obj.cast.personId === pid) out.push(`cast cue ${e.obj.id} (${e.where})`);
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
  const label = (kind, o) => kind === 'item' ? cut(o.text || '(empty)', 30) : kind === 'cue' ? o.dept : kind === 'scene' ? (o.title || o.type) : kind === 'part' || kind === 'person' || kind === 'prop' ? o.name : kind === 'track' ? `BGM ${o.no}` : cut(o.text, 30);

  const OP_KEYS = { set: ['op', 'id', 'kind', 'fields'], add: ['op', 'kind', 'parent', 'after', 'data'], remove: ['op', 'id', 'kind', 'force'], move: ['op', 'id', 'kind', 'parent', 'after'] };
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
      patch(e.kind, e.obj, o.fields, false);
      if (e.kind === 'track' && e.obj.no !== oldNo) {
        if (show.tracks.some(t => t !== e.obj && isObj(t) && t.no === e.obj.no)) throw fail('bad_field', `track number ${e.obj.no} is already used by another track`);
        const cs = oldNo == null ? [] : soundCues(oldNo);
        cs.forEach(c => { c.obj.sound.track = e.obj.no; });
        sortTracks();
        changes.push({ op: 'set', kind: 'track', id: e.obj.id, text: `BGM ${oldNo} → ${e.obj.no}${cs.length ? `, ${cs.length} sound cue(s) updated` : ''}` });
      }
      tidy(e.kind, e.obj, e.kind === 'cue' && isObj(o.fields) && ['dept', 'stage', 'status'].some(k => has(o.fields, k)));
      changes.push({ op: 'set', kind: e.kind, id: e.obj.id, text: `${e.kind} ${e.obj.id}: ${Object.keys(o.fields).join(', ')} (${e.where})` });
    } else if (o.op === 'add') {
      if (!o.kind) throw fail('bad_op', `"kind" is required — one of ${KINDS.join('|')}`);
      if (o.kind === 'track' && o.after != null) throw fail('bad_op', 'tracks are always ordered by "no" — leave "after" out');
      const t = target(o.kind, o.parent, o.after);
      const obj = build(o.kind, o.data);
      if (o.kind === 'track') {
        if (show.tracks.some(x => isObj(x) && x.no === obj.no)) throw fail('bad_field', `track number ${obj.no} is already used`);
        show.tracks.push(obj); sortTracks();
      } else insert(t.arr, obj, o.after, o.kind, t.where);
      if (o.kind === 'cue') syncCue(t.owner.obj);
      const n = count(obj);
      changes.push({ op: 'add', kind: o.kind, id: obj.id, parent: t.owner ? t.owner.obj.id : null, text: `added ${o.kind} ${obj.id} in ${t.where}: ${label(o.kind, obj)}${(o.kind === 'part' || o.kind === 'scene') && n.items ? ` (${n.items} items, ${n.cues} cues)` : o.kind === 'item' && n.cues ? ` (${n.cues} cues)` : ''}` });
    } else if (o.op === 'remove') {
      const e = resolve(o.id, kinds);
      if (o.force != null && typeof o.force !== 'boolean') throw fail('bad_op', '"force" must be true or false');
      if (e.kind === 'person') {
        const refs = refsToPerson(e.obj.id);
        if (refs.length && !o.force) {
          throw fail('referenced', `person ${e.obj.id} (${e.obj.name}) is still used in ${refs.length} place(s): ${refs.slice(0, 10).join('; ')}${refs.length > 10 ? '; …' : ''}. Change those first, or send force:true to remove anyway (scene cast entries are dropped; speakers and cast cues then show "(삭제된 사람)")`, { references: refs });
        }
        if (refs.length) {
          for (const [, es] of idx) for (const x of es) if (x.kind === 'scene' && Array.isArray(x.obj.cast)) x.obj.cast = x.obj.cast.filter(p => p !== e.obj.id);
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

  // 큐 번호: 사이트와 같이 늘 1부터 연속 — 어긋나 있으면(큐 추가·삭제·이동, 문단 이동, 옛 소수 번호) 전부 다시 매긴다.
  // labels = 번호가 바뀐 문단 { id, label, was } (label null = 큐가 없어져 번호도 없어짐)
  const oldLabels = new Map(showItems(before).filter(isObj).map(i => [i.id, i.label == null ? null : i.label]));
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
  const vb = validateShow(before), va = validateShow(show);
  const shape = p => String(p).replace(/\[\d+\]/g, '[]');
  const diff = (after, base) => {
    const pool = new Map();
    base.forEach(x => { const k = shape(x.path) + '|' + x.msg; pool.set(k, (pool.get(k) || 0) + 1); });
    return after.filter(x => { const k = shape(x.path) + '|' + x.msg; const n = pool.get(k) || 0; if (n) { pool.set(k, n - 1); return false; } return true; });
  };
  let newErrors = diff(va.errors, vb.errors);
  // force 로 지운 사람을 가리키는 대사·출연 큐는 브라우저처럼 "(삭제된 사람)" 으로 남긴다 → 경고로
  forcedPeople.forEach(pid => {
    const n = newErrors.length;
    newErrors = newErrors.filter(x => !x.msg.includes(`"${pid}" 가 people 에 없습니다`));
    if (n > newErrors.length) warnings.push({ path: 'people', msg: `${n - newErrors.length} speaker/cast-cue reference(s) to removed person ${pid} remain — the web app shows them as "(삭제된 사람)"` });
  });
  if (newErrors.length) {
    throw new OpError('invalid', `the result would be invalid, nothing was changed:\n${newErrors.slice(0, 20).map(x => `- ${x.path}: ${x.msg}${x.where ? ` [${x.where}]` : ''}`).join('\n')}`, { errors: newErrors });
  }
  diff(va.warnings, vb.warnings).forEach(x => warnings.push(x));
  return { show, changes, labels, warnings, preexistingErrors: va.errors.length };
}

module.exports = { applyOps, OpError, KINDS, PREFIX, buildIndex, uid, isActHead };
