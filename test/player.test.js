// 음향 큐 실행(index.html "음원: 플레이어" 구간) — PLAY 시작 볼륨(sound.level)이 오디오 volume 에 바로 걸리는지.
// 공유 <audio> 와 트랙 조회만 흉내 내고, 큐 → cueRun/cuePlay → playTrack 경로는 사이트 코드 그대로 돌린다
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function cut(from) {
  const a = HTML.indexOf('/* ================= ' + from), b = HTML.indexOf('/* =================', a + 10);
  assert.ok(a > 0 && b > a, `index.html 에서 ${from} 구간 표시를 찾지 못했습니다`);
  return HTML.slice(a, b);
}
// 함수 하나만 떼어 낸다 (다음 줄 첫 칸의 "}" 까지)
function fn(name) {
  const a = HTML.indexOf('function ' + name + '(');
  const b = HTML.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a, `index.html 에서 ${name} 를 찾지 못했습니다`);
  return HTML.slice(a, b + 3);
}

function player() {
  const audio = { src: '', dataset: {}, paused: true, ended: false, loop: false, volume: 1, currentTime: 0, getAttribute(k) { return k === 'src' ? this.src || null : null; },
    play() { this.paused = false; return undefined; }, pause() { this.paused = true; } };
  const tracks = [{ id: 't1', no: 1, title: '하우스 음악', fileKey: 'k1', loop: true }, { id: 't2', no: 2, title: '오프닝', fileKey: 'k2' }];
  const toasts = [];
  const ctx = {
    document: { getElementById: id => (id === 'player-audio' ? audio : null) },
    performance: { now: () => 0 }, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    toast: m => toasts.push(m), $$: () => [], cssq: s => s, savePrefs: () => {},
    trackByNo: no => tracks.find(t => t.no === no) || null, trackUrl: t => (t && t.fileKey ? '/f/' + t.fileKey : null)
  };
  const api = vm.runInNewContext('const FADE_DEFAULT = 3;\n' + cut('음원: 플레이어') + '\n;({ AU, cuePlay, cueRun, cuePlayLabel, playTrack, plVolTo, plEff, ramp })', ctx);
  return Object.assign(api, { audio, toasts });
}
const sq = (action, level, x) => Object.assign({ id: 'q', dept: 'sound', sound: { track: 1, action, timeSec: null, level } }, x);

test('PLAY 시작 볼륨: level 50 이면 audio.volume = 0.5 × 플레이어 볼륨으로 바로 재생, 비우면 기본(1)', () => {
  let P = player();
  P.AU.vol = 1;
  P.cuePlay(sq('play', 50));
  assert.equal(P.audio.paused, false);
  assert.equal(P.AU.gain, 0.5);
  assert.equal(P.audio.volume, 0.5);
  P = player();
  P.AU.vol = 0.9;
  P.cueRun(sq('play', 50));
  assert.ok(Math.abs(P.audio.volume - 0.45) < 1e-9, 'cueRun(런·플레이어 버튼·P 키) 도 같은 경로');
  P = player();
  P.AU.vol = 1;
  P.cuePlay(sq('play', null));
  assert.equal(P.AU.gain, 1, '비우면 지금처럼 기본 볼륨');
  P = player();
  P.AU.vol = 1;
  P.cuePlay(sq('play', 0));
  assert.equal(P.audio.volume, 0, '0 도 값이다');
});

test('PLAY 시작 볼륨: 같은 곡을 처음부터 다시 틀어도 시작 볼륨으로 돌아간다 · 뒤 VOL 큐는 그 볼륨에서 출발', () => {
  const P = player();
  P.AU.vol = 1;
  P.cuePlay(sq('play', 50));
  P.cuePlay(sq('volume', 80));
  assert.equal(P.AU.gain, 0.8);
  P.cuePlay(sq('play', 50));
  assert.equal(P.AU.gain, 0.5);
});

test('플레이어에서 곡을 직접 고르면(이전/다음·목록 = playTrack(no, 0)) 큐 레벨은 100 으로 돌아간다', () => {
  const P = player();
  P.AU.vol = 1;
  P.cuePlay(sq('play', 50));
  assert.equal(P.AU.gain, 0.5);
  P.playTrack(2, 0);
  assert.equal(P.AU.gain, 1);
  assert.equal(P.audio.volume, 1);
});

test('손으로 바꾼 볼륨은 큐 레벨을 푼다: 실제 출력에서 이어서(점프 없음) · 진행 중인 페이드는 멈춤 · 뒤 볼륨 큐는 그 볼륨 기준', () => {
  const P = player();
  P.AU.vol = 0.9;
  P.cuePlay(sq('play', 50));
  assert.ok(Math.abs(P.plEff() - 0.45) < 1e-9, '슬라이더·% 는 실제 출력 45');
  P.plVolTo(P.plEff() + 0.05); // ↑ 한 번
  assert.equal(P.AU.gain, 1, '큐 레벨 풀림');
  assert.equal(P.AU.vol, 0.5, '45 에서 이어서 50');
  assert.ok(Math.abs(P.audio.volume - 0.5) < 1e-9, '출력 = 슬라이더');
  // 뒤 볼륨 큐: 조작자 볼륨 기준으로 게인을 바꾼다 (시간 0 → 바로)
  P.cuePlay(sq('volume', 60));
  assert.equal(P.AU.gain, 0.6);
  assert.ok(Math.abs(P.audio.volume - 0.3) < 1e-9);
  // 페이드 중에 손으로 바꾸면 페이드가 멈춘다
  P.ramp(0.6, 0, 3, () => { throw new Error('페이드가 끝까지 가면 안 된다'); });
  assert.ok(P.AU.timer);
  P.plVolTo(0.7);
  assert.equal(P.AU.timer, null, '페이드 멈춤');
  assert.equal(P.AU.gain, 1);
  assert.ok(Math.abs(P.audio.volume - 0.7) < 1e-9);
});

test('플레이어 버튼 문구: PLAY 에 시작 볼륨 — 100·비움이면 붙이지 않는다', () => {
  const P = player();
  assert.equal(P.cuePlayLabel(sq('play', 50)), 'BGM 1 재생 50%');
  assert.equal(P.cuePlayLabel(sq('play', null)), 'BGM 1 재생');
  assert.equal(P.cuePlayLabel(sq('play', 100)), 'BGM 1 재생');
  assert.equal(P.cuePlayLabel(sq('fadeIn', 50)), 'BGM 1 fadeIn');
});

test('편집 모달 저장(draftCue): play·fadeIn 의 level 은 남고(비우면 null), volume 은 기본 100, stop·fadeOut 은 지운다', () => {
  const { draftCue } = vm.runInNewContext(fn('draftCue') + '\n;({ draftCue })', {});
  const d = (action, level) => ({ id: 'q', dept: 'sound', trigger: '', offsetSec: null, note: '', status: 'set', sound: { track: 1, action, timeSec: null, level } });
  const lv = (a, l) => draftCue(d(a, l)).sound.level;
  assert.equal(lv('play', 50), 50);
  assert.equal(lv('play', null), null);
  assert.equal(lv('fadeIn', 70), 70);
  assert.equal(lv('volume', null), 100);
  assert.equal(lv('stop', 50), null);
  assert.equal(lv('fadeOut', 50), null);
});
