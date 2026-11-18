# 큐시트 JSON 형식 (show v7)과 업로드

원문 큐시트(대본 + 조명·음향·무대·출연 큐)를 이 JSON 으로 바꿔 `scripts/upload.js` 로 올린다.
사이트의 "내보내기"가 만드는 JSON 과 같은 형식이다. `version` 5·6 파일도 그대로 읽힌다(경고 없음). 새로 만들 땐 7 을 쓴다. 기준 구현은 `index.html` 의 `migrate()`, 검증은 `lib/validate.js`.

## 형식 버전

필드를 더하면 `version` 을 올린다. 서버가 저장 요청의 버전을 비교해, 새 필드를 모르는 옛 화면이 그 필드를 떨어뜨린 채 저장하는 것을 막기 위해서다.

| version | 바뀐 것 |
|---|---|
| 5 | 코멘트 해결자·해결 시각(`resolvedBy`·`resolvedAt`) |
| 6 | 소품: `props[]`, `preShowProps[]`, 무대 큐 `stage.props[]` |
| 7 | 문단 코멘트의 선택 필드 `snapshot`(코멘트 당시 문단). 없으면 6 과 같은 모양 — 6 → 7 은 `version` 만 바뀐다 |

## 올리기

```sh
node scripts/upload.js cues/show.json --dry-run                 # 검증만
node scripts/upload.js cues/show.json                           # 새 프로젝트로 → id·주소 출력
node scripts/upload.js cues/show.json --project <id|제목> --edit-key <편집 비밀번호>   # 그 프로젝트를 덮어쓰기 (없으면 --create 로 그 제목으로 생성)
```

- 서버: `--url https://…` 또는 `$CUE_URL`. 기본 `http://localhost:$PORT`(3000).
- 비밀번호(서버의 `APP_PASSWORD`): `--key …` 또는 `$CUE_KEY`.
- 편집 비밀번호(프로젝트마다 따로, 사이트에서 바꿈): `--edit-key …` 또는 `$CUE_EDIT_KEY`. **`--project` 로 덮어쓸 때만** 필요하고
  새로 만들 때는 필요 없다. 스크립트는 기본값(1234)을 대신 넣어 보지 않는다 — 아직 기본 비밀번호인 프로젝트도 `--edit-key 1234` 를
  명시해야 하고, 그때 "기본 비밀번호" 경고가 나온다. 틀리면 백업·업로드 전에 멈춘다(종료 코드 2). `--dry-run` 은 키 없이도 되지만
  키를 주면 맞는지 확인한다. 1분에 10번 넘게 틀리면 잠시 막힌다(429).
- `--json`: 결과를 stdout 에 JSON 한 줄로 `{ ok, action, id, rev, url, title, errors, warnings }` (실패 시 `{ ok:false, error }`).
- 종료 코드: `0` 성공 · `1` 데이터 오류(서버에 아무것도 보내지 않음) · `2` 사용법·연결·인증·서버 오류.
- 출력된 `열기:` 주소(`/?show=<id>`)로 그 프로젝트가 바로 열린다.
- 덮어쓰기 때: 서버의 이전 버전을 임시 폴더(`$TMPDIR/cue-sheet-backup-…json`)에 남기고, 사이트에서 올린 음원 연결
  (`tracks[].fileKey`)은 같은 `no` 트랙에서 이어받는다. 그 사이 사이트에서 저장되면(409) 다시 실행하면 된다.
  서버도 저장할 때마다 이전 버전을 보관하므로 사이트의 "버전 기록"에서 되돌릴 수 있다.
- 파일 최상위는 show 객체 그대로, 또는 `{ "show": {…} }` 둘 다 된다. `id` 는 빼도 된다(위치 기반으로 자동 부여).

검증 결과는 `오류 <경로>: <이유> [파트 › 씬 › #문단]` 형식이다. **오류**는 사이트가 불러올 때 뜻이 바뀌거나 사라지는 값이라
업로드를 막는다. **경고**는 사이트가 알아서 채우거나 고치는 값(숫자 문자열, 빠진 id, 모르는 필드 등)이라 올라간다.

## 구조

