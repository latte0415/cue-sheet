// 원격 MCP 서버 (/mcp) — Claude Code·Codex 같은 에이전트가 큐시트를 읽고 부분 수정한다. 설계와 도구 설명은 docs/mcp.md
//
// 공식 MCP TypeScript SDK v2(@modelcontextprotocol/server + /node)를 처음 요청이 올 때 불러온다 — SDK 가 설치되지 않았어도
// 나머지 서버(/api, 정적 파일)는 그대로 돈다(/mcp 만 503). 요청마다 새 McpServer 를 만드는 상태 없는(stateless) 방식이라
// 서버 쪽 세션이 없다. 2026-07-28 개정판 클라이언트는 createMcpHandler 의 기본 경로로, 2025 개정판 클라이언트(현재의
// Claude Code·Codex 등)는 legacy: 'stateless' 대체 경로로 같은 도구를 받는다.
const { applyOps, OpError } = require('./ops');
const { outline, search, select } = require('./view');
const { ID_RE } = require('./store');

const SERVER_INFO = { name: 'cue-sheet', version: '1.0.0' };

const INSTRUCTIONS = `cue-sheet: 마술 공연 큐시트(대본 + 조명·음향·무대·출연 큐)를 읽고 부분 수정한다. 형식 원문은 저장소의 docs/cue-format.md.

구조 (show v6, v5 도 읽고 고치면 v6 으로 저장): show → parts[] ("1부") → scenes[] → items[] (대본 문단 하나) → cues[] (그 문단 시점에 나가는 큐).
- scene.type: mc(진행·멘트·전환) | act(마술 액트). scene.cast = 출연자 person id 목록. setup = 씬 시작 전 무대 세팅.
- item.kind: line(대사, speaker = person id) | action(지문, speaker 없음).
- 표기 규칙: 대사 text 는 말하는 내용만, 말투·동작은 대사 안에 괄호로 ("(한숨 쉬며) 에휴"). 지문 text 는 항상 괄호 한 쌍 "(…)" —
  묘사·진행·인/아웃 모두 지문, 괄호 안에 괄호를 또 넣지 말고 보충은 " — " 로 ("(조예준 인 — 고개 절레절레)"). "*"·"—" 로 시작하는 지문은 쓰지 않는다.
  큐는 스태프·출연자가 실제로 실행할 일(조명·음향·무대 작업·출연자 인/아웃)만 만들고, 묘사에서 큐를 끌어내지 않는다. 규칙을 어기면 edit_show 가 경고한다.
- cue.dept: cast | light | sound | stage. 내용은 같은 이름의 객체 하나.
  light {channels:[{ch: back|top|front|house(객석), action: on|off|fadeIn|fadeOut|anim, dim 0-100, color "#rrggbb", colorName, timeSec}], anim}. 암전 = 네 채널 모두 off.
  sound {track: 트랙 번호 tracks[].no (id 아님), action: play|fadeIn|fadeOut|stop|volume, timeSec, level 0-100}
  stage {text, props:[{propId: props[].id, action: in|out|move, at: 놓는 위치}]}  (text 나 props 중 하나는 있어야 내용 있는 큐)
  cast {personId, move: in|out|move, text}
  공통: trigger(언제, 예: "암전 후"), offsetSec(trigger 뒤 지연 초), memo, status: set | tbd(미정).
- people[] {id, name, role: performer|mc|light|sound|stage|other, note}. 화자·출연자·출연 큐는 이름이 아니라 person id 를 쓴다.
- props[] {id, name, note}: 소품 목록. 무대 큐 stage.props 와 preShowProps 는 이름이 아니라 prop id 를 쓴다.
- preShowProps[] {propId, at}: 공연 시작 때 이미 무대에 있는 소품(IN 으로 셈). set kind:"show" 로 배열 통째로 고친다.
- tracks[] {id, no, title, loop, durationSec, note}. 음향 큐는 no 로 가리킨다. no 를 바꾸면 그 트랙을 쓰는 큐도 함께 바뀐다.
- comments[] (scene·item 에) {author, text, resolved}: 확인 요청·메모.
- 큐 번호(item.label, 화면의 "Q12")는 서버가 자동으로 매긴다: 큐가 처음 붙은 문단에만, 한 번 정하면 바뀌지 않는다.
  맨 뒤면 다음 정수, 사이에 끼우면 앞 번호 + ".1" 같은 소수. 직접 정할 수 없다.
- 원문에 없는 값은 지어내지 말고 null / "" / status:"tbd" + memo 로 남긴다.

작업 순서: list_shows → get_show(view:"outline") 로 id 확인 → edit_show(ops) 에 그 id 를 써서 고친다.
큰 공연은 get_show 에 partId/sceneId 를 줘서 좁히고, 모든 필드가 필요할 때만 view:"full". 특정 대사·큐 찾기는 search_show.
edit_show 의 ops 는 한 번에 원자적으로 적용된다(하나라도 틀리면 아무것도 바뀌지 않고 이유를 돌려준다). 확신이 없으면 dryRun:true 로 먼저.
모든 저장은 기록에 남는다: list_revisions → restore_revision(rev) 로 되돌릴 수 있고, 복원도 다시 되돌릴 수 있다.
웹 앱에서 누가 같은 공연을 편집하는 중이면 그 화면에 "다른 기기에서 수정됨" 선택 바가 뜰 수 있다 — 큰 수정 전에는 사용자에게 알린다.
음원 파일은 MCP 로 올리거나 지울 수 없다(웹 앱에서). 트랙 정보(번호·제목 등)만 고칠 수 있다.`;

