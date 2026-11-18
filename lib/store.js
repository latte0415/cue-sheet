// 프로젝트(공연) 단위 파일 저장소
//   DATA_DIR/shows/<id>.json              { rev, updatedAt, by?, via?, restoredFrom?, show }
//   DATA_DIR/shows/<id>/audio/<fileKey>    음원 원본
//   DATA_DIR/shows/<id>/audio/<fileKey>.json  { fileKey, name, mime, size }
//   DATA_DIR/shows/<id>/history/<rev>.json    덮어쓰기 직전 버전 (같은 모양) — 최근 historyKeep 개
//   DATA_DIR/shows/<id>/auth.json             편집 비밀번호 해시 (lib/editkey.js). 없으면 기본 비밀번호 상태. show 밖에 두어 GET·내보내기에 섞이지 않는다
//   한 프로젝트의 부속 파일은 모두 shows/<id>/ 아래 — 삭제는 폴더째 휴지통으로, 복제는 audio/ 만 복사한다
//   DATA_DIR/trash/<id>-<삭제 ms>/{ meta.json, show.json(=<id>.json), files/(=shows/<id>/ 통째) }  — 휴지통. trashDays 가 지나면 영구 삭제
// 레코드의 선택 필드 — 그 버전을 만든 쓰기에 대한 것이라 기록 스냅숏에도 그대로 따라간다:
//   by·via = 누가·어떤 경로로 (기록 표시용). by: MCP 토큰 이름 | '사이트 비밀번호'(그 비밀번호로 붙은 MCP) | '브라우저' | '익명',
//   via: 'mcp' | 'browser' | 'restore'.  restoredFrom = 복원으로 만든 버전이면 원래 rev. 이 필드들이 생기기 전 파일에는 없다(null 로 본다).
// 쓰기는 임시 파일 → rename(원자적). 같은 프로세스 안의 쓰기는 Promise 큐 하나로 직렬화한다.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { basicInvalid } = require('./validate');

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
// 보관 개수. MCP 수정·복원은 매번 남기므로 에이전트가 한 번에 수십 번 고쳐도 그 전 버전이 남게 넉넉히 (env HISTORY_KEEP)
const HISTORY_KEEP = Number(process.env.HISTORY_KEEP) > 0 ? Math.floor(Number(process.env.HISTORY_KEEP)) : 100;
// 브라우저 PUT 은 몇 초마다 오므로 매번 남기면 30개가 금방 찬다. PUT 은 직전 쓰기가 PUT 이 아니었거나(MCP 수정·복원 직후)
// 마지막으로 남긴 지 이만큼 지났을 때만 남긴다. update·restore 는 항상 남긴다.
const PUT_SNAPSHOT_MS = 10 * 60 * 1000;
// 휴지통 보관 일수 (env TRASH_DAYS)
const TRASH_DAYS = Number(process.env.TRASH_DAYS) > 0 ? Number(process.env.TRASH_DAYS) : 30;
const TRASH_RE = /^[A-Za-z0-9_-]{1,32}-\d{10,16}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

