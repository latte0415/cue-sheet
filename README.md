# cue-sheet

공연 큐시트 웹앱. 프런트는 단일 파일(`index.html`), 서버는 Node 20(`server.js` + `lib/store.js`). npm 의존성은
`/mcp` 가 쓰는 공식 MCP SDK 뿐이고(`npm install` 필요), 없으면 `/mcp` 만 꺼지고 나머지는 그대로 돈다.

- **서버 모드**(기본): 여러 기기(연출 노트북, 조명/음향 오퍼 노트북, 무대보조 폰)가 같은 큐시트를 보고 고친다.
  공연 하나 = 프로젝트 하나. 음원 파일도 서버에 올라가 모든 기기에서 재생된다. 5초마다 다른 기기의 변경을 가져오고,
  겹치면 "다른 기기에서 수정됨 — 서버 버전 불러오기 / 내 버전으로 덮어쓰기" 안내가 뜬다.
- **로컬 모드**: `/api/health` 에 닿지 못하면(claude.ai 아티팩트, `file://`, 정적 호스팅) 자동 전환. 지금까지처럼 이 브라우저
  (localStorage + IndexedDB)에만 저장하고, 프로젝트는 하나만 쓴다. 상단에 "로컬 모드 — 이 브라우저에만 저장" 표시.
- **화면**: 대본 · 큐시트 · 런 │ 목록(사람 · 소품·조명 · 음원 · 무대 상황 · 흐름), 점검은 목차 맨 위. **흐름**(`#flow`)은 읽기 전용 가로 그림 한 장 —
  씬 띠, 큐끼리의 트리거 연결(후·함께·대사), 사람·소품·조명·음원이 들어와 있는 동안의 막대, 런의 지금 위치 선(런과 같은 진행 상태).

## 로컬 실행

```sh
node server.js                         # http://localhost:3000, 비밀번호 없음, 데이터는 ./data
APP_PASSWORD=비번 node server.js        # 비밀번호 화면 확인용
npm install                            # MCP SDK (처음 한 번)
npm test                               # 서버 API·MCP 테스트 (node --test)
```

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | Railway 가 자동으로 넣는다 |
| `DATA_DIR` | `./data` | 프로젝트 JSON·음원 저장 위치. Railway 에서는 볼륨 경로 `/data` |
| `APP_PASSWORD` | (없음) | 설정하면 `/api/*`·`/mcp` 에 팀 공유 비밀번호 필요(`/mcp` 는 사람별 토큰도 받음). 없으면 인증 없음(로컬 개발용) |
| `HISTORY_KEEP` | 100 | 프로젝트마다 보관할 이전 버전 수 (웹 자동 저장은 10분에 한 번만 남김, MCP 수정·복원은 매번) |
| `TRUST_PROXY` | (Railway 에서 자동) | `1` 이면 편집 비밀번호 실패 제한의 IP 를 `X-Forwarded-For` 마지막 값으로 판별 |
| `TRASH_DAYS` | 30 | 삭제한 프로젝트를 휴지통(`DATA_DIR/trash/`)에 두는 일수. 지나면 서버 시작 때와 6시간마다 영구 삭제 |
| `BODY_CACHE_MB` | 64 | 큐시트 본문(파일 바이트·gzip)을 메모리에 두는 상한(MB, 오래 안 쓴 것부터 비움). 0 이면 끈다. 폴링 200 응답이 파일을 다시 읽지 않게 한다 |
| `ADMIN_KEY` | (없음) | 설정하면 관리자 복구 키가 켜진다 — 편집 비밀번호를 `1234` 로 초기화(`POST /api/shows/:id/edit-password/reset`). 없으면 그 기능 자체가 없다(404). 있으면 MCP 토큰 발급·폐기에도 필요 |

`data/` 는 `.gitignore` 에 들어 있다.

## Railway 배포

볼륨은 `railway.json` 으로 만들 수 없고 **대시보드에서만** 만든다. 볼륨 없이 배포하면 재배포할 때마다 데이터가 사라진다.

