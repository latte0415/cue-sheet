// 도움말 원본(docs/help) — index.html 에 넣은 한 줄과 같은지, 글·용어·팁이 서로 가리키는 곳이 다 있는지
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../scripts/embed-help');

const dir = H.HELP_DIR;
const read = n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const arts = read('articles.json'), gl = read('glossary.json'), tips = read('modal-tips.json'), empty = read('empty-states.json');
const ROLES = ['연출·작성', '출연자', '조명·음향', '무대'];
const artIds = new Set(arts.map(a => a.id)), terms = new Set(gl.map(g => g.term));

test('index.html 의 #help-data 가 docs/help 와 같다 (다르면: node scripts/embed-help.js)', () => {
  const html = fs.readFileSync(H.INDEX, 'utf8');
  const cur = H.embedded(html);
  assert.ok(cur != null, 'index.html 에 <script type="application/json" id="help-data"> 가 없습니다');
  assert.equal(cur, H.build(), 'index.html 의 도움말이 docs/help 와 다릅니다 — node scripts/embed-help.js 를 돌리세요');
  const d = JSON.parse(cur);
  assert.equal(d.a.length, arts.length); assert.equal(d.g.length, gl.length); assert.equal(d.tip.length, tips.length);
});

test('글: id 겹침 없음 · 역할은 네 가지 중에서 · 제목·요약·본문 있음', () => {
  assert.equal(artIds.size, arts.length, '글 id 가 겹칩니다');
  arts.forEach(a => {
    assert.ok(a.title && a.summary && a.body, a.id);
    assert.ok(a.roles.length && a.roles.every(r => ROLES.includes(r)), `${a.id}: 역할 ${a.roles}`);
  });
});

test('화면의 data-help 가 가리키는 글이 다 있다 (index.html)', () => {
  const html = fs.readFileSync(H.INDEX, 'utf8');
  const ids = new Set([...html.matchAll(/data-help="([a-z0-9-]+)"/g)].map(m => m[1]).concat([...html.matchAll(/(?:nextHtml|helpA)\('([a-z0-9-]+)'/g)].map(m => m[1])));
  assert.ok(ids.size >= 8, [...ids].join());
  ids.forEach(id => assert.ok(artIds.has(id), `없는 글: ${id}`));
});

test('용어: 이름 겹침 없음 · "함께 보기" 가 가리키는 용어가 다 있다', () => {
  assert.equal(terms.size, gl.length, '용어가 겹칩니다');
  gl.forEach(g => {
    assert.ok(g.desc, g.term);
    (g.seeAlso || []).forEach(s => { assert.ok(terms.has(s), `${g.term} → 없는 용어 "${s}"`); assert.notEqual(s, g.term); });
  });
});

test('팁 · 빈 화면 안내가 가리키는 글이 다 있다', () => {
  tips.forEach(t => assert.ok(t.field && t.tip && artIds.has(t.articleId), `${t.field} → ${t.articleId}`));
  empty.forEach(e => assert.ok(e.text && artIds.has(e.articleId), `${e.place} → ${e.articleId}`));
});

test('글 본문의 "따옴표 말" 중 글 제목 모양인 링크 대상이 있다 · 바뀐 옛 용어가 없다', () => {
  const titles = new Set(arts.map(a => a.title));
  arts.forEach(a => {
    // "다음: "글 제목"" 은 화면에서 글 링크가 된다 — 제목이 바뀌면 끊어지므로 확인
    const m = /다음:([^\n]*)$/.exec(a.body);
    if (m) [...m[1].matchAll(/"([^"]+)"/g)].forEach(x => assert.ok(titles.has(x[1]), `${a.id}: 다음 → 없는 글 "${x[1]}"`));
  });
  const all = JSON.stringify([arts, gl, tips, empty]) + fs.readFileSync(path.join(dir, 'crew-guide.md'), 'utf8');
  ['큐만 있는 줄', '큐 지점', '상세(채널)', '머리글 미리보기', '데이터 메뉴', '공연 모드', '판 이름', '점검 탭', '저장됨 · rev'].forEach(w => assert.ok(!all.includes(w), `옛 화면 용어 "${w}" 가 남아 있습니다`));
});

test('크루 안내: 네 역할 절이 있고 역할 이름은 글 역할로 시작한다', () => {
  const c = H.parseCrew(fs.readFileSync(path.join(dir, 'crew-guide.md'), 'utf8'));
  assert.ok(c.title && c.intro);
  assert.equal(c.roles.length, 4);
  ROLES.forEach(r => assert.ok(c.roles.some(x => x.r.indexOf(r) === 0 && x.i.length), r));
});