```
show
├─ title, version: 7, preShowSetup, revision
├─ people[]  { id, name, role, note }
├─ props[]   { id, name, note }                            ← 소품 목록 (v6)
├─ preShowProps[]  { propId, at }                          ← 공연 시작 때 무대에 있는 소품 (v6)
├─ tracks[]  { id, no, title, durationSec, fileName, fileKey, note, loop }
└─ parts[]   { id, name, scenes[] }                       ← 1부, 2부 …
   └─ scenes[] { id, type, title, cast[], durationSec, setup, comments[], items[] }
      └─ items[] { id, kind, speaker, text, label, isCue, cues[], comments[] }   ← 대본 한 문단
         └─ cues[] { id, dept, trigger, offsetSec, memo, status, <dept>: {…} }
```

빈 값은 `null`(숫자·참조) 또는 `""`(문자열). 표에 없는 필드는 불러올 때 버려진다(경고).

### show

| 필드 | 타입 | 뜻 |
|---|---|---|
| `title` | string | 공연(프로젝트) 제목 |
| `version` | number | **필수**, `7` (`5`·`6` 도 읽힘) |
| `preShowSetup` | string | 공연 전 무대 세팅 (런 보기 첫 화면) |
| `revision` | string | 판 표시, 40자까지 |
| `people` / `props` / `preShowProps` / `tracks` / `parts` | array | 아래. `parts` 는 **필수** |

### people[] — 출연자·스태프

| 필드 | 타입 | 뜻 |
|---|---|---|
| `id` | string | 다른 곳에서 이 사람을 가리키는 값. **화자·출연자·출연 큐는 이름이 아니라 이 id 를 쓴다** |
| `name` | string | 표시 이름 |
| `role` | `performer` `mc` `light` `sound` `stage` `other` | 기본 `other` |
| `note` | string | 메모 (예: "MC 겸 공연자") |

### props[] — 소품 (v6)

사람(`people`)과 같은 방식의 목록. 무대 큐와 `preShowProps` 는 소품 이름이 아니라 이 `id` 로 가리킨다.

| 필드 | 타입 | 뜻 |
|---|---|---|
| `id` | string | 소품을 가리키는 값 (예: `"pr-tophat"`) |
| `name` | string | 표시 이름 |
| `note` | string | 메모 |

### preShowProps[] — 공연 전 무대 소품 (v6)

공연이 시작할 때 이미 무대에 있는 소품. 항상 "들어와 있음"으로 보므로 `action` 은 없다.

| 필드 | 타입 | 뜻 |
|---|---|---|
| `propId` | string | `props[].id`. 목록에 없으면 경고(지우지 않고 "삭제된 소품"으로 남는다) |
| `at` | string | 놓인 위치 ("무대 오른쪽 테이블 위"). 빈 값 `""` 가능 |

### tracks[] — 음원(BGM)

| 필드 | 타입 | 뜻 |
|---|---|---|
| `no` | number | 트랙 번호. 음향 큐의 `sound.track` 이 이 값을 가리킨다. 겹치면 오류 |
| `title` | string | 곡 이름 |
| `loop` | boolean | 반복 재생 (하우스 음악 등) |
| `durationSec`, `note` | number\|null, string | 길이(초), 메모 |
| `fileName`, `fileKey` | null | 사이트에서 파일을 올리면 채워진다. **변환 시 `null`** |

### parts[] / scenes[]

| 필드 | 타입 | 뜻 |
|---|---|---|
| part `name` | string | "1부" |
| scene `type` | `mc` \| `act` | `mc` = 진행·멘트·전환 구간, `act` = 마술 액트 |
| scene `title` | string | 액트 이름 (mc 구간은 보통 `""`) |
| scene `cast` | string[] | 이 씬에 나오는 사람 `people[].id` |
| scene `durationSec` | number\|null | 예상 길이(초) |
| scene `setup` | string | 씬 시작 전 무대 세팅 |

### items[] — 대본 문단

| 필드 | 타입 | 뜻 |
|---|---|---|
| `kind` | `line` \| `action` | `line` = 대사, `action` = 지문·동작 |
| `speaker` | string\|null | 대사의 화자 `people[].id`. `action` 은 `null` |
| `text` | string | 대사 본문(화자 이름 빼고) 또는 지문. **지문은 항상 `(…)` 괄호 한 쌍** — `"(암전)"`, `"(액트 도중 조예준 인)"`. 표기는 아래 "표기 규칙" |
| `label` | string\|null | 큐 번호. **보통 `null`** — 사이트가 큐 붙은 문단에 순서대로 매긴다 |
| `isCue` | boolean | 큐 유무. 생략 가능(큐가 있으면 자동 true) |
| `cues` | array | 이 문단 시점에 나가는 큐들 |