1. Railway 대시보드 → New Project → Deploy from GitHub repo → 이 저장소 선택. Node 서비스로 자동 감지되고
   `railway.json` 의 `node server.js`, 헬스체크 `/healthz` 가 적용된다.
2. 서비스를 연 상태에서 캔버스 빈 곳 우클릭(또는 ⌘K) → **Create Volume** → 이 서비스에 연결, Mount path 를 **`/data`** 로.
   (서비스 → Settings → Volumes 에서도 확인 가능)
3. 서비스 → **Variables** 탭 → New Variable:
   - `DATA_DIR` = `/data`
   - `APP_PASSWORD` = 팀에 공유할 비밀번호
   - `ADMIN_KEY` = 관리자만 아는 긴 무작위 문자열(예: `openssl rand -base64 24`). 팀에 공유하지 않는다. 편집 비밀번호를 빼앗겼을 때 되찾는 용도
   - (선택) `TRASH_DAYS` = 휴지통 보관 일수. 기본 30
4. 변수를 저장하면 재배포된다. 서비스 → Settings → Networking → **Generate Domain** 으로 주소를 만든다.
5. 처음 접속하면 비밀번호 → "첫 프로젝트 만들기"(빈 프로젝트 / 샘플로 시작). 이후 기기들은 같은 주소로 들어와 프로젝트를 고른다.

비밀번호를 바꾸려면 `APP_PASSWORD` 만 바꾸면 된다. 열려 있던 기기는 다음 요청에서 401 을 받고 비밀번호를 다시 묻는다.

## 권한: 보기와 편집

- **사이트 비밀번호**(`APP_PASSWORD`) = 보기. 모든 프로젝트를 읽고, 음원을 재생하고, 새 프로젝트를 만들거나 복제할 수 있다.
- **프로젝트 편집 비밀번호** = 그 프로젝트를 바꾸는 모든 쓰기(저장·삭제·음원 올리기/지우기·버전 복원·비밀번호 변경, MCP 의 `edit_show`·`restore_revision`).
  처음에는 모든 프로젝트가 **`1234`** 다(기존 프로젝트 포함). 사이트에서 "편집"을 누르면 묻고, 맞으면 이 브라우저가 프로젝트별로
  기억한다. 기본값인 동안 편집을 켤 때 "기본 비밀번호(1234) 사용 중" 안내가 한 줄 뜬다(닫거나 다른 화면으로 가면 그 탭에서는 다시 안 뜸, 런·부스 모드에서는 안 뜸). 그 뒤로는 ⋯ 메뉴 → "편집 비밀번호 변경" 옆에 "기본 1234" 표시만 남는다.
- 편집 비밀번호는 `DATA_DIR/shows/<id>/auth.json` 에 scrypt 해시로만 저장한다(평문 없음, `show` 와 분리돼 내보내기·업로드 JSON 에
  섞이지 않음).
- **휴지통**: 프로젝트를 지우면 바로 없어지지 않고 `DATA_DIR/trash/` 로 옮겨져 `TRASH_DAYS`(기본 30)일 동안 남는다(음원·버전 기록·
  편집 비밀번호까지 그대로). ⋯ 메뉴(관리) 또는 프로젝트 메뉴 → **휴지통**에서 되살린다. 목록과 복구는 **사이트 비밀번호만으로** 된다 —
  편집 비밀번호를 빼앗긴 사람이 비밀번호를 바꾸고 지워도 원래 편집자가 되살릴 수 있게(복구는 아무것도 지우지 않는다). 프로젝트가
  하나도 없으면 시작 화면에 휴지통 입구가 있다. 같은 id 가 이미 있으면 새 id 로 되살린다.
