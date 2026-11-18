// 사람별 MCP 토큰 — 협업자마다 자기 토큰으로 에이전트를 붙여, 수정 기록에 이름이 남고 토큰만 따로 폐기할 수 있게 한다
//   DATA_DIR/tokens.json   [{ id, name, hash, createdAt, lastUsedAt }]  — hash = 토큰의 sha256 hex. 토큰 원문은 저장하지 않는다
// 토큰 형식: "cue_" + 무작위 32바이트 base64url (256비트). 발급할 때 한 번만 돌려준다.
// 쓰기는 store.js 처럼 임시 파일 → rename, Promise 큐 하나로 직렬화. 파일은 이 프로세스만 쓰므로 시작할 때 한 번 읽어 메모리에 둔다.
//
// 조회가 왜 시간 차이로 새지 않는가: 받은 문자열을 sha256 한 값으로 Map 을 찾는다. Map 조회 시간은 "sha256(입력)" 이 저장된
// 해시와 얼마나 닮았는지에 따라 달라질 수 있지만, 공격자가 그걸로 알아낼 수 있는 건 저장된 해시의 일부뿐이고, 해시에서 토큰을
// 되돌릴 수 없다(역상 저항). 원하는 해시 접두어가 나오는 입력을 고르는 것도 sha256 이라 불가능하다. 토큰 자체를 한 글자씩
// 비교하는 경로는 없으니 timingSafeEqual 로 하나씩 비교할 필요가 없다.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'cue_';
const NAME_MAX = 40;
const TOUCH_MS = 60 * 1000; // lastUsedAt 은 토큰마다 1분에 한 번만 파일에 쓴다
// 기록(by)에 이미 쓰는 이름 — 토큰 이름으로 쓰면 누가 고쳤는지 헷갈린다
const RESERVED = ['관리자', '사이트 비밀번호', '브라우저', '익명'];

class TokenError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const sha256hex = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const newToken = () => PREFIX + crypto.randomBytes(32).toString('base64url');
const newId = () => 'tk-' + crypto.randomBytes(6).toString('hex');
// 중복·예약어 비교용: NFKC(전각 "ＡＬＩＣＥ" → "ALICE" 같은 호환 문자 통일) + 대소문자 무시 + 공백 하나로
const nameKey = s => s.normalize('NFKC').toUpperCase().toLowerCase().replace(/\s+/g, ' ').trim();
// 보이지 않거나 줄을 바꾸는 문자: 제어(Cc, C1 포함)·서식(Cf: 폭 없는 공백, 양방향 제어 …)·대리·사용자 정의·미할당(\p{C}), 줄·문단 구분자.
// "관리자\u200b" 처럼 예약 이름과 똑같아 보이는 이름이나 list_revisions 한 줄을 깨는 이름을 막는다
const INVISIBLE = /[\p{C}\p{Zl}\p{Zp}]/u;

// 이름: 앞뒤 공백 제거, 1~40자, 보이지 않는 문자 없음. 통과하면 정리한 이름(NFC), 아니면 TokenError
function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new TokenError(400, 'bad_name', '이름을 입력하세요');
  const n = name.trim().normalize('NFC');
  if ([...n].length > NAME_MAX) throw new TokenError(400, 'bad_name', `이름은 ${NAME_MAX}자 이하로 쓰세요`);
  if (INVISIBLE.test(n)) throw new TokenError(400, 'bad_name', '이름에 줄바꿈·제어 문자·보이지 않는 문자를 쓸 수 없습니다');
  if (!nameKey(n)) throw new TokenError(400, 'bad_name', '이름을 입력하세요');
  if (RESERVED.some(r => nameKey(r) === nameKey(n))) throw new TokenError(400, 'bad_name', `"${n}" 은 기록에 따로 쓰는 이름이라 쓸 수 없습니다`);
  return n;
}

