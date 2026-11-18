# MCP 서버 (`/mcp`) — 에이전트로 큐시트 고치기

Claude Code·Codex 같은 AI 에이전트가 사이트의 큐시트를 **읽고 일부만 고칠 수 있게** 하는 원격 MCP 서버.
"3번 씬 끝에 박대훈 퇴장 큐 넣어 줘", "BGM 3 을 5번으로 바꿔 줘", "아까 수정 되돌려 줘" 같은 요청을 에이전트가 처리한다.
구현은 `lib/mcp.js`(도구), `lib/ops.js`(수정 적용), `lib/view.js`(개요·검색), `lib/labels.js`(큐 번호), `lib/store.js`(저장·기록).

## 연결하기 (개발자가 아니어도 됨)

필요한 것: 사이트 주소(예: `https://cue-sheet.example.app`)와 팀 비밀번호(서버의 `APP_PASSWORD`).

**가장 쉬운 방법:** 사이트 메뉴 → **에이전트 연결** 을 열면 이 사이트 주소와 비밀번호가 들어간 명령·설정이 나온다. **복사** 버튼으로
복사해 붙여 넣으면 된다. 비밀번호에 `$` `` ` `` `"` `\` `'` 같은 기호가 있어도 복사 버튼이 셸·TOML 용으로 알맞게 감싸 준다.

