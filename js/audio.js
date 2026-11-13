// 区間再生（mp3 は分割せず、開始秒から再生して終了秒で止める）
//
// iPhone Safari の注意：
// - play() はボタンを押した処理の中で（await をはさまずに）呼ばないと止められることがある。
//   そのため、音声は prepare() で先に読み込んでおき、ボタンでは playSegment() だけを呼ぶ。
// - timeupdate は 0.25 秒ほどの間隔でしか来ないので、requestAnimationFrame で終了秒を見張る。

const audio = new Audio();
audio.preload = 'auto';
// 画面が消えている間は requestAnimationFrame が止まるので、timeupdate でも終了秒を見張る
audio.addEventListener('timeupdate', () => {
  if (endAt && !audio.paused && audio.currentTime >= endAt) {
    audio.pause();
    if (stopTimer) cancelAnimationFrame(stopTimer);
    stopTimer = 0;
    const cb = onEnd; onEnd = null;
    if (cb) cb();
  }
});
let currentKey = null;
let currentUrl = null;
let stopTimer = 0;
let endAt = 0;
let onEnd = null;

/**
 * 再生する音声を用意する（同じものなら何もしない）
 * @param {string} key ファイル名など、音声を区別する名前
 * @param {Blob|string} src Blob か URL
 */
export function prepare(key, src) {
  if (key === currentKey) return;
  stop();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = src instanceof Blob ? URL.createObjectURL(src) : null;
  audio.src = currentUrl || src;
  currentKey = key;
  audio.load();
}

function watch() {
  if (audio.paused) { stopTimer = 0; return; }
  if (audio.currentTime >= endAt) {
    audio.pause();
    stopTimer = 0;
    const cb = onEnd; onEnd = null;
    if (cb) cb();
    return;
  }
  stopTimer = requestAnimationFrame(watch);
}

/**
 * 区間 [start, end]（秒）を再生する。prepare() 済みであること。
 * @returns {Promise<void>} 再生が始まったら解決（自動再生が拒否されたら reject）
 */
export function playSegment(start, end, { onFinish = null } = {}) {
  stop();
  endAt = end;
  onEnd = onFinish;
  const begin = () => {
    audio.currentTime = start;
    const p = audio.play();
    stopTimer = requestAnimationFrame(watch);
    return p;
  };
  // メタデータ読み込み前は currentTime を設定できないことがあるので待つ
  if (audio.readyState >= 1) return begin();
  return new Promise((resolve, reject) => {
    audio.addEventListener('loadedmetadata', () => begin().then(resolve, reject), { once: true });
  });
}

/** 連続した区間を順に再生する（例：英語だけを続けて、など） */
export async function playSequence(ranges, gapSec = 0.4) {
  for (const [s, e] of ranges) {
    await new Promise((resolve, reject) => {
      playSegment(s, e, { onFinish: resolve }).catch(reject);
    });
    if (gapSec) await new Promise((r) => setTimeout(r, gapSec * 1000));
  }
}

/**
 * 再生の速さを変える（聞き流しで使う。1 = 普通）。
 * 音声を入れ替える（load）と playbackRate は defaultPlaybackRate に戻るので、両方に入れる。
 * 区間の秒数（start / end）は音声の中の位置なので、速さを変えてもそのままでよい。
 */
export function setRate(rate) {
  const r = Number(rate);
  const v = Number.isFinite(r) && r > 0 ? r : 1;
  try {
    audio.defaultPlaybackRate = v;
    audio.playbackRate = v;
  } catch {
    // 対応していない環境では普通の速さのまま
  }
}

/** 止める */
export function stop() {
  if (stopTimer) cancelAnimationFrame(stopTimer);
  stopTimer = 0;
  onEnd = null;
  if (!audio.paused) audio.pause();
}

/** 単語単体の発音（Web Speech API、en-US） */
export function speakWord(text) {
  if (!('speechSynthesis' in window)) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.9;
  speechSynthesis.speak(u);
  return true;
}