### cues[] — 공통

| 필드 | 타입 | 뜻 |
|---|---|---|
| `dept` | `cast` `light` `sound` `stage` | **필수**. 같은 이름의 객체 하나가 내용 |
| `trigger` | string | 언제 — "암전 후", "'소개합니다 박대훈' 후", "예준 스냅 주면" |
| `offsetSec` | number\|null | trigger 뒤 지연(초). "암전 7초 후" → `trigger:"암전 후", offsetSec:7` |
| `memo` | string | 메모 |
| `status` | `set` \| `tbd` | 원문이 "미정"이면 `tbd`. 기본 `set` |

| dept | 내용 객체 |
|---|---|
| `light` | `{ channels: [{ ch, action, dim, color, colorName, timeSec }], anim }` — `ch`: `back` `top` `front` `house`(객석). `action`: `on` `off` `fadeIn` `fadeOut` `anim`. `dim` 0–100(%)·null, `color` `"#rrggbb"`·null, `colorName` 색 이름·null, `timeSec` 페이드 초·null. 암전 = 네 채널 모두 `off`. 상세 미정이면 `channels: []` + `status:"tbd"` |
| `sound` | `{ track, action, timeSec, level }` — `track` = `tracks[].no`. `action`: `play` `fadeIn` `fadeOut` `stop` `volume`. `timeSec` 페이드/변화 초·null, `level` 0–100·null |
| `stage` | `{ text, props: [{ propId, action, at }] }` — 무대 작업. `text` 는 글로 적는 작업("탑햇테이블에 탑햇 세팅"), `props` 는 소품이 들어오고 나가는 동작: `propId` = `props[].id`, `action`: `in` `out` `move` (그 밖은 오류), `at` 위치·메모(`""` 가능). **`text` 와 `props` 중 하나는 있어야 한다**(둘 다 비면 경고). `props` 가 없으면 `[]` 로 채워진다. 모르는 `propId` 는 경고 |
| `cast` | `{ personId, move, text }` — `personId` = `people[].id`, `move`: `in` `out` `move`, `text` 보충 |

## 표기 규칙

원문마다 지문이 `* …`, `(…)`, `— …` 로 섞여 있어 하나로 통일한다. 사이트 편집기는 `*`·`—` 시작도 받지만 업로드 검증이 **경고**한다.

1. **대사** — `kind:"line"`, `speaker` 는 사람 id, `text` 는 말하는 내용. 말하는 방식이나 동작은 대사 안에 괄호로 넣는다 (위치 자유: 앞·중간·끝).
   - 좋음: `"(한숨 쉬며) 에휴 나가계세요"`, `"…그런 건 아닙니다….(째려보며)"`, `"…고통이에요 (계속 주절주절)"`
   - 나쁨: 말하는 방식을 따로 지문 문단으로 쪼개기
2. **지문** — `kind:"action"`. 묘사·진행·연출 의도·기획 설명·인/아웃 표기 모두 여기. `text` 는 항상 `(` 로 시작해 `)` 로 끝나는 괄호 **한 쌍**. 괄호 안에 괄호를 또 넣지 말고 보충 설명은 ` — ` 로 잇는다. `*`·`—` 로 시작하는 지문은 쓰지 않는다.
   - 좋음: `"(조예준 인 — 고개 절레절레)"`
   - 나쁨: `"* 액트 도중 조예준 인"`, `"— 암전"`, `"(조예준 인 (고개 절레절레))"`
3. **큐** — 조명·음향·무대팀·출연자 인/아웃처럼 스태프나 출연자가 **실제로 실행해야 하는 일**만 큐로 만든다. 문단 text 가 아니라 그 문단의 `cues[]` 로 표현한다. 큐 시점이 대사면 그 대사 문단에, 아니면 그 순간을 설명하는 지문에 단다. 묘사에서 큐를 억지로 끌어내지 않는다.
   - 좋음: 지문 `"(3명이 관객석으로 간다)"` 에 무대팀 `stage` 큐 "테이블 교체" 하나만 단다
   - 나쁨: 같은 지문에서 이동 자체를 `cast` 큐로 만들기

검증은 지문(`action`) 문단만 본다 — `(` 로 시작하지 않거나 `)` 로 끝나지 않으면, 괄호 안에 괄호가 또 있으면 경고. 대사(`line`) 안의 괄호는 검사하지 않는다.

## 변환 요령

