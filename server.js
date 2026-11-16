const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
// 지금은 index.html 과 /healthz 만 서빙. 정적 파일·API 는 이후 추가.
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const text = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(body); };
  if (!['GET', 'HEAD'].includes(req.method) || url.includes('..')) return text(404, 'not found');
  if (url === '/healthz') return text(200, 'ok');
  if (url === '/' || url === '/index.html') {
    return fs.readFile(INDEX, (err, data) => {
      if (err) return text(500, 'error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }
  text(404, 'not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`cue-sheet listening on :${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
