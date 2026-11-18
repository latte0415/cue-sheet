// 큐 번호(item.label) — index.html 의 "큐 번호 (고정 라벨)" 구간(showItems·labelRoot·assignLabels)을 그대로 옮겼다.
// 서버(MCP edit_show)가 새로 큐가 붙은 문단에 번호를 매길 때 쓴다. 동작이 브라우저와 같아야 한다
// (test/labels.test.js 가 index.html 의 함수와 결과를 대조한다).
//
// 규칙: label 은 문단에 처음 큐가 붙을 때 정해지고 바뀌지 않는다(큐를 다 지워도 남는다).
//   - 뒤에 번호 붙은 문단이 없으면(맨 뒤) → 지금까지 쓴 정수 최댓값 + 1
//   - 사이에 끼우면 → 앞 번호의 정수부 + ".k" (그 정수부에서 아직 안 쓴 다음 k). 맨 앞이면 "0.k"
// 서버 데이터는 배열이 빠져 있을 수 있어 없는 배열은 빈 배열로 본다(브라우저 데이터에서는 차이 없음).

const list = (o, k) => (o && Array.isArray(o[k]) ? o[k] : []);

function showItems(show) {
  const out = [];
  list(show, 'parts').forEach(p => list(p, 'scenes').forEach(s => list(s, 'items').forEach(i => out.push(i))));
  return out;
}
function labelRoot(l) { return String(l).split('.')[0]; }
const hasCues = i => list(i, 'cues').length > 0;

// 번호가 없는 큐 문단에 번호를 붙인다. 하나라도 붙였으면 true. show 를 직접 고친다
function assignLabels(show) {
  const all = showItems(show);
  if (!all.some(i => hasCues(i) && i.label == null)) return false;
  const used = new Set(all.filter(i => i.label != null).map(i => i.label));
  const maxInt = () => { let m = 0; used.forEach(l => { const v = parseInt(labelRoot(l), 10); if (v > m) m = v; }); return m; };
  all.forEach((it, k) => {
    if (!hasCues(it) || it.label != null) return;
    let prev = null;
    for (let j = k - 1; j >= 0; j--) if (hasCues(all[j]) && all[j].label != null) { prev = all[j].label; break; }
    const hasNext = all.slice(k + 1).some(x => hasCues(x) && x.label != null);
    let lab;
    if (!hasNext) lab = String(maxInt() + 1); // 맨 뒤에 붙이면 다음 정수
    else {
      const root = prev == null ? '0' : labelRoot(prev);
      let m = 0;
      used.forEach(l => { const a = String(l).split('.'); if (a[0] === root && a.length > 1) { const v = parseInt(a[1], 10); if (v > m) m = v; } });
      lab = root + '.' + (m + 1);
    }
    it.label = lab; used.add(lab);
  });
  return true;
}

module.exports = { assignLabels, showItems, labelRoot };
