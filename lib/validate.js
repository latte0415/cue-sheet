// 큐시트(show v5~v11) 검증 — 서버(basicInvalid), 업로드 스크립트(validateShow), MCP 부분 수정(lib/ops.js 가 op 적용 뒤 validateShow)이 같이 쓴다
//
// 기준은 index.html 의 migrate(). 프런트는 불러올 때마다 migrate 로 값을 정규화하는데, 이때 조용히 바뀌는 값을
// 둘로 나눈다.
//   error   — migrate 가 의미를 잃게 바꾸는 값 (모르는 dept → stage, "7초" → null, 없는 사람 id → "삭제된 사람" …)
//   warning — migrate 가 뜻을 유지한 채 채우거나 고치는 값 (숫자 문자열, 빠진 id, 버려지는 모르는 필드 …)
// 아래 상수는 index.html 의 DEPTS·CH·L_ACT·S_ACT·MOVES·PROP_ACTS·ROLES 와 같아야 한다 (test/validate.test.js 가 대조).
const DEPTS = ['cast', 'light', 'sound', 'stage'];
const CH = ['back', 'top', 'front', 'house'];
const L_ACT = ['on', 'off', 'fadeIn', 'fadeOut', 'anim'];
const S_ACT = ['play', 'fadeIn', 'fadeOut', 'stop', 'volume'];
const MOVES = ['in', 'out', 'move'];
const PROP_ACTS = ['in', 'out', 'move', 'clean']; // v8: 무대 소품 액션에 clean(치우기)
const HOUSE_ACTS = ['on', 'off']; // v8: 객석 채널은 켠다/끈다만
const LOOK_ACTS = ['on', 'off']; // v11: 이름 붙인 조명(lights[])은 켠다/끈다만 — index.html LOOK_ACTS
const ROLES = ['performer', 'mc', 'light', 'sound', 'stage', 'other'];
const SCENE_TYPES = ['mc', 'act'];
// 현재 형식 = index.html 의 SHOW_VER (test/server.test.js 가 대조). /api/health 의 schema, PUT 의 옛 화면 차단, MCP 수정(lib/ops.js)이 이 값을 쓴다
// v7: 문단 코멘트의 snapshot(코멘트 당시 문단). 필드를 더하면 올린다
// v8: 큐 상세 note 하나(cast.text · stage.text · memo 는 불러올 때 note 로 합쳐짐), 무대 큐 소품 필수(없으면 경고) + clean, 객석 on/off 만
// v9: 음향 PLAY 큐의 sound.level = 시작 볼륨 (모양은 v8 과 같다 — v8 화면이 저장할 때 지우므로 올려서 옛 화면 저장을 막는다)
// v10: 출연 큐 하나에 여러 사람 — cast { people: [{ personId, move }] } (사람마다 IN/OUT/MOVE). v9 까지의 { personId, move } 는 한 줄짜리 people 로 옮겨진다
// v11: 이름 붙인 조명 — show.lights [{ id, name, note }] (리허설에서 정해 이름을 붙인 조명) + 조명 큐 light.looks [{ lookId, action: on|off }].
//      채널 상세(light.channels)는 그대로 — 한 큐에 둘 다 있어도 된다. v10 → v11 은 lights: [] · looks: [] 만 붙는다
const SHOW_VER = 11;
const SHOW_VERS = [5, 6, 7, 8, 9, 10, SHOW_VER]; // 읽을 수 있는 형식 — 5 소품 없음, 6 코멘트 snapshot 없음, 7 큐 메모·설명이 따로(불러올 때 note 로 합침), 8 PLAY 볼륨 없음(모양 같음), 9 출연 큐가 한 사람, 10 이름 붙인 조명 없음, 11 이 현재
const KINDS = ['line', 'action', 'cue']; // cue = 큐 지점: 본문 없이 큐만 있는 대본 흐름 안의 실행 지점
const CH_L = { back: '백', top: '탑', front: '프론트', house: '객석' }; // index.html CH_L

