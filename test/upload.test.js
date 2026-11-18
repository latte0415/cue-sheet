// scripts/upload.js — 임시 서버를 띄우고 스크립트를 자식 프로세스로 돌려 실제로 올려 본다
// (서버가 같은 프로세스에 있으므로 execFile 은 비동기로 — 동기 실행이면 서버가 응답하지 못한다)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createServer } = require('../server');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'upload.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-upload-'));

function start(password) {
  const dir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const server = createServer({ dataDir: dir, password, log: null });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
// 환경변수의 CUE_URL·CUE_KEY·APP_PASSWORD 가 섞이지 않게 비우고, 백업은 TMP 아래로
function run(args, extraEnv) {
  const env = Object.assign({}, process.env, { CUE_URL: '', CUE_KEY: '', APP_PASSWORD: '', TMPDIR: TMP }, extraEnv);
  return new Promise(res => execFile(process.execPath, [SCRIPT, ...args], { env }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr, out: stdout + stderr })));
}
let n = 0;
function file(obj) { const f = path.join(TMP, `in-${++n}.json`); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; }
const J = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// 에이전트가 만들 법한 파일: id 없이, 사람·트랙만 id
const cueDoc = (title, extra) => Object.assign({
  title, version: 5,
  people: [{ id: 'p-a', name: '조예준', role: 'mc' }],
  tracks: [{ id: 'tr-1', no: 1, title: '하우스', fileName: null, fileKey: null, loop: true }],
  parts: [{ name: '1부', scenes: [
    { type: 'mc', title: '', cast: ['p-a'], items: [
      { kind: 'action', speaker: null, text: '(하우스 오픈)', cues: [{ dept: 'sound', trigger: '객석 오픈', offsetSec: null, sound: { track: 1, action: 'play' } }] },
      { kind: 'line', speaker: 'p-a', text: '안녕하세요', cues: [] }
    ] },
    { type: 'act', title: '제로존', cast: ['p-a'], durationSec: 60, items: [] }
  ] }]
}, extra);

let S;
before(async () => { S = await start(''); });
after(() => new Promise(r => S.server.close(() => { fs.rmSync(TMP, { recursive: true, force: true }); r(); })));
const list = async () => (await fetch(S.base + '/api/shows')).json();
const get = async id => (await fetch(`${S.base}/api/shows/${id}`)).json();

test('새 프로젝트로 업로드: id 자동 부여, 열기 주소 출력, 사이트가 읽는 형식 그대로', async () => {
  const r = await run([file(cueDoc('업로드 A')), '--url', S.base]);
  assert.equal(r.code, 0, r.out);
  const id = /id (\S+) · rev 1/.exec(r.stdout)[1];
  assert.match(r.stdout, new RegExp(`열기: ${S.base}/\\?show=${id}`));
  assert.match(r.stdout, /id 없는 항목 6개/);
  const g = await get(id);
  assert.equal(g.rev, 1);
  assert.equal(g.show.title, '업로드 A');
  const sc = g.show.parts[0].scenes[0];
  assert.equal(g.show.parts[0].id, 'pt-1');
  assert.deepEqual(sc.items.map(i => i.id), ['i-1-1-1', 'i-1-1-2']);
  assert.equal(sc.items[0].cues[0].id, 'q-1-1-1-1');
  assert.equal(sc.items[0].cues[0].sound.track, 1);
  const row = (await list()).find(x => x.id === id);
  assert.deepEqual([row.sceneCount, row.cueCount], [2, 1]);
});