- 원문의 글머리표(`*`)는 괄호 지문으로 바꾼다 (`* 액트 도중 조예준 인` → `(액트 도중 조예준 인)`).
- 원문의 지문 한 줄 = `action` 문단 하나, 대사 한 줄 = `line` 문단 하나. 큐는 그 큐가 나가는 시점의 문단 `cues` 에 단다.
  큐만 있고 대본이 없는 지점(예: "하우스 오픈")은 지문 문단 `"(하우스 오픈 — 하우스 음악 시작)"` 을 만들어 거기에 단다.
- 액트 본편처럼 대본이 없는 씬은 `items: []` 로 둬도 된다.
- 등장하는 사람은 모두 `people` 에 넣고 id 를 정한다(예: `"p-yejun"`). 음향 큐가 쓰는 트랙 번호는 모두 `tracks` 에 넣는다.
- 원문에 없는 값은 지어내지 말고 `null` / `""` / `status:"tbd"` + `memo` 로 남긴다.
- comments(`{ author, text, createdAt(ISO), resolved }`)는 원문의 확인 요청·메모를 남길 때만 쓴다.
  앱은 문단 코멘트에 선택 필드 `snapshot`(`{ kind, speaker, text, cues[] }`, 코멘트를 달 당시 그 문단)을 함께 저장해 "코멘트 당시로 되돌리기"에 쓴다. 업로드할 때는 넣지 않는다 — 없으면 위치 이동만 된다.

## 최소 예시

```json
{
  "title": "1부 (초안)",
  "version": 7,
  "preShowSetup": "탑햇테이블",
  "people": [
    { "id": "p-yejun", "name": "조예준", "role": "mc", "note": "MC 겸 공연자" },
    { "id": "p-daehoon", "name": "박대훈", "role": "performer", "note": "" }
  ],
  "props": [
    { "id": "pr-tophat", "name": "탑햇", "note": "" },
    { "id": "pr-table", "name": "탑햇테이블", "note": "" }
  ],
  "preShowProps": [
    { "propId": "pr-table", "at": "무대 중앙" }
  ],
  "tracks": [
    { "id": "tr-1", "no": 1, "title": "하우스 음악", "durationSec": null, "fileName": null, "fileKey": null, "note": "", "loop": true }
  ],
  "parts": [{
    "id": "pt-1", "name": "1부",
    "scenes": [
      { "id": "s-1", "type": "mc", "title": "", "cast": ["p-yejun"], "durationSec": null, "setup": "", "comments": [],
        "items": [
          { "id": "i-1", "kind": "action", "speaker": null, "text": "(암전)", "label": null, "comments": [],
            "cues": [
              { "id": "q-1", "dept": "light", "trigger": "하우스 페이드 아웃 후", "offsetSec": null, "memo": "", "status": "set",
                "light": { "channels": [
                  { "ch": "back", "action": "off", "dim": null, "color": null, "colorName": null, "timeSec": null },
                  { "ch": "top", "action": "off", "dim": null, "color": null, "colorName": null, "timeSec": null },
                  { "ch": "front", "action": "off", "dim": null, "color": null, "colorName": null, "timeSec": null },
                  { "ch": "house", "action": "off", "dim": null, "color": null, "colorName": null, "timeSec": null }
                ], "anim": "" } },
              { "id": "q-2", "dept": "sound", "trigger": "암전 후", "offsetSec": 7, "memo": "", "status": "set",
                "sound": { "track": 1, "action": "fadeOut", "timeSec": 3, "level": null } }
            ] },
          { "id": "i-2", "kind": "line", "speaker": "p-yejun", "text": "소개합니다 박대훈", "label": null, "comments": [],
            "cues": [
              { "id": "q-3", "dept": "cast", "trigger": "멘트 후", "offsetSec": null, "memo": "", "status": "set",
                "cast": { "personId": "p-daehoon", "move": "in", "text": "" } },
              { "id": "q-4", "dept": "stage", "trigger": "이 대사 즈음", "offsetSec": null, "memo": "시점 리허설 때 확정", "status": "tbd",
                "stage": { "text": "탑햇테이블에 탑햇 세팅", "props": [{ "propId": "pr-tophat", "action": "in", "at": "테이블 위" }] } }
            ] }
        ] },
      { "id": "s-2", "type": "act", "title": "멘탈", "cast": ["p-daehoon"], "durationSec": 180, "setup": "", "comments": [], "items": [] }
    ]
  }]
}
```
