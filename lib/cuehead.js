// 큐 문구 한 벌 — index.html 의 "큐 요약" 구간(cueHead · cueDetail · cueText)을 그대로 옮긴 사본이다.
// MCP 개요(lib/view.js outline)가 사이트와 같은 머리글을 쓰려고 둔다. 동작이 브라우저와 같아야 한다
// (test/cuehead.test.js 가 index.html 의 함수와 실제 데이터 · 만든 큐로 결과를 대조한다 — 한쪽만 고치면 그 테스트가 실패한다).
// 서버 데이터는 모양이 덜 고를 수 있어 look 은 꼭 넘긴다: { person(id) → 이름, track(no) → 제목, prop(id) → 소품 이름 }
const DEPT_L = { cast: '출연', light: '조명', sound: '음향', stage: '무대' };
const CH = ['back', 'top', 'front', 'house'];
const CH_L = { back: '백', top: '탑', front: '프론트', house: '객석' };
const L_ACT_L = { on: 'ON', off: 'OFF', fadeIn: 'FADE IN', fadeOut: 'FADE OUT', anim: 'ANIM' };
const S_ACT_L = { play: 'PLAY', stop: 'STOP', fadeIn: 'FADE IN', fadeOut: 'FADE OUT', volume: 'VOL' };
const MOVES = { in: 'IN', out: 'OUT', move: 'MOVE' };
const PROP_ACTS = { in: 'IN', out: 'OUT', move: 'MOVE', clean: 'CLEAN' };
// 출연 큐 내용 → 사람 줄 [{ personId, move }]. v10 은 people 배열, v9 까지(서버 원본)는 { personId(또는 옛 name), move } 한 사람
function castRows(b) {
  if (!b || typeof b !== 'object') return [];
  if (Array.isArray(b.people)) return b.people.filter(x => x && typeof x === 'object').map(x => ({ personId: x.personId == null || x.personId === '' ? null : x.personId, move: x.move }));
  const pid = b.personId != null && b.personId !== '' ? b.personId : b.name != null && b.name !== '' ? b.name : null;
  return pid == null && b.move == null ? [] : [{ personId: pid, move: b.move }];
}
const houseOnOff = a => (a === 'off' || a === 'fadeOut' ? 'off' : 'on');
const FADE_DEFAULT = 3; // fadeOut 시간이 비어 있을 때 쓰는 기본 페이드(초)
const NO_LOOK = { person: () => '', track: () => '', prop: () => '' };
function trigLabel(c) { const a = []; if (c.trigger) a.push(c.trigger); if (c.offsetSec != null) a.push('+' + c.offsetSec + 's'); return a.join(' '); }
function colorLabel(c) { return c.colorName || (c.color ? c.color.toUpperCase() : ''); }
// 암전 = 네 채널 모두 off (다른 동작이 섞이면 암전이 아니다)
function isBlackout(l) {
  const chs = (l && l.channels) || [];
  return chs.length > 0 && chs.every(x => x.action === 'off') && CH.every(ch => chs.some(x => x.ch === ch));
}
// 객석(house)은 켠다/끈다만 있다 — 밝기·색·페이드·애니는 무대 채널(백·탑·프론트)만. 옛 데이터의 객석 페이드인·애니는 ON, 페이드아웃은 OFF 로 읽는다
const lightCh = x => (x && x.ch === 'house' ? { ch: 'house', action: houseOnOff(x.action), dim: null, color: null, colorName: null, timeSec: null } : x);
// 같은 액션·밝기·색·시간인 채널을 한 덩어리로 (처음 나온 순서). 객석은 늘 따로 — "백·탑 FADE IN / 객석 OFF"
function lightGroups(chs) {
  const out = [];
  (chs || []).map(lightCh).forEach(c => {
    const key = [c.ch === 'house', c.action, c.dim, c.color, c.colorName, c.timeSec].join('|');
    const g = out.find(x => x.key === key);
    if (g) g.chs.push(c.ch); else out.push({ key, chs: [c.ch], c });
  });
  return out;
}
const chGroupName = g => g.chs.map(x => CH_L[x] || x).join('·');
// 머리글과 값을 한 번에 — cueHead · cueDetail 이 나눠 쓴다
function cueParts(c, look) {
  look = look || NO_LOOK;
  const tbd = c.status === 'tbd', b = (c && c[c.dept]) || {};
  const gap = what => what + (tbd ? ' 미정' : ' 미지정');
  let head = '', miss = false, val = '';
  switch (c.dept) {
    case 'cast': {
      // v10: 한 큐에 여러 사람 — 같은 액션끼리 묶어 "조예준·라태형 IN", 섞이면 " · " 로 "조예준 IN · 라태형 OUT" (묶음은 처음 나온 순서)
      const rows = castRows(b);
      if (!rows.length) { head = gap('출연자'); miss = true; break; }
      const gs = [];
      rows.forEach(x => {
        const mv = MOVES[x.move] ? x.move : 'in', who = x.personId ? (look.person(x.personId) || x.personId) : '';
        if (!who) miss = true;
        const nm = who || gap('출연자'), g = gs.find(y => y.mv === mv);
        if (!g) gs.push({ mv, names: [nm] }); else if (!g.names.includes(nm)) g.names.push(nm);
      });
      head = gs.map(g => g.names.join('·') + ' ' + MOVES[g.mv]).join(' · ');
      break;
    }
    case 'sound': {
      if (b.track == null) miss = true;
      head = 'BGM ' + (b.track == null ? (tbd ? '미정' : '미지정') : b.track) + ' ' + (S_ACT_L[b.action] || S_ACT_L.play);
      const v = [], title = b.track == null || !look.track ? '' : look.track(b.track);
      if (title) v.push(title);
      if (b.action === 'volume') v.push((b.level == null ? 100 : b.level) + '%' + (b.timeSec ? ' ' + b.timeSec + 's' : ''));
      else if (b.action === 'fadeOut') v.push((b.timeSec || FADE_DEFAULT) + 's');
      else if (b.timeSec) v.push(b.timeSec + 's');
      if (b.action === 'fadeIn' && b.level != null && b.level !== 100) v.push('→ ' + b.level + '%');
      if (b.action === 'play' && b.level != null && b.level !== 100) v.push(b.level + '%'); // 시작 볼륨 (비우거나 100 이면 기본 볼륨이라 표시 안 함)
      val = v.join(' · ');
      break;
    }
    case 'light': {
      const chs = b.channels || [], anim = String(b.anim || '').trim();
      if (!chs.length) {
        if (anim) { head = L_ACT_L.anim; val = `"${anim}"`; } else { head = gap('조명'); miss = true; }
      } else if (isBlackout(b)) {
        head = 'BLACKOUT';
        const ts = Array.from(new Set(chs.map(x => x.timeSec)));
        if (ts.length === 1 && ts[0]) val = ts[0] + 's';
      } else {
        const gs = lightGroups(chs);
        head = gs.map(g => chGroupName(g) + ' ' + (L_ACT_L[g.c.action] || g.c.action)).join(' / ');
        val = gs.map(g => {
          const x = g.c, v = [];
          if (x.action === 'anim' && anim) v.push(`"${anim}"`);
          if (x.dim != null && x.action !== 'off') v.push(x.dim + '%');
          const cl = colorLabel(x); if (cl) v.push(cl);
          if (x.timeSec) v.push(x.timeSec + 's');
          return v.length ? (gs.length > 1 ? chGroupName(g) + ' ' : '') + v.join(' ') : '';
        }).filter(Boolean).join(' / ');
      }
      if (chs.length && anim && !chs.map(lightCh).some(x => x.action === 'anim')) val += (val ? ' · ' : '') + `ANIM "${anim}"`;
      break;
    }
    case 'stage': {
      const ps = (b.props || []).filter(x => x && x.propId), pn = id => (look.prop && look.prop(id)) || id;
      // v8: 무대 큐는 소품이 필수 — 소품 없는 옛 큐는 빨간 "소품 미지정", 원래 문장은 상세(note)로 보인다
      if (!ps.length) { head = gap('소품'); miss = true; break; }
      head = ps.map(x => pn(x.propId) + ' ' + (PROP_ACTS[x.action] || PROP_ACTS.in)).join(' · ');
      val = ps.filter(x => x.at).map(x => (ps.length > 1 ? pn(x.propId) + ' ' : '') + '→ ' + x.at).join(' · ');
      break;
    }
  }
  return { dept: DEPT_L[c.dept] || c.dept, head, miss, val, tbd };
}
// → { dept, head, miss, tbd }
function cueHead(c, look) { const P = cueParts(c, look); return { dept: P.dept, head: P.head, miss: P.miss, tbd: P.tbd }; }
// 미정 큐의 메모가 미정이라는 사실만 다시 적은 것("조명 상세 미정", "상세 없음")이면 표시하지 않는다 — 빨간 "미정" 이 이미 말한다
const TBD_ECHO_RE = /^(조명|음향|무대|출연|음원|소품)?(상세|내용|시점|밝기)?(미정|없음|미확정)$/;
const tbdEcho = t => TBD_ECHO_RE.test(String(t || '').replace(/[\s·.,—–-]/g, ''));
// → { val, note, when, memo } — val: 시스템 값(밝기·시간·위치), note: 사용자가 쓴 상세, when: 시점.
// v8 은 note 하나뿐이다 — memo · cast.text · stage.text 는 migrate 전의 옛 데이터(MCP 개요가 읽는 서버 원본)일 때만 읽는다
function cueDetail(c, look) {
  const b = (c && c[c.dept]) || {}, tbd = c.status === 'tbd';
  const keep = t => { t = String(t == null ? '' : t).trim(); return t && !(tbd && tbdEcho(t)) ? t : ''; };
  const note = Array.from(new Set(String(c.note || '').split(' / ').concat(c.dept === 'cast' || c.dept === 'stage' ? [b.text] : []).map(keep).filter(Boolean))).join(' / ');
  return { val: cueParts(c, look).val, note, when: trigLabel(c), memo: keep(c.memo) };
}
// 한 줄 글자: 머리글 값 — 상세
function cueText(c, look) {
  const H = cueHead(c, look), D = cueDetail(c, look);
  return H.head + (D.val ? ' ' + D.val : '') + (D.note ? ' — ' + D.note : '');
}

module.exports = { cueHead, cueDetail, cueText, isBlackout, castRows };