- **관리자 복구 키**(`ADMIN_KEY`): 편집 비밀번호를 잊었거나 누가 바꿔 잠갔을 때, 서버 관리자가 그 프로젝트의 편집 비밀번호를 `1234`
  (기본 상태)로 되돌린다. 화면은 없고 curl 로 쓴다. 내용·음원·기록은 그대로이고, 되돌린 뒤 사이트에서 새 비밀번호로 바꾼다.

  ```sh
  # <id> 는 주소의 ?show=<id> 또는 GET /api/shows 의 id. 키에 한글·기호가 있으면 URL 인코딩해서 넣는다
  curl -X POST 'https://<사이트>/api/shows/<id>/edit-password/reset' \
    -H 'X-App-Key: <APP_PASSWORD>' -H 'X-Admin-Key: <ADMIN_KEY>'
  # → {"ok":true,"isDefault":true}. 틀리면 403 admin_forbidden, 같은 IP 에서 1분에 10번 틀리면 429, ADMIN_KEY 미설정이면 404
  ```

  `ADMIN_KEY` 는 팀 비밀번호와 따로, 서버 관리자만 안다. 키가 유출됐다고 의심되면 Railway 변수를 바꾸면 바로 바뀐다.
- **버전 기록**: 저장할 때 직전 버전을 `shows/<id>/history/` 에 남긴다(최근 `HISTORY_KEEP` 개). 웹 자동 저장은 10분에 한 번만,
  MCP 수정·복원은 매번 남긴다. 편집 권한이 있으면 ⋯ 메뉴(파일) → "버전 기록 · 복원"에서 골라 복원한다(MCP 의 `restore_revision` 과 같은 것).
  복원도 새 rev 로 저장되므로 복원 자체를 다시 되돌릴 수 있다. 목록(rev·시각·제목·개수)은 보기 권한으로도 읽히지만 내용과 복원은 편집 권한이 필요하다.

## 오프라인 준비 (네트워크 없이 진행 — 예전 이름 "공연 모드")

공연 전에 런 뷰의 "보기 옵션 ▾"(또는 ⋯ 메뉴 → 공연 준비)의 **오프라인 준비**를 누르면 그 프로젝트의 음원 전부를 이 기기(IndexedDB `cuesheet-offline`)에,
큐시트 최신본을 localStorage(`cueSheet.offline.<id>`)에 받아 둔다. 이미 받은 파일은 건너뛰고, 파일을 바꿔 올린 트랙(새 fileKey)만 새로 받는다.
켜져 있는 동안 재생은 받아 둔 파일로 하므로 공연장 네트워크가 끊겨도 재생·큐 이동·카운트다운이 그대로 되고, 상단에는
"오프라인 · 저장은 연결되면 보냄"만 보인다(변경은 이 브라우저에 백업했다가 연결되면 보냄). 준비 뒤 다른 기기에서 음원이 바뀌면 런 줄이 빨갛게
"BGM n 바뀜"을 알린다 — 다시 준비를 누른다. 켜짐 여부는 기기별 설정이고 데이터 형식은 바꾸지 않는다. ⋯ 메뉴에서 끄거나 받은 음원을 지운다. 켜져 있거나 받는 중·실패면 런 상단에 그 줄이 늘 보인다.

오프라인 준비를 켠 기기에는 Service Worker(`/sw.js`)가 등록돼, 공연 중 실수로 새로고침해도 오프라인에서 화면이 뜬다(받아 둔 큐시트로 연다).
화면은 늘 네트워크 먼저 받으므로 연결돼 있으면 새 배포가 바로 적용되고, 오프라인 사본으로 떴다가 다시 연결됐을 때 새 배포가 있으면
"새 화면이 배포되었습니다" 바를 띄운다. 켠 프로젝트가 하나도 없으면 해제한다. 로컬 모드(파일로 열기·아티팩트)에서는 등록하지 않는다.

## 도움말 고치기

