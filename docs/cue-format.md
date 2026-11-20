# 큐시트 JSON 형식 (show v13)과 업로드

원문 큐시트(대본 + 조명·음향·무대·출연 큐)를 이 JSON 으로 바꿔 `scripts/upload.js` 로 올린다.
사이트의 "내보내기"가 만드는 JSON 과 같은 형식이다. `version` 5·6·7·8·9·10·11·12 파일도 그대로 읽힌다(옛 필드는 불러올 때 v13 모양으로 옮겨진다). 새로 만들 땐 13 을 쓴다. 기준 구현은 `index.html` 의 `migrate()`, 검증은 `lib/validate.js`.

## 형식 버전

필드를 더하거나 필드의 뜻을 바꾸면 `version` 을 올린다. 서버가 저장 요청의 버전을 비교해, 새 필드를 모르는 옛 화면이 그 필드를 떨어뜨린 채 저장하는 것을 막기 위해서다.

| version | 바뀐 것 |
|---|---|
| 5 | 코멘트 해결자·해결 시각(`resolvedBy`·`resolvedAt`) |
| 6 | 소품: `props[]`, `preShowProps[]`, 무대 큐 `stage.props[]` |
| 7 | 문단 코멘트의 선택 필드 `snapshot`(코멘트 당시 문단). 없으면 6 과 같은 모양 — 6 → 7 은 `version` 만 바뀐다 |
| 8 | 큐 상세 `note` 하나(모든 부서). `memo`·`cast.text`·`stage.text` 는 없어지고 `note` 로 합쳐진다. 무대 큐는 소품 필수(`stage.props`), 소품 액션 `clean` 추가. 객석(`house`) 채널은 `on`/`off` 만. 머리글(대상 + 액션)은 사이트가 만든다 — 아래 "큐 머리글" |
| 9 | 음향 `play` 큐의 `sound.level` = 시작 볼륨(그 볼륨으로 바로 재생, 예: 하우스 오픈 BGM 50). 모양은 8 과 같다 — 8 → 9 는 `version` 만 바뀐다. 8 화면은 `play` 의 `level` 을 저장할 때 지우므로 올려서 옛 화면의 저장을 막는다 |
| 10 | 출연 큐 하나에 여러 사람: `cast` = `{ people: [{ personId, move }] }`(사람마다 IN/OUT/MOVE, 순서 = 머리글 순서). 9 까지의 `{ personId, move }` 는 불러올 때 한 줄짜리 `people` 로 옮겨진다(사람이 비어 있어도 줄은 남김). 9 화면은 `people` 을 몰라 저장하면 사람을 잃으므로 올린다 |
| 11 | 이름 붙인 조명: `lights[]` `{ id, name, note }`(리허설에서 정해 이름을 붙인 조명 — `note` 에 상세 설명) + 조명 큐 `light.looks[]` `{ lookId, action: on\|off }`. 조명 큐는 이제 이름 붙인 조명을 켜고 끄는 것이 기본이고, 채널(`light.channels`)은 "상세(채널)" 로 그대로 쓴다 — 한 큐에 둘 다 있어도 된다. 10 → 11 은 `lights: []`·`looks: []` 만 붙고 채널 큐는 바꾸지 않는다. 10 화면은 `looks` 를 몰라 저장하면 지우므로 올린다 |
| 12 | 트리거: 대본 흐름(`items[]`)에는 **대사**(`line`·`action`)와 **큐**(`kind:"cue"`)만 있다. 큐는 그 자체로 한 항목이고 트리거 하나(`trigger` — 대사의 끝·시작 / 다른 큐 후·함께 / 신호)와 `offsetSec`, 부서 동작 `cues[]` 를 갖는다. 부서 큐(동작)에는 `trigger`·`offsetSec` 이 없고, 대사·지문에는 큐가 붙지 않는다(`cues: []`). 11 까지의 "문단에 붙은 큐" 는 불러올 때 그 문단 바로 뒤의 큐로 옮겨진다(아래 "v11 → v12 변환"). 11 화면은 이 모양을 몰라 저장하면 큐를 잃으므로 올린다 |
| 13 | 조명 룩의 배치: `lights[].rig`(선택) `[{ pos, count, color, side? }]` — 사이트가 룩 이름에 올리거나 누르면 위에서 본 무대 그림으로 보여 준다(아래 "lights[]"). 없으면 12 와 같다 — 12 → 13 은 `version` 만 바뀐다. 12 화면은 `rig` 를 몰라 저장하면 지우므로 올린다 |

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
├─ title, version: 13, preShowSetup, revision
├─ people[]  { id, name, role, note }
├─ props[]   { id, name, note }                            ← 소품 목록 (v6)
├─ preShowProps[]  { propId, at }                          ← 공연 시작 때 무대에 있는 소품 (v6)
├─ lights[]  { id, name, note, rig? }                      ← 이름 붙인 조명 목록 (v11, rig 배치 v13)
├─ tracks[]  { id, no, title, durationSec, fileName, fileKey, note, loop }
└─ parts[]   { id, name, scenes[] }                       ← 1부, 2부 …
   └─ scenes[] { id, type, title, cast[], durationSec, setup, comments[], items[] }
      └─ items[]                                           ← 대본 흐름: 대사와 큐가 순서대로
         ├─ 대사  { id, kind: line|action, speaker, text, label: null, isCue: false, cues: [], comments[] }
         └─ 큐    { id, kind: cue, speaker: null, text: "", label, isCue: true, trigger, offsetSec, cues[], comments[] }
                    └─ cues[] { id, dept, note, status, <dept>: {…} }   ← 부서 동작 (출연·조명·음향·무대)
