#!/usr/bin/env node
// 큐시트 JSON 을 검증한 뒤 서버에 올린다 — 의존성 없음 (Node 20 내장 fetch)
//   node scripts/upload.js <파일.json> [--project <id|이름>] [--create] [--url <서버>] [--key <비밀번호>] [--edit-key <편집 비밀번호>] [--dry-run] [--json]
// 형식은 docs/cue-format.md. 종료 코드: 0 성공, 1 데이터 오류(업로드 안 함), 2 사용법·연결·서버 오류
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateShow, unwrapShow, fillIds } = require('../lib/validate');

const JSON_LIMIT = 5 * 1024 * 1024; // server.js 와 같은 본문 한도
const USAGE = `사용법: node scripts/upload.js <파일.json> [옵션]

  (옵션 없음)          새 프로젝트로 올린다
  --project <id|이름>  그 프로젝트를 이 파일 내용으로 덮어쓴다 (id 우선, 다음은 제목이 정확히 같은 것)
  --create             --project 로 찾지 못하면 그 이름으로 새로 만든다
  --url <서버>         기본 $CUE_URL 또는 http://localhost:$PORT(3000)
  --key <비밀번호>     서버의 APP_PASSWORD. 기본 $CUE_KEY 또는 $APP_PASSWORD
  --edit-key <비밀번호> 덮어쓸 프로젝트의 편집 비밀번호. 기본 $CUE_EDIT_KEY. --project 덮어쓰기에만 필요(새로 만들기는 불필요)
  --dry-run            검증과 대상 확인만 하고 올리지 않는다
  --json               결과를 JSON 한 줄로 stdout 에 (사람용 메시지는 stderr)`;

class Fail extends Error { constructor(code, msg) { super(msg); this.exit = code; } }

function parseArgs(argv) {
  const o = { file: null, project: null, create: false, url: null, key: null, editKey: null, dryRun: false, json: false, help: false };
  const val = (i, name) => { if (i >= argv.length || argv[i].startsWith('--')) throw new Fail(2, `${name} 에 값이 필요합니다`); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--project') o.project = val(++i, a);
    else if (a === '--url') o.url = val(++i, a);
    else if (a === '--key') o.key = val(++i, a);
    else if (a === '--edit-key') o.editKey = val(++i, a);
    else if (a === '--create') o.create = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new Fail(2, `모르는 옵션: ${a}`);
    else if (o.file) throw new Fail(2, `파일은 하나만: ${a}`);
    else o.file = a;
  }
  return o;
}

// 같은 메시지가 여럿이면 묶어서 앞 3곳만
function printIssues(log, label, list) {
  const groups = new Map();
  list.forEach(x => { if (!groups.has(x.msg)) groups.set(x.msg, []); groups.get(x.msg).push(x); });
  for (const [msg, xs] of groups) {
    if (xs.length <= 3) xs.forEach(x => log(`${label} ${x.path || '(최상위)'}: ${msg}${x.where ? `  [${x.where}]` : ''}`));
    else log(`${label} ${msg} — ${xs.slice(0, 3).map(x => x.path).join(', ')} 외 ${xs.length - 3}곳`);
  }
}

function counts(show) {
  let scenes = 0, items = 0, cues = 0;
  (show.parts || []).forEach(p => (p && p.scenes || []).forEach(s => {
    scenes++;
    (s && s.items || []).forEach(i => { items++; cues += i && Array.isArray(i.cues) ? i.cues.length : 0; });
  }));
  return { parts: (show.parts || []).length, scenes, items, cues, people: (show.people || []).length, tracks: (show.tracks || []).length };
}