// 큐를 그대로 다시 적은 지문(action-echo) — 큐 머리글이 이미 말하는 것뿐이라 지워도 되는 지문. 보수적으로:
// 지문(action)이고 큐가 있고, 괄호를 벗긴 본문의 낱말이 전부 그 문단 큐의 대상(사람·트랙·채널·소품 이름) · 액션(인/아웃/재생/암전 …)
// · 트리거 · 지연(7초) 낱말일 때만. " — " 보충이 있으면 정보가 더 있는 것으로 본다. look = { person(id), track(no), prop(id), light(id) } → 이름
const ECHO_SPLIT = /[\s()（）,·+/'"“”‘’.…:!?~]+/;
const ECHO_ACT = {
  cast: { in: ['인', '등장', 'in'], out: ['아웃', '퇴장', 'out'], move: ['이동', 'move'] },
  sound: { play: ['재생', '시작', 'play', '틀기'], stop: ['정지', '멈춤', 'stop'], fadeIn: ['페이드인', '페이드', '인', 'fade', 'in'], fadeOut: ['페이드아웃', '페이드', '아웃', 'fade', 'out'], volume: ['볼륨', '올림', '내림', 'vol'] },
  light: { on: ['on', '켬', '온'], off: ['off', '끔', '오프'], fadeIn: ['페이드인', '페이드', '인', 'fade', 'in'], fadeOut: ['페이드아웃', '페이드', '아웃', 'fade', 'out'], anim: ['애니', 'anim'] },
  stage: { in: ['인', '반입', '세팅', 'in'], out: ['아웃', '빼기', '반출', 'out'], move: ['이동', 'move'], clean: ['청소', '치우기', 'clean'] }
};
function actionEcho(it, look) {
  if (!isObj(it) || it.kind !== 'action' || !Array.isArray(it.cues) || !it.cues.length) return false;
  const text = typeof it.text === 'string' ? it.text.trim() : '';
  if (!text || text.includes('\n') || /[—–]|\s-\s/.test(text)) return false;
  const words = text.toLowerCase().split(ECHO_SPLIT).filter(Boolean);
  if (!words.length) return false;
  const voc = new Set(['후', '뒤']);
  const add = v => String(v == null ? '' : v).toLowerCase().split(ECHO_SPLIT).filter(Boolean).forEach(w => voc.add(w));
  const acts = (d, a) => ((ECHO_ACT[d] || {})[a] || []).forEach(w => voc.add(w));
  it.cues.forEach(c => {
    if (!isObj(c)) return;
    const b = isObj(c[c.dept]) ? c[c.dept] : {};
    add(c.trigger);
    if (typeof c.offsetSec === 'number') voc.add(c.offsetSec + '초');
    if (c.dept === 'cast') {
      castRows(b).forEach(x => {
        const n = x.personId ? look.person(x.personId) : '';
        add(n); if (n && n.length === 3) voc.add(n.slice(1)); // 조예준 → 예준
        acts('cast', x.move);
      });
    } else if (c.dept === 'sound') {
      ['bgm', '음악', '음원', '노래'].forEach(w => voc.add(w));
      if (b.track != null) { voc.add(String(b.track)); add(look.track(b.track)); }
      acts('sound', b.action);
    } else if (c.dept === 'light') {
      const chs = Array.isArray(b.channels) ? b.channels.filter(isObj) : [];
      voc.add('조명');
      if (chs.length && chs.every(x => x.action === 'off') && CH.every(ch => chs.some(x => x.ch === ch))) voc.add('암전');
      chs.forEach(x => { add(CH_L[x.ch]); if (x.ch === 'house') voc.add('관객석'); acts('light', x.action); });
      lookRows(b).forEach(x => { if (x.lookId) add(look.light ? look.light(x.lookId) : ''); acts('light', x.action); });
    } else if (c.dept === 'stage') {
      (Array.isArray(b.props) ? b.props : []).filter(isObj).forEach(x => { if (x.propId) add(look.prop(x.propId)); acts('stage', x.action); });
    }
  });
  return words.every(w => voc.has(w));
}
const STATUS = ['set', 'tbd'];
const LABEL_MAX = 12;
const ACT_RE = /^\s*(\(|（|\*|—|–|--)/; // index.html 의 ACT_RE — 동작 문단 앞 기호

const KEYS = {
  show: ['id', 'title', 'version', 'revision', 'updatedAt', 'preShowSetup', 'people', 'props', 'preShowProps', 'lights', 'tracks', 'parts'],
  person: ['id', 'name', 'role', 'note'],
  prop: ['id', 'name', 'note'],
  look: ['id', 'name', 'note'], // v11: 이름 붙인 조명
  preShowProp: ['propId', 'at'],
  propAct: ['propId', 'action', 'at'],
  track: ['id', 'no', 'title', 'durationSec', 'fileName', 'fileKey', 'note', 'loop'],
  part: ['id', 'name', 'scenes'],
  scene: ['id', 'type', 'title', 'cast', 'durationSec', 'setup', 'comments', 'items'],
  item: ['id', 'kind', 'speaker', 'text', 'label', 'isCue', 'cues', 'comments'],
  cue: ['id', 'dept', 'trigger', 'offsetSec', 'note', 'status'],
  light: ['looks', 'channels', 'anim'],
  lookRow: ['lookId', 'action'],
  channel: ['ch', 'action', 'dim', 'color', 'colorName', 'timeSec'],
  sound: ['track', 'action', 'timeSec', 'level'],
  stage: ['props'],
  cast: ['people'],
  castRow: ['personId', 'move'],
  castOld: ['personId', 'move'], // v9 까지 — 한 사람
  comment: ['id', 'author', 'text', 'createdAt', 'resolved', 'resolvedBy', 'resolvedAt', 'snapshot'] // snapshot: 앱이 문단 코멘트에 남기는 코멘트 당시 문단 (선택)
};

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// 출연 큐 내용 → 사람 줄 [{ personId, move }]. v10 은 people 배열, v9 까지는 { personId(또는 옛 name), move } 한 사람.
// index.html castRows 와 같다 — 어느 모양이든 읽는 쪽(머리글 · 점검 · 개요)은 이 함수로 본다
function castRows(b) {
  if (!isObj(b)) return [];
  if (Array.isArray(b.people)) return b.people.filter(isObj).map(x => ({ personId: x.personId == null || x.personId === '' ? null : x.personId, move: x.move }));
  const pid = b.personId != null && b.personId !== '' ? b.personId : b.name != null && b.name !== '' ? b.name : null;
  return pid == null && b.move == null ? [] : [{ personId: pid, move: b.move }];
}

// 조명 큐의 이름 붙인 조명 줄 (v11) [{ lookId, action }] — 객체인 줄만. index.html lookRows · lib/cuehead.js 와 같다
function lookRows(b) { return isObj(b) && Array.isArray(b.looks) ? b.looks.filter(isObj) : []; }

// 서버 저장 전 검사 — 프런트 validateImport 와 같은 수준의 구조만 본다 (프런트가 저장하는 값은 항상 통과).
// 실패하면 이유 문자열, 통과하면 null
function basicInvalid(show) {
  if (!isObj(show)) return 'show 는 객체여야 합니다';
  if (!Array.isArray(show.parts)) return 'show.parts 배열이 없습니다';
  if (typeof show.version !== 'number' || !isFinite(show.version)) return 'show.version 숫자가 없습니다';
  for (const k of ['people', 'props', 'preShowProps', 'lights', 'tracks']) if (show[k] != null && !Array.isArray(show[k])) return `show.${k} 가 배열이 아닙니다`;
  for (let i = 0; i < show.parts.length; i++) {
    const p = show.parts[i], pp = `parts[${i}]`;
    if (!isObj(p)) return `${pp} 가 객체가 아닙니다`;
    if (p.scenes == null) continue;
    if (!Array.isArray(p.scenes)) return `${pp}.scenes 가 배열이 아닙니다`;
    for (let j = 0; j < p.scenes.length; j++) {
      const s = p.scenes[j], sp = `${pp}.scenes[${j}]`;
      if (!isObj(s)) return `${sp} 가 객체가 아닙니다`;
      if (s.items == null) continue;
      if (!Array.isArray(s.items)) return `${sp}.items 가 배열이 아닙니다`;
      for (let k = 0; k < s.items.length; k++) {
        const it = s.items[k], ip = `${sp}.items[${k}]`;
        if (!isObj(it)) return `${ip} 가 객체가 아닙니다`;
        if (it.cues != null && !Array.isArray(it.cues)) return `${ip}.cues 가 배열이 아닙니다`;
      }
    }
  }
  return null;
}

// 파일 최상위가 show 자체, { show }, 서버 레코드 { rev, updatedAt, show } 중 무엇이든 show 를 꺼낸다
function unwrapShow(data) {
  if (isObj(data) && !Array.isArray(data.parts) && isObj(data.show)) return data.show;
  return data;
}

function cut(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

// 엄격 검사 — { errors: [{ path, msg, where }], warnings: [...] }
function validateShow(show) {
  const errors = [], warnings = [];
  let where = '';
  const err = (path, msg) => errors.push({ path, msg, where });
  const warn = (path, msg, code) => warnings.push(code ? { path, msg, where, code } : { path, msg, where });
  const j = JSON.stringify;

  if (!isObj(show)) { err('', '최상위 값은 큐시트 객체(또는 { show: 객체 })여야 합니다'); return { errors, warnings }; }

  function keys(o, path, allowed, extra) {
    for (const k of Object.keys(o)) {
      if (allowed.includes(k) || (extra && extra.includes(k))) continue;
      warn(path ? `${path}.${k}` : k, '모르는 필드 — 사이트에서 불러올 때 버려집니다');
    }
  }
  // 문자열 필드: 없거나 null 이면 '' (괜찮음), 숫자·불리언은 문자열로 바뀜(경고), 객체·배열은 깨짐(오류)
  function str(o, k, path) {
    const v = o[k], p = path ? `${path}.${k}` : k;
    if (v == null || typeof v === 'string') return;
    if (typeof v === 'number' || typeof v === 'boolean') warn(p, `문자열이어야 합니다 — ${j(v)} 는 "${v}" 로 바뀝니다`);
    else err(p, `문자열이어야 합니다 (지금: ${Array.isArray(v) ? '배열' : typeof v})`);
  }
  // 숫자 필드: null/없음 허용. 숫자 문자열은 변환(경고), 그 밖은 null 이 됨(오류)
  function numv(o, k, path, opt) {
    opt = opt || {};
    const v = o[k], p = path ? `${path}.${k}` : k;
    if (v == null || v === '') return null;
    let n = v;
    if (typeof v !== 'number') {
      n = typeof v === 'string' ? Number(v) : NaN;
      if (!Number.isFinite(n)) { err(p, `숫자 또는 null 이어야 합니다 — ${j(v)} 는 null 이 됩니다`); return null; }
      warn(p, `숫자여야 합니다 — 문자열 ${j(v)} 는 ${n} 으로 바뀝니다`);
    } else if (!Number.isFinite(v)) { err(p, '유한한 숫자여야 합니다'); return null; }
    if (opt.min != null && n < opt.min) (opt.clamp ? warn : err)(p, `${opt.min} 이상이어야 합니다 (지금 ${n})${opt.clamp ? ' — 잘립니다' : ''}`);
    if (opt.max != null && n > opt.max) (opt.clamp ? warn : err)(p, `${opt.max} 이하여야 합니다 (지금 ${n})${opt.clamp ? ' — 잘립니다' : ''}`);
    return n;
  }
  function bool(o, k, path) {
    const v = o[k];
    if (v == null || typeof v === 'boolean') return;
    warn(path ? `${path}.${k}` : k, `true/false 여야 합니다 — ${j(v)} 는 ${!!v} 로 바뀝니다`);
  }
  // 열거형: 없으면 기본값(need 면 경고), 틀리면 오류
  function oneOf(o, k, path, list, def, need) {
    const v = o[k], p = path ? `${path}.${k}` : k;
    if (v == null || v === '') { if (need) warn(p, `없음 — "${def}" 로 채워집니다 (${list.join('|')})`); return def; }
    if (!list.includes(v)) { err(p, `${j(v)} 는 허용되지 않습니다 — ${list.join('|')} 중 하나${def ? ` (그대로 두면 "${def}" 로 바뀝니다)` : ''}`); return null; }
    return v;
  }
  function arr(o, k, path, need) {
    const v = o[k], p = path ? `${path}.${k}` : k;
    if (v == null) { if (need) err(p, '배열이 필요합니다'); return []; }
    if (!Array.isArray(v)) { err(p, `배열이어야 합니다 (지금: ${typeof v})`); return []; }
    return v;
  }
  // id: 없으면 경고(업로드 스크립트가 채운다), 문자열 아니면 경고, 같은 종류 안에서 겹치면 오류
  const seen = {};
  function id(o, path, kind) {
    const v = o.id, p = `${path}.id`;
    if (v == null || v === '') { warn(p, 'id 없음 — 업로드할 때 자동으로 붙습니다'); return null; }
    if (typeof v !== 'string') { if (typeof v === 'number') warn(p, `문자열이어야 합니다 — ${v} 는 "${v}" 로 바뀝니다`); else { err(p, 'id 는 문자열이어야 합니다'); return null; } }
    const s = String(v);
    seen[kind] = seen[kind] || new Map();
    if (seen[kind].has(s)) err(p, `id "${s}" 가 ${seen[kind].get(s)} 와 겹칩니다`);
    else seen[kind].set(s, p);
    return s;
  }
  function comments(o, path) {
    arr(o, 'comments', path).forEach((c, i) => {
      const cp = `${path}.comments[${i}]`;
      if (!isObj(c)) { err(cp, '코멘트는 객체여야 합니다 (버려집니다)'); return; }
      keys(c, cp, KEYS.comment);
      id(c, cp, 'comment');
      str(c, 'author', cp); str(c, 'text', cp); str(c, 'resolvedBy', cp);
      if (c.createdAt == null || isNaN(Date.parse(c.createdAt))) warn(`${cp}.createdAt`, 'ISO 날짜가 아닙니다 — 불러올 때마다 현재 시각으로 채워집니다');
      bool(c, 'resolved', cp);
    });
  }

  // ---- 최상위
  keys(show, '', KEYS.show);
  if (typeof show.version !== 'number' || !isFinite(show.version)) err('version', `숫자가 필요합니다 (현재 형식은 ${SHOW_VER}, 5~${SHOW_VER - 1} 도 읽힙니다)`);
  else if (!SHOW_VERS.includes(show.version)) warn('version', `현재 형식은 ${SHOW_VER} 입니다 (5~${SHOW_VER - 1} 도 읽힘) — ${show.version} 이면 불러올 때 옛 형식 변환이 적용됩니다`);
  // v7 이하의 큐 메모(memo)·출연/무대 설명(text)은 불러올 때 note 로 합쳐진다 — 그 형식에서는 정상, v8 에서는 옛 필드라 경고
  const legacy = typeof show.version === 'number' && show.version < 8;
  // v9 이하의 출연 큐 { personId, move } 는 그 형식에서는 정상 — v10 에서는 옛 모양이라 경고(불러올 때 people 한 줄로 옮겨짐)
  const oneCast = typeof show.version === 'number' && show.version < 10;
  if (show.title == null || show.title === '') warn('title', '제목 없음 — "제목 없는 공연" 으로 표시됩니다');
  ['id', 'title', 'revision', 'preShowSetup'].forEach(k => str(show, k, ''));
  if (typeof show.revision === 'string' && show.revision.trim().length > 40) warn('revision', '40자를 넘는 부분은 잘립니다');

  // ---- 사람
  const people = new Set();
  const nameToId = new Map(); // 이름을 id 자리에 썼을 때 고칠 값을 알려 주려고
  const peopleArr = arr(show, 'people', '');
  peopleArr.forEach((p, i) => {
    const pp = `people[${i}]`;
    where = '';
    if (!isObj(p)) { err(pp, '사람은 객체여야 합니다 (버려집니다)'); return; }
    keys(p, pp, KEYS.person);
    const pid = id(p, pp, 'person');
    if (pid) people.add(pid);
    if (pid && typeof p.name === 'string' && !nameToId.has(p.name.trim())) nameToId.set(p.name.trim(), pid);
    if (p.name == null || p.name === '') warn(`${pp}.name`, '이름 없음 — "이름 없음" 으로 표시됩니다');
    str(p, 'name', pp); str(p, 'note', pp);
    oneOf(p, 'role', pp, ROLES, 'other', false);
  });
  const hasPeople = Array.isArray(show.people);
  function personRef(v, p, what) {
    if (v == null || v === '') return;
    if (typeof v !== 'string') { err(p, `${what} 는 people 의 id 문자열이어야 합니다`); return; }
    if (people.has(v)) return;
    const hint = nameToId.get(v.trim());
    err(p, !hasPeople ? `${what} "${v}" 를 쓰려면 people 배열에 그 사람을 id 와 함께 넣어야 합니다`
      : hint ? `${what} "${v}" 는 이름입니다 — people[].id 인 "${hint}" 를 쓰세요`
        : `${what} "${v}" 가 people 에 없습니다 — people[].id 를 써야 합니다 (이름이 아니라 id)`);
  }

  // ---- 소품 (v6) — 사람과 같은 방식의 레지스트리
  const propIds = new Set();
  arr(show, 'props', '').forEach((p, i) => {
    const pp = `props[${i}]`;
    where = '';
    if (!isObj(p)) { err(pp, '소품은 객체여야 합니다 (버려집니다)'); return; }
    keys(p, pp, KEYS.prop);
    const pid = id(p, pp, 'prop');
    if (pid) propIds.add(pid);
    if (p.name == null || p.name === '') warn(`${pp}.name`, '이름 없음 — "이름 없음" 으로 표시됩니다');
    str(p, 'name', pp); str(p, 'note', pp);
  });
  const hasProps = Array.isArray(show.props);
  // 모르는 propId 는 사이트가 지우지 않고 "(삭제된 소품)" 으로 보여 주므로 오류가 아니라 경고
  function propRef(v, p, what) {
    if (v == null || v === '') { warn(p, `${what} 의 propId 가 없습니다 — 불러올 때 버려집니다`); return; }
    if (typeof v !== 'string') { err(p, `${what} 는 props 의 id 문자열이어야 합니다`); return; }
    if (propIds.has(v)) return;
    warn(p, !hasProps ? `${what} "${v}" 를 쓰려면 props 배열에 그 소품을 id 와 함께 넣어야 합니다 — 지금은 "(삭제된 소품)" 으로 표시됩니다`
      : `${what} "${v}" 가 props 에 없습니다 — "(삭제된 소품)" 으로 표시됩니다`);
  }
  arr(show, 'preShowProps', '').forEach((x, i) => {
    const xp = `preShowProps[${i}]`;
    where = '';
    if (!isObj(x)) { err(xp, '공연 전 소품은 객체여야 합니다 (버려집니다)'); return; }
    keys(x, xp, KEYS.preShowProp);
    propRef(x.propId, `${xp}.propId`, '공연 전 소품');
    str(x, 'at', xp);
  });

  // ---- 이름 붙인 조명 (v11) — 소품과 같은 방식의 레지스트리. 조명 큐 light.looks 가 id 로 가리킨다
  const lookIds = new Set();
  arr(show, 'lights', '').forEach((p, i) => {
    const pp = `lights[${i}]`;
    where = '';
    if (!isObj(p)) { err(pp, '조명은 객체여야 합니다 (버려집니다)'); return; }
    keys(p, pp, KEYS.look);
    const lid = id(p, pp, 'look');
    if (lid) lookIds.add(lid);
    if (p.name == null || p.name === '') warn(`${pp}.name`, '이름 없음 — "이름 없음" 으로 표시됩니다');
    str(p, 'name', pp); str(p, 'note', pp);
  });
  const hasLights = Array.isArray(show.lights);
  // 모르는 lookId 는 소품처럼 지우지 않고 "(삭제된 조명)" 으로 보여 준다 — 경고
  function lookRef(v, p) {
    if (v == null || v === '') { warn(p, '조명 줄의 lookId 가 없습니다 — 불러올 때 버려집니다'); return; }
    if (typeof v !== 'string') { err(p, '조명 줄의 lookId 는 lights 의 id 문자열이어야 합니다'); return; }
    if (lookIds.has(v)) return;
    warn(p, !hasLights ? `조명 "${v}" 를 쓰려면 lights 배열에 그 조명을 id 와 함께 넣어야 합니다 — 지금은 "(삭제된 조명)" 으로 표시됩니다`
      : `조명 "${v}" 가 lights 에 없습니다 — "(삭제된 조명)" 으로 표시됩니다`);
  }

  // ---- 음원 트랙
  const trackNos = new Set();
  arr(show, 'tracks', '').forEach((t, i) => {
    const tp = `tracks[${i}]`;
    where = '';
    if (!isObj(t)) { err(tp, '트랙은 객체여야 합니다 (버려집니다)'); return; }
    keys(t, tp, KEYS.track);
    id(t, tp, 'track');
    const no = numv(t, 'no', tp);
    if (no == null) warn(`${tp}.no`, '트랙 번호(no)가 없습니다 — 음향 큐가 이 트랙을 가리킬 수 없습니다');
    else if (trackNos.has(no)) err(`${tp}.no`, `트랙 번호 ${no} 가 겹칩니다`);
    else trackNos.add(no);
    ['title', 'note', 'fileName', 'fileKey'].forEach(k => str(t, k, tp));
    numv(t, 'durationSec', tp, { min: 0 });
    bool(t, 'loop', tp);
  });
  const hasTracks = Array.isArray(show.tracks);
  // action-echo 판정용 이름 찾기
  const nameOf = arr => new Map((Array.isArray(arr) ? arr : []).filter(x => isObj(x) && x.id != null).map(x => [String(x.id), String(x.name || '')]));
  const pNames = nameOf(show.people), rNames = nameOf(show.props), lNames = nameOf(show.lights);
  const tTitles = new Map((Array.isArray(show.tracks) ? show.tracks : []).filter(isObj).map(t => [t.no, String(t.title || '')]));
  const look = { person: id => pNames.get(String(id)) || '', prop: id => rNames.get(String(id)) || '', light: id => lNames.get(String(id)) || '', track: no => tTitles.get(no) || '' };

  // ---- 파트 › 씬 › 문단 › 큐
  const labels = new Map();
  if (Array.isArray(show.parts) && !show.parts.length) warn('parts', '파트가 하나도 없습니다');
  arr(show, 'parts', '', true).forEach((part, pi) => {
    const pp = `parts[${pi}]`;
    where = '';
    if (!isObj(part)) { err(pp, '파트는 객체여야 합니다'); return; }
    keys(part, pp, KEYS.part);
    id(part, pp, 'part');
    str(part, 'name', pp);
    const pname = typeof part.name === 'string' && part.name ? part.name : `파트 ${pi + 1}`;

    arr(part, 'scenes', pp).forEach((sc, si) => {
      const sp = `${pp}.scenes[${si}]`;
      where = `${pname} › 씬 ${si + 1}`;
      if (!isObj(sc)) { err(sp, '씬은 객체여야 합니다'); return; }
      const stype = oneOf(sc, 'type', sp, SCENE_TYPES, 'act', true);
      const sceneWhere = `${pname} › ${sc.title ? cut(sc.title, 20) : `씬 ${si + 1}(${stype || '?'})`}`;
      where = sceneWhere;
      keys(sc, sp, KEYS.scene, ['performers']);
      if (sc.performers != null) warn(`${sp}.performers`, sc.cast == null ? '옛 필드 — cast 로 옮겨집니다' : '옛 필드 — cast 가 있어 버려집니다');
      id(sc, sp, 'scene');
      str(sc, 'title', sp); str(sc, 'setup', sp);
      numv(sc, 'durationSec', sp, { min: 0 });
      const cast = sc.cast != null ? arr(sc, 'cast', sp) : arr(sc, 'performers', sp);
      cast.forEach((c, ci) => personRef(c, `${sp}.${sc.cast != null ? 'cast' : 'performers'}[${ci}]`, '출연자'));
      comments(sc, sp);

      arr(sc, 'items', sp).forEach((it, ii) => {
        const ip = `${sp}.items[${ii}]`;
        where = `${sceneWhere} › #${ii + 1}${isObj(it) && it.text ? ` "${cut(it.text, 24)}"` : ''}`;
        if (!isObj(it)) { err(ip, '문단은 객체여야 합니다'); return; }
        keys(it, ip, KEYS.item);
        id(it, ip, 'item');
        const kind = oneOf(it, 'kind', ip, KINDS, 'line', true);
        str(it, 'text', ip);
        personRef(it.speaker, `${ip}.speaker`, '화자');
        if (kind === 'action' && it.speaker != null && it.speaker !== '') warn(`${ip}.speaker`, '동작(action) 문단에는 화자가 표시되지 않습니다');
        // 대본 편집기는 문단 앞 기호로 동작/대사를 가른다 — 어긋나면 사용자가 그 문단을 고칠 때 종류가 바뀐다
        const t = typeof it.text === 'string' ? it.text : '';
        // 표기 규칙(docs/cue-format.md "표기 규칙"): 지문은 text 전체가 괄호 한 쌍 (…). 편집기는 * 와 — 도 받으므로 오류가 아니라 경고
        // code 'action-format' 은 이 규칙 경고를 가려내는 표지 (프런트 샘플이 아직 옛 표기라 테스트가 거른다)
        // 여러 줄 지문(Shift+Enter 줄바꿈)은 첫 줄이 "(" 로 시작하는지만 본다 — 줄 단위 괄호 규칙은 아직 정하지 않았다
        if (kind === 'action' && t.includes('\n')) {
          if (!t.trim().startsWith('(')) warn(`${ip}.text`, '지문은 괄호 지문 `(…)` 으로 쓰세요 — "(" 로 시작해야 합니다 ("*", "—" 시작 금지)', 'action-format');
        } else if (kind === 'action' && t.trim()) {
          const tt = t.trim();
          if (!tt.startsWith('(') || !tt.endsWith(')')) warn(`${ip}.text`, '지문은 괄호 지문 `(…)` 으로 쓰세요 — "(" 로 시작해 ")" 로 끝나야 합니다 ("*", "—" 시작 금지)', 'action-format');
          else if (/[()]/.test(tt.slice(1, -1))) warn(`${ip}.text`, '지문 안에 괄호가 또 있습니다 — 괄호는 한 쌍만 쓰고 보충 설명은 " — " 로 이으세요. 괄호 지문 `(…)` 으로 쓰세요', 'action-format');
        }
        // 큐를 그대로 다시 적은 지문 — 큐 머리글(조예준 IN, BLACKOUT …)이 이미 말하므로 지운다. 지워도 뜻이 안 바뀌어 경고
        if (actionEcho(it, look)) warn(`${ip}.text`, '큐를 다시 적은 지문 — 큐가 이미 말하는 대상·동작·트리거뿐입니다. 큐만 있는 문단으로 바꾸세요 (kind:"cue", text 는 비움)', 'action-echo');
        // 큐 지점(kind:'cue'): 본문·화자 없음(사이트가 버린다), 큐는 하나 이상(없으면 지점이 아니다 — 사이트는 빈 지문으로 바꾼다)
        if (kind === 'cue') {
          if (t.trim()) warn(`${ip}.text`, '큐만 있는 문단(kind:"cue")에는 본문이 없습니다 — 불러올 때 버려집니다. 덧붙일 말은 큐의 note 에', 'cue-text');
          if (it.speaker != null && it.speaker !== '') warn(`${ip}.speaker`, '큐만 있는 문단(kind:"cue")에는 화자가 없습니다 — 버려집니다');
          if (!Array.isArray(it.cues) || !it.cues.length) err(`${ip}.cues`, '큐만 있는 문단(kind:"cue")에 큐가 없습니다 — 큐를 하나 이상 넣거나 그 문단을 지우세요');
        }
        // 빈 문단에 붙은 큐(사이트 점검 "빈 문단에 붙은 큐", 확인): 본문이 빈 대사·지문에 큐 — 큐 지점으로 바꾸라고
        if (kind !== 'cue' && !t.trim() && Array.isArray(it.cues) && it.cues.length) warn(`${ip}.text`, '본문이 빈 문단에 큐가 붙어 있습니다 — 큐만 있는 문단으로 바꾸세요 (kind:"cue", text 는 비움)', 'empty-cued');
        if (kind === 'line' && !it.speaker && ACT_RE.test(t)) warn(`${ip}.text`, '화자 없는 대사가 "(" 등으로 시작합니다 — 편집기에서 고치면 동작 문단으로 바뀝니다. 동작이면 kind "action"');
        if (it.label != null && it.label !== '') {
          if (typeof it.label !== 'string' && typeof it.label !== 'number') err(`${ip}.label`, '큐 번호(label)는 문자열이어야 합니다');
          else {
            const l = String(it.label).trim();
            if (typeof it.label === 'number') warn(`${ip}.label`, `문자열이어야 합니다 — ${it.label} 는 "${l}" 로 바뀝니다`);
            if (l.length > LABEL_MAX) warn(`${ip}.label`, `${LABEL_MAX}자를 넘는 부분은 잘립니다`);
            if (labels.has(l)) warn(`${ip}.label`, `큐 번호 "${l}" 가 ${labels.get(l)} 와 겹칩니다`);
            else labels.set(l, ip);
          }
        }
        bool(it, 'isCue', ip);
        comments(it, ip);

        arr(it, 'cues', ip).forEach((c, ci) => {
          const cp = `${ip}.cues[${ci}]`;
          if (!isObj(c)) { err(cp, '큐는 객체여야 합니다'); return; }
          id(c, cp, 'cue');
          let dept = null;
          if (c.dept == null || c.dept === '') err(`${cp}.dept`, `dept 가 필요합니다 — ${DEPTS.join('|')}`);
          else dept = oneOf(c, 'dept', cp, DEPTS, 'stage', true);
          keys(c, cp, KEYS.cue, DEPTS.concat(['memo']));
          for (const d of DEPTS) if (d !== dept && c[d] != null && dept) warn(`${cp}.${d}`, `dept 가 "${dept}" 라 이 내용은 버려집니다`);
          str(c, 'trigger', cp); str(c, 'note', cp); str(c, 'memo', cp);
          if (!legacy && c.memo != null && c.memo !== '') warn(`${cp}.memo`, '옛 필드(v7 이하) — 불러올 때 note 에 " / " 로 이어 붙습니다. note 를 쓰세요', 'legacy-field');
          numv(c, 'offsetSec', cp);
          oneOf(c, 'status', cp, STATUS, 'set', false);
          if (!dept) return;
          const body = c[dept], bp = `${cp}.${dept}`;
          if (body == null) { warn(bp, `${dept} 내용이 없습니다 — 빈 큐로 들어갑니다`); return; }
          if (!isObj(body)) { err(bp, `${dept} 는 객체여야 합니다`); return; }
          if (dept === 'light') {
            keys(body, bp, KEYS.light);
            str(body, 'anim', bp);
            // v11: 이름 붙인 조명 줄 — 줄마다 켠다/끈다. 같은 조명이 두 줄이면 경고(머리글이 헷갈린다)
            const lk = arr(body, 'looks', bp), lseen = new Map();
            lk.forEach((x, xi) => {
              const xp = `${bp}.looks[${xi}]`;
              if (!isObj(x)) { err(xp, '조명 줄은 { lookId, action } 객체여야 합니다 (버려집니다)'); return; }
              keys(x, xp, KEYS.lookRow);
              lookRef(x.lookId, `${xp}.lookId`);
              oneOf(x, 'action', xp, LOOK_ACTS, 'on', true);
              if (typeof x.lookId === 'string' && x.lookId) {
                if (lseen.has(x.lookId)) warn(`${xp}.lookId`, `같은 조명이 이 큐에 두 번 있습니다 (${lseen.get(x.lookId)} 와 겹침) — 한 줄로 합치세요`, 'light-dup');
                else lseen.set(x.lookId, xp);
              }
            });
            const chArr = Array.isArray(body.channels) ? body.channels : [];
            // 빈 조명 큐 (사이트 점검 "비어 있는 확정 조명 큐"): 확정인데 켜고 끌 조명·채널·애니메이션이 없다
            if (c.status !== 'tbd' && !lk.some(x => isObj(x) && x.lookId) && !chArr.length && !(typeof body.anim === 'string' && body.anim.trim())) {
              warn(bp, '조명 큐가 비어 있습니다 — 켜고 끌 조명(looks)·채널(channels)·애니메이션(anim) 중 하나를 넣거나 status:"tbd"', 'light-empty');
            }
            arr(body, 'channels', bp).forEach((h, hi) => {
              const hp = `${bp}.channels[${hi}]`;
              if (!isObj(h)) { err(hp, '채널은 객체여야 합니다'); return; }
              keys(h, hp, KEYS.channel);
              const chv = oneOf(h, 'ch', hp, CH, 'front', true);
              const act = oneOf(h, 'action', hp, L_ACT, 'on', true);
              numv(h, 'dim', hp, { min: 0, max: 100 });
              numv(h, 'timeSec', hp, { min: 0 });
              str(h, 'colorName', hp);
              // v8: 객석은 켠다/끈다만 — 그 밖의 액션·밝기·색·시간은 불러올 때 on/off 로 접히고 흔적이 note 에 남는다
              if (chv === 'house' && ((act && !HOUSE_ACTS.includes(act)) || h.dim != null || (h.color != null && h.color !== '') || (h.colorName != null && h.colorName !== '') || h.timeSec != null)) {
                warn(hp, '객석(house)은 on/off 만 됩니다 — 페이드·애니는 on/off 로, 밝기·색·시간은 지워지고 note 에 "(객석: 원래 …)" 로 남습니다', 'house-onoff');
              }
              if (h.color != null && h.color !== '' && !/^#[0-9a-fA-F]{6}$/.test(String(h.color))) {
                warn(`${hp}.color`, `#rrggbb 형식이 아닙니다 — ${h.colorName ? '버려집니다' : `colorName "${h.color}" 로 옮겨집니다`}`);
              }
            });
          } else if (dept === 'sound') {
            keys(body, bp, KEYS.sound);
            const no = numv(body, 'track', bp);
            if (no == null) warn(`${bp}.track`, '트랙 번호가 없습니다');
            else if (hasTracks && !trackNos.has(no)) warn(`${bp}.track`, `tracks 에 no ${no} 인 트랙이 없습니다`);
            const sact = oneOf(body, 'action', bp, S_ACT, 'play', true);
            numv(body, 'timeSec', bp, { min: 0 });
            // level = play 시작 볼륨 · fadeIn 도착 볼륨(비우면 100) · volume 목표 볼륨. stop·fadeOut 에는 뜻이 없다 — 편집기·MCP 가 저장할 때 지운다
            const nw = warnings.length, lv = numv(body, 'level', bp, { min: 0, max: 100, clamp: true });
            if (lv != null && warnings.length === nw && (sact === 'stop' || sact === 'fadeOut')) warn(`${bp}.level`, `${sact} 에는 볼륨(level)이 쓰이지 않습니다 — 편집기에서 저장하면 지워집니다 (play 시작 볼륨 · fadeIn 도착 볼륨 · volume 목표 볼륨에만)`);
          } else if (dept === 'stage') {
            keys(body, bp, KEYS.stage, ['text']);
            str(body, 'text', bp);
            if (!legacy && body.text != null && body.text !== '') warn(`${bp}.text`, '옛 필드(v7 이하) — 불러올 때 note 로 옮겨집니다. note 를 쓰세요', 'legacy-field');
            const pa = arr(body, 'props', bp);
            pa.forEach((x, xi) => {
              const xp = `${bp}.props[${xi}]`;
              if (!isObj(x)) { err(xp, '소품 동작은 객체여야 합니다 (버려집니다)'); return; }
              keys(x, xp, KEYS.propAct);
              propRef(x.propId, `${xp}.propId`, '소품 동작');
              oneOf(x, 'action', xp, PROP_ACTS, 'in', true);
              str(x, 'at', xp);
            });
            // v8: 무대 큐는 소품이 필수 — 옛 데이터를 올릴 수 있게 오류가 아니라 경고(사이트는 빨간 "소품 미지정" 으로 보인다). 미정 큐는 비어도 된다
            if (c.status !== 'tbd' && !pa.some(x => isObj(x) && x.propId)) warn(bp, '무대 큐에 소품이 없습니다 — v8 부터 무대 큐는 소품이 필요합니다. props 에 소품을 등록하고 stage.props 에 넣으세요 (설명 글은 note 에)', 'stage-no-props');
          } else {
            str(body, 'text', bp);
            if (!legacy && body.text != null && body.text !== '') warn(`${bp}.text`, '옛 필드(v7 이하) — 불러올 때 note 로 옮겨집니다. note 를 쓰세요', 'legacy-field');
            if (body.people == null) {
              // v9 까지의 한 사람 모양 { personId, move } — 불러올 때 people 한 줄로 옮겨진다
              keys(body, bp, KEYS.castOld, ['name', 'text']);
              if (!oneCast) warn(bp, '옛 모양(v9 이하) — 불러올 때 { people: [{ personId, move }] } 한 줄로 옮겨집니다. people 을 쓰세요', 'legacy-field');
              if (body.personId == null && body.name != null) {
                personRef(body.name, `${bp}.name`, '출연 대상');
                warn(`${bp}.name`, '옛 필드 — personId 를 쓰세요');
              } else if (body.personId == null || body.personId === '') warn(`${bp}.personId`, '출연 대상이 없습니다');
              else personRef(body.personId, `${bp}.personId`, '출연 대상');
              oneOf(body, 'move', bp, MOVES, 'in', true);
              return;
            }
            // v10: { people: [{ personId, move }] } — 한 큐에 여러 사람, 사람마다 IN/OUT/MOVE (순서 그대로)
            keys(body, bp, KEYS.cast, ['text']);
            const rows = arr(body, 'people', bp), who = new Map();
            rows.forEach((x, xi) => {
              const xp = `${bp}.people[${xi}]`;
              if (!isObj(x)) { err(xp, '출연 줄은 { personId, move } 객체여야 합니다 (버려집니다)'); return; }
              keys(x, xp, KEYS.castRow);
              if (x.personId == null || x.personId === '') warn(`${xp}.personId`, '출연 대상이 없습니다');
              else {
                personRef(x.personId, `${xp}.personId`, '출연 대상');
                if (who.has(x.personId)) warn(`${xp}.personId`, `같은 사람이 이 큐에 두 번 있습니다 (${who.get(x.personId)} 와 겹침) — 한 줄로 합치세요`, 'cast-dup');
                else who.set(x.personId, xp);
              }
              oneOf(x, 'move', xp, MOVES, 'in', true);
            });
            if (!rows.some(x => isObj(x) && x.personId != null && x.personId !== '')) warn(`${bp}.people`, '출연 대상이 없습니다');
          }
        });
      });
    });
  });
  return { errors, warnings };
}

// id 가 빠진 항목에 위치 기반 id 를 붙인다 (기존 id 와 겹치지 않게). 붙인 개수를 돌려준다. show 를 직접 고친다
function fillIds(show) {
  if (!isObj(show)) return 0;
  const all = []; // [객체, 기본 id]
  const add = (o, base) => { if (isObj(o)) all.push([o, base]); };
  const list = (o, k) => (isObj(o) && Array.isArray(o[k]) ? o[k] : []);
  list(show, 'people').forEach((p, i) => add(p, `p-${i + 1}`));
  list(show, 'props').forEach((p, i) => add(p, `pr-${i + 1}`));
  list(show, 'lights').forEach((p, i) => add(p, `lk-${i + 1}`));
  list(show, 'tracks').forEach((t, i) => add(t, `tr-${isObj(t) && typeof t.no === 'number' ? t.no : 'x' + (i + 1)}`));
  list(show, 'parts').forEach((p, pi) => {
    add(p, `pt-${pi + 1}`);
    list(p, 'scenes').forEach((s, si) => {
      const sb = `${pi + 1}-${si + 1}`;
      add(s, `s-${sb}`);
      list(s, 'comments').forEach((c, k) => add(c, `c-${sb}-${k + 1}`));
      list(s, 'items').forEach((it, ii) => {
        const ib = `${sb}-${ii + 1}`;
        add(it, `i-${ib}`);
        list(it, 'cues').forEach((c, k) => add(c, `q-${ib}-${k + 1}`));
        list(it, 'comments').forEach((c, k) => add(c, `c-${ib}-${k + 1}`));
      });
    });
  });
  const has = o => o.id != null && o.id !== '';
  const used = new Set(all.filter(([o]) => has(o)).map(([o]) => String(o.id)));
  let n = 0;
  all.forEach(([o, base]) => {
    if (has(o)) return;
    let v = base, k = 1;
    while (used.has(v)) v = `${base}-${++k}`;
    o.id = v; used.add(v); n++;
  });
  return n;
}

module.exports = { basicInvalid, validateShow, unwrapShow, fillIds, actionEcho, castRows, lookRows, SHOW_VER, CONST: { DEPTS, CH, L_ACT, S_ACT, MOVES, PROP_ACTS, HOUSE_ACTS, LOOK_ACTS, ROLES, ACT_RE, SHOW_VERS } };