```

빈 값은 `null`(숫자·참조) 또는 `""`(문자열). 표에 없는 필드는 불러올 때 버려진다(경고).

### show

| 필드 | 타입 | 뜻 |
|---|---|---|
| `title` | string | 공연(프로젝트) 제목 |
| `version` | number | **필수**, `11` (`5`·`6`·`7`·`8`·`9`·`10` 도 읽힘) |
| `preShowSetup` | string | 공연 전 무대 세팅 (런 보기 첫 화면) |
| `revision` | string | 판 표시, 40자까지 |
| `people` / `props` / `preShowProps` / `lights` / `tracks` / `parts` | array | 아래. `parts` 는 **필수** |

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

### lights[] — 이름 붙인 조명 (v11)

리허설에서 정해 이름을 붙인 조명(룩) 목록. 공연 중 조명 큐는 대개 이 조명을 켜고 끄기만 한다. 조명 큐 `light.looks` 는 이름이 아니라 이 `id` 로 가리킨다.
사이트에서는 "소품·조명" 탭의 조명 구간에서 이름·설명·순서를 고치고, 조명 큐 편집 창에서 이름을 적어 바로 등록할 수도 있다.

| 필드 | 타입 | 뜻 |
|---|---|---|
| `id` | string | 조명을 가리키는 값 (예: `"lk-stage-a"`) |
| `name` | string | 조명팀이 부르는 이름 ("무대 A", "엔딩 블루", "핀") — 머리글에 그대로 쓰인다 |
| `note` | string | 상세 설명 ("프론트 70 + 탑 블루, 리허설 11/12 확정"). 채널·밝기·색·페이드는 여기에 |
| `rig` | array | (선택, v13) 배치 — 이 룩에서 켜지는 조명기의 위치·개수·색. 없거나 `[]` 이면 그림 없이 지금처럼 이름·설명만 |

`rig[]` 한 줄 = 같은 위치·색인 조명기 묶음:

| 필드 | 타입 | 뜻 |
|---|---|---|
| `pos` | `"back"` \| `"top"` \| `"front"` | 위치 — 백(무대 안쪽), 탑(머리 위), 프론트(객석 쪽). 그 밖은 오류(줄이 버려짐, `rig-pos`) |
| `count` | integer | 개수 1~24. 없거나 1 미만은 오류(줄이 버려짐, `rig-count`), 소수는 반올림·24 초과는 24 로(경고) |
| `color` | string | 색 이름 (40자까지): `노랑` `연노랑` `화이트` `웜화이트` `레드` `마젠타` `핑크` `그린` `시안` `블루` `퍼플` `앰버` `오렌지` `라임`. 섞인 색은 `+` 로 잇는다 (`"레드+화이트"`, `"블루+화이트"`) — 그림에서 원을 나눠 칠한다. 모르는 이름·빈 값은 경고(`rig-color`)이고 회색으로 그린다(글에는 이름 그대로) |
| `side` | `"in"` \| `"out"` | (선택) 안쪽 한 쌍 / 바깥쪽 한 쌍 — 주로 백. 안쪽은 가운데 가까이, 바깥쪽은 양 끝에 그린다. 없으면 고르게. 그 밖의 값은 오류(버려짐, `rig-side`) |

예 — "링앤로프": `[{ "pos": "top", "count": 3, "color": "노랑" }, { "pos": "back", "count": 2, "color": "마젠타", "side": "in" }, { "pos": "back", "count": 2, "color": "그린", "side": "out" }, { "pos": "front", "count": 2, "color": "화이트" }]`
→ 한 줄 글 "백 안쪽 마젠타 2 · 백 바깥쪽 그린 2 · 탑 노랑 3 · 프론트 화이트 2" (백 → 탑 → 프론트 순서). 배열이 아닌 `rig` 는 오류(`rig-shape`).
병합(동시 편집)에서 `rig` 는 통째 값이다 — 두 기기가 같은 룩의 배치를 다르게 고치면 충돌(서버 것).

목록에서 지워도 조명 큐의 줄은 지우지 않는다 — 다른 줄(조명·채널)이 있는 큐에서는 그 줄만 빠지고, 그 조명뿐인 큐는 "(삭제된 조명)" 으로 남아 점검이 알린다(사이트 삭제·MCP `force` 삭제 같은 규칙, 사이트에서는 Ctrl+Z 로 되돌린다).

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

### items[] — 대본 흐름 (대사 · 큐)

| 필드 | 타입 | 뜻 |
|---|---|---|
| `kind` | `line` \| `action` \| `cue` | `line` = 대사, `action` = 지문·동작, `cue` = **큐** — 본문 없이 트리거와 부서 동작만 있는 대본 흐름 안의 실행 지점(아래). 큐는 `text` 가 `""`, `speaker` 가 `null`, `cues` 가 하나 이상 |
| `speaker` | string\|null | 대사의 화자 `people[].id`. `action`·`cue` 는 `null` |
| `text` | string | 대사 본문(화자 이름 빼고) 또는 지문. **지문은 항상 `(…)` 괄호 한 쌍** — `"(암전)"`, `"(액트 도중 조예준 인)"`. 표기는 아래 "표기 규칙" |
| `label` | string\|null | 큐 번호. **보통 `null`** — 사이트가 큐에 순서대로 1, 2, 3 … 을 매긴다(대사는 늘 `null`) |
| `isCue` | boolean | 큐인지. 생략 가능(큐면 자동 true) |
| `cues` | array | 큐의 부서 동작(아래 "cues[]"). 대사·지문은 `[]` |
| `trigger` | object | **큐만** — 이 큐를 나가게 하는 것, 큐마다 하나(아래 "트리거") |
| `offsetSec` | number\|null | **큐만** — 트리거 뒤 지연(초). "암전 7초 후" → 트리거 = 암전 큐 후, `offsetSec: 7`. 런에서 저절로 센다 |

### 트리거 (v12) — 큐마다 하나

| 모양 | 뜻 | 사이트에 보이는 글 |
|---|---|---|
| `{ "type": "line", "itemId": "<대사 id>", "at": "end" }` | 그 대사의 끝(기본). `"at": "start"` 면 시작 | 조예준 “…소개합니다 박대훈” 끝에 (바로 아래면 "대사 끝에") |
| `{ "type": "cue", "cueId": "<큐 id>", "mode": "after" }` | 다른 큐가 나간 뒤("연속 큐"). `"mode": "with"` 면 함께 | BLACKOUT(Q15) 후 7초 · 객석 OFF(Q2)와 함께 |
| `{ "type": "signal", "text": "박수 끝" }` | 대본에 없는 신호 — 대사나 큐로 잡을 수 없을 때만 | 박수 끝 |

- 큐를 가리키는 글은 머리글 + 번호다(동작이 여럿이면 첫 머리글 뒤 "…": "무대 ON…(Q17) 후"). 연결이라 번호가 바뀌거나 대사를 고쳐도 글이 따라간다.
- 문장 가운데에서 나가는 큐는 그 자리에서 대사를 두 항목으로 나누고 앞 대사 끝에 단다(단어 위치는 저장하지 않는다).
- 트리거가 대사·큐인 큐는 보통 그 대사·앞 큐 바로 아래에 둔다(사이트는 저장할 때 그 자리로 옮긴다). 신호 큐는 놓은 자리에 남는다.
- 서로를 기다리는 고리(Q4 → Q6 → Q4)는 만들 수 없다(사이트 편집 창·MCP 가 거부, 그래도 생기면 점검 "서로 기다리는 큐").
- 사이트에서 대사·큐를 지우며 그것을 트리거로 쓰던 큐를 남기면 트리거가 신호로 바뀌고 `"converted": "line"`(대사가 지워짐) · `"cue"`(앞 큐가 지워짐)가 붙는다 — 점검 "신호로 바뀐 트리거"(확인). 새 트리거를 고르거나 "이대로 둠"이면 빠진다.
- 검증 경고 코드: `trigger-line-missing`(트리거 대사가 없음) · `trigger-cue-missing`(앞 큐가 없음) · `trigger-loop`(고리) · `trigger-signal-empty`(빈 신호) · `trigger-converted`(신호로 바뀜). v12 파일의 옛 모양(대사에 붙은 큐 · 부서 큐의 `trigger`·`offsetSec`)은 `legacy-field`.

### v11 → v12 변환 (불러올 때 자동, `index.html` `migrate()` · `lib/ops.js` `upgradeShow()`)

- 큐가 붙은 대사·지문 → 그 문단(큐 없이) + 바로 뒤에 큐. 부서 큐를 (`trigger` 글, `offsetSec`) 이 같은 것끼리 처음 나온 순서로 묶어 묶음 하나 = 큐 하나. 새 큐 id 는 `"<문단 id>-q"`(둘째 묶음부터 `-q2` …), 코멘트는 문단에 남는다.
- 큐 지점(`kind:"cue"`) → 그 자리의 큐. 첫 묶음이 옛 id 를 그대로 쓰고, 묶음이 갈리면 `"<id>-q2"` … 로 나뉜다.
- 트리거: 글이 `"이전 큐 후"`(앱의 "이전 큐 후 +N초" 단추가 쓴 글) → 앞 문단까지의 마지막 큐 후(`offsetSec` 그대로). 대사·지문 문단에 붙은 묶음 → 글과 상관없이 그 문단 끝(`{ line, 그 문단, end }`). 남길 글(빈 글 · `"이전 큐 후"` · "대사 끝"·"이 대사 즈음"·"멘트 후" 꼴이 아닌 것)이면 트리거에 `migrated: true` · `was: "<옛 글>"` 을 달고 그 묶음 동작의 `note` 끝에 `"옮기기 전 글: <옛 글>"` 을 덧붙인다(점검 참고 "옮기며 대사 끝으로 정한 큐" — "이대로 둠"이나 편집 창에서 트리거를 저장하면 표시가 지워진다). 큐 지점(본문 없는 `kind:"cue"`)의 묶음 → 같은 글의 신호.
- 신호가 됐지만 앞 큐·앞 대사를 가리키는 것 같은 글("암전 후", "음원 시작 후", "'소개합니다 박대훈' 후" …)은 사이트 점검의 참고 "신호를 연결로 바꿀 수 있는 큐" 에 제안으로 뜬다 — 자동으로 바꾸지 않는다.
- 큐 번호는 다시 매긴다(묶음이 나뉘면 번호가 늘어난다). 글 문단 코멘트 `snapshot` 의 큐는 버린다.

### cues[] — 큐의 부서 동작 (공통)

| 필드 | 타입 | 뜻 |
|---|---|---|
| `dept` | `cast` `light` `sound` `stage` | **필수**. 같은 이름의 객체 하나가 내용 |
| `note` | string | 상세 — 머리글이 말하지 않는 것을 적는 자유 문장 하나("마이크 들고 들어와 라태형에게 건넴", "밀대로"). 모든 부서 공통. 빈 값 `""` (v8) |
| `status` | `set` \| `tbd` | 원문이 "미정"이면 `tbd`. 기본 `set` |

| dept | 내용 객체 |
|---|---|
| `light` | `{ looks: [{ lookId, action }], channels: […], anim }` (v11) — **기본은 `looks`**: 이름 붙인 조명을 켜고(`on`) 끈다(`off`). `lookId` = `lights[].id`, `action`: `on` `off`(그 밖은 오류). 한 큐에 여러 줄 — 한 조명을 끄며 다른 조명을 켜면 `off` 줄 + `on` 줄. 같은 조명 두 줄은 경고(`light-dup`), 모르는 `lookId` 는 경고("(삭제된 조명)"). 페이드·밝기 같은 상세는 그 조명의 `note` 에. 확정 큐에 `looks`·`channels`·`anim` 이 모두 비면 경고(`light-empty`). **`channels`(상세, 선택)**: `[{ ch, action, dim, color, colorName, timeSec }]` — `ch`: `back` `top` `front` `house`(객석). `action`: `on` `off` `fadeIn` `fadeOut` `anim`. `dim` 0–100(%)·null, `color` `"#rrggbb"`·null, `colorName` 색 이름·null, `timeSec` 페이드 초·null. 암전 = 네 채널 모두 `off`. 상세 미정이면 `channels: []` + `status:"tbd"`. **객석(`house`)은 켠다/끈다만**: `action` 은 `on`·`off`, `dim`·`color`·`colorName`·`timeSec` 는 `null` — 밝기·색·페이드·애니는 무대 채널(`back`·`top`·`front`)만 (v8) |
| `sound` | `{ track, action, timeSec, level }` — `track` = `tracks[].no`. `action`: `play` `fadeIn` `fadeOut` `stop` `volume`. `timeSec` 페이드/변화 초·null, `level` 0–100·null — 액션마다 뜻이 다르다: `play` 시작 볼륨(그 볼륨으로 바로 재생, null 이면 100 — 예: 하우스 오픈 BGM 50), `fadeIn` 도착 볼륨(null 이면 100), `volume` 목표 볼륨(null 이면 100으로 채워짐). `stop`·`fadeOut` 에는 뜻이 없어 편집기·MCP 가 저장할 때 지운다(검증 경고) |
| `stage` | `{ props: [{ propId, action, at }] }` — 소품이 들어오고 나가고 치워지는 동작. `propId` = `props[].id`, `action`: `in` `out` `move` `clean`(그 밖은 오류), `at` 위치(`""` 가능). **무대 큐는 소품이 필수**(v8) — 소품 없는 확정 큐는 경고(올라가지만 사이트에 빨간 "소품 미지정"). 글로 적던 작업 설명은 `note` 에. `clean` = 치우기(흘린 카드 줍기, 꽃가루 밀대 청소) — 치울 것도 `props` 에 등록해 고른다. 모르는 `propId` 는 경고 |
| `cast` | `{ people: [{ personId, move }] }` (v10) — 한 큐에 한 사람 이상, 사람마다 액션. `personId` = `people[].id`, `move`: `in` `out` `move`. 줄 순서 = 머리글 순서. 여러 사람이 함께 들어오면 `in` 줄 여럿, 한 사람이 나가며 다른 사람이 들어오면 `out` 줄 + `in` 줄. 사람이 없으면 경고("출연 대상이 없습니다"), 같은 사람 두 줄은 경고(`cast-dup`). v9 까지의 `{ personId, move }` 도 읽힌다(불러올 때 한 줄로, v10 파일에 쓰면 `legacy-field` 경고). 보충 설명은 `note` 에 |

### v7 → v8 변환 (불러올 때 자동, `index.html` `migrate()` · `lib/ops.js` `upgradeShow()`)

- `note` = 기존 `note` · `cast.text`/`stage.text` · `memo` 중 값이 있는 것을 이 순서로 `" / "` 로 잇는다(같은 문장은 한 번만). 그 세 필드는 없어진다.
- 소품 없는 옛 무대 큐는 지우지 않는다 — 원래 문장은 `note` 로 옮겨지고, 사이트가 빨간 "소품 미지정" 으로 소품 지정을 이끈다.
- 객석 채널: `fadeIn`·`anim` → `on`, `fadeOut` → `off`, `dim`·`color`·`colorName`·`timeSec` 은 지운다. 지운 값이 있었으면 `note` 끝에
  `"(객석: 원래 FADE IN 40% 3s)"` 처럼 흔적을 남긴다(조용히 사라지지 않게 — 확인 후 지우면 된다).
- v8 파일에 `memo`·`cast.text`·`stage.text` 가 있으면 경고(옛 필드, 불러올 때 `note` 로 합쳐짐).

### 큐 머리글

사이트는 큐를 **머리글(대상 + 고정 액션, 영문 대문자)** + 값 + 상세로 보인다. 머리글은 데이터에 저장하지 않고 대상·액션 필드에서 만든다 —
사용자는 대상과 액션을 고르기만 하고 머리글 문구는 고칠 수 없다. 자유 문장은 `note` 에만 쓴다.

| 부서 | 머리글 | 값 (머리글 뒤, 약하게) |
|---|---|---|
| 출연 | `{사람} IN` · `OUT` · `MOVE` — `조예준 OUT`. 여러 사람이면 같은 액션끼리 `·` 로 묶고(처음 나온 순서), 액션이 섞이면 ` · ` — `조예준·라태형 IN`, `조예준 OUT · 라태형 IN` | — |
| 음향 | `BGM {번호} PLAY` · `STOP` · `FADE IN` · `FADE OUT` · `VOL` — `BGM 4 PLAY` | 트랙 제목 · 시간 · 볼륨 — `BGM 1 PLAY  하우스 음악 · 50%` (PLAY·FADE IN 은 100% 가 아닐 때만) |
| 조명 | 이름 붙인 조명(v11): `{조명} ON` · `OFF`, 같은 액션끼리 `·` 로 묶고 섞이면 ` · ` — `무대 A ON`, `무대 A·핀 ON`, `무대 A OFF · 엔딩 블루 ON`. 채널(상세): `{채널 묶음} ON` · `OFF` · `FADE IN` · `FADE OUT` · `ANIM` — `백·탑 FADE IN / 객석 OFF`. 같은 값인 채널은 한 묶음, 객석은 늘 따로 ON/OFF. 네 채널 모두 `off` 면 `BLACKOUT`. 둘 다 있으면 조명 다음에 ` · ` 로 채널 — `무대 A ON · 객석 OFF` | 밝기 · 색 · 시간 (채널만) |
| 무대 | `{소품} IN` · `OUT` · `MOVE` · `CLEAN`, 여럿이면 ` · ` — `빈 탑햇 OUT · 실크쓰루 탑햇 IN`, `카드 CLEAN` | `→ 위치` |

대상이 비면 머리글 자리에 빨간 `조명 미정`·`출연자 미정 IN`·`BGM 미정 PLAY`·`소품 미정`(미정 큐) / `… 미지정`(확정 큐).
구현은 `index.html` "큐 요약" 구간의 `cueHead`·`cueDetail`, MCP 개요는 그 사본 `lib/cuehead.js`.

## 표기 규칙

원문마다 지문이 `* …`, `(…)`, `— …` 로 섞여 있어 하나로 통일한다. 사이트 편집기는 `*`·`—` 시작도 받지만 업로드 검증이 **경고**한다.

1. **대사** — `kind:"line"`, `speaker` 는 사람 id, `text` 는 말하는 내용. 말하는 방식이나 동작은 대사 안에 괄호로 넣는다 (위치 자유: 앞·중간·끝).
   - 좋음: `"(한숨 쉬며) 에휴 나가계세요"`, `"…그런 건 아닙니다….(째려보며)"`, `"…고통이에요 (계속 주절주절)"`
   - 나쁨: 말하는 방식을 따로 지문 문단으로 쪼개기
2. **지문** — `kind:"action"`. 묘사·진행·연출 의도·기획 설명·인/아웃 표기 모두 여기. `text` 는 항상 `(` 로 시작해 `)` 로 끝나는 괄호 **한 쌍**. 괄호 안에 괄호를 또 넣지 말고 보충 설명은 ` — ` 로 잇는다. `*`·`—` 로 시작하는 지문은 쓰지 않는다.
   - **지문은 바로 아래 큐가 이미 말하는 대상·동작·트리거를 다시 쓰지 않는다.** 큐 줄(머리글 `조예준 IN`, `BLACKOUT`, 트리거 `BLACKOUT(Q15) 후`)이 바로 보이므로, 지문에는 큐에 없는 묘사·연출만 남긴다. 큐를 그대로 다시 적기만 한 지문은 지우고 큐만 둔다.
4. **큐** — `kind:"cue"`. 큐는 지문 디테일에 매달린 것이 아니라 대본 흐름 안의 실행 지점 그 자체다. 대사 끝에 나가면 그 대사 바로 뒤에 트리거 `{ "type": "line", "itemId": <대사 id> }` 인 큐를, 대사·지문 없는 자리(예: 암전, 인/아웃)는 신호나 앞 큐 트리거의 큐를 둔다.
   동작이 0개인 큐는 없다 — 사이트·MCP 모두 동작을 지우거나 옮겨 비면 큐도 지운다(코멘트가 달렸으면 빈 지문으로 남긴다). 큐 번호(Q)는 큐에만 매긴다.
   - 좋음: 대사 `"소개합니다 다음 공연자 라태형"` 다음에 `{ "kind": "cue", "trigger": { "type": "line", "itemId": <그 대사> }, "cues": [조명 BLACKOUT] }`, 그다음 `{ "kind": "cue", "trigger": { "type": "cue", "cueId": <BLACKOUT 큐> }, "offsetSec": 7, "cues": [조명 ON, 음향 PLAY] }`
   - 나쁨: 지문 `"(암전)"` 을 따로 두고 그 뒤에 BLACKOUT 큐를 다는 것(큐를 다시 적은 지문)
   - 나쁨: `"* 액트 도중 조예준 인"`, `"— 암전"`, `"(조예준 인 (고개 절레절레))"`
3. **큐로 만들 것** — 조명·음향·무대팀·출연자 인/아웃처럼 스태프나 출연자가 **실제로 실행해야 하는 일**만 큐로 만든다. 문단 text 가 아니라 큐의 `cues[]` 로 표현한다. 큐 시점이 대사면 트리거를 그 대사로, 앞 큐면 그 큐로, 대본에 없는 신호면 신호로. 묘사에서 큐를 억지로 끌어내지 않는다.
   - 좋음: 지문 `"(3명이 관객석으로 간다)"` 에 무대팀 `stage` 큐 "테이블 교체" 하나만 단다
   - 나쁨: 같은 지문에서 이동 자체를 `cast` 큐로 만들기

검증은 지문(`action`) 문단만 본다 — `(` 로 시작하지 않거나 `)` 로 끝나지 않으면, 괄호 안에 괄호가 또 있으면 경고. 대사(`line`) 안의 괄호는 검사하지 않는다.
v11 이하 파일에서 큐가 달린 지문의 낱말이 전부 그 큐의 대상·액션·트리거뿐이면(`"(조예준 인)"` + 출연 큐 `조예준 IN`) **`action-echo` 경고**(큐를 다시 적은 지문). 큐(`kind:"cue"`)에 본문이 있으면 경고(`cue-text`, 불러올 때 버려짐), 동작이 없으면 오류.
v12 의 대사·지문에는 큐가 붙지 않으므로 `action-echo`·`empty-cued` 는 v11 이하 파일에서만 본다. 사이트 대본 편집기에서 트리거로 쓰이는 대사의 글을 지워 문단이 사라지면 빈 문단으로 남긴다(지우려면 패널에서 — 붙은 큐를 함께 지울지 묻는다).

## 변환 요령

- 원문의 글머리표(`*`)는 괄호 지문으로 바꾼다 (`* 액트 도중 조예준 인` → `(액트 도중 조예준 인)`).
- 원문의 지문 한 줄 = `action` 하나, 대사 한 줄 = `line` 하나. 큐는 그 큐가 나가는 시점 바로 뒤의 `kind:"cue"` 항목으로 두고 트리거를 그 대사(또는 앞 큐 · 신호)로.
  대본이 없는 지점(예: "하우스 오픈")은 신호 트리거의 큐로 둔다(`"text": "객석 오픈"`) — 지문을 따로 만들 필요 없다.
- 액트 본편처럼 대본이 없는 씬은 `items: []` 로 둬도 된다.
- 등장하는 사람은 모두 `people` 에 넣고 id 를 정한다(예: `"p-yejun"`). 음향 큐가 쓰는 트랙 번호는 모두 `tracks` 에 넣는다.
- 원문에 없는 값은 지어내지 말고 `null` / `""` / `status:"tbd"` + `note` 로 남긴다.
- comments(`{ author, text, createdAt(ISO), resolved }`)는 원문의 확인 요청·메모를 남길 때만 쓴다.
  앱은 문단 코멘트에 선택 필드 `snapshot`(`{ kind, speaker, text, cues[] }`, 코멘트를 달 당시 그 문단)을 함께 저장해 "코멘트 당시로 되돌리기"에 쓴다. 업로드할 때는 넣지 않는다 — 없으면 위치 이동만 된다.

## 최소 예시

```json
{
  "title": "1부 (초안)",
  "version": 13,
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
  "lights": [
    { "id": "lk-stage-a", "name": "무대 A", "note": "프론트 70 + 탑 블루, 리허설 11/12 확정",
      "rig": [{ "pos": "front", "count": 2, "color": "화이트" }, { "pos": "top", "count": 4, "color": "블루" }] }
  ],
  "tracks": [
    { "id": "tr-1", "no": 1, "title": "하우스 음악", "durationSec": null, "fileName": null, "fileKey": null, "note": "", "loop": true }
  ],
  "parts": [{
    "id": "pt-1", "name": "1부",
    "scenes": [
      { "id": "s-1", "type": "mc", "title": "", "cast": ["p-yejun"], "durationSec": null, "setup": "", "comments": [],
        "items": [
          { "id": "i-1", "kind": "cue", "speaker": null, "text": "", "label": null, "comments": [],
            "trigger": { "type": "signal", "text": "하우스 음악 페이드 아웃 후" }, "offsetSec": null,
            "cues": [
              { "id": "q-1", "dept": "light", "note": "", "status": "set",
                "light": { "looks": [], "channels": [
                  { "ch": "back", "action": "off", "dim": null, "color": null, "colorName": null, "timeSec": null },
                  { "ch": "top", "action": "off", "dim": null, "color": null, "colorName": null, "timeSec": null },
                  { "ch": "front", "action": "off", "dim": null, "color": null, "colorName": null, "timeSec": null },
                  { "ch": "house", "action": "off", "dim": null, "color": null, "colorName": null, "timeSec": null }
                ], "anim": "" } }
            ] },
          { "id": "i-2", "kind": "cue", "speaker": null, "text": "", "label": null, "comments": [],
            "trigger": { "type": "cue", "cueId": "i-1", "mode": "after" }, "offsetSec": 7,
            "cues": [
              { "id": "q-2", "dept": "sound", "note": "", "status": "set",
                "sound": { "track": 1, "action": "fadeOut", "timeSec": 3, "level": null } }
            ] },
          { "id": "i-3", "kind": "line", "speaker": "p-yejun", "text": "소개합니다 박대훈", "label": null, "cues": [], "comments": [] },
          { "id": "i-4", "kind": "cue", "speaker": null, "text": "", "label": null, "comments": [],
            "trigger": { "type": "line", "itemId": "i-3", "at": "end" }, "offsetSec": null,
            "cues": [
              { "id": "q-3", "dept": "cast", "note": "", "status": "set",
                "cast": { "people": [{ "personId": "p-daehoon", "move": "in" }] } },
              { "id": "q-5", "dept": "light", "note": "", "status": "set",
                "light": { "looks": [{ "lookId": "lk-stage-a", "action": "on" }], "channels": [], "anim": "" } }
            ] },
          { "id": "i-5", "kind": "cue", "speaker": null, "text": "", "label": null, "comments": [],
            "trigger": { "type": "line", "itemId": "i-3", "at": "start" }, "offsetSec": null,
            "cues": [
              { "id": "q-4", "dept": "stage", "note": "시점 리허설 때 확정", "status": "tbd",
                "stage": { "props": [{ "propId": "pr-tophat", "action": "in", "at": "테이블 위" }] } }
            ] }
        ] },
      { "id": "s-2", "type": "act", "title": "멘탈", "cast": ["p-daehoon"], "durationSec": 180, "setup": "", "comments": [], "items": [] }
    ]
  }]
}
```
