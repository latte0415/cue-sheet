// 원격 MCP 서버 (/mcp) — Claude Code·Codex 같은 에이전트가 큐시트를 읽고 부분 수정한다. 설계와 도구 설명은 docs/mcp.md
//
// 공식 MCP TypeScript SDK v2(@modelcontextprotocol/server + /node)를 처음 요청이 올 때 불러온다 — SDK 가 설치되지 않았어도
// 나머지 서버(/api, 정적 파일)는 그대로 돈다(/mcp 만 503). 요청마다 새 McpServer 를 만드는 상태 없는(stateless) 방식이라
// 서버 쪽 세션이 없다. 2026-07-28 개정판 클라이언트는 createMcpHandler 의 기본 경로로, 2025 개정판 클라이언트(현재의
// Claude Code·Codex 등)는 legacy: 'stateless' 대체 경로로 같은 도구를 받는다.
// 누가 부르는지(actor: 토큰 이름 | '사이트 비밀번호' | '익명')는 server.js 가 인증한 뒤 handle(req, res, actor) 로 넘기고, req.auth →
// SDK 의 authInfo → 요청마다 부르는 factory 의 ctx.authInfo 로 받아 그 요청의 McpServer 에 묶는다. 쓰기는 기록에 by·via 로 남는다.
const { applyOps, OpError } = require('./ops');
const { outline, search, select } = require('./view');
const { ID_RE } = require('./store');
const { AsyncLocalStorage } = require('async_hooks');

const SERVER_INFO = { name: 'cue-sheet', version: '1.0.0' };

