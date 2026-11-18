#!/usr/bin/env node
// 도움말 원본(docs/help/*.json · crew-guide.md)을 index.html 의 <script type="application/json" id="help-data"> 한 줄로 넣는다 — 의존성 없음
//   node scripts/embed-help.js           index.html 을 다시 쓴다
//   node scripts/embed-help.js --check   다시 쓰지 않고 같은지만 본다 (다르면 종료 코드 1)
// 도움말은 docs/help/*.json 을 고친 뒤 이 스크립트를 돌린다. test/help.test.js 가 어긋나면 실패한다
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HELP_DIR = path.join(ROOT, 'docs', 'help');
const INDEX = path.join(ROOT, 'index.html');
const OPEN = '<script type="application/json" id="help-data">', CLOSE = '</script>';

function readJson(dir, name) { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }

// 크루 안내 마크다운: "# 제목" / 소개 문단 / "## 역할" + "- 항목"
function parseCrew(md) {
  const crew = { title: '', intro: '', roles: [] };
  md.split('\n').forEach(l => {
    if (/^# /.test(l)) crew.title = l.slice(2).trim();
    else if (/^## /.test(l)) crew.roles.push({ r: l.slice(3).trim(), i: [] });
    else if (/^- /.test(l) && crew.roles.length) crew.roles[crew.roles.length - 1].i.push(l.slice(2).trim());
    else if (l.trim() && !crew.roles.length) crew.intro += (crew.intro ? ' ' : '') + l.trim();
  });
  return crew;
}

// 화면이 읽는 줄인 모양 { a: 글, g: 용어, tip: 큐 모달 팁, crew: 크루 안내 } — 짧은 키로
function build(dir) {
  dir = dir || HELP_DIR;
  const arts = readJson(dir, 'articles.json'), gl = readJson(dir, 'glossary.json'), tips = readJson(dir, 'modal-tips.json');
  const data = {
    a: arts.map(x => ({ id: x.id, t: x.title, r: x.roles, s: x.summary, b: x.body })),
    g: gl.map(x => x.seeAlso ? { t: x.term, d: x.desc, s: x.seeAlso } : { t: x.term, d: x.desc }),
    tip: tips.map(x => ({ f: x.field, t: x.tip, a: x.articleId })),
    crew: parseCrew(fs.readFileSync(path.join(dir, 'crew-guide.md'), 'utf8'))
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// index.html 안에 지금 들어 있는 한 줄
function embedded(html) {
  const a = html.indexOf(OPEN); if (a < 0) return null;
  const b = html.indexOf(CLOSE, a); return b < 0 ? null : html.slice(a + OPEN.length, b);
}

function embed(html, json) {
  const a = html.indexOf(OPEN); if (a < 0) throw new Error('index.html 에 ' + OPEN + ' 자리가 없습니다');
  const b = html.indexOf(CLOSE, a);
  return html.slice(0, a + OPEN.length) + json + html.slice(b);
}

module.exports = { build, embedded, embed, parseCrew, HELP_DIR, INDEX };

if (require.main === module) {
  const json = build(), html = fs.readFileSync(INDEX, 'utf8');
  if (process.argv.includes('--check')) {
    const same = embedded(html) === json;
    console.log(same ? '도움말: index.html 과 docs/help 가 같습니다' : '도움말: index.html 이 docs/help 와 다릅니다 — node scripts/embed-help.js 를 돌리세요');
    process.exit(same ? 0 : 1);
  }
  const out = embed(html, json);
  if (out === html) console.log('도움말: 바뀐 것 없음');
  else { fs.writeFileSync(INDEX, out); console.log('도움말을 index.html 에 넣었습니다 (' + json.length + '자)'); }
}
