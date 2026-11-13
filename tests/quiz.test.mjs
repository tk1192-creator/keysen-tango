// quiz.js の単体テスト（node --test tests/quiz.test.mjs）
// 例文・単語はすべて自作のダミー（教材の文章は使わない）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findForm,
  makeChoice,
  makeCloze,
  makeSpell,
  checkSpelling,
  makeQuestion,
} from '../js/quiz.js';

// ---- ダミーデータ ----
const sentences = {
  1: { id: 1, en: 'My brother picked them up at the station on Monday.', ja: '（ダミー）' },
  2: { id: 2, en: 'Look at the big dog in the park.', ja: '（ダミー）' },
  3: { id: 3, en: 'She often plays tennis after school.', ja: '（ダミー）' },
  4: { id: 4, en: 'How about going to the zoo tomorrow?', ja: '（ダミー）' },
  5: { id: 5, en: 'We walked to the library and studied together.', ja: '（ダミー）' },
};

const w = (id, word, pos, meaning, sid, form, isPhrase = false) => ({
  id, word, pos, meaning, isPhrase, sentenceIds: [sid], form, source: 'auto', verified: false,
});

const words = [
  w('w01', 'pick up', '熟語', '拾う、迎えに行く', 1, 'picked them up', true),
  w('w02', 'station', '名詞', '駅', 1, 'station'),
  w('w03', 'Monday', '名詞', '月曜日', 1, 'Monday'),
  w('w04', 'look at', '熟語', '～を見る', 2, 'Look at', true),
  w('w05', 'big', '形容詞', '大きい', 2, 'big'),
  w('w06', 'dog', '名詞', '犬', 2, 'dog'),
  w('w07', 'park', '名詞', '公園', 2, 'park'),
  w('w08', 'often', '副詞', 'よく、しばしば', 3, 'often'),
  w('w09', 'play', '動詞', '（スポーツを）する', 3, 'plays'),
  w('w10', 'tennis', '名詞', 'テニス', 3, 'tennis'),
  w('w11', 'How about ...?', '会話表現', '～はどうですか', 4, 'How about'),
  w('w12', 'zoo', '名詞', '動物園', 4, 'zoo'),
  w('w13', 'tomorrow', '副詞', '明日', 4, 'tomorrow'),
  w('w14', 'walk', '動詞', '歩く', 5, 'walked'),
  w('w15', 'library', '名詞', '図書館', 5, 'library'),
  w('w16', 'study', '動詞', '勉強する', 5, 'studied'),
  w('w17', 'together', '副詞', 'いっしょに', 5, 'together'),
  // 多義語の別項目（同じ見出し語）：出題中の play の選択肢に出てはいけない
  w('w18', 'play', '動詞', '演奏する', 3, 'plays'),
  // 同じ意味の別の語：big の選択肢に「大きい」が 2 つ出てはいけない
  w('w19', 'large', '形容詞', '大きい', 2, 'large'),
  w('w20', 'jump', '動詞', '跳ぶ', 3, 'jumped'),
  w('w21', 'run', '動詞', '走る', 3, 'running'),
  w('w22', 'happy', '形容詞', '幸せな', 2, 'happy'),
  w('w23', 'tall', '形容詞', '背が高い', 2, 'tall'),
  w('w24', 'small', '形容詞', '小さい', 2, 'small'),
  w('w25', 'eat', '動詞', '食べる', 5, 'eats'),
];
const byId = Object.fromEntries(words.map((x) => [x.id, x]));
const sentenceOf = (word) => sentences[word.sentenceIds[0]];

// 固定の乱数（mulberry32）
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- findForm ----
describe('findForm', () => {
  test('通常の一致で 3 つに分ける', () => {
    assert.deepEqual(findForm(sentences[3].en, 'plays'), {
      before: 'She often ',
      target: 'plays',
      after: ' tennis after school.',
    });
  });

  test('語の境目で一致する位置を選ぶ（station や Monday の中の on に一致しない）', () => {
    const r = findForm(sentences[1].en, 'on');
    assert.equal(r.before, 'My brother picked them up at the station ');
    assert.equal(r.target, 'on');
    assert.equal(r.after, ' Monday.');
  });

  test('境目で一致しなければ語の途中でも見つける', () => {
    const r = findForm(sentences[1].en, 'Mon');
    assert.equal(r.target, 'Mon');
    assert.equal(r.after, 'day.');
  });

  test('熟語（間に語が入る form）', () => {
    assert.deepEqual(findForm(sentences[1].en, 'picked them up'), {
      before: 'My brother ',
      target: 'picked them up',
      after: ' at the station on Monday.',
    });
  });

  test('文頭の大文字：区別して見つからなければ区別せずに探す', () => {
    const r = findForm(sentences[2].en, 'look');
    assert.equal(r.before, '');
    assert.equal(r.target, 'Look');
    assert.equal(r.after, ' at the big dog in the park.');
  });

  test('大文字小文字を区別した一致を優先する', () => {
    const r = findForm('The cat saw the dog.', 'the');
    assert.equal(r.before, 'The cat saw ');
    assert.equal(r.target, 'the');
  });

  test('会話表現（"How about" が文頭にある）', () => {
    const r = findForm(sentences[4].en, 'How about');
    assert.equal(r.before, '');
    assert.equal(r.after, ' going to the zoo tomorrow?');
  });

  test('’ と \' の違いは区別しない探し方で吸収する', () => {
    const r = findForm('I don’t know.', "don't");
    assert.equal(r.target, 'don’t');
    assert.equal(r.after, ' know.');
  });

  test('見つからない場合は null', () => {
    assert.equal(findForm(sentences[3].en, 'swimming'), null);
    assert.equal(findForm(sentences[3].en, ''), null);
    assert.equal(findForm(undefined, 'plays'), null);
  });
});

