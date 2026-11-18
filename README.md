# cue-sheet

공연 큐시트 웹앱. 프런트는 단일 파일(`index.html`), 서버는 Node 20(`server.js` + `lib/store.js`). npm 의존성은
`/mcp` 가 쓰는 공식 MCP SDK 뿐이고(`npm install` 필요), 없으면 `/mcp` 만 꺼지고 나머지는 그대로 돈다.

- **서버 모드**(기본): 여러 기기(연출 노트북, 조명/음향 오퍼 노트북, 무대보조 폰)가 같은 큐시트를 보고 고친다.
  공연 하나 = 프로젝트 하나. 음원 파일도 서버에 올라가 모든 기기에서 재생된다. 5초마다 다른 기기의 변경을 가져오고,
  겹치면 "다른 기기에서 수정됨 — 서버 버전 불러오기 / 내 버전으로 덮어쓰기" 안내가 뜬다.
- **로컬 모드**: `/api/health` 에 닿지 못하면(claude.ai 아티팩트, `file://`, 정적 호스팅) 자동 전환. 지금까지처럼 이 브라우저
  (localStorage + IndexedDB)에만 저장하고, 프로젝트는 하나만 쓴다. 상단에 "로컬 모드 — 이 브라우저에만 저장" 표시.

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
| `APP_PASSWORD` | (없음) | 설정하면 `/api/*`·`/mcp` 에 팀 공유 비밀번호 필요. 없으면 인증 없음(로컬 개발용) |

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
4. 변수를 저장하면 재배포된다. 서비스 → Settings → Networking → **Generate Domain** 으로 주소를 만든다.
5. 처음 접속하면 비밀번호 → "첫 프로젝트 만들기"(빈 프로젝트 / 샘플로 시작). 이후 기기들은 같은 주소로 들어와 프로젝트를 고른다.

비밀번호를 바꾸려면 `APP_PASSWORD` 만 바꾸면 된다. 열려 있던 기기는 다음 요청에서 401 을 받고 비밀번호를 다시 묻는다.

## 원문 큐시트 올리기 (에이전트용)

원문을 큐시트 JSON 으로 바꾼 뒤 `node scripts/upload.js <파일.json> [--project <id|제목>] [--url <서버>] [--key <비밀번호>] [--dry-run]`.
검증에 실패하면 어느 행·필드가 틀렸는지 출력하고 올리지 않는다. 형식과 옵션은 [docs/cue-format.md](docs/cue-format.md).

## 에이전트로 고치기 (MCP)

Claude Code·Codex 에 이 사이트를 MCP 서버로 연결하면 "멘탈 씬 끝에 박대훈 퇴장 큐 넣어 줘" 처럼 말로 큐시트를 부분 수정할 수 있다.
수정은 모두 기록에 남아 되돌릴 수 있다. 연결:

```sh
claude mcp add --transport http cue-sheet 'https://<사이트>/mcp' --header 'Authorization: Bearer <비밀번호>'
```

사이트 메뉴의 **에이전트 연결** 에서 이 사이트 주소·비밀번호가 들어간 명령을 그대로 복사할 수도 있다(비밀번호의 특수 문자도 알맞게 감싼다).

Codex 설정, 도구 목록, 동시 편집 주의점은 [docs/mcp.md](docs/mcp.md).

## 데이터 구조

```
DATA_DIR/shows/<id>.json                 { rev, updatedAt, show }   ← show = 앱의 큐시트 JSON (version 5)
DATA_DIR/shows/<id>/audio/<fileKey>       음원 원본
DATA_DIR/shows/<id>/audio/<fileKey>.json  { fileKey, name, mime, size }
DATA_DIR/shows/<id>.history/<rev>.json    덮어쓰기 직전 버전 (최근 30개, 되돌리기용 — docs/mcp.md)
```

쓰기는 임시 파일 → rename 으로 원자적이고, 한 프로세스 안에서 직렬화된다(서버 인스턴스는 하나로 둔다).

## API

모든 `/api/*` 응답은 JSON, `Cache-Control: no-store`. `APP_PASSWORD` 가 있으면 `X-App-Key` 헤더(URL 인코딩한 비밀번호),
`Authorization: Bearer <비밀번호>` 또는 `?key=` 쿼리가 필요하고, 틀리면 `401 {"error":"unauthorized"}`. 오류는 `{ "error": "<code>" }`.

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/health` | `{ ok, hasPassword, showCount }` — 인증 없음 |
| GET | `/api/shows` | `[{ id, title, rev, updatedAt, sceneCount, cueCount }]` (최근 수정 순) |
| POST | `/api/shows` | body `{ show }` → `201 { id, rev: 1, updatedAt }` |
| GET | `/api/shows/:id` | `{ rev, updatedAt, show }` + `ETag: "rev"`. `If-None-Match` 가 같으면 `304`. 없으면 `404` |
| PUT | `/api/shows/:id` | body `{ baseRev, show }` (≤5MB) → `{ rev, updatedAt }`. `baseRev` 가 현재 rev 와 다르면 `409 { error:'conflict', rev, updatedAt, show }` |
| DELETE | `/api/shows/:id` | `{ ok: true }` — 음원 폴더까지 삭제, 복구 불가 |
| POST | `/api/shows/:id/duplicate` | `201 { id, rev: 1, updatedAt }` — 제목 뒤 "(복제)", 음원 파일도 복사 |
| GET | `/api/shows/:id/audio` | `[{ fileKey, name, size, mime }]` |
| DELETE | `/api/shows/:id/audio` | `{ ok: true }` — 그 프로젝트의 음원 전부 삭제 |
| PUT | `/api/shows/:id/audio/:fileKey` | raw body(`audio/*` 또는 `application/octet-stream`, `X-File-Name` 은 URL 인코딩, ≤100MB) → `{ fileKey, size, name }` |
| GET | `/api/shows/:id/audio/:fileKey` | 파일. `Range` 지원(`206`, `Accept-Ranges: bytes`), `?download=1` 이면 attachment |
| DELETE | `/api/shows/:id/audio/:fileKey` | `{ ok: true }` |
| POST | `/mcp` | MCP Streamable HTTP (상태 없음, JSON-RPC). 인증은 위와 같음(보통 `Authorization: Bearer`). 도구 6개 — [docs/mcp.md](docs/mcp.md). GET·DELETE 는 `405` |

검증: `:id` 는 `[A-Za-z0-9_-]{1,32}`(서버가 생성), `:fileKey` 는 `[A-Za-z0-9_-]{1,64}` — 아니면 `400`.
`show` 는 `parts` 배열과 숫자 `version` 이 있어야 하고 parts·scenes·items·cues 가 객체 배열이어야 한다(`400 invalid_show`, `message` 에 경로). 필드 단위 엄격 검증은 업로드 스크립트가 한다(`lib/validate.js`). 본문 초과는 `413 too_large`.

그 밖에 `/`(index.html), `/healthz`(text `ok`)는 인증 없이 열린다.
