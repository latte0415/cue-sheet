// 문단 안 줄바꿈(Shift+Enter → text 의 \n): 화자·동작 판정은 첫 줄만, 저장·검사는 \n 을 그대로 둔다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { validateShow, basicInvalid } = require('../lib/validate');
const { Store } = require('../lib/store');

// index.html 의 "상수"·"유틸" 구간과 "문단 문법" 구간(+ textOf)만 떼어 Node 에서 돌린다
function grammar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cut = (from, label) => {
    const a = html.indexOf(from);
    const b = html.indexOf('/* =================', a + from.length);
    assert.ok(a > 0 && b > a, `index.html 에서 ${label} 구간 표시를 찾지 못했습니다 (구간 주석이 바뀌었으면 이 테스트를 고치세요)`);
    return html.slice(a, b);
  };
  const consts = cut('/* ================= 상수', '상수');
  const utils = cut('/* ================= 유틸', '유틸');
  const parse = cut('/* ================= 문단 문법', '문단 문법');
  const textOf = /^function textOf\(p\).*$/m.exec(html);
  assert.ok(textOf, 'index.html 에서 textOf 를 찾지 못했습니다');
  const people = [{ id: 'p-a', name: '박대훈' }, { id: 'p-b', name: '조예준' }];
  const ctx = {
    state: { show: { people } },
    IDX: { people: new Map(people.map(p => [p.id, p])) }
  };
  return vm.runInNewContext(consts + utils + parse + textOf[0] + '\n;({ splitHead, applyParse, itemToRaw, rawToHtml, newItem, textOf })', ctx);
}
const G = grammar();

test('splitHead: 화자 머리말은 첫 줄로 판정하고 둘째 줄 이후는 본문(rest)에 붙는다', () => {
  const s = G.splitHead('박대훈: 첫 줄\n둘째 줄');
  assert.equal(s.kind, 'line');
  assert.equal(s.name, '박대훈');
  assert.equal(s.rest, ' 첫 줄\n둘째 줄');
});

test('splitHead: 둘째 줄의 "이름:" 이나 "(" 때문에 화자·종류가 바뀌지 않는다', () => {
  assert.deepEqual({ ...G.splitHead('그냥 대사\n조예준: 이건 본문') }, { kind: 'line' });
  assert.deepEqual({ ...G.splitHead('그냥 대사\n(동작처럼 보이는 줄)') }, { kind: 'line' });
  // 첫 줄이 이름뿐이고 둘째 줄이 ":" 로 시작해도 화자 머리말이 아니다
  assert.deepEqual({ ...G.splitHead('박대훈\n: 대사') }, { kind: 'line' });
  // 따옴표형 머리말(이름 "대사")도 첫 줄 안에서만
  assert.deepEqual({ ...G.splitHead('박대훈\n"안녕하세요"') }, { kind: 'line' });
  assert.equal(G.splitHead('박대훈 "안녕하세요"\n다음 줄').rest, ' "안녕하세요"\n다음 줄');
  // 빈 첫 줄 뒤의 "(" 도 동작이 아니다 — 판정은 첫 줄만
  assert.equal(G.splitHead('\n(동작)').kind, 'line');
});

test('splitHead: 첫 줄이 동작이면 뒤 줄과 상관없이 동작', () => {
  assert.equal(G.splitHead('(마술사 등장)\n박대훈: 대사처럼 보이는 줄').kind, 'action');
});

test('applyParse ↔ itemToRaw: 줄바꿈이 든 문단도 화자를 유지하고 한 문단으로 왕복한다', () => {
  const it = G.newItem('line');
  G.applyParse(it, '박대훈: 안녕하세요\n반갑습니다', false, null);
  assert.equal(it.kind, 'line');
  assert.equal(it.speaker, 'p-a');
  assert.equal(it.text, '안녕하세요\n반갑습니다');
  assert.equal(G.itemToRaw(it), '박대훈: 안녕하세요\n반갑습니다');
  // 화자 없는 대사
  const b = G.newItem('line');
  G.applyParse(b, '첫 줄\n박대훈: 둘째 줄', false, null);
  assert.equal(b.speaker, null);
  assert.equal(b.text, '첫 줄\n박대훈: 둘째 줄');
  // 동작 문단
  const c = G.newItem('line');
  G.applyParse(c, '(카드를 뒤집는다)\n천천히', false, null);
  assert.equal(c.kind, 'action');
  assert.equal(c.text, '(카드를 뒤집는다)\n천천히');
  assert.equal(G.itemToRaw(c), '(카드를 뒤집는다)\n천천히');
  // 괄호 없이 들어온 동작 text 는 첫 줄 기준으로 괄호를 덧씌운다
  assert.equal(G.itemToRaw({ kind: 'action', speaker: null, text: '첫 줄\n(둘째 줄)' }), '(첫 줄\n(둘째 줄))');
});

test('rawToHtml: 줄바꿈은 그대로 두고, 끝 줄바꿈엔 커서용 <br>, 이스케이프는 유지', () => {
  assert.equal(G.rawToHtml('그냥 대사\n<b>둘째</b>'), '그냥 대사\n&lt;b&gt;둘째&lt;/b&gt;');
  assert.equal(G.rawToHtml('그냥 대사\n'), '그냥 대사\n<br>');
  assert.equal(G.rawToHtml('박대훈: 첫 줄\n'), '<span class="spk">박대훈:</span> 첫 줄\n<br>');
  assert.equal(G.rawToHtml('(동작)\n'), '(동작)\n<br>');
  assert.equal(G.rawToHtml(''), '<br>');
});

test('textOf: 편집기 원문에서 \\n 을 지우지 않는다 (nbsp 는 공백, CRLF 는 \\n)', () => {
  assert.equal(G.textOf({ textContent: '첫 줄\n둘째\r\n셋째' }), '첫 줄\n둘째\n셋째');
});

const showWithBreak = () => ({
  id: 'show-x', title: '줄바꿈 테스트', version: 5, revision: '', updatedAt: '', preShowSetup: '',
  people: [{ id: 'p-a', name: '박대훈', role: 'performer', note: '' }],
  tracks: [],
  parts: [{ id: 'pt-1', name: '1부', scenes: [{ id: 'sc-1', type: 'mc', title: '오프닝', cast: ['p-a'], durationSec: null, comments: [], items: [
    { id: 'i-1', kind: 'line', speaker: 'p-a', text: '안녕하세요\n반갑습니다', label: null, isCue: false, cues: [], comments: [] },
    { id: 'i-2', kind: 'action', speaker: null, text: '(인사)\n천천히', label: null, isCue: false, cues: [], comments: [] }
  ] }] }]
});

test('validate: 문단 text 안의 \\n 을 오류·경고로 잡지 않는다', () => {
  const s = showWithBreak();
  assert.equal(basicInvalid(s), null);
  const v = validateShow(s);
  assert.deepEqual(v.errors.filter(e => /\.text$/.test(e.path)), []);
  assert.deepEqual(v.warnings.filter(e => /\.text$/.test(e.path)), []);
});

test('store: 저장·불러오기에서 text 의 \\n 이 그대로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuesheet-nl-'));
  try {
    const st = new Store(dir); await st.init();
    const { id } = await st.create(showWithBreak());
    const rec = await st.get(id);
    const items = rec.show.parts[0].scenes[0].items;
    assert.equal(items[0].text, '안녕하세요\n반갑습니다');
    assert.equal(items[1].text, '(인사)\n천천히');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