손으로 쓰려면 아래 `<사이트>` 와 `<비밀번호>` 를 바꿔 넣는다. 셸 명령은 헤더 전체를 **작은따옴표**로 감싼다(큰따옴표 안에서는
`$`·`` ` `` 가 해석돼 비밀번호가 바뀌거나 명령이 실행된다). 비밀번호에 `'` 가 있으면 그 자리를 `'\''` 로 바꾼다.

### Claude Code

터미널에서 한 줄:

```sh
claude mcp add --transport http cue-sheet 'https://<사이트>/mcp' --header 'Authorization: Bearer <비밀번호>'
```

- Claude Code 를 열고 `/mcp` 를 입력하면 `cue-sheet` 가 **connected** 로 보여야 한다. 실패로 나오면 주소 끝의 `/mcp`,
  비밀번호 앞의 `Bearer ` (한 칸 띄움)를 확인한다.
- 기본은 지금 폴더(프로젝트)에서만 쓰인다. 어느 폴더에서나 쓰려면 `--scope user` 를 붙인다.
- 지우기: `claude mcp remove cue-sheet`

### Codex

`~/.codex/config.toml` 파일(없으면 만든다)에 추가:

```toml
[mcp_servers.cue-sheet]
url = "https://<사이트>/mcp"
http_headers = { "Authorization" = "Bearer <비밀번호>" }
```

TOML 의 `"…"` 안에서는 비밀번호의 `\` 를 `\\`, `"` 를 `\"` 로 쓴다.

Codex 를 다시 시작한 뒤 `/mcp` 로 `cue-sheet` 와 도구 6개가 보이는지 확인한다.

### 이렇게 말하면 된다

- "cue-sheet 에서 공연 목록 보여 줘" → `list_shows`
- "가을 정기공연 1부에서 멘탈 씬 구성 보여 줘" → `get_show`
- "탑햇 나오는 큐 찾아 줘" → `search_show`
- "Q11 다음에 '(테이블 정리)' 지문 넣고 무대 큐 달아 줘" → `edit_show`
- "방금 수정 취소해 줘" → `list_revisions` → `restore_revision`

비밀번호는 팀 공용이라 이 설정이 있으면 누구나 수정할 수 있다. 비밀번호를 바꾸면(`APP_PASSWORD`) 위 설정도 바꿔야 한다.
음원 파일은 MCP 로 올리거나 지울 수 없다 — 웹 앱에서 한다.

## 설계

### 도구는 6개, 수정은 `edit_show` 하나

| 도구 | 하는 일 | 성격 |
|---|---|---|
| `list_shows` | 공연 목록 `{ id, title, rev, updatedAt, sceneCount, cueCount }` | 읽기 |
| `get_show { showId, view?, partId?, sceneId? }` | `outline`(기본): 한 줄에 하나씩 id·큐 번호·화자 이름·잘린 본문·큐 한 줄 요약 + 사람·트랙 목록. `full`: 고른 파트/씬(또는 전체)의 JSON 그대로 | 읽기 |
| `search_show { showId, query }` | 대본·화자·큐(trigger·memo·무대/출연 내용·트랙 제목)·코멘트·씬 제목/세팅·사람·트랙에서 대소문자 무시 부분 일치. `Q12`/`12` 는 큐 번호. 최대 50개, id·위치·발췌 | 읽기 |
| `edit_show { showId, ops, dryRun?, expectRev? }` | ops 를 원자적으로 적용 → 새 rev, 바뀐 내용 요약(새로 매긴 큐 번호 포함), 경고 | 쓰기 |
| `list_revisions { showId }` | 저장 기록, 최신 먼저(맨 앞이 현재) | 읽기 |
| `restore_revision { showId, rev }` | 그 버전을 새 버전으로 저장(복원도 되돌릴 수 있음). 이미 같은 내용이면 아무것도 안 함 | 쓰기 |

결과는 모두 사람이 읽는 텍스트와 `structuredContent`(JSON)를 함께 준다. 실패(없는 id, 틀린 값, 충돌 …)는 프로토콜 오류가
아니라 `isError: true` 결과로, **무엇을 어떻게 고치면 되는지** 문장으로 돌려준다(예: `"조예준" is a name, use id "p-yejun"`).
annotations: 읽기 도구는 `readOnlyHint`, `edit_show` 는 `destructiveHint`(지우기 가능), `restore_revision` 은
`destructiveHint` + `idempotentHint`(같은 rev 를 두 번 복원해도 결과가 같다).

**왜 도구 하나에 ops 배열인가.** `add_cue`·`move_scene` 같은 도구를 종류별로 만들면 20개가 넘고, 에이전트가 여러 번 호출하는 사이
일부만 반영된 상태가 저장된다. ops 배열이면 "문단 넣고 → 큐 달고 → 트랙 번호 바꾸기" 가 한 번의 원자적 저장이 되고(하나라도
틀리면 아무것도 안 바뀜), 저장 기록도 한 칸만 쓴다. 에이전트는 `get_show` 개요에서 id 를 보고 바로 op 를 만든다.

**개요는 싸게.** `cues/backstage-part1.json`(85문단·36큐) 기준 JSON 전체가 약 20,000자, 개요는 약 5,300자.
씬 하나만 보려면 `sceneId` 로 더 줄인다. 모든 필드가 필요할 때만 `view:"full"`.

### ops

모든 op 는 순서대로 적용되고, 끝난 뒤 (1) 새로 큐가 붙은 문단에 번호를 매기고 (2) show 전체를 `lib/validate.js` 의
`validateShow` 로 검사한다. **op 가 새로 만든 오류가 하나라도 있으면 전부 취소**한다. 원래 있던 오류(예: 사이트에서 사람을 지워
남은 화자 참조)는 막지 않는다 — 그렇지 않으면 그런 공연은 영영 고칠 수 없다. 오류 비교는 경로의 배열 번호를 뺀 모양 + 메시지로 한다.
알려진 한계: 같은 모양·같은 메시지의 오류가 원래 하나 있었는데 op 가 그것을 고치면서 **다른 곳에 같은 오류를 새로 만들면** 개수가 같아
새 오류로 잡지 못한다(드문 경우). 또 원래 있던 id 중복 오류는 메시지에 위치가 들어 있어, 그 항목을 옮기면 새 오류로 보여 막힐 수 있다.

| op | 형식 | 규칙 |
|---|---|---|
| set | `{ op:"set", id, kind?, fields }` | 준 필드만 바꾼다. `kind:"show"` 면 id 없이 `title`·`preShowSetup`·`revision`. 모르는 필드, `id`, `label`, `isCue`, 자식 배열(`items` 등), 트랙의 `fileName`/`fileKey` 는 거부 |
| add | `{ op:"add", kind, parent?, after?, data }` | `kind`: part·scene·item·cue·comment·person·track. `parent`: scene→파트 id, item→씬 id, cue→문단 id, comment→씬 또는 문단 id (part·person·track 은 없음). `after`: 형제 id / `"first"` / 생략·`null` = 맨 뒤. after 가 형제 id 면 parent 생략 가능 |
| remove | `{ op:"remove", id, kind?, force? }` | 안에 든 것까지 지운다. 화자·출연자·출연 큐가 가리키는 사람, 음향 큐가 쓰는 트랙은 사용처 목록과 함께 거부. `force:true` 면 지운다 |
| move | `{ op:"move", id, kind?, parent?, after? }` | 같은 단계 안에서 순서 바꾸기 또는 다른 부모로(큐를 다른 문단으로, 씬을 다른 파트로). parent 를 안 주면 지금 부모 안에서(after 가 다른 부모의 형제면 그쪽으로) |

- `kind` 는 서로 다른 종류에 같은 id 가 있을 때만 필요하다(그때는 오류가 알려 준다).
- **필드 형식.** 문자열 필드에 숫자를 주면 문자열로, 숫자 필드에 `"240"` 같은 숫자 문자열을 주면 숫자로 바꾼다. 그 밖은 거부.
  트랙 번호(`track.no`, 음향 큐 `sound.track`)는 1 이상의 정수(`sound.track` 은 미정이면 null). 필드 이름은 정해진 목록과
  정확히 같아야 한다(`constructor`·`__proto__` 같은 이름도 모르는 필드로 거부).
  열거형(`type`, `kind`, `dept`, `role`, `ch`, `action`, `move`, `status`)은 `docs/cue-format.md` 의 값만.
  사람 참조(`speaker`, `cast`, `cast.personId`)는 `people[].id` 만 — 이름을 주면 그 사람의 id 를 알려 주며 거부.
- **얕은 합치기.** 큐의 `light`·`sound`·`stage`·`cast` 객체는 한 단계만 합친다: `{ sound: { level: 80 } }` 은 track·action·timeSec 을
  그대로 두고 level 만 바꾼다. 배열(`light.channels`, `scene.cast`)은 통째로 바뀐다. 채널의 빠진 필드는 기본값
  (`ch:"front", action:"on"`, 나머지 null). `dept` 를 바꾸면 이전 부서 내용은 버리고 새 부서 기본값에서 시작한다.
- **브라우저와 같은 정리.** action 문단은 화자를 지우고 본문이 `(`·`*` 로 시작하지 않으면 괄호를 씌운다(경고).
  `data.kind` 없이 본문이 `(` 로 시작하면 action. 음향 `level` 은 `volume`(없으면 100)·`fadeIn` 에서만 남긴다(index.html `saveCue`).
  `#rrggbb` 가 아닌 색은 `colorName` 으로 옮긴다(migrate). 큐가 바뀐 문단의 `isCue` 는 큐 유무를 따른다.
  내용 없는 큐(채널 없는 조명, 트랙 없는 음향 …)는 저장하되 "채우거나 `status:"tbd"`" 경고.
- **새 항목.** id 는 브라우저 `uid()` 와 같은 접두어(`pt-` `s-` `i-` `q-` `c-` `p-` `tr-`)로 만든다. 같은 호출의 뒤 op 에서
  가리키려면 `data.id` 를 직접 줘도 된다(`[A-Za-z0-9_-]{1,64}`, 쓰지 않은 값). 기본값은 브라우저가 새로 만들 때와 같다
  (씬 `type:"act"`, 사람 `role:"other"`, 코멘트 작성자 `"익명"`, 트랙 `no` = 지금 최댓값 + 1). `data` 에 자식을 함께 넣을 수 있다:
  part.`scenes`, scene.`items`/`comments`, item.`cues`/`comments`.
- **트랙.** 항상 `no` 순으로 정렬된다(add 에 `after`, move 는 거부). `no` 를 바꾸면 그 번호를 쓰던 음향 큐의 `sound.track` 도
  함께 바뀐다. 겹치는 번호는 거부. 올린 음원이 있던 트랙을 지우면 파일은 서버에 남는다(경고).
- **사람 force 삭제.** 브라우저의 사람 삭제와 같이 씬 출연자 목록에서는 빼고, 대사 화자·출연 큐는 그대로 둬 사이트에
  "(삭제된 사람)" 으로 보인다(경고 한 줄로 개수를 알려 줌).

### 큐 번호

`item.label`(화면의 Q12)은 `lib/labels.js` 가 매긴다. index.html 의 `assignLabels` 를 그대로 옮긴 것이고
`test/labels.test.js` 가 index.html 의 함수를 직접 떼어 와 같은 결과인지 대조한다. 규칙: 큐가 처음 붙은 문단에만, 한 번 정하면
바뀌지 않는다(큐를 다 지워도 남는다). 맨 뒤면 다음 정수, 번호 붙은 문단 사이면 앞 번호의 정수부 + `.k`(맨 앞이면 `0.k`).
그래서 `label` 은 set 으로 바꿀 수 없다.

### 동시 편집

- 서버 안의 쓰기는 하나의 큐로 직렬화된다. `edit_show` 는 `store.update(id, fn)` — **쓰기 큐 안에서 최신 버전을 읽어** ops 를
  적용하고 rev 를 올린다. 그래서 브라우저 저장과 MCP 수정이 동시에 와도 한쪽이 다른 쪽을 모르고 덮어쓰는 일은 서버에서는 없다.
- `expectRev` 를 주면 그 rev 일 때만 저장한다(개요를 읽은 뒤 누가 저장했으면 "다시 읽고 하라" 는 오류). 안 주면 최신 버전에
  op 를 적용한다 — op 가 id 로 가리키므로 그 사이 다른 곳이 바뀌었어도 대개 그대로 맞다.
- **알려진 한계 (브라우저 쪽).** 브라우저는 5초마다 `If-None-Match` 로 폴링하고, 고치던 내용이 없으면 MCP 수정을 바로 받아 온다.
  하지만 **그 사이 브라우저에 저장 안 된 편집이 있으면** 다음 저장이 409 가 되고 "다른 기기에서 수정됨 — 서버 버전 불러오기 /
  내 버전으로 덮어쓰기" 선택 바가 뜬다. "내 버전으로 덮어쓰기" 를 누르면 MCP 수정이 사라진다(기록에는 남아 복원 가능).
  그래서 에이전트 instructions 에 "큰 수정 전에는 사용자에게 알린다" 를 넣었다.
- **2단계 계획: id 단위 자동 병합.** 모든 항목에 안정된 id 가 있으므로, 409 때 브라우저가 (기준 버전 → 내 버전) 과
  (기준 버전 → 서버 버전) 의 차이를 id 단위로 계산해 서로 다른 항목을 고친 경우는 자동으로 합치고, 같은 항목·같은 필드를 고친
  경우만 묻게 할 수 있다. 이번 범위에는 넣지 않았다(index.html 변경 필요).

### 기록 (되돌리기)

- 쓰기 직전 버전을 `DATA_DIR/shows/<id>.history/<rev>.json`(`{ rev, updatedAt, show }`)으로 남긴다. **최근 30개**.
- MCP 수정(`update`)과 복원(`restore`)은 매번 남긴다. 브라우저 저장(PUT)은 몇 초마다 오므로 솎는다: 직전 쓰기가 PUT 이 아니었을
  때(= MCP 수정·복원 직후, 서버 재시작 후 첫 PUT) 또는 마지막으로 남긴 지 10분이 지났을 때만. 그래서 MCP 수정 직전·직후 상태는
  브라우저 편집이 이어져도 남는다.
- 복원은 그 버전의 내용을 **새 rev 로 저장**하는 것이라 복원도 기록에 남고 되돌릴 수 있다. 음원 파일은 기록에 없으므로,
  복원한 버전의 트랙이 그 사이 지워진 음원을 가리키면 그 트랙의 `fileKey`·`fileName` 을 비우고 경고로 알린다(웹 앱에서 다시 올린다). 프로젝트를 지우면 기록도 지운다.
  복제는 기록을 가져가지 않는다.

### 프로토콜·SDK

- 공식 MCP TypeScript SDK v2: `@modelcontextprotocol/server` 2.4.0 + `@modelcontextprotocol/node` 2.1.2 (`engines: node >=20`).
  CJS 빌드도 들어 있어 `require` 로 쓰고, `/mcp` 첫 요청 때 불러온다 — SDK 가 없으면 `/mcp` 만 `503 mcp_unavailable`,
  나머지 서버는 그대로. 테스트용 클라이언트 `@modelcontextprotocol/client` 는 devDependency.
- `createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json' })` + `toNodeHandler`. 요청마다 새 `McpServer` 를 만드는
  상태 없는 방식(서버에 세션 없음). 2026-07-28 개정판 클라이언트는 기본 경로로, 2025 개정판 클라이언트(현재의 Claude Code·Codex
  등)는 `legacy: 'stateless'` 대체 경로로 같은 도구를 받는다. 세션이 없으므로 GET(SSE 대기)·DELETE 는 `405`.
- 입력 스키마는 zod 없이 JSON Schema(`fromJsonSchema`)로 적었다. 스키마에 안 맞는 인자는 SDK 가 `isError` 결과로 돌려준다.

### 인증

`/api` 와 같은 검사 하나(`server.js` 의 `authed`)를 쓴다: `Authorization: Bearer <APP_PASSWORD>`, `X-App-Key`(URL 인코딩 가능),
`?key=` 중 하나. 헤더에 한글 비밀번호를 UTF-8 그대로 실어 보내는 클라이언트도 통과한다. 틀리거나 없으면
`401 {"error":"unauthorized"}` + `WWW-Authenticate: Bearer`. 401 때 길이를 아는 작은 본문(≤64KB)만 비우고, 길이를 모르거나 큰 본문은
읽지 않고 응답 뒤 연결을 닫는다(`/api` 도 같음). 서버의 `keepAliveTimeout` 은 65초(프록시 유휴 시간보다 길게). `APP_PASSWORD` 가 없으면 `/api` 처럼 인증 없이 열린다(로컬 개발용).
OAuth 는 없다 — 팀 공용 비밀번호 하나.

## 확인 방법

```sh
npm test                                  # test/ops·store·labels·mcp.test.js 포함
# 손으로: 서버를 띄우고 JSON-RPC 한 번
curl -s http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <비밀번호>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```