앱 안 도움말(상단 "?" · F1)의 원본은 `docs/help/`(글 `articles.json` · 용어 `glossary.json` · 큐 창 팁 `modal-tips.json` · 빈 화면 문구 `empty-states.json` · 크루 한 장 안내 `crew-guide.md`)다.
고친 뒤 `node scripts/embed-help.js` 로 `index.html` 의 `#help-data` 에 다시 넣는다. 넣지 않았거나 "함께 보기"·글 id 가 끊기면 `npm test`(test/help.test.js)가 실패한다.

## 원문 큐시트 올리기 (에이전트용)

원문을 큐시트 JSON 으로 바꾼 뒤 `node scripts/upload.js <파일.json> [--project <id|제목> --edit-key <편집 비밀번호>] [--url <서버>] [--key <비밀번호>] [--dry-run]`.
덮어쓰기(`--project`)에는 그 프로젝트의 편집 비밀번호가 필요하다(`$CUE_EDIT_KEY` 도 됨). 새로 만들기에는 필요 없다.
검증에 실패하면 어느 행·필드가 틀렸는지 출력하고 올리지 않는다. 형식과 옵션은 [docs/cue-format.md](docs/cue-format.md).

## 에이전트로 고치기 (MCP)

Claude Code·Codex 에 이 사이트를 MCP 서버로 연결하면 "멘탈 씬 끝에 박대훈 퇴장 큐 넣어 줘" 처럼 말로 큐시트를 부분 수정할 수 있다.
수정은 모두 기록에 남아 되돌릴 수 있고, 누가 고쳤는지도 남는다.

연결은 사이트 메뉴의 **에이전트 연결** 에서 쓸 사람 이름으로 **토큰을 발급**하고, 나오는 명령을 복사해 붙여 넣으면 된다.
사람마다 토큰을 따로 쓰면 수정 기록에 그 이름이 남고, 그 토큰만 폐기할 수 있다(팀 비밀번호는 그대로).
토큰은 읽기 권한과 이름이고, 고치게 하려면 그 공연의 편집 비밀번호도 `X-Edit-Key` 로 넣는다(편집 잠금을 푼 상태에서 열면 같이 들어간다).

```sh
claude mcp add --transport http cue-sheet 'https://<사이트>/mcp' --header 'Authorization: Bearer cue_…' --header 'X-Edit-Key: <편집 비밀번호>'
```

Codex 설정, 도구 목록, 동시 편집 주의점은 [docs/mcp.md](docs/mcp.md).

## 데이터 구조

```
DATA_DIR/shows/<id>.json                 { rev, updatedAt, by, via, show[, restoredFrom] }   ← show = 앱의 큐시트 JSON (version 7). by·via = 그 버전을 저장한 사람·경로
DATA_DIR/shows/<id>/audio/<fileKey>       음원 원본
DATA_DIR/shows/<id>/audio/<fileKey>.json  { fileKey, name, mime, size }
DATA_DIR/shows/<id>/history/<rev>.json    덮어쓰기 직전 버전 (최근 HISTORY_KEEP 개, 되돌리기용). 예전 위치 shows/<id>.history/ 는 시작할 때 여기로 옮긴다
DATA_DIR/shows/<id>/auth.json             편집 비밀번호 scrypt 해시. 없으면 기본값 1234
DATA_DIR/trash/<id>-<삭제 ms>/             휴지통: meta.json { id, title, rev, deletedAt, ip }, show.json(=<id>.json), files/(=shows/<id>/ 통째)
DATA_DIR/tokens.json                      사람별 MCP 토큰 [{ id, name, hash, createdAt, lastUsedAt }] — 토큰 원문은 저장하지 않음(sha256)
```

쓰기는 임시 파일 → rename 으로 원자적이고, 한 프로세스 안에서 프로젝트별로 직렬화된다 — 같은 프로젝트는 한 줄로, 다른 프로젝트는 서로 기다리지 않는다(서버 인스턴스는 하나로 둔다). 프로젝트별 현재 rev 는 메모리에 두고, 폴링의 `If-None-Match` 가 같으면 파일을 읽지 않고 `304` 를 준다 — 그래서 서버 밖에서 `shows/*.json` 을 손으로 고치면 재시작해야 반영된다.