// ---- makeChoice ----
describe('makeChoice', () => {
  test('選択肢が 4 つ・重複なし・正解が answerIndex の位置にある', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const q = makeChoice(byId.w05, words, seeded(seed));
      assert.equal(q.type, 'choice');
      assert.equal(q.wordId, 'w05');
      assert.equal(q.prompt, 'big');
      assert.equal(q.options.length, 4);
      assert.equal(new Set(q.options).size, 4);
      assert.equal(q.options[q.answerIndex], '大きい');
      assert.equal(q.options.filter((o) => o === '大きい').length, 1);
    }
  });

  test('不正解は同じ品詞の別の語から選ばれる', () => {
    const verbMeanings = new Set(
      words.filter((x) => x.pos === '動詞' && x.word !== 'play').map((x) => x.meaning),
    );
    for (let seed = 1; seed <= 50; seed++) {
      const q = makeChoice(byId.w09, words, seeded(seed));
      q.options.forEach((o, i) => {
        if (i !== q.answerIndex) assert.ok(verbMeanings.has(o), `動詞以外の意味が出た: ${o}`);
      });
    }
  });

  test('同じ見出し語の別の意味（多義語の別項目）は出ない', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const q = makeChoice(byId.w09, words, seeded(seed));
      assert.ok(!q.options.includes('演奏する'));
    }
  });

  test('同じ品詞が足りなければ他の品詞から補う', () => {
    // 会話表現は 1 語しかない
    const q = makeChoice(byId.w11, words, seeded(3));
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options).size, 4);
    assert.equal(q.options[q.answerIndex], '～はどうですか');
  });

  test('語が少ないときも落ちずに出せるだけの選択肢で返す', () => {
    const two = [byId.w05, byId.w06];
    const q2 = makeChoice(byId.w05, two, seeded(1));
    assert.equal(q2.options.length, 2);
    assert.equal(q2.options[q2.answerIndex], '大きい');

    const q1 = makeChoice(byId.w05, [byId.w05], seeded(1));
    assert.deepEqual(q1.options, ['大きい']);
    assert.equal(q1.answerIndex, 0);

    // 同じ意味の語しかない場合も重複させない
    const q3 = makeChoice(byId.w05, [byId.w05, byId.w19, byId.w06], seeded(2));
    assert.equal(q3.options.length, 2);
    assert.equal(new Set(q3.options).size, 2);
  });
});

// ---- makeCloze ----
describe('makeCloze', () => {
  test('parts が正しく、選択肢に正解が 1 つだけ', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const q = makeCloze(byId.w09, sentences[3], words, seeded(seed));
      assert.equal(q.type, 'cloze');
      assert.equal(q.wordId, 'w09');
      assert.deepEqual(q.parts, { before: 'She often ', after: ' tennis after school.' });
      assert.equal(q.options.length, 4);
      assert.equal(q.options[q.answerIndex], 'plays');
      assert.equal(q.options.filter((o) => o.toLowerCase() === 'plays').length, 1);
      assert.equal(new Set(q.options.map((o) => o.toLowerCase())).size, 4);
    }
  });

  test('不正解は同じ品詞の form から、語尾が同じものを優先する', () => {
    // walked（-ed）の不正解：動詞の form のうち -ed の jumped・studied が必ず入る
    for (let seed = 1; seed <= 30; seed++) {
      const q = makeCloze(byId.w14, sentences[5], words, seeded(seed));
      const wrongs = q.options.filter((_, i) => i !== q.answerIndex);
      assert.ok(wrongs.includes('jumped'));
      assert.ok(wrongs.includes('studied'));
      const verbForms = new Set(words.filter((x) => x.pos === '動詞').map((x) => x.form));
      wrongs.forEach((f) => assert.ok(verbForms.has(f), `動詞以外の form: ${f}`));
    }
  });

  test('熟語（間に語が入る form）でも空欄が作れる', () => {
    const q = makeCloze(byId.w01, sentences[1], words, seeded(7));
    assert.deepEqual(q.parts, { before: 'My brother ', after: ' at the station on Monday.' });
    assert.equal(q.options[q.answerIndex], 'picked them up');
  });

  test('文頭の正解なら不正解の先頭も大文字にそろえる', () => {
    const q = makeCloze(byId.w04, sentences[2], words, seeded(5));
    assert.equal(q.parts.before, '');
    q.options.forEach((o) => assert.match(o, /^[A-Z]/));
  });

  test('form が例文に見つからなければ null', () => {
    assert.equal(makeCloze(byId.w09, sentences[5], words, seeded(1)), null);
  });
});