const INSTRUCTIONS = `cue-sheet: 마술 공연 큐시트(대본 + 조명·음향·무대·출연 큐)를 읽고 부분 수정한다. 형식 원문은 저장소의 docs/cue-format.md.

구조 (show v12, v5~v11 도 읽고 고치면 v12 로 저장): show → parts[] ("1부") → scenes[] → items[] (대본 흐름 — 대사와 큐가 순서대로).
- scene.type: mc(사이트 화면 이름 "MC 씬" — 진행·멘트·전환) | act(마술 액트). scene.cast = 출연자 person id 목록. setup = 씬 시작 전 무대 세팅.
- item.kind: line(대사, speaker = person id) | action(지문, speaker 없음) | cue(큐 — 본문·화자 없이 트리거 하나와 부서 동작 cues[] 하나 이상).
  대사·지문에는 큐가 붙지 않는다(cues 는 늘 []). 큐는 그 대사 바로 뒤의 따로 있는 item 이다.
- 큐의 트리거(item.trigger, 큐마다 하나) + item.offsetSec(트리거 뒤 지연 초):
    {type:"line", itemId: 대사·지문 id, at:"end"|"start"} — 그 대사의 끝(기본) 또는 시작. 문장 가운데에서 나가야 하면 대사를 두 item 으로 나눈다.
    {type:"cue", cueId: 다른 큐 id, mode:"after"|"with"} — 그 큐 후(기본) 또는 함께 ("연속 큐"). 고리(서로 기다림)는 거부된다.
    {type:"signal", text:"박수 끝"} — 대본에 없는 신호. 대사·큐로 잡을 수 없을 때만.
  사이트는 큐를 "BLACKOUT(Q15) 후 7초", 조예준 “…소개합니다 박대훈” 끝에 처럼 보인다 — 연결이라 번호·대사가 바뀌어도 따라간다.
  큐 만들기: add item {kind:"cue", trigger:{…}, offsetSec, cues:[{dept, …}]} — 보통 after = 그 대사 id(또는 그 대사 뒤 큐들의 마지막). 마지막 동작을 지우거나 옮기면 그 큐도 사라진다.
  옛 글 트리거("암전 후", "이전 큐 후", "대사 끝")도 받아 사이트의 옛 파일 변환과 같게 옮긴다(경고로 알린다). 부서 큐(동작)에는 trigger · offsetSec 이 없다.
  지울 때: 대사를 지우면 그 대사가 트리거인 큐는 남고 트리거가 그 대사를 인용한 신호로 바뀐다(remove mode:"with-cues" 면 함께 지움). 큐를 지우면 따라가던 큐는 신호 "<머리글> 후" 로(mode:"with-followers" 면 함께).
- 표기 규칙: 대사 text 는 말하는 내용만, 말투·동작은 대사 안에 괄호로 ("(한숨 쉬며) 에휴"). 지문 text 는 항상 괄호 한 쌍 "(…)" —
  묘사·진행·연출 모두 지문, 괄호 안에 괄호를 또 넣지 말고 보충은 " — " 로. "*"·"—" 로 시작하는 지문은 쓰지 않는다.
  큐는 스태프·출연자가 실제로 실행할 일(조명·음향·무대 작업·출연자 인/아웃)만 만들고, 묘사에서 큐를 끌어내지 않는다.
  큐가 이미 말하는 대상·동작을 지문으로 다시 쓰지 않는다 — 출연 큐 조예준 IN 옆에 지문 "(조예준 인)" 은 중복이다. 규칙을 어기면 edit_show 가 경고한다.
- 큐의 동작(cues[] — 사이트 화면 이름 "동작", MCP kind "cue")의 dept: cast | light | sound | stage. 내용은 같은 이름의 객체 하나.
  light {looks:[{lookId: lights[].id, action: on|off}], channels:[…], anim}. 기본은 looks — 리허설에서 정해 이름을 붙인 조명(lights[])을 켜고 끈다.
    한 큐에 여러 줄(무대 A OFF + 엔딩 블루 ON). 조명이 목록에 없으면 먼저 kind:"look" 으로 등록(이름 + note 에 상세 설명). 페이드·밝기 같은 상세는 그 조명의 note 에.
    channels = 채널 상세(선택, 옛 방식과 같다): [{ch: back|top|front|house(객석), action: on|off|fadeIn|fadeOut|anim, dim 0-100, color "#rrggbb", colorName, timeSec}]. 암전 = 네 채널 모두 off.
    객석(house)은 channels 의 on|off 한 줄, dim·color·colorName·timeSec 없음. looks 와 channels 는 한 큐에 같이 있어도 된다.
  sound {track: 트랙 번호 tracks[].no (id 아님), action: play|fadeIn|fadeOut|stop|volume, timeSec, level 0-100}
    level = play 시작 볼륨(그 볼륨으로 바로 재생, 예: 하우스 오픈 BGM 50) · fadeIn 도착 볼륨 · volume 목표 볼륨 — 비우면 100. stop·fadeOut 에는 없음(지워짐).
  stage {props:[{propId: props[].id, action: in|out|move|clean, at: 위치}]}  무대 큐는 소품 필수(없으면 먼저 kind:"prop" 으로 등록). clean = 치우기(흘린 카드, 꽃가루)
  cast {people:[{personId, move: in|out|move}]}  한 큐에 여러 사람, 사람마다 액션(함께 IN, 한 사람 OUT · 다른 사람 IN). 한 줄에 한 사람, 순서 = 머리글 순서.
    v9 까지의 한 사람 입력 {personId, move} 도 받는다 — 사람이 0·1명인 큐에만(그 줄을 고친다). 여러 사람이면 people 을 통째로 보낸다.
  공통: note(화면 이름 "메모" — 자유 문장 하나, 모든 부서), status: set | tbd(미정). 시점(트리거 · 지연)은 큐(item)에 하나 — 동작에는 없다.
  머리글(사이트·개요의 "조예준 OUT", "조예준·라태형 IN", "조예준 OUT · 라태형 IN", "BGM 4 PLAY", "무대 A OFF · 엔딩 블루 ON", "백·탑 FADE IN / 객석 OFF", "BLACKOUT", "카드 CLEAN")은 대상·액션에서 자동으로 만들어진다 — 문구를 note 에 다시 쓰지 않는다.
  v8 에서 없어진 필드: memo · cast.text · stage.text → 모두 note.
- people[] {id, name, role: performer|mc|light|sound|stage|other, note}. 화자·출연자·출연 큐는 이름이 아니라 person id 를 쓴다.
- props[] {id, name, note}: 소품 목록. 무대 큐 stage.props 와 preShowProps 는 이름이 아니라 prop id 를 쓴다.
- preShowProps[] {propId, at}: 공연 시작 때 이미 무대에 있는 소품(IN 으로 셈). set kind:"show" 로 배열 통째로 고친다.
- lights[] {id, name, note}: 이름 붙인 조명 목록(v11). name = 조명팀이 부르는 이름("무대 A"), note = 상세 설명("프론트 70 + 탑 블루, 리허설 11/12 확정").
  조명 큐 light.looks 는 이름이 아니라 look id 를 쓴다. add/set/remove/move 에 kind:"look".
- tracks[] {id, no, title, loop, durationSec, note}. 음향 큐는 no 로 가리킨다. no 를 바꾸면 그 트랙을 쓰는 큐도 함께 바뀐다.
- comments[] (scene·item 에) {author, text, resolved}: 확인 요청·메모.
- 큐 번호(item.label, 화면의 "Q12")는 자동이다: 늘 1, 2, 3 … 큐(kind:"cue")에 대본 순서대로(대사는 null). 큐를 더하거나 지우거나
  옮기면 그 뒤 번호가 다시 매겨지므로(사이트에서 고쳐도 같다) 번호 대신 id 로 가리킨다. 직접 정할 수 없다.
- 원문에 없는 값은 지어내지 말고 null / "" / status:"tbd" + note 로 남긴다.

작업 순서: list_shows → get_show(view:"outline") 로 id 확인 → edit_show(ops) 에 그 id 를 써서 고친다.
큰 공연은 get_show 에 partId/sceneId 를 줘서 좁히고, 모든 필드가 필요할 때만 view:"full". 특정 대사·큐 찾기는 search_show.
edit_show 의 ops 는 한 번에 원자적으로 적용된다(하나라도 틀리면 아무것도 바뀌지 않고 이유를 돌려준다). 확신이 없으면 dryRun:true 로 먼저.
모든 저장은 기록에 남는다: list_revisions → restore_revision(rev) 로 되돌릴 수 있고, 복원도 다시 되돌릴 수 있다.
저장(edit_show·restore_revision)에는 그 공연의 편집 비밀번호가 필요하다 — 연결의 X-Edit-Key 헤더, 또는 인자 editKey. 막히면 사용자에게 묻는다(지어내지 않는다).
수정·복원은 연결한 사람의 이름(발급받은 토큰의 이름, 사이트 비밀번호로 붙었으면 "사이트 비밀번호")으로 기록된다 — list_revisions 에 누가(by)·어떤 경로로(via) 저장했는지 나온다.
웹 앱에서 누가 같은 공연을 편집하는 중이면 그 화면에 "다른 기기에서 수정됨" 선택 바가 뜰 수 있다 — 큰 수정 전에는 사용자에게 알린다.
음원 파일은 MCP 로 올리거나 지울 수 없다(웹 앱에서). 트랙 정보(번호·제목 등)만 고칠 수 있다.`;

