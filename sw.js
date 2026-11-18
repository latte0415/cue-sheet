// 공연 모드용 Service Worker — 서버 모드에서 공연 모드를 켠 기기만 등록한다(index.html smSwSync). file://·아티팩트(로컬 모드)에서는 등록하지 않는다.
// 하는 일은 하나: 공연 중 실수로 새로고침해도 네트워크 없이 화면이 뜨게 화면(index.html)과 /lib/merge.js 의 마지막 사본을 둔다.
//   늘 네트워크 먼저 — 네트워크가 안 되거나(오류·5xx) WAIT_MS 안에 답이 없을 때만 사본으로 답한다. 연결돼 있으면 새 배포를 바로 받는다.
//   사본으로 답했는데 나중에 받은 새 화면이 다르면 그 페이지에 shell-updated 를 보낸다(페이지가 "새 화면이 배포되었습니다" 바).
// /api(큐시트·음원)·/mcp 는 건드리지 않는다 — 오프라인 음원은 페이지가 IndexedDB 에 받아 둔 것으로, 큐시트는 localStorage 사본으로 연다.
const CACHE = 'cue-sheet-shell-1';
const SHELL = { '/': '/', '/index.html': '/', '/lib/merge.js': '/lib/merge.js' };
const WAIT_MS = 4000;
// 이 워커가 사본으로 답한 적이 있나(워커가 새로 떠서 모르면 true) — 페이지의 check 요청 때 새 화면을 받아 비교할지
let stale = true;

const fresh = key => fetch(key, { cache: 'no-store', credentials: 'same-origin' }).then(r => {
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
});
const notify = (clientId) => (clientId ? self.clients.get(clientId).then(c => c && [c]) : self.clients.matchAll({ type: 'window' }))
  .then(cs => (cs || []).forEach(c => c.postMessage({ type: 'shell-updated' })));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(['/', '/lib/merge.js'].map(k => fresh(k).then(r => c.put(k, r)))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.indexOf('cue-sheet-shell-') === 0 && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;
  const key = SHELL[u.pathname];
  if (!key || (key === '/' && req.mode !== 'navigate')) return;
  e.respondWith(netFirst(key, e));
});
async function netFirst(key, e) {
  const cache = await caches.open(CACHE);
  const net = fresh(key).then(r => cache.put(key, r.clone()).then(() => r));
  let timer;
  const late = new Promise(res => { timer = setTimeout(res, WAIT_MS, 'late'); });
  try {
    const r = await Promise.race([net, late]);
    if (r !== 'late') { clearTimeout(timer); if (key === '/') stale = false; return r; }
  } catch (err) { clearTimeout(timer); /* 네트워크 오류·5xx → 사본 */ }
  const hit = await cache.match(key);
  if (!hit) return net; // 사본이 없으면 네트워크를 끝까지 기다린다
  if (key === '/') {
    stale = true;
    // 늦게라도 새 화면이 오면 사본과 비교해 그 페이지에 알린다
    const old = await hit.clone().text();
    e.waitUntil(net.then(r => r.clone().text()).then(t => { if (t !== old) return notify(e.resultingClientId || e.clientId); }).catch(() => {}));
  } else e.waitUntil(net.catch(() => {}));
  return hit;
}
// 페이지가 서버와 다시 연결되면 묻는다: 사본으로 떴었다면 새 화면을 받아 사본과 비교하고, 다르면 사본을 바꾸고 알린다
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'check' || !stale) return;
  const src = e.source;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const old = await cache.match('/');
    let r;
    try { r = await fresh('/'); } catch (err) { return; }
    const [a, b] = await Promise.all([old ? old.text() : null, r.clone().text()]);
    await cache.put('/', r);
    stale = false;
    fresh('/lib/merge.js').then(m => cache.put('/lib/merge.js', m)).catch(() => {});
    if (a !== null && a !== b && src) src.postMessage({ type: 'shell-updated' });
  })());
});
