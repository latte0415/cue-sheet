// 큐시트(show v5) 검증 — 서버(basicInvalid)와 업로드 스크립트(validateShow)가 같이 쓴다
//
// 기준은 index.html 의 migrate(). 프런트는 불러올 때마다 migrate 로 값을 정규화하는데, 이때 조용히 바뀌는 값을
// 둘로 나눈다.
//   error   — migrate 가 의미를 잃게 바꾸는 값 (모르는 dept → stage, "7초" → null, 없는 사람 id → "삭제된 사람" …)
//   warning — migrate 가 뜻을 유지한 채 채우거나 고치는 값 (숫자 문자열, 빠진 id, 버려지는 모르는 필드 …)
// 아래 상수는 index.html 의 DEPTS·CH·L_ACT·S_ACT·MOVES·ROLES 와 같아야 한다 (test/validate.test.js 가 대조).
const DEPTS = ['cast', 'light', 'sound', 'stage'];
const CH = ['back', 'top', 'front', 'house'];
const L_ACT = ['on', 'off', 'fadeIn', 'fadeOut', 'anim'];
const S_ACT = ['play', 'fadeIn', 'fadeOut', 'stop', 'volume'];
const MOVES = ['in', 'out', 'move'];
const ROLES = ['performer', 'mc', 'light', 'sound', 'stage', 'other'];
const SCENE_TYPES = ['mc', 'act'];
const KINDS = ['line', 'action'];
const STATUS = ['set', 'tbd'];
const LABEL_MAX = 12;
const ACT_RE = /^\s*(\(|（|\*|—|–|--)/; // index.html 의 ACT_RE — 동작 문단 앞 기호

const KEYS = {
  show: ['id', 'title', 'version', 'revision', 'updatedAt', 'preShowSetup', 'people', 'tracks', 'parts'],
  person: ['id', 'name', 'role', 'note'],
  track: ['id', 'no', 'title', 'durationSec', 'fileName', 'fileKey', 'note', 'loop'],
  part: ['id', 'name', 'scenes'],
  scene: ['id', 'type', 'title', 'cast', 'durationSec', 'setup', 'comments', 'items'],
  item: ['id', 'kind', 'speaker', 'text', 'label', 'isCue', 'cues', 'comments'],
  cue: ['id', 'dept', 'trigger', 'offsetSec', 'memo', 'status'],
  light: ['channels', 'anim'],
  channel: ['ch', 'action', 'dim', 'color', 'colorName', 'timeSec'],
  sound: ['track', 'action', 'timeSec', 'level'],
  stage: ['text'],
  cast: ['personId', 'move', 'text'],
  comment: ['id', 'author', 'text', 'createdAt', 'resolved', 'resolvedBy', 'resolvedAt']
};

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// 서버 저장 전 검사 — 프런트 validateImport 와 같은 수준의 구조만 본다 (프런트가 저장하는 값은 항상 통과).
// 실패하면 이유 문자열, 통과하면 null
function basicInvalid(show) {
  if (!isObj(show)) return 'show 는 객체여야 합니다';
  if (!Array.isArray(show.parts)) return 'show.parts 배열이 없습니다';
  if (typeof show.version !== 'number' || !isFinite(show.version)) return 'show.version 숫자가 없습니다';
  for (const k of ['people', 'tracks']) if (show[k] != null && !Array.isArray(show[k])) return `show.${k} 가 배열이 아닙니다`;
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
  if (typeof show.version !== 'number' || !isFinite(show.version)) err('version', '숫자가 필요합니다 (현재 형식은 5)');
  else if (show.version !== 5) warn('version', `현재 형식은 5 입니다 — ${show.version} 이면 불러올 때 옛 형식 변환이 적용됩니다`);
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
          keys(c, cp, KEYS.cue, DEPTS);
          for (const d of DEPTS) if (d !== dept && c[d] != null && dept) warn(`${cp}.${d}`, `dept 가 "${dept}" 라 이 내용은 버려집니다`);
          str(c, 'trigger', cp); str(c, 'memo', cp);
          numv(c, 'offsetSec', cp);
          oneOf(c, 'status', cp, STATUS, 'set', false);
          if (!dept) return;
          const body = c[dept], bp = `${cp}.${dept}`;
          if (body == null) { warn(bp, `${dept} 내용이 없습니다 — 빈 큐로 들어갑니다`); return; }
          if (!isObj(body)) { err(bp, `${dept} 는 객체여야 합니다`); return; }
          if (dept === 'light') {
            keys(body, bp, KEYS.light);
            str(body, 'anim', bp);
            arr(body, 'channels', bp).forEach((h, hi) => {
              const hp = `${bp}.channels[${hi}]`;
              if (!isObj(h)) { err(hp, '채널은 객체여야 합니다'); return; }
              keys(h, hp, KEYS.channel);
              oneOf(h, 'ch', hp, CH, 'front', true);
              oneOf(h, 'action', hp, L_ACT, 'on', true);
              numv(h, 'dim', hp, { min: 0, max: 100 });
              numv(h, 'timeSec', hp, { min: 0 });
              str(h, 'colorName', hp);
              if (h.color != null && h.color !== '' && !/^#[0-9a-fA-F]{6}$/.test(String(h.color))) {
                warn(`${hp}.color`, `#rrggbb 형식이 아닙니다 — ${h.colorName ? '버려집니다' : `colorName "${h.color}" 로 옮겨집니다`}`);
              }
            });
          } else if (dept === 'sound') {
            keys(body, bp, KEYS.sound);
            const no = numv(body, 'track', bp);
            if (no == null) warn(`${bp}.track`, '트랙 번호가 없습니다');
            else if (hasTracks && !trackNos.has(no)) warn(`${bp}.track`, `tracks 에 no ${no} 인 트랙이 없습니다`);
            oneOf(body, 'action', bp, S_ACT, 'play', true);
            numv(body, 'timeSec', bp, { min: 0 });
            numv(body, 'level', bp, { min: 0, max: 100, clamp: true });
          } else if (dept === 'stage') {
            keys(body, bp, KEYS.stage);
            str(body, 'text', bp);
          } else {
            keys(body, bp, KEYS.cast, ['name']);
            if (body.personId == null && body.name != null) {
              personRef(body.name, `${bp}.name`, '출연 대상');
              warn(`${bp}.name`, '옛 필드 — personId 를 쓰세요');
            } else if (body.personId == null || body.personId === '') warn(`${bp}.personId`, '출연 대상이 없습니다');
            else personRef(body.personId, `${bp}.personId`, '출연 대상');
            oneOf(body, 'move', bp, MOVES, 'in', true);
            str(body, 'text', bp);
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

module.exports = { basicInvalid, validateShow, unwrapShow, fillIds, CONST: { DEPTS, CH, L_ACT, S_ACT, MOVES, ROLES, ACT_RE } };