// ---- makeSpell ----
describe('makeSpell', () => {
  test('取り決めどおりの形', () => {
    assert.deepEqual(makeSpell(byId.w16, sentences[5]), {
      type: 'spell',
      wordId: 'w16',
      meaning: '勉強する',
      parts: { before: 'We walked to the library and ', after: ' together.' },
      answer: 'studied',
      hint: 's',
    });
  });

  test('form が例文に見つからなければ null', () => {
    assert.equal(makeSpell(byId.w16, sentences[1]), null);
  });
});

// ---- checkSpelling ----
describe('checkSpelling', () => {
  test('完全一致', () => {
    assert.equal(checkSpelling('studied', 'studied'), true);
    assert.equal(checkSpelling('studyed', 'studied'), false);
  });

  test('大文字小文字を無視する', () => {
    assert.equal(checkSpelling('MONDAY', 'Monday'), true);
    assert.equal(checkSpelling('look at', 'Look at'), true);
  });

  test('前後の空白・連続した空白を無視する', () => {
    assert.equal(checkSpelling('  picked   them  up ', 'picked them up'), true);
    assert.equal(checkSpelling('pickedthemup', 'picked them up'), false);
  });

  test('’ と \' の違いを無視する', () => {
    assert.equal(checkSpelling("don't", 'don’t'), true);
    assert.equal(checkSpelling('don’t', "don't"), true);
  });

  test('末尾の . ? ! を無視する', () => {
    assert.equal(checkSpelling('How about', 'How about?'), true);
    assert.equal(checkSpelling('Nice to see you.', 'Nice to see you'), true);
    assert.equal(checkSpelling('Nice to see you', 'Nice to see you!'), true);
    assert.equal(checkSpelling('Really ?', 'Really?'), true);
  });

  test('熟語（間に語が入る）', () => {
    assert.equal(checkSpelling('Picked Them Up', 'picked them up'), true);
    assert.equal(checkSpelling('picked up', 'picked them up'), false);
  });

  test('全角英字も受け付け、空の入力は不正解', () => {
    assert.equal(checkSpelling('ｓｔｕｄｉｅｄ', 'studied'), true);
    assert.equal(checkSpelling('', 'studied'), false);
    assert.equal(checkSpelling('   ', 'studied'), false);
    assert.equal(checkSpelling(undefined, 'studied'), false);
  });
});

// ---- makeQuestion ----
describe('makeQuestion', () => {
  test('箱ごとの形式（0〜1 choice、2〜3 cloze、4〜5 spell）', () => {
    const word = byId.w09;
    const expect = ['choice', 'choice', 'cloze', 'cloze', 'spell', 'spell'];
    expect.forEach((type, box) => {
      const q = makeQuestion(word, sentenceOf(word), words, box, seeded(box + 1));
      assert.equal(q.type, type, `box ${box}`);
      assert.equal(q.wordId, 'w09');
    });
  });

  test('form が例文に見つからないときは choice にする', () => {
    const broken = { ...byId.w09, form: 'played' };
    assert.equal(makeQuestion(broken, sentences[3], words, 2, seeded(1)).type, 'choice');
    assert.equal(makeQuestion(broken, sentences[3], words, 5, seeded(1)).type, 'choice');
  });

  test('例文が無いときも choice にする', () => {
    assert.equal(makeQuestion(byId.w09, undefined, words, 4, seeded(1)).type, 'choice');
  });

  test('箱が範囲外・数でないときは丸める', () => {
    assert.equal(makeQuestion(byId.w09, sentences[3], words, undefined, seeded(1)).type, 'choice');
    assert.equal(makeQuestion(byId.w09, sentences[3], words, 9, seeded(1)).type, 'spell');
  });
});

// ---- 乱数の固定 ----
describe('rng の固定', () => {
  test('同じ seed なら同じ結果になる', () => {
    for (const box of [0, 2, 4]) {
      const a = makeQuestion(byId.w14, sentences[5], words, box, seeded(42));
      const b = makeQuestion(byId.w14, sentences[5], words, box, seeded(42));
      assert.deepEqual(a, b);
    }
    assert.deepEqual(makeChoice(byId.w06, words, seeded(9)), makeChoice(byId.w06, words, seeded(9)));
    assert.deepEqual(
      makeCloze(byId.w06, sentences[2], words, seeded(9)),
      makeCloze(byId.w06, sentences[2], words, seeded(9)),
    );
  });

  test('seed が違えば結果が変わりうる（偏りの確認）', () => {
    const positions = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      positions.add(makeChoice(byId.w06, words, seeded(seed)).answerIndex);
    }
    assert.equal(positions.size, 4, '正解の位置が 4 か所すべてに散らばる');
  });
});