const OPS_DOC = `Operations (applied in order, all-or-nothing):
- {"op":"set","id":"<id>","fields":{...}} — change only the given fields. kind:"show" (no id) edits show title/preShowSetup/revision/preShowProps (preShowProps = [{propId, at}], replaced as a whole).
  Fields per kind — person: name, role, note · prop: name, note · track: no, title, durationSec, note, loop · part: name · scene: type, title, cast (person ids), durationSec, setup ·
  look (a named lighting look, show.lights): name, note ·
  item: kind (line|action — a line can't become a cue or back), speaker (person id or null), text; a cue item (kind "cue"): trigger, offsetSec — trigger is {"type":"line","itemId":"<line/action id>","at":"end"|"start"} | {"type":"cue","cueId":"<cue item id>","mode":"after"|"with"} | {"type":"signal","text":"박수 끝"} (legacy text like "암전 후" / "이전 큐 후" is accepted and mapped, with a warning); a cue item has no text/speaker and at least one action · cue (= one action of a cue item): dept, note (free-text detail, all departments), status, light/sound/stage/cast (merged one level deep: {"sound":{"level":80}} keeps the other sound fields; light.looks [{lookId, action: on|off}], light.channels, stage.props [{propId, action: in|out|move|clean, at}] and cast.people [{personId, move: in|out|move}] are replaced as a whole). A light cue normally switches named looks: {"light":{"looks":[{"lookId":"lk-a","action":"off"},{"lookId":"lk-b","action":"on"}]}} — register a look first with {"op":"add","kind":"look","data":{"name":"무대 A","note":"프론트 70 + 탑 블루"}}; light.channels is the optional per-channel detail. A cast cue holds one or more people, each with its own move: {"cast":{"people":[{"personId":"p-a","move":"in"},{"personId":"p-b","move":"out"}]}}; the single-person {"cast":{"personId":"p-a","move":"in"}} still works on a cue with 0 or 1 people.
  show v8: memo, cast.text and stage.text no longer exist (use note); a stage cue needs at least one stage.props row unless status:"tbd"; the house channel takes only action on|off with no dim/color/colorName/timeSec ·
  comment: author, text, resolved, resolvedBy. Unknown fields, "id", "label" and child lists are rejected.
- {"op":"add","kind":"part|scene|item|cue|comment|person|prop|look|track","parent":"<container id>","after":"<sibling id>"|"first"|null,"data":{...}}
  parent: scene→part id, item→scene id, cue→cue item id, comment→scene or item id; none for part/person/prop/look/track. after omitted/null = append.
  A new cue: {"op":"add","kind":"item","after":"<line id>","data":{"kind":"cue","trigger":{"type":"line","itemId":"<line id>"},"offsetSec":null,"cues":[{"dept":"light","light":{…}}]}} (put it after the line, or after the cues already below it).
  Legacy: adding a cue (kind "cue") to a line/action parent with a text "trigger" still works — it goes into a cue item right after that line (same trigger → same cue item).
  If after is a sibling id, parent may be omitted. data may nest children: part.scenes, scene.items/comments, item.cues/comments.
  Ids are generated (or give data.id). A cue needs dept. Tracks get the next free no unless given, and stay sorted by no.
- {"op":"remove","id":"<id>","mode"?} — removes it with everything inside. A person still used as speaker/cast, a prop used in stage cues/preShowProps, a look used in light cues, or a track used by sound cues, is refused with the list of uses unless "force":true.
  Removing a line/action that triggers cues: mode "keep-cues" (default — the cues stay, their trigger becomes a signal quoting the removed line, flagged for checking) | "with-cues" (also removes those cues and the cues following them).
  Removing a cue item that other cues follow: mode "only" (default — the direct followers get the signal "<head> 후") | "with-followers" (removes them too). Removing the last action of a cue item removes the cue item (followers → signal).
- {"op":"move","id":"<id>","parent":"<new container id>","after":...} — reorder, or move to another container of the right kind (e.g. a cue to another item). Without parent it stays in its container (or follows the "after" sibling).
Add "kind" to any op when an id could match two kinds.`;

