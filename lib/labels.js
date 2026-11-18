// 큐 번호(item.label) — index.html 의 "큐 번호" 구간(showItems·renumberLabels·labelsInOrder·relabel·fillLabels)을 그대로 옮겼다.
// 서버(MCP edit_show)가 op 를 적용한 뒤 번호를 맞출 때 쓴다. 동작이 브라우저와 같아야 한다
// (test/labels.test.js 가 index.html 의 함수와 결과를 대조한다).
//
// 규칙: 번호는 늘 1부터 빈틈없이 대본 순서대로(소수 번호 없음), 큐가 없는 문단은 null.
//   - 편집(사이트의 저장, MCP 의 op 적용) 뒤 어긋나 있으면 전부 다시 매긴다(relabel)
//   - 읽기(불러오기·렌더·get_show)는 번호를 바꾸지 않는다. 번호 없이 올린 파일만 화면용으로 채운다(fillLabels)
// 서버 데이터는 배열이 빠져 있을 수 있어 없는 배열은 빈 배열로 본다(브라우저 데이터에서는 차이 없음).

const list = (o, k) => (o && Array.isArray(o[k]) ? o[k] : []);

function showItems(show) {
  const out = [];
  list(show, 'parts').forEach(p => list(p, 'scenes').forEach(s => list(s, 'items').forEach(i => out.push(i))));
  return out;
}
const hasCues = i => list(i, 'cues').length > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function renumberLabels(show) {
  let n = 0;
  showItems(show).forEach(i => { if (isObj(i)) i.label = hasCues(i) ? String(++n) : null; });
}
// 이미 1, 2, 3 … 순서대로인가 (큐 없는 문단은 번호 없음)
function labelsInOrder(show) {
  let n = 0;
  return showItems(show).every(i => !isObj(i) || (hasCues(i) ? i.label === String(++n) : i.label == null));
}
// 편집 뒤: 어긋나 있으면 다시 매기고 true. show 를 직접 고친다
function relabel(show) { if (labelsInOrder(show)) return false; renumberLabels(show); return true; }
// 읽기: 큐가 있는데 번호가 없는 문단이 있을 때만 채운다(다시 매김). 그 밖의 번호는 그대로
function fillLabels(show) { if (!showItems(show).some(i => isObj(i) && hasCues(i) && i.label == null)) return false; renumberLabels(show); return true; }

module.exports = { showItems, renumberLabels, labelsInOrder, relabel, fillLabels };