## API

모든 `/api/*` 응답은 JSON, `Cache-Control: no-store`. `APP_PASSWORD` 가 있으면 `X-App-Key` 헤더(URL 인코딩한 비밀번호),
`Authorization: Bearer <비밀번호>` 또는 `?key=` 쿼리가 필요하고, 틀리면 `401 {"error":"unauthorized"}`. 오류는 `{ "error": "<code>" }`.

**편집**이라고 적힌 요청은 그 프로젝트의 편집 비밀번호를 `X-Edit-Key` 헤더(URL 인코딩)로 보내야 한다. 없거나 틀리면
`403 {"error":"edit_forbidden"}`. 같은 IP·프로젝트에서 1분에 10번 틀리면 그 창이 끝날 때까지 `429 {"error":"too_many_attempts", retryAfter}`
(+ `Retry-After`) — 막힌 동안은 맞는 비밀번호도 거절한다. 사이트 비밀번호 확인(401)이 먼저, 프로젝트 존재(404)가 그다음, 편집(403)이 마지막.

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/health` | `{ ok, hasPassword, showCount, schema }` — 인증 없음. `schema` = 서버가 아는 큐시트 형식(`lib/validate.js` `SHOW_VER`). 열어 둔 화면은 이것이 자기보다 높으면 저장을 멈추고 새로고침을 요구한다 |
| GET | `/api/shows` | `[{ id, title, rev, updatedAt, sceneCount, cueCount, editDefault }]` (최근 수정 순). `editDefault` = 아직 편집 비밀번호 1234 |
| POST | `/api/shows` | body `{ show }` → `201 { id, rev: 1, updatedAt }` |
| GET | `/api/shows/:id` | `{ rev, updatedAt, by?, via?, show }` + `ETag: "rev"`. `If-None-Match` 가 같으면 `304`. 없으면 `404` |
| PUT | `/api/shows/:id` | **편집**. body `{ baseRev, show }` (≤5MB) → `{ rev, updatedAt }`. `baseRev` 가 현재 rev 와 다르면 `409 { error:'conflict', rev, updatedAt, show }`. `show.version` 이 저장본보다 낮으면(업데이트 전에 열어 둔 옛 화면) baseRev 와 상관없이 `426 { error:'client_outdated', version, schema, message }` — 저장하지 않는다. 직전 레코드는 기록으로(10분에 한 번) |
| DELETE | `/api/shows/:id` | **편집**. `{ ok: true, trashId, trashDays }` — 레코드와 `shows/<id>/`(음원·기록·비밀번호)를 그대로 휴지통으로 옮긴다 |
| GET | `/api/trash` | `{ days, items: [{ trashId, id, title, rev, deletedAt, expiresAt, daysLeft }] }` 최근 삭제 먼저. 보기 권한 (삭제 IP 는 `meta.json` 에만) |
| POST | `/api/trash/:trashId/restore` | 보기 권한. `{ id, originalId, title }` — 같은 id 가 이미 있으면 새 `id`. 없는 항목이면 `404` |
| POST | `/api/shows/:id/duplicate` | `201 { id, rev: 1, updatedAt }` — 제목 뒤 "(복제)", 음원 파일도 복사. 히스토리·편집 비밀번호는 복사하지 않음(복제본은 1234) |
| POST | `/api/shows/:id/edit-check` | **편집**. 키 확인 → `{ ok: true, isDefault }` |
| POST | `/api/shows/:id/edit-password` | body `{ current, next }` (`current` 는 `X-Edit-Key` 로 줘도 됨) → `{ ok: true, isDefault }`. `next` 4~200자, 아니면 `400 bad_password`. `next` 가 `1234` 면 기본 상태로 되돌림. rev 는 그대로 |
| POST | `/api/shows/:id/edit-password/reset` | **관리자**. 헤더 `X-Admin-Key`(URL 인코딩 가능) → `{ ok: true, isDefault: true }`. `ADMIN_KEY` 미설정이면 `404`, 틀리면 `403 admin_forbidden`, IP 당 1분 10회 실패 시 `429` |
| GET | `/api/shows/:id/history` | `[{ rev, updatedAt, by, via, title, sceneCount, cueCount, current, restoredFrom }]` 최신순, 맨 앞이 현재 버전(`current: true`) |
| GET | `/api/shows/:id/history/:rev` | **편집**. `{ rev, updatedAt, show }`. 없으면 `404` |
| POST | `/api/shows/:id/restore` | **편집**. body `{ rev, baseRev? }` → `{ rev, updatedAt, restoredFrom, warnings }` — 그 버전의 show 를 새 rev 로 저장. 이미 같은 내용이면 `{ unchanged: true, rev }`. 지워진 음원을 가리키는 트랙은 연결을 비우고 `warnings` 로 알림. `baseRev` 가 다르면 `409`, 없는 rev 면 `404 rev_not_found` |
| GET | `/api/shows/:id/audio` | `[{ fileKey, name, size, mime }]` |
| DELETE | `/api/shows/:id/audio` | **편집**. `{ ok: true }` — 그 프로젝트의 음원 전부 삭제 |
| PUT | `/api/shows/:id/audio/:fileKey` | **편집**. raw body(`audio/*` 또는 `application/octet-stream`, `X-File-Name` 은 URL 인코딩, ≤100MB) → `{ fileKey, size, name }` |
| GET | `/api/shows/:id/audio/:fileKey` | 파일. `Range` 지원(`206`, `Accept-Ranges: bytes`), `?download=1` 이면 attachment |
| DELETE | `/api/shows/:id/audio/:fileKey` | **편집**. `{ ok: true }` |
| GET | `/api/tokens` | `[{ id, name, createdAt, lastUsedAt }]` 사람별 MCP 토큰(해시 없음). **사이트 비밀번호만**(토큰으로는 `401`). `APP_PASSWORD` 가 없으면 `404 tokens_disabled` |
| POST | `/api/tokens` | `ADMIN_KEY` 가 있으면 `X-Admin-Key` 도(없거나 틀리면 `403 admin_forbidden`, 실패 제한 `429`). body `{ name }`(앞뒤 공백 제거, 1~40자, 대소문자 무시 중복 불가) → `201 { token, id, name, createdAt }` — `token`(`cue_…`) 원문은 이 응답에만. 이름 오류 `400 bad_name`, 중복 `409 name_taken`(둘 다 `message`) |
| DELETE | `/api/tokens/:id` | `ADMIN_KEY` 가 있으면 `X-Admin-Key` 도. `{ ok: true }` — 그 토큰은 바로 `401`. 없으면 `404` |
| POST | `/mcp` | MCP Streamable HTTP (상태 없음, JSON-RPC). 사이트 비밀번호(위의 세 방식) 또는 사람별 토큰(`Authorization: Bearer cue_…` 만). 도구 6개 — [docs/mcp.md](docs/mcp.md). 쓰기 도구(`edit_show`·`restore_revision`)는 토큰으로 붙어도 그 프로젝트의 편집 비밀번호(`X-Edit-Key` 헤더 또는 도구 인자 `editKey`). GET·DELETE 는 `405` |

검증: `:id` 는 `[A-Za-z0-9_-]{1,32}`(서버가 생성), `:fileKey` 는 `[A-Za-z0-9_-]{1,64}` — 아니면 `400`.
`show` 는 `parts` 배열과 숫자 `version` 이 있어야 하고 parts·scenes·items·cues 가 객체 배열이어야 한다(`400 invalid_show`, `message` 에 경로). 필드 단위 엄격 검증은 업로드 스크립트가 한다(`lib/validate.js`). 본문 초과는 `413 too_large`.

그 밖에 `/`(index.html), `/healthz`(text `ok`)는 인증 없이 열린다.