// ---- 결과 모양: 텍스트 + structuredContent. 실패는 isError 결과 (프로토콜 오류 아님)
const ok = (text, data) => ({ content: [{ type: 'text', text }], structuredContent: data });
const fail = text => ({ content: [{ type: 'text', text }], isError: true });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// 쓰기 도구의 편집 비밀번호: 인자 editKey 가 있으면 그것, 없으면 요청 헤더 X-Edit-Key (클라이언트 설정에 한 번 넣어 두는 쪽)
const EDIT_KEY_PROP = { type: 'string', description: "This show's edit password, if the MCP connection has no X-Edit-Key header for it (or it differs)" };

function wlines(ws) { return ws.map(w => `- ${w.path ? w.path + ': ' : ''}${w.msg}${w.where ? ` [${w.where}]` : ''}`).join('\n'); }

function createMcp(opts) {
  const store = opts.store;
  const onerror = opts.onerror || (e => console.error('mcp:', e && e.message ? e.message : e));
  let nodeHandler = null, loadError = null;
  const reqCtx = new AsyncLocalStorage(); // 도구 처리기에서 지금 HTTP 요청(헤더·IP)을 보려고

  // 쓰기 전에 그 프로젝트의 편집 비밀번호 확인 (server.js 의 /api 와 같은 검사·같은 실패 제한). 없으면 막는다(fail-closed)
  async function needEdit(showId, editKey) {
    const req = reqCtx.getStore();
    const r = opts.checkEdit && req ? await opts.checkEdit(req, showId, typeof editKey === 'string' ? editKey : '') : { status: 403 };
    if (r.status === 429) throw new UserError(`too many wrong edit passwords for show "${showId}" — wait ${r.retryAfter}s and try again`);
    if (r.status) throw new UserError(`edit password required for show "${showId}" (missing or wrong) — nothing was saved. Ask the user for this show's edit password and set it as the X-Edit-Key header of the cue-sheet MCP connection, or pass it as editKey. Reading needs no edit password.`);
  }

  async function needShow(showId) {
    if (typeof showId !== 'string' || !ID_RE.test(showId)) throw new UserError(`"${showId}" is not a show id — call list_shows to get one`);
    const rec = await store.get(showId);
    if (!rec) throw new UserError(`no show with id "${showId}" — call list_shows to see the current shows`);
    return rec;
  }
  // 도구 처리기를 감싸 예외를 isError 결과로
  const safe = fn => async args => {
    try { return await fn(args || {}); } catch (e) {
      if (e instanceof UserError || e instanceof OpError) return fail(e.message);
      onerror(e);
      return fail('server error: ' + (e && e.message ? e.message : String(e)));
    }
  };

  function buildServer(S, actor) {
    const meta = via => ({ by: actor.name, via });
    const server = new S.McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    const schema = s => S.fromJsonSchema(Object.assign({ type: 'object', additionalProperties: false }, s));
    const showIdProp = { type: 'string', description: 'Show (project) id from list_shows' };

    server.registerTool('list_shows', {
      title: 'List shows',
      description: '공연(프로젝트) 목록. List all cue sheets (shows) on this server: id, title, rev, updatedAt, scene/cue counts. Start here to get a showId.',
      inputSchema: schema({ properties: {} }),
      annotations: READ
    }, safe(async () => {
      const shows = await store.list();
      const text = shows.length ? shows.map(s => `${s.id} rev ${s.rev} "${s.title}" — ${s.sceneCount} scenes, ${s.cueCount} cues, updated ${s.updatedAt}`).join('\n') : 'No shows yet. Create one in the web app (or with scripts/upload.js).';
      return ok(text, { shows: shows.map(s => ({ id: s.id, title: s.title, rev: s.rev, updatedAt: s.updatedAt, sceneCount: s.sceneCount, cueCount: s.cueCount })) });
    }));

    server.registerTool('get_show', {
      title: 'Read a show',
      description: '큐시트 읽기. Read a show. view "outline" (default) is a compact one-line-per-entry listing with every id, cue number (Q12), speaker names, shortened text and one-line cue summaries (the same headline as the web app, e.g. "cast 조예준 OUT", "cast 조예준·라태형 IN", "light 무대 A OFF · 엔딩 블루 ON", "stage 카드 CLEAN | → 무대 앞 — 밀대로"), plus the people, props, lights (named looks with their notes) and tracks lists — use it to find ids before edit_show. view "full" returns the exact JSON of the selected part/scene (or the whole show). Narrow large shows with partId or sceneId.',
      inputSchema: schema({
        properties: {
          showId: showIdProp,
          view: { type: 'string', enum: ['outline', 'full'], description: 'outline (default, compact) or full (JSON)' },
          partId: { type: 'string', description: 'Only this part' },
          sceneId: { type: 'string', description: 'Only this scene' }
        },
        required: ['showId']
      }),
      annotations: READ
    }, safe(async ({ showId, view, partId, sceneId }) => {
      const rec = await needShow(showId);
      let sel;
      try { sel = select(rec.show, partId, sceneId); } catch (e) { throw new UserError(`${e.message} — call get_show with view "outline" (no partId/sceneId) to see the ids`); }
      if (view === 'full') {
        const data = sel.scope === 'show' ? rec.show : sel.node;
        return ok(`show ${showId} rev ${rec.rev} — ${sel.scope}${sel.scope !== 'show' ? ' ' + data.id : ''} JSON:\n${JSON.stringify(data)}`, { showId, rev: rec.rev, updatedAt: rec.updatedAt, scope: sel.scope, data });
      }
      const text = outline(rec.show, { showId, rev: rec.rev, updatedAt: rec.updatedAt, partId, sceneId });
      return ok(text, { showId, rev: rec.rev, updatedAt: rec.updatedAt, scope: sel.scope, outline: text });
    }));

    server.registerTool('search_show', {
      title: 'Search a show',
      description: '큐시트 검색. Case-insensitive text search in a show: script text, speaker names, cue trigger/note/stage prop names/look names/track titles, comments, scene titles and setups, people, props, lights (named looks) and tracks. A query like "Q12" or "12" also matches that cue number. Returns ids with where they are and a snippet.',
      inputSchema: schema({ properties: { showId: showIdProp, query: { type: 'string', minLength: 1, description: 'Text to find' } }, required: ['showId', 'query'] }),
      annotations: READ
    }, safe(async ({ showId, query }) => {
      const rec = await needShow(showId);
      const r = search(rec.show, query, 50);
      const text = r.total ? `${r.total} match(es)${r.total > r.matches.length ? `, first ${r.matches.length}` : ''} in rev ${rec.rev}:\n` + r.matches.map(m => `${m.kind} ${m.id}${m.itemId ? ` (item ${m.itemId})` : ''} [${m.where}] ${m.field}: ${m.snippet}`).join('\n') : `No match for "${query}" in rev ${rec.rev}.`;
      return ok(text, { showId, rev: rec.rev, total: r.total, matches: r.matches });
    }));

    server.registerTool('edit_show', {
      title: 'Edit a show',
      description: `큐시트 부분 수정. Apply a list of edit operations to one show, using ids from get_show. All ops succeed together or nothing changes (the error says which op failed and why). After the ops, new cue items get cue numbers automatically and the whole show is validated. Returns the new rev, a change summary (including assigned cue numbers) and warnings. Every save is recorded in the history under the connected person's name and can be undone with restore_revision.\n${OPS_DOC}`,
      inputSchema: schema({
        properties: {
          showId: showIdProp,
          ops: {
            type: 'array', minItems: 1, maxItems: 500,
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['set', 'add', 'remove', 'move'] },
                id: { type: 'string', description: 'Target id (set/remove/move)' },
                kind: { type: 'string', enum: ['show', 'part', 'scene', 'item', 'cue', 'comment', 'person', 'prop', 'look', 'track'], description: 'Required for add; optional elsewhere to disambiguate (look = a named lighting look in show.lights)' },
                parent: { type: ['string', 'null'], description: 'Container id for add/move' },
                after: { type: ['string', 'null'], description: 'Sibling id to insert after, "first", or null/omitted for the end' },
                fields: { type: 'object', description: 'set: fields to change' },
                data: { type: 'object', description: 'add: the new entry (may nest children)' },
                force: { type: 'boolean', description: 'remove: remove a person/prop/look/track even if still referenced' },
                mode: { type: 'string', enum: ['keep-cues', 'with-cues', 'only', 'with-followers'], description: 'remove: a line/action → keep-cues (default, its cues become signals) | with-cues; a cue item → only (default, followers become signals) | with-followers' }
              },
              required: ['op']
            }
          },
          dryRun: { type: 'boolean', description: 'true = check and show the result without saving' },
          expectRev: { type: 'integer', description: 'Optional: only save if the show is still at this rev (from get_show)' },
          editKey: EDIT_KEY_PROP
        },
        required: ['showId', 'ops']
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }, safe(async ({ showId, ops, dryRun, expectRev, editKey }) => {
      const conflict = cur => new UserError(`the show is now at rev ${cur}, not rev ${expectRev} — someone saved in between. Call get_show again and redo the edit against the current content.`);
      const tail = r => (r.changes.length ? `\nchanges:\n${r.changes.map(c => '- ' + c.text).join('\n')}` : '') + (r.warnings.length ? `\nwarnings:\n${wlines(r.warnings)}` : '');
      const pick = r => ({ changes: r.changes, labels: r.labels, warnings: r.warnings });
      if (dryRun) {
        const rec = await needShow(showId);
        if (expectRev != null && rec.rev !== expectRev) throw conflict(rec.rev);
        const r = applyOps(rec.show, ops);
        return ok(`dry run — nothing saved (show is at rev ${rec.rev}). These ops are valid.${tail(r)}`, Object.assign({ showId, dryRun: true, rev: rec.rev }, pick(r)));
      }
      await needShow(showId);
      await needEdit(showId, editKey);
      let r = null;
      const w = await store.update(showId, (show, cur) => {
        if (expectRev != null && cur.rev !== expectRev) throw conflict(cur.rev);
        r = applyOps(show, ops);
        r.show.updatedAt = new Date().toISOString();
        return r.show;
      }, meta('mcp'));
      if (!w) throw new UserError(`no show with id "${showId}" — it was deleted`);
      const prev = w.rev - 1;
      return ok(`saved by ${actor.name}: show ${showId} rev ${w.rev} (was ${prev}). Undo with restore_revision {"showId":"${showId}","rev":${prev}}.${tail(r)}`,
        Object.assign({ showId, rev: w.rev, previousRev: prev, updatedAt: w.updatedAt, by: actor.name }, pick(r)));
    }));

    server.registerTool('list_revisions', {
      title: 'List saved versions',
      description: `저장 기록. List the saved versions of a show, newest first (the first one is the current version), with who saved each one (by: the connected person's token name, "사이트 비밀번호" for the shared site password, "브라우저" for the web app) and how (via: mcp | browser | restore). Older versions are kept for the last ${store.historyKeep || 100} saves (web-app autosaves are thinned to one per 10 minutes). Use with restore_revision to undo.`,
      inputSchema: schema({ properties: { showId: showIdProp }, required: ['showId'] }),
      annotations: READ
    }, safe(async ({ showId }) => {
      await needShow(showId);
      const revs = await store.revisions(showId);
      if (!revs) throw new UserError(`no show with id "${showId}"`);
      const who = r => (r.by || r.via ? ` by ${r.by || '?'}${r.via ? ` via ${r.via}` : ''}` : '');
      const text = revs.map(r => `rev ${r.rev}${r.current ? ' (current)' : ''} ${r.updatedAt}${who(r)}${r.restoredFrom ? ` (restored from rev ${r.restoredFrom})` : ''} "${r.title}" — ${r.sceneCount} scenes, ${r.cueCount} cues`).join('\n') + (revs.length === 1 ? '\n(no older versions saved yet)' : '');
      return ok(text, { showId, revisions: revs });
    }));

    server.registerTool('restore_revision', {
      title: 'Restore a saved version',
      description: '되돌리기. Bring back an older version of a show from list_revisions. This saves it as a new version, so the restore itself can be undone by restoring the rev that was current before. Restoring a version that equals the current content changes nothing.',
      inputSchema: schema({ properties: { showId: showIdProp, rev: { type: 'integer', minimum: 1, description: 'rev from list_revisions' }, editKey: EDIT_KEY_PROP }, required: ['showId', 'rev'] }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, safe(async ({ showId, rev, editKey }) => {
      await needShow(showId);
      await needEdit(showId, editKey);
      const r = await store.restore(showId, rev, null, meta('restore'));
      if (!r) throw new UserError(`no show with id "${showId}"`);
      if (r.missing) throw new UserError(`rev ${rev} is not in the saved history of this show — call list_revisions to see which revs can be restored`);
      if (r.unchanged) return ok(`nothing to do: the current version (rev ${r.rev}) already has that content.`, { showId, rev: r.rev, unchanged: true });
      const warn = r.warnings && r.warnings.length ? `\nwarnings:\n${r.warnings.map(w => '- ' + w.msg).join('\n')}` : '';
      return ok(`restored by ${actor.name}: rev ${rev} as new rev ${r.rev}. To undo this restore: restore_revision {"showId":"${showId}","rev":${r.rev - 1}}.${warn}`, { showId, rev: r.rev, restoredFrom: rev, previousRev: r.rev - 1, updatedAt: r.updatedAt, by: actor.name, warnings: r.warnings || [] });
    }));

    return server;
  }

  function load() {
    if (nodeHandler || loadError) return;
    try {
      const S = require('@modelcontextprotocol/server');
      const N = require('@modelcontextprotocol/node');
      const handler = S.createMcpHandler(ctx => buildServer(S, actorOf(ctx)), { legacy: 'stateless', responseMode: 'json', onerror });
      nodeHandler = N.toNodeHandler(handler, { onerror });
    } catch (e) { loadError = e; onerror(e); }
  }

  // (req, res, actor) — 인증은 호출하는 쪽(server.js)이 먼저 하고, 누구인지 { kind, name, id? } 를 넘긴다.
  // req.auth 는 toNodeHandler 가 authInfo 로 그대로 넘겨 factory 의 ctx.authInfo 가 된다(토큰 원문은 싣지 않는다)
  return async function handle(req, res, actor) {
    req.auth = { token: '', clientId: actor && actor.id ? actor.id : (actor && actor.kind) || 'open', scopes: [], extra: { actor: actor || ANON } };
    load();
    if (loadError) {
      const body = JSON.stringify({ error: 'mcp_unavailable', message: 'MCP SDK 를 불러오지 못했습니다 — npm install 을 확인하세요' });
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    return reqCtx.run(req, () => nodeHandler(req, res));
  };
}

class UserError extends Error {}
const ANON = { kind: 'open', name: '익명' };
function actorOf(ctx) {
  const a = ctx && ctx.authInfo && ctx.authInfo.extra && ctx.authInfo.extra.actor;
  return a && typeof a.name === 'string' && a.name ? a : ANON;
}

module.exports = { createMcp, INSTRUCTIONS, SERVER_INFO };