function newId() {
  // 시간 기반 짧은 id: base36 밀리초 + 무작위 4자
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('base64url').slice(0, 4).replace(/[^A-Za-z0-9]/g, 'x');
}
function tmpName(file) { return file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'); }
async function writeAtomic(file, data) {
  const tmp = tmpName(file);
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
async function readJsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// 쓰기 메타 { by, via } 중 문자열인 것만 레코드에 싣는다
function writeMeta(meta) {
  const o = {};
  if (meta && typeof meta.by === 'string') o.by = meta.by;
  if (meta && typeof meta.via === 'string') o.via = meta.via;
  return o;
}
// 저장 전 검증은 lib/validate.js (프런트가 저장하는 값은 항상 통과하는 구조 검사)
const invalidShow = basicInvalid;
function countShow(show) {
  let scenes = 0, cues = 0;
  (show && Array.isArray(show.parts) ? show.parts : []).forEach(p => {
    const ss = p && Array.isArray(p.scenes) ? p.scenes : [];
    scenes += ss.length;
    ss.forEach(s => (s && Array.isArray(s.items) ? s.items : []).forEach(i => { cues += i && Array.isArray(i.cues) ? i.cues.length : 0; }));
  });
  return { sceneCount: scenes, cueCount: cues };
}

class Store {
  constructor(dataDir, opts) {
    opts = opts || {};
    this.dir = path.resolve(dataDir);
    this.showsDir = path.join(this.dir, 'shows');
    this.historyKeep = opts.historyKeep > 0 ? Math.floor(opts.historyKeep) : HISTORY_KEEP;
    this.putSnapshotMs = opts.putSnapshotMs != null ? opts.putSnapshotMs : PUT_SNAPSHOT_MS;
    this.trashDir = path.join(this.dir, 'trash');
    this.trashDays = opts.trashDays > 0 ? opts.trashDays : TRASH_DAYS;
    this.q = Promise.resolve();
    this.lastWrite = new Map(); // id → { by: 'put'|'update'|'restore', snapAt }
  }
  async init() {
    await fsp.mkdir(this.showsDir, { recursive: true });
    await this.migrateHistory();
    await this.trashPurge();
  }
  // 예전 위치(shows/<id>.history/)의 기록을 shows/<id>/history/ 로 옮긴다. 같은 rev 가 이미 있으면 새 위치를 남긴다
  async migrateHistory() {
    for (const n of await fsp.readdir(this.showsDir)) {
      const m = /^([A-Za-z0-9_-]{1,32})\.history$/.exec(n);
      if (!m) continue;
      const from = path.join(this.showsDir, n), to = this.historyDir(m[1]);
      await fsp.mkdir(to, { recursive: true });
      for (const f of await fsp.readdir(from)) {
        if (!/^\d+\.json$/.test(f) || fs.existsSync(path.join(to, f))) continue;
        await fsp.rename(path.join(from, f), path.join(to, f));
      }
      await fsp.rm(from, { recursive: true, force: true });
    }
  }
  // 쓰기 직렬화: 앞 작업이 실패해도 큐는 계속 돈다
  serial(fn) {
    const p = this.q.then(fn, fn);
    this.q = p.catch(() => {});
    return p;
  }
  showFile(id) { return path.join(this.showsDir, id + '.json'); }
  audioDir(id) { return path.join(this.showsDir, id, 'audio'); }
  audioFile(id, key) { return path.join(this.audioDir(id), key); }
  historyDir(id) { return path.join(this.showsDir, id, 'history'); }
  authFile(id) { return path.join(this.showsDir, id, 'auth.json'); }

  async list() {
    let names;
    try { names = await fsp.readdir(this.showsDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json') || !ID_RE.test(n.slice(0, -5))) continue;
      const rec = await readJsonFile(path.join(this.showsDir, n)).catch(() => null);
      if (!rec || !rec.show) continue;
      const id = n.slice(0, -5);
      out.push({ id, title: String(rec.show.title || ''), rev: rec.rev, updatedAt: rec.updatedAt, ...countShow(rec.show), editDefault: !fs.existsSync(this.authFile(id)) });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }
  async count() {
    try { return (await fsp.readdir(this.showsDir)).filter(n => n.endsWith('.json') && ID_RE.test(n.slice(0, -5))).length; } catch (e) { return 0; }
  }
  get(id) { return readJsonFile(this.showFile(id)); }
  create(show, meta) {
    return this.serial(async () => {
      let id; do { id = newId(); } while (fs.existsSync(this.showFile(id)));
      const rec = Object.assign({ rev: 1, updatedAt: new Date().toISOString() }, writeMeta(meta), { show });
      await fsp.mkdir(this.audioDir(id), { recursive: true });
      await writeAtomic(this.showFile(id), JSON.stringify(rec));
      return { id, rev: rec.rev, updatedAt: rec.updatedAt };
    });
  }
  // baseRev 가 현재 rev 와 다르면 { conflict: 현재 레코드 }. 없는 프로젝트면 null. meta = { by, via } (아래 _write)
  // show.version 이 저장본보다 낮으면 { outdated: 현재 레코드 } — 업데이트 전에 열어 둔 옛 화면이 모르는 필드(v6 소품 등)를
  // 떨어뜨린 채 덮어쓰지 못하게. baseRev 보다 먼저 본다(옛 화면이 충돌의 "내 버전으로 덮어쓰기"로 돌아와도 같은 답)
  put(id, baseRev, show, meta) {
    return this.serial(async () => {
      const cur = await this.get(id);
      if (!cur) return null;
      if (Number(show && show.version) < Number(cur.show && cur.show.version)) return { outdated: cur };
      if (Number(baseRev) !== cur.rev) return { conflict: cur };
      const last = this.lastWrite.get(id);
      const snap = !last || last.by !== 'put' || Date.now() - last.snapAt >= this.putSnapshotMs;
      return this._write(id, cur, show, 'put', snap, writeMeta(meta));
    });
  }
  // 읽고-고치고-쓰기를 쓰기 큐 안에서. fn(현재 show 의 깊은 복사본, 현재 레코드) → 새 show (throw 하면 아무것도 안 씀).
  // 없는 프로젝트면 null. 쓰기 전 버전은 기록(history)에 남는다
  update(id, fn, meta) {
    return this.serial(async () => {
      const cur = await this.get(id);
      if (!cur) return null;
      const show = await fn(JSON.parse(JSON.stringify(cur.show)), { rev: cur.rev, updatedAt: cur.updatedAt });
      const why = invalidShow(show);
      if (why) throw new Error('invalid show: ' + why);
      return this._write(id, cur, show, 'update', true, writeMeta(meta));
    });
  }
  // 쓰기 큐 안에서만 부른다. extra(by·via·restoredFrom)는 새 버전에 붙는다 — 기록에 남을 때도 그 버전과 함께 간다
  async _write(id, cur, show, kind, snap, extra) {
    if (snap) await this._snapshot(id, cur);
    const rec = Object.assign({ rev: cur.rev + 1, updatedAt: new Date().toISOString() }, extra, { show });
    await writeAtomic(this.showFile(id), JSON.stringify(rec));
    const last = this.lastWrite.get(id);
    this.lastWrite.set(id, { by: kind, snapAt: snap ? Date.now() : (last ? last.snapAt : 0) });
    return { rev: rec.rev, updatedAt: rec.updatedAt };
  }
  async _snapshot(id, rec) {
    const dir = this.historyDir(id);
    await fsp.mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, rec.rev + '.json'), JSON.stringify(rec));
    const revs = await this._historyRevs(id);
    for (const r of revs.slice(this.historyKeep)) await fsp.rm(path.join(dir, r + '.json'), { force: true });
  }
  // 기록에 있는 rev 들, 최신 먼저
  async _historyRevs(id) {
    let names;
    try { names = await fsp.readdir(this.historyDir(id)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.filter(n => /^\d+\.json$/.test(n)).map(n => Number(n.slice(0, -5))).sort((a, b) => b - a);
  }
  // [{ rev, updatedAt, by, via, title, sceneCount, cueCount, current, restoredFrom }] 최신 먼저 (맨 앞이 현재 버전). 없는 프로젝트면 null.
  // by·via·restoredFrom 이 없는 버전은 null
  async revisions(id) {
    const cur = await this.get(id);
    if (!cur) return null;
    const row = (r, current) => ({ rev: r.rev, updatedAt: r.updatedAt, by: r.by || null, via: r.via || null, title: String((r.show && r.show.title) || ''), ...countShow(r.show), current, restoredFrom: r.restoredFrom || null });
    const out = [row(cur, true)];
    for (const rev of await this._historyRevs(id)) {
      if (rev >= cur.rev) continue;
      const r = await readJsonFile(path.join(this.historyDir(id), rev + '.json')).catch(() => null);
      if (r && r.show) out.push(row(r, false));
    }
    return out;
  }
  getRevision(id, rev) {
    if (!Number.isInteger(rev) || rev < 1) return Promise.resolve(null);
    return readJsonFile(path.join(this.historyDir(id), rev + '.json')).catch(() => null);
  }
  // 기록의 rev 내용으로 새로 쓴다(그래서 복원도 되돌릴 수 있다).
  // null = 프로젝트 없음, { missing: true } = 그 rev 가 기록에 없음, { unchanged: true, rev } = 이미 그 내용.
  // 그 사이 지워진 음원을 가리키는 트랙은 fileKey·fileName 을 비우고 warnings 로 알린다(없는 파일을 재생하려 하지 않게)
  // baseRev 를 주면 낙관적 잠금: 현재 rev 와 다르면 { conflict: 현재 레코드 }. meta = { by, via }
  restore(id, rev, baseRev, meta) {
    return this.serial(async () => {
      const cur = await this.get(id);
      if (!cur) return null;
      if (baseRev != null && Number(baseRev) !== cur.rev) return { conflict: cur };
      if (rev === cur.rev) return { unchanged: true, rev: cur.rev, updatedAt: cur.updatedAt };
      const old = await this.getRevision(id, rev);
      if (!old || !old.show) return { missing: true };
      const show = old.show, warnings = [];
      (Array.isArray(show.tracks) ? show.tracks : []).forEach(t => {
        if (!t || typeof t !== 'object' || !t.fileKey) return;
        const key = String(t.fileKey);
        if (KEY_RE.test(key) && fs.existsSync(this.audioFile(id, key))) return;
        warnings.push({ trackId: t.id, no: t.no, fileKey: key, msg: `BGM ${t.no}: audio file "${t.fileName || key}" is no longer on the server — the link was cleared; upload the file again in the web app` });
        t.fileKey = null; t.fileName = null;
      });
      if (JSON.stringify(show) === JSON.stringify(cur.show)) return { unchanged: true, rev: cur.rev, updatedAt: cur.updatedAt };
      const r = await this._write(id, cur, show, 'restore', true, Object.assign(writeMeta(meta), { restoredFrom: rev }));
      return Object.assign(r, { restoredFrom: rev, warnings });
    });
  }
  // 삭제 = 휴지통으로 이동. 레코드(<id>.json)와 shows/<id>/ 폴더(음원·기록·auth)를 내부 구조 그대로 옮긴다.
  // meta: { ip } 등 남길 정보. 없는 프로젝트면 false, 아니면 { trashId }
  remove(id, meta) {
    return this.serial(async () => {
      if (!fs.existsSync(this.showFile(id))) return false;
      const rec = await this.get(id).catch(() => null);
      let at = Date.now(), trashId;
      while (fs.existsSync(path.join(this.trashDir, trashId = id + '-' + at))) at++;
      const dir = path.join(this.trashDir, trashId);
      await fsp.mkdir(dir, { recursive: true });
      const m = Object.assign({ id, title: String((rec && rec.show && rec.show.title) || ''), rev: rec ? rec.rev : null, deletedAt: new Date(at).toISOString() }, meta);
      await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(m));
      if (fs.existsSync(path.join(this.showsDir, id))) await fsp.rename(path.join(this.showsDir, id), path.join(dir, 'files'));
      await fsp.rename(this.showFile(id), path.join(dir, 'show.json'));
      this.lastWrite.delete(id);
      return { trashId };
    });
  }

  // ---- 휴지통
  // [{ trashId, id, title, rev, deletedAt, expiresAt, daysLeft }] 최근 삭제 먼저. 삭제 IP 는 meta.json 에만 (응답에 넣지 않음)
  async trashList(now = Date.now()) {
    let names;
    try { names = await fsp.readdir(this.trashDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const n of names) {
      if (!TRASH_RE.test(n) || !fs.existsSync(path.join(this.trashDir, n, 'show.json'))) continue;
      const m = await readJsonFile(path.join(this.trashDir, n, 'meta.json')).catch(() => null);
      if (!m) continue;
      const exp = Date.parse(m.deletedAt) + this.trashDays * 86400000;
      out.push({ trashId: n, id: m.id, title: m.title, rev: m.rev, deletedAt: m.deletedAt, expiresAt: new Date(exp).toISOString(), daysLeft: Math.max(0, Math.ceil((exp - now) / 86400000)) });
    }
    out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    return out;
  }
  // 되살리기. 같은 id 가 이미 있으면 새 id 로. 없는 항목이면 null, 아니면 { id, originalId, title }
  trashRestore(trashId) {
    return this.serial(async () => {
      if (!TRASH_RE.test(String(trashId))) return null;
      const dir = path.join(this.trashDir, trashId);
      const m = await readJsonFile(path.join(dir, 'meta.json')).catch(() => null);
      if (!m || !fs.existsSync(path.join(dir, 'show.json'))) return null;
      let id = ID_RE.test(String(m.id)) ? m.id : null;
      while (!id || fs.existsSync(this.showFile(id)) || fs.existsSync(path.join(this.showsDir, id))) id = newId();
      if (fs.existsSync(path.join(dir, 'files'))) await fsp.rename(path.join(dir, 'files'), path.join(this.showsDir, id));
      await fsp.rename(path.join(dir, 'show.json'), this.showFile(id));
      await fsp.rm(dir, { recursive: true, force: true });
      this.lastWrite.delete(id);
      return { id, originalId: m.id, title: m.title };
    });
  }
  // trashDays 가 지난 항목 영구 삭제. 지운 trashId 목록
  trashPurge(now = Date.now()) {
    return this.serial(async () => {
      const gone = [];
      for (const t of await this.trashList(now)) {
        if (Date.parse(t.expiresAt) > now) continue;
        await fsp.rm(path.join(this.trashDir, t.trashId), { recursive: true, force: true });
        gone.push(t.trashId);
      }
      return gone;
    });
  }
  // ---- 편집 비밀번호 (해시 레코드만 다룬다. 검증은 lib/editkey.js)
  getAuth(id) { return readJsonFile(this.authFile(id)).catch(() => null); }
  // null 이면 지워서 기본 비밀번호 상태로
  setAuth(id, auth) {
    return this.serial(async () => {
      if (!auth) { await fsp.rm(this.authFile(id), { force: true }); return; }
      await fsp.mkdir(path.dirname(this.authFile(id)), { recursive: true });
      await writeAtomic(this.authFile(id), JSON.stringify(auth));
    });
  }
  // 복제: show 와 음원 폴더를 그대로 복사 (fileKey 가 같아 트랙 정보가 그대로 맞는다)
  duplicate(id, meta) {
    return this.serial(async () => {
      const cur = await this.get(id);
      if (!cur) return null;
      let nid; do { nid = newId(); } while (fs.existsSync(this.showFile(nid)));
      const show = Object.assign({}, cur.show, { title: (cur.show.title || '') + ' (복제)' });
      const rec = Object.assign({ rev: 1, updatedAt: new Date().toISOString() }, writeMeta(meta), { show });
      await fsp.mkdir(this.audioDir(nid), { recursive: true });
      if (fs.existsSync(this.audioDir(id))) {
        for (const n of await fsp.readdir(this.audioDir(id))) {
          if (n.includes('.tmp-')) continue;
          await fsp.copyFile(path.join(this.audioDir(id), n), path.join(this.audioDir(nid), n));
        }
      }
      await writeAtomic(this.showFile(nid), JSON.stringify(rec));
      return { id: nid, rev: rec.rev, updatedAt: rec.updatedAt };
    });
  }

  // ---- 음원
  async audioMeta(id, key) { return readJsonFile(this.audioFile(id, key) + '.json'); }
  async audioList(id) {
    let names;
    try { names = await fsp.readdir(this.audioDir(id)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.includes('.tmp-')) continue;
      const key = n.slice(0, -5);
      if (!KEY_RE.test(key)) continue;
      const m = await readJsonFile(path.join(this.audioDir(id), n)).catch(() => null);
      if (m) out.push({ fileKey: key, name: m.name, size: m.size, mime: m.mime });
    }
    return out;
  }
  // 스트림을 임시 파일에 쓴 뒤 rename. limit 초과면 { tooLarge: true }
  async audioPut(id, key, stream, { name, mime, limit }) {
    const dir = this.audioDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const file = this.audioFile(id, key), tmp = tmpName(file);
    let size = 0, tooLarge = false;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      out.on('error', reject);
      stream.on('error', reject);
      stream.on('data', chunk => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > limit) { tooLarge = true; out.destroy(); stream.resume(); return; }
        if (!out.write(chunk)) { stream.pause(); out.once('drain', () => stream.resume()); }
      });
      stream.on('end', () => { if (tooLarge) resolve(); else out.end(resolve); });
    });
    if (tooLarge) { await fsp.rm(tmp, { force: true }); return { tooLarge: true }; }
    const meta = { fileKey: key, name, mime, size };
    await this.serial(async () => {
      await fsp.rename(tmp, file);
      await writeAtomic(file + '.json', JSON.stringify(meta));
    });
    return meta;
  }
  audioDel(id, key) {
    return this.serial(async () => {
      const had = fs.existsSync(this.audioFile(id, key) + '.json') || fs.existsSync(this.audioFile(id, key));
      await fsp.rm(this.audioFile(id, key), { force: true });
      await fsp.rm(this.audioFile(id, key) + '.json', { force: true });
      return had;
    });
  }
  audioClear(id) {
    return this.serial(async () => {
      await fsp.rm(this.audioDir(id), { recursive: true, force: true });
      await fsp.mkdir(this.audioDir(id), { recursive: true });
    });
  }
}

module.exports = { Store, ID_RE, KEY_RE, invalidShow, HISTORY_KEEP, TRASH_DAYS };
