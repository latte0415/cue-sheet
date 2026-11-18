// 프로젝트(공연) 단위 파일 저장소
//   DATA_DIR/shows/<id>.json              { rev, updatedAt, show }
//   DATA_DIR/shows/<id>/audio/<fileKey>    음원 원본
//   DATA_DIR/shows/<id>/audio/<fileKey>.json  { fileKey, name, mime, size }
// 쓰기는 임시 파일 → rename(원자적). 같은 프로세스 안의 쓰기는 Promise 큐 하나로 직렬화한다.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { basicInvalid } = require('./validate');

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
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
  constructor(dataDir) {
    this.dir = path.resolve(dataDir);
    this.showsDir = path.join(this.dir, 'shows');
    this.q = Promise.resolve();
  }
  async init() { await fsp.mkdir(this.showsDir, { recursive: true }); }
  // 쓰기 직렬화: 앞 작업이 실패해도 큐는 계속 돈다
  serial(fn) {
    const p = this.q.then(fn, fn);
    this.q = p.catch(() => {});
    return p;
  }
  showFile(id) { return path.join(this.showsDir, id + '.json'); }
  audioDir(id) { return path.join(this.showsDir, id, 'audio'); }
  audioFile(id, key) { return path.join(this.audioDir(id), key); }

  async list() {
    let names;
    try { names = await fsp.readdir(this.showsDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json') || !ID_RE.test(n.slice(0, -5))) continue;
      const rec = await readJsonFile(path.join(this.showsDir, n)).catch(() => null);
      if (!rec || !rec.show) continue;
      out.push({ id: n.slice(0, -5), title: String(rec.show.title || ''), rev: rec.rev, updatedAt: rec.updatedAt, ...countShow(rec.show) });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }
  async count() {
    try { return (await fsp.readdir(this.showsDir)).filter(n => n.endsWith('.json') && ID_RE.test(n.slice(0, -5))).length; } catch (e) { return 0; }
  }
  get(id) { return readJsonFile(this.showFile(id)); }
  create(show) {
    return this.serial(async () => {
      let id; do { id = newId(); } while (fs.existsSync(this.showFile(id)));
      const rec = { rev: 1, updatedAt: new Date().toISOString(), show };
      await fsp.mkdir(this.audioDir(id), { recursive: true });
      await writeAtomic(this.showFile(id), JSON.stringify(rec));
      return { id, rev: rec.rev, updatedAt: rec.updatedAt };
    });
  }
  // baseRev 가 현재 rev 와 다르면 { conflict: 현재 레코드 }. 없는 프로젝트면 null
  put(id, baseRev, show) {
    return this.serial(async () => {
      const cur = await this.get(id);
      if (!cur) return null;
      if (Number(baseRev) !== cur.rev) return { conflict: cur };
      const rec = { rev: cur.rev + 1, updatedAt: new Date().toISOString(), show };
      await writeAtomic(this.showFile(id), JSON.stringify(rec));
      return { rev: rec.rev, updatedAt: rec.updatedAt };
    });
  }
  remove(id) {
    return this.serial(async () => {
      if (!fs.existsSync(this.showFile(id))) return false;
      await fsp.rm(path.join(this.showsDir, id), { recursive: true, force: true });
      await fsp.rm(this.showFile(id), { force: true });
      return true;
    });
  }
  // 복제: show 와 음원 폴더를 그대로 복사 (fileKey 가 같아 트랙 정보가 그대로 맞는다)
  duplicate(id) {
    return this.serial(async () => {
      const cur = await this.get(id);
      if (!cur) return null;
      let nid; do { nid = newId(); } while (fs.existsSync(this.showFile(nid)));
      const show = Object.assign({}, cur.show, { title: (cur.show.title || '') + ' (복제)' });
      const rec = { rev: 1, updatedAt: new Date().toISOString(), show };
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

module.exports = { Store, ID_RE, KEY_RE, invalidShow };