const OPS_DOC = `Operations (applied in order, all-or-nothing):
- {"op":"set","id":"<id>","fields":{...}} — change only the given fields. kind:"show" (no id) edits show title/preShowSetup/revision/preShowProps (preShowProps = [{propId, at}], replaced as a whole).
  Fields per kind — person: name, role, note · prop: name, note · track: no, title, durationSec, note, loop · part: name · scene: type, title, cast (person ids), durationSec, setup ·
  item: kind, speaker (person id or null), text · cue: dept, trigger, offsetSec, memo, status, light/sound/stage/cast (merged one level deep: {"sound":{"level":80}} keeps the other sound fields; light.channels and stage.props [{propId, action, at}] are replaced as a whole) ·
  comment: author, text, resolved, resolvedBy. Unknown fields, "id", "label" and child lists are rejected.
- {"op":"add","kind":"part|scene|item|cue|comment|person|prop|track","parent":"<container id>","after":"<sibling id>"|"first"|null,"data":{...}}
  parent: scene→part id, item→scene id, cue→item id, comment→scene or item id; none for part/person/prop/track. after omitted/null = append.
  If after is a sibling id, parent may be omitted. data may nest children: part.scenes, scene.items/comments, item.cues/comments.
  Ids are generated (or give data.id). A cue needs dept. Tracks get the next free no unless given, and stay sorted by no.
- {"op":"remove","id":"<id>"} — removes it with everything inside. A person still used as speaker/cast, a prop used in stage cues/preShowProps, or a track used by sound cues, is refused with the list of uses unless "force":true.
- {"op":"move","id":"<id>","parent":"<new container id>","after":...} — reorder, or move to another container of the right kind (e.g. a cue to another item). Without parent it stays in its container (or follows the "after" sibling).
Add "kind" to any op when an id could match two kinds.`;

// ---- 결과 모양: 텍스트 + structuredContent. 실패는 isError 결과 (프로토콜 오류 아님)
const ok = (text, data) => ({ content: [{ type: 'text', text }], structuredContent: data });
const fail = text => ({ content: [{ type: 'text', text }], isError: true });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function wlines(ws) { return ws.map(w => `- ${w.path ? w.path + ': ' : ''}${w.msg}${w.where ? ` [${w.where}]` : ''}`).join('\n'); }