async function main(argv) {
  const o = parseArgs(argv);
  const out = o.json ? process.stderr : process.stdout;
  const log = s => out.write(s + '\n');
  if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (!o.file) throw new Fail(2, '파일을 지정하세요\n\n' + USAGE);
  if (o.create && !o.project) throw new Fail(2, '--create 는 --project 와 함께 씁니다 (--project 없이 올리면 항상 새 프로젝트)');
  const result = { ok: false, action: null, id: null, rev: null, url: null, title: null, errors: [], warnings: [] };
  const done = code => { if (o.json) process.stdout.write(JSON.stringify(result) + '\n'); return code; };

  // ---- 1. 읽기·검증 (실패하면 서버에 아무것도 보내지 않는다)
  let text;
  try { text = fs.readFileSync(o.file, 'utf8'); } catch (e) { throw new Fail(2, `파일을 읽지 못했습니다: ${o.file} (${e.code || e.message})`); }
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    result.errors.push({ path: '', msg: 'JSON 문법 오류: ' + e.message });
    log(`오류 ${o.file}: JSON 문법 오류 — ${e.message}`);
    log('업로드하지 않았습니다.');
    return done(1);
  }
  const show = JSON.parse(JSON.stringify(unwrapShow(data)));
  const v = validateShow(show);
  result.errors = v.errors; result.warnings = v.warnings;
  if (v.warnings.length) printIssues(log, '경고', v.warnings);
  if (v.errors.length) {
    printIssues(log, '오류', v.errors);
    log(`오류 ${v.errors.length}개 — 업로드하지 않았습니다. docs/cue-format.md 를 참고해 고친 뒤 다시 실행하세요.`);
    return done(1);
  }
  const filled = fillIds(show);
  const c = counts(show);
  result.title = String(show.title || '');
  log(`검증 통과: "${show.title || '(제목 없음)'}" — 파트 ${c.parts} · 씬 ${c.scenes} · 문단 ${c.items} · 큐 ${c.cues} · 사람 ${c.people} · 트랙 ${c.tracks}${v.warnings.length ? ` (경고 ${v.warnings.length})` : ''}`);
  if (filled) log(`id 없는 항목 ${filled}개에 id 를 붙여 올립니다 (파일은 그대로)`);

  // ---- 2. 서버
  const base = String(o.url || process.env.CUE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  const key = o.key != null ? o.key : (process.env.CUE_KEY || process.env.APP_PASSWORD || '');
  // 편집 비밀번호는 기본값(1234)을 몰래 시도하지 않는다 — 덮어쓰기는 항상 명시적으로
  const editKey = o.editKey != null ? o.editKey : (process.env.CUE_EDIT_KEY || '');
  if (o.dryRun && !o.project) {
    result.ok = true; result.action = 'dry-run';
    log(`dry-run: ${base} 에 새 프로젝트로 올릴 예정 — 올리지 않았습니다.`);
    return done(0);
  }
  async function api(method, p, body, extra) {
    const headers = Object.assign({ Accept: 'application/json' }, extra);
    if (key) headers['X-App-Key'] = encodeURIComponent(key);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try { r = await fetch(base + '/api' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new Fail(2, `서버에 연결하지 못했습니다: ${base} (${(e.cause && e.cause.code) || e.message}) — 서버가 떠 있는지, --url 이 맞는지 확인하세요`); }
    let j = null;
    try { j = await r.json(); } catch (e) { /* 본문 없음 */ }
    if (r.status === 401) throw new Fail(2, key ? '비밀번호가 틀렸습니다 (--key 또는 $CUE_KEY 확인)' : '이 서버는 비밀번호가 필요합니다 — --key <APP_PASSWORD> 또는 $CUE_KEY 를 주세요');
    if (r.status === 403 && j && j.error === 'edit_forbidden') throw new Fail(2, '편집 비밀번호가 틀렸습니다 — 덮어쓰지 않았습니다 (--edit-key 또는 $CUE_EDIT_KEY 확인)');
    if (r.status === 429) throw new Fail(2, `편집 비밀번호를 너무 많이 틀렸습니다 — ${(j && j.retryAfter) || 60}초 뒤에 다시 시도하세요`);
    return { status: r.status, data: j };
  }
  const editHeaders = () => ({ 'X-Edit-Key': encodeURIComponent(editKey) });
  const fail = (what, r) => new Fail(2, `${what} 실패 (HTTP ${r.status}${r.data && r.data.error ? ' ' + r.data.error : ''}${r.data && r.data.message ? ': ' + r.data.message : ''})`);

  let target = null; // 덮어쓸 프로젝트 id
  let targetRow = null;
  if (o.project) {
    const r = await api('GET', '/shows');
    if (r.status !== 200 || !Array.isArray(r.data)) throw fail('프로젝트 목록 조회', r);
    const list = r.data;
    const byId = list.find(x => x.id === o.project);
    const byTitle = list.filter(x => String(x.title).trim() === o.project.trim());
    if (byId) targetRow = byId;
    else if (byTitle.length === 1) targetRow = byTitle[0];
    if (targetRow) target = targetRow.id;
    else if (byTitle.length > 1) throw new Fail(2, `제목이 "${o.project}" 인 프로젝트가 ${byTitle.length}개입니다 — id 로 지정하세요: ${byTitle.map(x => x.id).join(', ')}`);
    else if (!o.create) {
      const names = list.slice(0, 20).map(x => `  ${x.id}  ${x.title}`).join('\n');
      throw new Fail(2, `프로젝트 "${o.project}" 가 없습니다. 새로 만들려면 --create 를 붙이세요.${list.length ? '\n있는 프로젝트:\n' + names : ' (서버에 프로젝트가 없습니다)'}`);
    } else if (show.title !== o.project) {
      log(`새 프로젝트 제목을 "${o.project}" 로 합니다 (파일의 title: "${show.title || ''}")`);
      show.title = o.project; result.title = o.project;
    }
  }

  const fileKeys = (show.tracks || []).filter(t => t && t.fileKey);
  if (!target) {
    if (fileKeys.length) log(`경고 tracks 의 fileKey ${fileKeys.length}개는 새 프로젝트에 파일이 없어 재생되지 않습니다 — 사이트 음원 탭에서 올리세요`);
    if (o.dryRun) {
      result.ok = true; result.action = 'dry-run';
      log(`dry-run: "${show.title}" 프로젝트가 없어 새로 만들 예정 — 올리지 않았습니다.`);
      return done(0);
    }
    const body = { show };
    if (Buffer.byteLength(JSON.stringify(body)) > JSON_LIMIT) throw new Fail(1, '5MB 를 넘어 서버가 받지 않습니다');
    const r = await api('POST', '/shows', body);
    if (r.status !== 201 || !r.data) throw fail('업로드', r);
    Object.assign(result, { ok: true, action: 'create', id: r.data.id, rev: r.data.rev });
  } else {
    // 덮어쓰기는 그 프로젝트의 편집 비밀번호가 필요하다. 미리 확인해(틀리면 여기서 멈춘다) PUT 에도 싣는다
    const defHint = targetRow.editDefault ? ' (이 프로젝트는 아직 기본 비밀번호 1234 — 사이트에서 바꾸세요)' : '';
    if (!editKey) {
      if (!o.dryRun) throw new Fail(2, `프로젝트 ${target} 를 덮어쓰려면 편집 비밀번호가 필요합니다 — --edit-key <비밀번호> 또는 $CUE_EDIT_KEY${defHint}`);
      log(`경고 실제로 덮어쓰려면 편집 비밀번호(--edit-key 또는 $CUE_EDIT_KEY)가 필요합니다${defHint}`);
    } else {
      const ck = await api('POST', `/shows/${encodeURIComponent(target)}/edit-check`, undefined, editHeaders());
      if (ck.status !== 200) throw fail('편집 비밀번호 확인', ck);
      if (ck.data && ck.data.isDefault) log('경고 이 프로젝트는 아직 기본 편집 비밀번호(1234)입니다 — 사이트에서 바꾸세요');
    }
    const cur = await api('GET', '/shows/' + encodeURIComponent(target));
    if (cur.status !== 200 || !cur.data) throw fail('기존 프로젝트 조회', cur);
    // 사이트에서 올린 음원 연결(fileKey)은 이 파일에 없으므로 같은 트랙 번호에서 이어받는다
    const old = Array.isArray(cur.data.show && cur.data.show.tracks) ? cur.data.show.tracks : [];
    const kept = [];
    (show.tracks || []).forEach(t => {
      if (!t || t.fileKey) return;
      const o2 = old.find(x => x && x.fileKey && Number(x.no) === Number(t.no));
      if (!o2) return;
      t.fileKey = o2.fileKey; t.fileName = o2.fileName || null;
      if (t.durationSec == null && o2.durationSec != null) t.durationSec = o2.durationSec;
      kept.push(t.no);
    });
    const lost = old.filter(x => x && x.fileKey && !(show.tracks || []).some(t => t && t.fileKey === x.fileKey));
    if (kept.length) log(`음원 연결 유지: 트랙 ${kept.join(', ')}`);
    if (lost.length) log(`경고 기존 음원 ${lost.length}개(트랙 ${lost.map(x => x.no).join(', ')})는 이 파일에 같은 번호 트랙이 없어 연결이 끊깁니다 (파일은 서버에 남음)`);
    const audio = await api('GET', `/shows/${encodeURIComponent(target)}/audio`);
    if (audio.status === 200 && Array.isArray(audio.data)) {
      const have = new Set(audio.data.map(x => x.fileKey));
      const miss = (show.tracks || []).filter(t => t && t.fileKey && !have.has(t.fileKey));
      if (miss.length) log(`경고 트랙 ${miss.map(t => t.no).join(', ')} 의 fileKey 파일이 서버에 없습니다`);
    }
    if (o.dryRun) {
      result.ok = true; result.action = 'dry-run'; result.id = target; result.rev = cur.data.rev;
      log(`dry-run: 프로젝트 ${target} ("${cur.data.show && cur.data.show.title}", rev ${cur.data.rev}) 를 덮어쓸 예정 — 올리지 않았습니다.`);
      return done(0);
    }
    const body = { baseRev: cur.data.rev, show };
    if (Buffer.byteLength(JSON.stringify(body)) > JSON_LIMIT) throw new Fail(1, '5MB 를 넘어 서버가 받지 않습니다');
    // 덮어쓰기 전 서버 버전을 임시 폴더에 남긴다 (되돌릴 때 이 파일을 --project 로 다시 올리면 된다)
    const backup = path.join(os.tmpdir(), `cue-sheet-backup-${target}-rev${cur.data.rev}-${Date.now()}.json`);
    try { fs.writeFileSync(backup, JSON.stringify(cur.data.show, null, 2)); log(`이전 버전(rev ${cur.data.rev}) 백업: ${backup}`); }
    catch (e) { log(`경고 백업을 남기지 못했습니다: ${e.message}`); }
    const r = await api('PUT', '/shows/' + encodeURIComponent(target), body, editHeaders());
    if (r.status === 409) throw new Fail(2, `그 사이 사이트에서 누군가 저장했습니다 (rev ${r.data && r.data.rev}) — 다시 실행하면 그 버전 위에 덮어씁니다`);
    if (r.status !== 200 || !r.data) throw fail('업로드', r);
    Object.assign(result, { ok: true, action: 'update', id: target, rev: r.data.rev });
  }
  result.url = `${base}/?show=${encodeURIComponent(result.id)}`;
  log(`${result.action === 'create' ? '새 프로젝트로 올렸습니다' : '덮어썼습니다'}: id ${result.id} · rev ${result.rev}`);
  log(`열기: ${result.url}`);
  if (result.action === 'create') log(`다시 올릴 때: node scripts/upload.js ${o.file} --project ${result.id}`);
  return done(0);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
    if (e instanceof Fail) { process.stderr.write(e.message + '\n'); process.exitCode = e.exit; }
    else { process.stderr.write((e && e.stack || String(e)) + '\n'); process.exitCode = 2; }
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, error: e && e.message || String(e) }) + '\n');
  });
}

module.exports = { main, parseArgs };