test('--json: 결과 한 줄, 사람용 메시지는 stderr', async () => {
  const r = await run([file({ show: cueDoc('업로드 J') }), '--url', S.base, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true); assert.equal(j.action, 'create'); assert.equal(j.rev, 1); assert.equal(j.title, '업로드 J');
  assert.equal(j.url, `${S.base}/?show=${j.id}`);
  assert.match(r.stderr, /검증 통과/);
});

test('검증 실패: 경로를 알려 주고 서버에는 아무것도 보내지 않는다', async () => {
  const before = (await list()).length;
  const bad = cueDoc('나쁨');
  bad.parts[0].scenes[0].items[0].cues[0].dept = 'music';
  bad.parts[0].scenes[0].items[1].speaker = '조예준';
  const r = await run([file(bad), '--url', S.base]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /오류 parts\[0\]\.scenes\[0\]\.items\[0\]\.cues\[0\]\.dept: "music" 는 허용되지 않습니다/);
  assert.match(r.out, /오류 parts\[0\]\.scenes\[0\]\.items\[1\]\.speaker: 화자 "조예준" 는 이름입니다 — people\[\]\.id 인 "p-a" 를 쓰세요.*\[1부 › 씬 1\(mc\) › #2 "안녕하세요"\]/);
  assert.match(r.out, /업로드하지 않았습니다/);
  assert.equal((await list()).length, before);

  const r2 = await run([file('{"title": "x",'), '--url', S.base, '--json']);
  assert.equal(r2.code, 1);
  assert.equal(JSON.parse(r2.stdout).ok, false);
  assert.equal((await list()).length, before);
});

test('--dry-run: 검증·대상 확인만', async () => {
  const before = (await list()).length;
  let r = await run([file(cueDoc('드라이')), '--url', S.base, '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /dry-run: .*올리지 않았습니다/);
  r = await run([file(cueDoc('드라이')), '--url', S.base, '--dry-run', '--project', '드라이', '--create']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /새로 만들 예정/);
  assert.equal((await list()).length, before);
});

test('--project 이름: 없으면 실패, --create 면 그 제목으로 생성, 다시 올리면 덮어쓰기', async () => {
  const before = (await list()).length;
  let r = await run([file(cueDoc('파일 제목')), '--url', S.base, '--project', '2부 리허설']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /프로젝트 "2부 리허설" 가 없습니다. 새로 만들려면 --create/);
  assert.equal((await list()).length, before);

  r = await run([file(cueDoc('파일 제목')), '--url', S.base, '--project', '2부 리허설', '--create', '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.stdout);
  assert.equal(j.action, 'create');
  assert.equal((await get(j.id)).show.title, '2부 리허설');

  r = await run([file(cueDoc('2부 리허설')), '--url', S.base, '--project', '2부 리허설', '--json']);
  assert.equal(r.code, 0, r.out);
  const j2 = JSON.parse(r.stdout);
  assert.deepEqual([j2.action, j2.id, j2.rev], ['update', j.id, 2]);
  assert.equal((await list()).length, before + 1);
});

test('--project id 덮어쓰기: 음원 연결(fileKey) 유지, 이전 버전 백업', async () => {
  // 사이트에서 만든 프로젝트: 트랙 1 에 음원을 올려 둔 상태
  const siteShow = cueDoc('사이트', { tracks: [{ id: 'tr-1', no: 1, title: '하우스', fileName: 'house.mp3', fileKey: 'k-house', durationSec: 95, loop: true }] });
  let res = await fetch(S.base + '/api/shows', J('POST', { show: siteShow }));
  const { id } = await res.json();
  res = await fetch(`${S.base}/api/shows/${id}/audio/k-house`, { method: 'PUT', headers: { 'Content-Type': 'audio/mpeg', 'X-File-Name': 'house.mp3' }, body: Buffer.from('abc') });
  assert.equal(res.status, 200);

  const r = await run([file(cueDoc('수정본')), '--url', S.base, '--project', id]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /음원 연결 유지: 트랙 1/);
  const bk = /이전 버전\(rev 1\) 백업: (\S+)/.exec(r.stdout)[1];
  assert.ok(bk.startsWith(TMP));
  assert.equal(JSON.parse(fs.readFileSync(bk, 'utf8')).title, '사이트');
  const g = await get(id);
  assert.equal(g.rev, 2);
  assert.equal(g.show.title, '수정본');
  assert.deepEqual([g.show.tracks[0].fileKey, g.show.tracks[0].fileName, g.show.tracks[0].durationSec], ['k-house', 'house.mp3', 95]);
  assert.equal(g.show.tracks[0].title, '하우스');

  // 없는 id 지정
  const r2 = await run([file(cueDoc('x')), '--url', S.base, '--project', 'nothere']);
  assert.equal(r2.code, 2);
});

test('비밀번호 서버: 키 없으면 안내 후 실패, --key 나 $CUE_KEY 로 성공', async () => {
  const P = await start('비번 1');
  try {
    let r = await run([file(cueDoc('보호')), '--url', P.base]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /비밀번호가 필요합니다/);
    r = await run([file(cueDoc('보호')), '--url', P.base, '--key', '틀림']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /비밀번호가 틀렸습니다/);
    r = await run([file(cueDoc('보호')), '--url', P.base, '--key', '비번 1']);
    assert.equal(r.code, 0, r.out);
    r = await run([file(cueDoc('보호')), '--json'], { CUE_URL: P.base, CUE_KEY: '비번 1' });
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(r.stdout).ok, true);
  } finally { await new Promise(r => P.server.close(r)); }
});

test('연결 실패·사용법 오류는 종료 코드 2', async () => {
  let r = await run([file(cueDoc('x')), '--url', 'http://127.0.0.1:1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /서버에 연결하지 못했습니다/);
  r = await run(['--nope']);
  assert.equal(r.code, 2);
  r = await run([file(cueDoc('x')), '--create']);
  assert.equal(r.code, 2);
  r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /사용법/);
});

test('서버도 구조가 깨진 show 는 받지 않는다 (경로 포함 메시지)', async () => {
  const res = await fetch(S.base + '/api/shows', J('POST', { show: { version: 5, parts: [{ scenes: [{ items: {} }] }] } }));
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.error, 'invalid_show');
  assert.match(j.message, /parts\[0\]\.scenes\[0\]\.items 가 배열이 아닙니다/);
});