function createMcp(opts) {
  const store = opts.store;
  const onerror = opts.onerror || (e => console.error('mcp:', e && e.message ? e.message : e));
  let nodeHandler = null, loadError = null;

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

  function buildServer(S) {
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
      description: '큐시트 읽기. Read a show. view "outline" (default) is a compact one-line-per-entry listing with every id, cue number (Q12), speaker names, shortened text and one-line cue summaries, plus the people, props and tracks lists — use it to find ids before edit_show. view "full" returns the exact JSON of the selected part/scene (or the whole show). Narrow large shows with partId or sceneId.',
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
      description: '큐시트 검색. Case-insensitive text search in a show: script text, speaker names, cue trigger/memo/stage text/stage prop names/cast text/track titles, comments, scene titles and setups, people, props and tracks. A query like "Q12" or "12" also matches that cue number. Returns ids with where they are and a snippet.',
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
      description: `큐시트 부분 수정. Apply a list of edit operations to one show, using ids from get_show. All ops succeed together or nothing changes (the error says which op failed and why). After the ops, new cue items get cue numbers automatically and the whole show is validated. Returns the new rev, a change summary (including assigned cue numbers) and warnings. Every save can be undone with restore_revision.\n${OPS_DOC}`,
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
                kind: { type: 'string', enum: ['show', 'part', 'scene', 'item', 'cue', 'comment', 'person', 'prop', 'track'], description: 'Required for add; optional elsewhere to disambiguate' },
                parent: { type: ['string', 'null'], description: 'Container id for add/move' },
                after: { type: ['string', 'null'], description: 'Sibling id to insert after, "first", or null/omitted for the end' },
                fields: { type: 'object', description: 'set: fields to change' },
                data: { type: 'object', description: 'add: the new entry (may nest children)' },
                force: { type: 'boolean', description: 'remove: remove a person/prop/track even if still referenced' }
              },
              required: ['op']
            }
          },
          dryRun: { type: 'boolean', description: 'true = check and show the result without saving' },
          expectRev: { type: 'integer', description: 'Optional: only save if the show is still at this rev (from get_show)' }
        },
        required: ['showId', 'ops']
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }, safe(async ({ showId, ops, dryRun, expectRev }) => {
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
      let r = null;
      const w = await store.update(showId, (show, cur) => {
        if (expectRev != null && cur.rev !== expectRev) throw conflict(cur.rev);
        r = applyOps(show, ops);
        r.show.updatedAt = new Date().toISOString();
        return r.show;
      });
      if (!w) throw new UserError(`no show with id "${showId}" — it was deleted`);
      const prev = w.rev - 1;
      return ok(`saved: show ${showId} rev ${w.rev} (was ${prev}). Undo with restore_revision {"showId":"${showId}","rev":${prev}}.${tail(r)}`,
        Object.assign({ showId, rev: w.rev, previousRev: prev, updatedAt: w.updatedAt }, pick(r)));
    }));

    server.registerTool('list_revisions', {
      title: 'List saved versions',
      description: '저장 기록. List the saved versions of a show, newest first (the first one is the current version). Older versions are kept for the last 30 saves (web-app autosaves are thinned to one per 10 minutes). Use with restore_revision to undo.',
      inputSchema: schema({ properties: { showId: showIdProp }, required: ['showId'] }),
      annotations: READ
    }, safe(async ({ showId }) => {
      await needShow(showId);
      const revs = await store.revisions(showId);
      if (!revs) throw new UserError(`no show with id "${showId}"`);
      const text = revs.map(r => `rev ${r.rev}${r.current ? ' (current)' : ''} ${r.updatedAt} "${r.title}" — ${r.sceneCount} scenes, ${r.cueCount} cues`).join('\n') + (revs.length === 1 ? '\n(no older versions saved yet)' : '');
      return ok(text, { showId, revisions: revs });
    }));

    server.registerTool('restore_revision', {
      title: 'Restore a saved version',
      description: '되돌리기. Bring back an older version of a show from list_revisions. This saves it as a new version, so the restore itself can be undone by restoring the rev that was current before. Restoring a version that equals the current content changes nothing.',
      inputSchema: schema({ properties: { showId: showIdProp, rev: { type: 'integer', minimum: 1, description: 'rev from list_revisions' } }, required: ['showId', 'rev'] }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, safe(async ({ showId, rev }) => {
      await needShow(showId);
      const r = await store.restore(showId, rev);
      if (!r) throw new UserError(`no show with id "${showId}"`);
      if (r.missing) throw new UserError(`rev ${rev} is not in the saved history of this show — call list_revisions to see which revs can be restored`);
      if (r.unchanged) return ok(`nothing to do: the current version (rev ${r.rev}) already has that content.`, { showId, rev: r.rev, unchanged: true });
      const warn = r.warnings && r.warnings.length ? `\nwarnings:\n${r.warnings.map(w => '- ' + w.msg).join('\n')}` : '';
      return ok(`restored rev ${rev} as new rev ${r.rev}. To undo this restore: restore_revision {"showId":"${showId}","rev":${r.rev - 1}}.${warn}`, { showId, rev: r.rev, restoredFrom: rev, previousRev: r.rev - 1, updatedAt: r.updatedAt, warnings: r.warnings || [] });
    }));

    return server;
  }

  function load() {
    if (nodeHandler || loadError) return;
    try {
      const S = require('@modelcontextprotocol/server');
      const N = require('@modelcontextprotocol/node');
      const handler = S.createMcpHandler(() => buildServer(S), { legacy: 'stateless', responseMode: 'json', onerror });
      nodeHandler = N.toNodeHandler(handler, { onerror });
    } catch (e) { loadError = e; onerror(e); }
  }

  // (req, res) — 인증은 호출하는 쪽(server.js)이 먼저 한다
  return async function handle(req, res) {
    load();
    if (loadError) {
      const body = JSON.stringify({ error: 'mcp_unavailable', message: 'MCP SDK 를 불러오지 못했습니다 — npm install 을 확인하세요' });
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    return nodeHandler(req, res);
  };
}

class UserError extends Error {}

module.exports = { createMcp, INSTRUCTIONS, SERVER_INFO };
