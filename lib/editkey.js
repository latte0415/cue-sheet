// 프로젝트별 편집 비밀번호 — 해시·검증과 실패 횟수 제한 (Node 내장 crypto 만)
//   저장 형식(DATA_DIR/shows/<id>/auth.json): { v: 1, algo: 'scrypt', N, r, p, salt, hash, changedAt }  (salt·hash 는 base64)
//   auth.json 이 없으면 기본 비밀번호(DEFAULT_EDIT_KEY) 상태로 본다. 평문은 어디에도 저장하지 않는다.
const crypto = require('crypto');

const DEFAULT_EDIT_KEY = '1234';
const MIN_LEN = 4, MAX_LEN = 200;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scrypt(pw, salt, o) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pw), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? reject(e) : resolve(k)));
}
async function hashKey(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, SCRYPT);
  return { v: 1, algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: hash.toString('base64'), changedAt: new Date().toISOString() };
}
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
// auth 가 null 이면 기본 비밀번호와 비교. 길이가 다른 버퍼는 timingSafeEqual 이 던지므로 같은 길이로 맞춘다
async function verifyKey(auth, given) {
  if (typeof given !== 'string' || !given) return false;
  if (!auth) return crypto.timingSafeEqual(sha(given), sha(DEFAULT_EDIT_KEY));
  const want = Buffer.from(String(auth.hash || ''), 'base64');
  if (!want.length) return false;
  const got = await scrypt(given, Buffer.from(String(auth.salt || ''), 'base64'), { N: auth.N || SCRYPT.N, r: auth.r || SCRYPT.r, p: auth.p || SCRYPT.p, keylen: want.length });
  return crypto.timingSafeEqual(got, want);
}
// 새 비밀번호 검사. 문제 없으면 null, 있으면 이유 문자열 (글자 수는 코드포인트 기준)
function badNewKey(pw) {
  if (typeof pw !== 'string') return '새 비밀번호가 없습니다';
  const n = Array.from(pw).length;
  if (n < MIN_LEN) return `새 비밀번호는 ${MIN_LEN}자 이상이어야 합니다`;
  if (n > MAX_LEN) return `새 비밀번호는 ${MAX_LEN}자 이하여야 합니다`;
  return null;
}

// 고정 창 실패 카운터: 같은 키(IP|프로젝트)로 windowMs 안에 max 번 틀리면 창이 끝날 때까지 막는다
class FailLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.m = new Map(); }
  // 막혀 있으면 남은 초, 아니면 0
  blocked(k, now = Date.now()) {
    const e = this.m.get(k);
    if (!e || e.reset <= now) return 0;
    return e.n >= this.max ? Math.ceil((e.reset - now) / 1000) : 0;
  }
  fail(k, now = Date.now()) {
    let e = this.m.get(k);
    if (!e || e.reset <= now) { e = { n: 0, reset: now + this.windowMs }; this.m.set(k, e); }
    e.n++;
    if (this.m.size > 5000) for (const [key, v] of this.m) if (v.reset <= now) this.m.delete(key);
  }
}

module.exports = { DEFAULT_EDIT_KEY, hashKey, verifyKey, badNewKey, FailLimiter };
