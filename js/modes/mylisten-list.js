// 聞き流し：再生画面の単語リスト（下から出るシート）
//
// 使い方：openListSheet(host, opts) → { update({ currentNo, marks }), close(), isOpen() }
//   host … シートを入れる要素（聞き流しの画面の外枠）
//   opts = {
//     numbered,     // player.numberWords(words) の結果 [{ no, word }]
//     sectionSize,  // Section の大きさ
//     currentNo,    // 再生中の No.（無ければ null）
//     lastNo,       // 前回止めた No.（無ければ null）
//     marks,        // { wordId: 'known' | 'notyet' }
//     onPlayFrom(no),        // 行タップ・メニュー「ここから再生」
//     onRepeatOne(no),       // メニュー「この単語だけリピート」
//     onPlaySection(section),// メニュー「この Section の最初から再生」（その Section だけを再生する）
//     onJumpSection(section),// Section の見出しタップ（今の範囲のまま、その Section の先頭へ）
//     onClose(),
//   }
//
// この画面で決めたこと：
// - 一覧は「Section の見出し」と「行」を 1 本の並び（entries）にして描く。検索で絞ると、行のある Section の見出しだけ残す。
// - 検索：英単語・意味の部分一致（NFKC・小文字・波線をそろえる）。数字だけ（「125」「No.125」）なら No. の完全一致も含める。
// - 重くしないために：entries のうち CHUNK 件ずつだけ描く。開いたときは今の語（無ければ前回の語）の少し前から描き、
//   上下の端が見えたら（IntersectionObserver）前・後ろの CHUNK 件を足す。前に足すときはスクロール位置を保つ。
//   使えない環境では「前を表示」「もっと見る」ボタンで足す。行のタップは一覧の要素 1 か所で受ける。
// - 行の右端「︙」でメニュー（ここから再生／この単語だけリピート／この Section の最初から再生／閉じる）。
// - 再生中の語（is-current）と前回の語（is-last）に色。開いたら再生中の語へ自動でスクロールする。

export const CHUNK = 120;
export const BEFORE = 30;       // 開いたとき、目当ての行より前に描いておく件数
export const SEARCH_DEBOUNCE_MS = 250;

// ---------- DOM を使わない部分（テスト対象） ----------

/** 検索用に文字列をそろえる */
export function normalizeListText(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[〜～]/g, '~')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 検索のことばが No. の形（「125」「No.125」「no 125」。全角も可）ならその番号、違えば null */
export function parseNoQuery(text) {
  const m = /^(?:no\.?\s*)?(\d+)$/.exec(normalizeListText(text));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * 絞り込む（numbered の順のまま）。text が空なら全部
 * @param {Array<{no, word}>} numbered
 */
export function filterListItems(numbered, text) {
  const list = Array.isArray(numbered) ? numbered.filter((x) => x && x.word) : [];
  const q = normalizeListText(text);
  if (!q) return list;
  const noQ = parseNoQuery(q);
  return list.filter((x) => {
    if (noQ !== null && x.no === noQ) return true;
    return normalizeListText(x.word.word).includes(q) || normalizeListText(x.word.meaning).includes(q);
  });
}

/** Section の番号（1 始まり。Section 1 = No.1〜size） */
export function sectionOfNo(no, size) {
  const s = Math.max(1, Math.trunc(Number(size)) || 1);
  return Math.max(1, Math.ceil(Number(no) / s));
}

/**
 * 見出しと行を 1 本の並びにする
 * @returns {Array<{type:'head', section, from, to} | {type:'row', no, word}>}
 *   from / to は Section 全体の範囲（total で切る）
 */
export function buildListEntries(items, sectionSize, total) {
  const out = [];
  const size = Math.max(1, Math.trunc(Number(sectionSize)) || 1);
  const max = Number.isFinite(total) && total > 0 ? total : Infinity;
  let cur = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const sec = sectionOfNo(it.no, size);
    if (sec !== cur) {
      cur = sec;
      out.push({ type: 'head', section: sec, from: (sec - 1) * size + 1, to: Math.min(sec * size, max) });
    }
    out.push({ type: 'row', no: it.no, word: it.word });
  }
  return out;
}

/** entries の中で No. の行の位置（無ければ -1） */
export function findEntryIndex(entries, no) {
  if (no == null) return -1;
  return entries.findIndex((e) => e.type === 'row' && e.no === no);
}

/** 最初に描く範囲 [lo, hi)（目当ての行の BEFORE 件前から CHUNK 件） */
export function initialWindow(length, targetIndex, chunk = CHUNK, before = BEFORE) {
  if (length <= 0) return { lo: 0, hi: 0 };
  const lo = targetIndex > 0 ? Math.max(0, targetIndex - before) : 0;
  const hi = Math.min(length, Math.max(lo + chunk, targetIndex + 1));
  return { lo, hi };
}

/** 仕分けの印（文字つき） */
export function markLabel(mark) {
  if (mark === 'known') return '○ 覚えた';
  if (mark === 'notyet') return '△ まだ';
  return '';
}

// ---------- 画面 ----------

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : String(c));
  }
  return n;
}