class Tokens {
  constructor(dataDir) {
    this.dir = path.resolve(dataDir);
    this.file = path.join(this.dir, 'tokens.json');
    this.q = Promise.resolve();
    this.rows = [];             // 파일과 같은 모양
    this.byHash = new Map();    // hash → row
    this.revoked = new Set();   // 폐기 요청을 받은 hash — 파일에 반영되기 전에도(쓰기 대기·실패 중에도) 이 프로세스에서는 바로 거부
    this.onerror = e => console.error('tokens:', e && e.message ? e.message : e);
  }
  // 파일이 깨져 있으면 시작을 멈춘다 — 빈 목록으로 시작해 다음 발급 때 덮어쓰면 기존 토큰이 다 사라진다
  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    let raw;
    try { raw = await fsp.readFile(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') raw = null; else throw e; }
    let rows = [];
    if (raw != null) {
      try { rows = JSON.parse(raw); } catch (e) { throw new Error(`${this.file} 를 읽을 수 없습니다 (JSON 오류): ${e.message}`); }
      if (!Array.isArray(rows)) throw new Error(`${this.file} 의 형식이 틀렸습니다 (배열이 아님)`);
    }
    this.rows = rows.filter(r => r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.hash === 'string' && /^[0-9a-f]{64}$/.test(r.hash));
    this.byHash = new Map(this.rows.map(r => [r.hash, r]));
  }
  serial(fn) {
    const p = this.q.then(fn, fn);
    this.q = p.catch(() => {});
    return p;
  }
  // 쓰기 큐가 빌 때까지 (테스트·종료용)
  idle() { return this.q; }
  // next(기본: 지금 목록)에서 폐기 요청된 것을 빼고 파일에 쓴 뒤, 성공했을 때만 메모리를 바꾼다(실패하면 메모리·파일 모두 이전 그대로).
  // 쓰기 큐 안에서만 부른다
  async _save(next) {
    const drop = new Set([...this.revoked].filter(h => (next || this.rows).some(r => r.hash === h)));
    const rows = (next || this.rows).filter(r => !drop.has(r.hash));
    const tmp = this.file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    try {
      await fsp.writeFile(tmp, JSON.stringify(rows, null, 1));
      await fsp.rename(tmp, this.file);
    } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
    this.rows = rows;
    for (const h of drop) { this.byHash.delete(h); this.revoked.delete(h); }
  }
  get size() { return this.rows.length; }
  // 해시 없이 [{ id, name, createdAt, lastUsedAt }] 발급 순
  list() { return this.rows.map(r => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt || null })); }
  // → { token(원문, 이번 한 번만), id, name, createdAt }
  create(name) {
    return this.serial(async () => {
      const n = cleanName(name);
      if (this.rows.some(r => nameKey(r.name) === nameKey(n))) throw new TokenError(409, 'name_taken', `"${n}" 이름의 토큰이 이미 있습니다 — 다른 이름을 쓰거나 기존 토큰을 폐기하세요`);
      const token = newToken();
      let id; do { id = newId(); } while (this.rows.some(r => r.id === id));
      const row = { id, name: n, hash: sha256hex(token), createdAt: new Date().toISOString(), lastUsedAt: null };
      await this._save(this.rows.concat(row));
      this.byHash.set(row.hash, row);
      return { token, id, name: n, createdAt: row.createdAt };
    });
  }
  // 있으면 true. 부르는 즉시(쓰기 큐를 기다리기 전에) revoked 에 넣으므로 바로 다음 요청부터 거부된다.
  // 파일 쓰기가 실패하면 reject — 이 프로세스에서는 계속 거부되고 목록에는 남아 다시 폐기할 수 있다. 다만 파일에는 아직 있으므로
  // 다시 폐기하거나 다른 쓰기(발급 등)가 성공하기 전에 서버가 재시작되면 그 토큰은 다시 통한다
  revoke(id) {
    const row = this.rows.find(r => r.id === id);
    if (row) this.revoked.add(row.hash);
    return this.serial(async () => {
      const cur = this.rows.find(r => r.id === id);
      if (!cur) return false;
      this.revoked.add(cur.hash);
      await this._save();
      return true;
    });
  }
  // 토큰 원문 → { id, name } 또는 null. 맞으면 lastUsedAt 을 갱신한다(파일에는 1분에 한 번, 기다리지 않음)
  lookup(token) {
    if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 200) return null;
    const hash = sha256hex(token);
    if (this.revoked.has(hash)) return null;
    const row = this.byHash.get(hash);
    if (!row) return null;
    const now = Date.now();
    if (!row.lastUsedAt || now - Date.parse(row.lastUsedAt) >= TOUCH_MS) {
      row.lastUsedAt = new Date(now).toISOString();
      this.serial(() => (this.byHash.get(row.hash) === row && !this.revoked.has(row.hash) ? this._save() : null)).catch(this.onerror);
    }
    return { id: row.id, name: row.name };
  }
}

module.exports = { Tokens, TokenError, cleanName, sha256hex, PREFIX, NAME_MAX, TOUCH_MS, RESERVED };