export function openListSheet(host, opts) {
  const {
    numbered = [], sectionSize = 50, lastNo = null,
    onPlayFrom, onRepeatOne, onPlaySection, onJumpSection, onClose,
  } = opts || {};
  let currentNo = opts && opts.currentNo != null ? opts.currentNo : null;
  let marks = (opts && opts.marks) || {};
  const total = numbered.length;
  const call = (fn, ...a) => { if (typeof fn === 'function') fn(...a); };

  let entries = [];
  let lo = 0;
  let hi = 0;
  const rowsByNo = new Map(); // 描いた行（No. → li）
  let observer = null;
  let menu = null;
  let searchTimer = 0;
  let open = true;

  const searchInput = el('input', {
    type: 'search', class: 'ml-search', 'aria-label': '英単語・意味・No. で検索',
    placeholder: '英単語・意味・No. で検索', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off',
    spellcheck: 'false', enterkeyhint: 'search',
  });
  const countEl = el('p', { class: 'muted small ml-list-count', 'aria-live': 'polite' });
  const listEl = el('ul', { class: 'ml-list', 'aria-label': '単語のリスト' });
  const topSentinel = el('li', { class: 'ml-sentinel', 'aria-hidden': 'true' });
  const bottomSentinel = el('li', { class: 'ml-sentinel', 'aria-hidden': 'true' });
  const prevBtn = el('button', { type: 'button', class: 'btn btn-subtle ml-more', hidden: true }, '▲ 前を表示');
  const moreBtn = el('button', { type: 'button', class: 'btn btn-subtle ml-more', hidden: true }, '▼ もっと見る');
  const emptyEl = el('p', { class: 'muted', hidden: true, text: '見つかりません。ことばを変えてください。' });
  const body = el('div', { class: 'ml-sheet-body' }, prevBtn, listEl, moreBtn, emptyEl);
  const closeBtn = el('button', { type: 'button', class: 'btn ml-sheet-close', onclick: () => close() }, '閉じる');
  const panel = el('div', { class: 'ml-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '単語のリスト', tabindex: '-1' },
    el('div', { class: 'ml-sheet-head' }, searchInput, countEl),
    body,
    el('div', { class: 'ml-sheet-foot' }, closeBtn),
  );
  const backdrop = el('div', { class: 'ml-backdrop' }, panel);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });

  function headOf(e) {
    return el('li', { class: 'ml-head-item' },
      el('button', {
        type: 'button', class: 'ml-section-head', 'data-section': String(e.section),
        'aria-label': `Section ${e.section}（No.${e.from}〜${e.to}）の先頭から再生`,
      },
      el('span', { class: 'ml-section-name', text: `Section ${e.section}` }),
      el('span', { class: 'ml-section-range', text: `No.${e.from}〜${e.to}` }),
      el('span', { class: 'ml-section-go', 'aria-hidden': 'true', text: '▶' })));
  }

  function rowOf(e) {
    const w = e.word;
    const mark = marks[w.id];
    const cls = ['ml-row-item'];
    if (e.no === currentNo) cls.push('is-current');
    if (e.no === lastNo) cls.push('is-last');
    const li = el('li', { class: cls.join(' '), 'data-no': String(e.no) },
      el('button', { type: 'button', class: 'ml-row', 'data-no': String(e.no), 'data-action': 'play' },
        el('span', { class: 'ml-row-no', text: `No.${e.no}` }),
        el('span', { class: 'ml-row-main' },
          el('span', { class: 'ml-row-word', lang: 'en', text: w.word || '' }),
          el('span', { class: 'ml-row-meaning', text: w.meaning || '' })),
        el('span', { class: `ml-row-mark ml-mark-${mark || 'none'}`, text: markLabel(mark) }),
      ),
      el('button', {
        type: 'button', class: 'ml-row-menu', 'data-no': String(e.no), 'data-action': 'menu',
        'aria-label': `No.${e.no} のメニュー`,
      }, '︙'),
    );
    rowsByNo.set(e.no, li);
    return li;
  }

  function nodeOf(e) { return e.type === 'head' ? headOf(e) : rowOf(e); }

  function renderRange(from, to) {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.append(nodeOf(entries[i]));
    return frag;
  }

  function paintButtons() {
    prevBtn.hidden = lo <= 0;
    moreBtn.hidden = hi >= entries.length;
  }

  function appendMore() {
    if (hi >= entries.length) return;
    const to = Math.min(entries.length, hi + CHUNK);
    bottomSentinel.before(renderRange(hi, to));
    hi = to;
    paintButtons();
  }

  function prependMore() {
    if (lo <= 0) return;
    const from = Math.max(0, lo - CHUNK);
    const before = body.scrollHeight;
    topSentinel.after(renderRange(from, lo));
    lo = from;
    // 上に足した分だけずらして、見ている位置を保つ
    body.scrollTop += body.scrollHeight - before;
    paintButtons();
  }

  /** 一覧を描き直す。targetNo があれば、その行が見えるように描いて真ん中へ */
  function rebuild(targetNo) {
    const items = filterListItems(numbered, searchInput.value);
    entries = buildListEntries(items, sectionSize, total);
    rowsByNo.clear();
    const rows = items.length;
    countEl.textContent = searchInput.value.trim() ? `${rows.toLocaleString('ja-JP')} 語（全 ${total.toLocaleString('ja-JP')} 語中）` : `全 ${total.toLocaleString('ja-JP')} 語`;
    emptyEl.hidden = rows > 0;
    const idx = findEntryIndex(entries, targetNo);
    ({ lo, hi } = initialWindow(entries.length, idx));
    // 見出しから始まるように、目当ての Section の見出しまで戻す
    while (lo > 0 && entries[lo].type !== 'head' && idx - lo < BEFORE + 60) lo -= 1;
    listEl.replaceChildren(topSentinel, renderRange(lo, hi), bottomSentinel);
    paintButtons();
    if (idx >= 0) {
      const li = rowsByNo.get(targetNo);
      if (li) requestAnimationFrame(() => li.scrollIntoView({ block: 'center' }));
    } else {
      body.scrollTop = 0;
    }
  }

  // ---- メニュー（︙） ----
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  function openMenu(no) {
    closeMenu();
    const item = numbered.find((x) => x.no === no);
    if (!item) return;
    const sec = sectionOfNo(no, sectionSize);
    const act = (fn) => () => { closeMenu(); close(); fn(); };
    menu = el('div', { class: 'ml-menu-backdrop' },
      el('div', { class: 'ml-menu', role: 'menu', 'aria-label': `No.${no} のメニュー` },
        el('p', { class: 'ml-menu-title' },
          el('span', { class: 'ml-row-no', text: `No.${no}` }), ' ',
          el('strong', { lang: 'en', text: item.word.word || '' })),
        el('button', { type: 'button', class: 'btn btn-primary', role: 'menuitem', onclick: act(() => call(onPlayFrom, no)) }, '▶ ここから再生'),
        el('button', { type: 'button', class: 'btn', role: 'menuitem', onclick: act(() => call(onRepeatOne, no)) }, '🔂 この単語だけリピート'),
        el('button', { type: 'button', class: 'btn', role: 'menuitem', onclick: act(() => call(onPlaySection, sec)) }, `この Section（${sec}）の最初から再生`),
        el('button', { type: 'button', class: 'btn btn-subtle', onclick: closeMenu }, 'キャンセル'),
      ));
    menu.addEventListener('click', (ev) => { if (ev.target === menu) closeMenu(); });
    backdrop.append(menu);
    menu.querySelector('button').focus({ preventScroll: true });
  }

  listEl.addEventListener('click', (ev) => {
    const head = ev.target.closest('.ml-section-head');
    if (head && listEl.contains(head)) {
      const sec = Number(head.getAttribute('data-section'));
      close();
      call(onJumpSection, sec);
      return;
    }
    const btn = ev.target.closest('[data-action]');
    if (!btn || !listEl.contains(btn)) return;
    const no = Number(btn.getAttribute('data-no'));
    if (btn.getAttribute('data-action') === 'menu') { openMenu(no); return; }
    close();
    call(onPlayFrom, no);
  });

  searchInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = 0; rebuild(currentNo ?? lastNo); }, SEARCH_DEBOUNCE_MS);
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = 0;
      rebuild(currentNo ?? lastNo);
      searchInput.blur();
    }
  });
  prevBtn.addEventListener('click', prependMore);
  moreBtn.addEventListener('click', appendMore);

  function onKey(ev) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    if (menu) closeMenu(); else close();
  }
  document.addEventListener('keydown', onKey);

  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        if (e.target === bottomSentinel) appendMore();
        else if (e.target === topSentinel) prependMore();
      }
    }, { root: body, rootMargin: '300px 0px' });
    observer.observe(topSentinel);
    observer.observe(bottomSentinel);
  }

  host.append(backdrop);
  rebuild(currentNo ?? lastNo);
  panel.focus({ preventScroll: true });

  function close() {
    if (!open) return;
    open = false;
    if (searchTimer) clearTimeout(searchTimer);
    if (observer) observer.disconnect();
    document.removeEventListener('keydown', onKey);
    closeMenu();
    backdrop.remove();
    call(onClose);
  }

  /** 再生中の語・仕分けが変わったら、描いてある行だけ直す */
  function update(next = {}) {
    if (!open) return;
    if (next.marks) marks = next.marks;
    if ('currentNo' in next && next.currentNo !== currentNo) {
      const old = rowsByNo.get(currentNo);
      if (old) old.classList.remove('is-current');
      currentNo = next.currentNo;
      const li = rowsByNo.get(currentNo);
      if (li) li.classList.add('is-current');
    }
    if (next.marks) {
      for (const [no, li] of rowsByNo) {
        const item = numbered[no - 1] && numbered[no - 1].no === no ? numbered[no - 1] : numbered.find((x) => x.no === no);
        const m = item ? marks[item.word.id] : undefined;
        const span = li.querySelector('.ml-row-mark');
        if (span) { span.className = `ml-row-mark ml-mark-${m || 'none'}`; span.textContent = markLabel(m); }
      }
    }
  }

  return { update, close, isOpen: () => open };
}
