// Разбор раскадровки от Gemini. Понимает форматы:
//   "КАДР 1" отдельной строкой, ниже короткое описание и блок «Plaintext» с длинным промптом
//   (так выглядит ответ Gemini на этапе раскадровки) — в этом случае берётся ТОЛЬКО промпт
//   "Кадр 1: ...", "Кадр 1. ...", "Frame 1 - ...", "**КАДР 1**", "### Кадр 1"
//   "1. ...", "1) ..." (голый номер — только со знаком после него)
// Всё, что идёт до следующего заголовка кадра, относится к текущему кадру.

// Из блока кадра выбирает сам промпт: содержимое ```-блока или текст после строки «Plaintext».
function extractPrompt(rawBlock) {
  // Gemini иногда добавляет служебные метки источников «[cite: 1]» — в промпте им не место.
  const block = rawBlock.replace(/\s*\[cite(?:_start|_end)?[^\]]*\]/gi, "");
  const fence = block.match(/```[^\n]*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const lines = block.split("\n");
  const i = lines.findIndex((l) => /^\s*(plaintext|plain text|text)\s*$/i.test(l));
  if (i >= 0) {
    return lines
      .slice(i + 1)
      .filter((l) => !/^\s*(copy|копировать|скопировать)\s*$/i.test(l))
      .join("\n")
      .trim();
  }
  return block.trim();
}

function parseFrames(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const word = /^\s*[#*_>\s]*(?:кадр|frame|shot|сцена)\s*[№#]?\s*(\d{1,3})\s*[*_]*\s*[.:)\-–—]?\s*[*_]*\s*/i;
  const bare = /^\s*(\d{1,3})\s*[.:)\-–—]\s+/;
  const raw = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(word) || line.match(bare);
    if (m) {
      if (cur) raw.push(cur);
      cur = { n: Number(m[1]), lines: [line.slice(m[0].length)] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) raw.push(cur);
  // Один номер кадра берём один раз (если Gem повторил кадр при «дальше», остаётся первый).
  const seen = new Set();
  return raw
    .map((f) => {
      // Необязательная строка «Персонажи: Алексей | Аня» (её пишет расширение, можно править руками):
      // явный список персонажей кадра, надёжнее поиска слов в тексте. «Персонажи: нет» — никого.
      let chars = null;
      const lines = f.lines.filter((l) => {
        const m = l.match(/^\s*(?:персонажи|characters)\s*:\s*(.*?)\s*$/i);
        if (!m) return true;
        chars = /^(нет|none|[-—])?$/i.test(m[1]) ? [] : m[1].split(m[1].includes("|") ? "|" : /[,;]/).map((s) => s.trim()).filter(Boolean);
        return false;
      });
      return { n: f.n, prompt: extractPrompt(lines.join("\n")), chars };
    })
    .filter((f) => f.prompt && !seen.has(f.n) && seen.add(f.n));
}

// Группы синонимов: подпись персонажа «папа» должна находить и «father», и «отец».
const SYNONYMS = [
  ["папа", "отец", "батя", "father", "dad", "daddy"],
  ["мама", "мать", "mother", "mom", "mum", "mommy"],
  ["муж", "husband", "жених", "groom"],
  ["жена", "wife", "невеста", "bride"],
  ["сын", "son"],
  ["дочь", "дочка", "daughter"],
  ["бабушка", "grandmother", "grandma"],
  ["дедушка", "дед", "grandfather", "grandpa"],
  ["брат", "brother"],
  ["сестра", "sister"],
];

// Список искомых слов для подписи: сама подпись (можно через запятую) + её синонимы.
function aliasesFor(label) {
  const words = label.toLowerCase().split(/[,/;|]+/).map((s) => s.trim()).filter(Boolean);
  const out = new Set(words);
  for (const g of SYNONYMS) if (words.some((w) => g.includes(w))) g.forEach((x) => out.add(x));
  return [...out];
}

// Слово ищется целиком, но с возможным окончанием (папы, папе, fathers); «grandfather» не считается «father».
function mentions(text, word) {
  const stem = word.length > 3 ? word.slice(0, -1) : word;
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}])${esc}\\p{L}{0,3}(?![\\p{L}])`, "iu").test(text);
}

// Роли из текста (сын, дочка, бабушка…), которых нет среди добавленных персонажей: у них нет фото-референса.
// Возвращает [{role: "son", label: "сын"}]; role — по-английски (для промпта), label — по-русски (для показа).
function extraRolesIn(text, characters) {
  const covered = new Set(characters.flatMap((c) => aliasesFor(c.name)));
  return SYNONYMS
    .filter((g) => !g.some((w) => covered.has(w)) && g.some((w) => mentions(text, w)))
    .map((g) => ({ role: g.find((w) => /^[a-z]+$/.test(w)), label: g[0] }));
}

// Предварительная догадка об именах героев по тексту сценария (без ИИ): слова с большой буквы не в начале предложения,
// которые встречаются не меньше двух раз (разные падежи считаем одним именем). Точный список приходит от ИИ.
function guessNames(text) {
  // 1) Чистим текст от того, что не герои: заголовки-названия кадров («Кадр 3. Король жуков»), строки титров,
  // слова в кавычках («Коротышки»).
  const t = text
    .replace(/^\s*(?:кадр|frame|shot|сцена)\s*\d+\s*[.:)\-–—]\s*[^\n.!?:]{0,60}$/gim, "")
    .replace(/^\s*(?:титры?|credits?)\s*:.*$/gim, "")
    .replace(/«[^»]*»|"[^"]*"/g, " ");
  const stop = new Set(["кадр", "frame"]);
  const CAP = "[А-ЯЁA-Z][а-яёa-z]{2,}";
  // последовательность слов с большой буквы подряд («Король Стригун», «Галина Ергужина») — одно имя
  const re = new RegExp(`(^|[.!?…:;\\n]\\s*|[—–-]\\s+)?(${CAP}(?:[ \\t]${CAP})*)`, "g");
  const PREP = /^\s+(?:на|в|во|с|со|у|из|под|за|к|ко|по|от|до|над|перед|для|без|об|о)\s/;

  // 2) Собираем кандидатов: форма -> { total, mid }. mid — слово стоит не в начале предложения (или это пара слов
  // с большой буквы, или одиночное слово в начале предложения, за которым сразу идёт предлог: «Эдин на ветке»).
  const words = new Map();
  let m;
  while ((m = re.exec(t))) {
    const phrase = m[2];
    if (phrase.split(" ").length === 1 && stop.has(phrase.toLowerCase())) continue;
    const parts = phrase.split(/[ \t]/);
    const startOfSentence = !!m[1] && parts.length === 1;
    const afterIsPrep = PREP.test(t.slice(m.index + m[0].length));
    const w = words.get(phrase) || { total: 0, mid: 0 };
    w.total++;
    if (!startOfSentence || afterIsPrep) w.mid++;
    words.set(phrase, w);
  }

  // 3) Склеиваем падежные формы одного имени (Артём/Артёму, Соня/Соне): общее начало, отличаются последние 1–3 буквы.
  const sameName = (a, b) => {
    const x = a.toLowerCase(), y = b.toLowerCase();
    let p = 0;
    while (p < x.length && p < y.length && x[p] === y[p]) p++;
    if (!(p >= Math.max(3, Math.min(x.length, y.length) - 1) && Math.max(x.length, y.length) - p <= 3)) return false;
    // «Амир» и «Амира» неоднозначны: это может быть родительный падеж мужского имени или другое, женское имя.
    // Не склеиваем, если к слову на согласную просто добавлена одна «а»/«я»: ИИ разберётся точнее.
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    if (long.length === short.length + 1 && /[ая]$/.test(long) && !/[аеёиоуыэюяйь]$/.test(short)) return false;
    return true;
  };
  const clusters = []; // { forms: [[слово, число]], total, mid }
  for (const [word, w] of [...words.entries()].sort((a, b) => a[0].length - b[0].length)) {
    const c = clusters.find((cl) => cl.forms.some(([f]) => sameName(f, word)));
    if (c) { c.forms.push([word, w.total]); c.total += w.total; c.mid += w.mid; }
    else clusters.push({ forms: [[word, w.total]], total: w.total, mid: w.mid });
  }

  // 4) Герой — слово с большой буквы не в начале предложения (даже одно упоминание: «королева Сафина»), либо слово,
  // встреченное в разных падежах. Обычные слова вроде «Семья» стоят в начале в одной форме и сюда не попадают.
  return clusters
    .filter((c) => c.mid >= 1 || (c.total >= 2 && c.forms.length >= 2))
    .map((c) => ({ name: c.forms[0][0], role: "" })); // первая форма — самая короткая ≈ именительный падеж
}

// Находит персонажей кадра по подписям в тексте промпта.
function charactersInPrompt(prompt, characters) {
  return characters.filter((c) => aliasesFor(c.name).some((w) => mentions(prompt, w)));
}

// Персонажи кадра: явный список из строки «Персонажи: …» (по подписи или любому её синониму), а если строки нет —
// поиск по тексту кадра.
function charactersForFrame(frame, characters) {
  // Нет строки «Персонажи» или она пустая («нет»): ищем героев по тексту промпта. Пустая строка часто устаревшая:
  // промпты делали до того, как в блоке 2 появились фото, и тогда без этого референсы бы не прикрепились вообще.
  if (!frame.chars || !frame.chars.length) return charactersInPrompt(frame.prompt, characters);
  return characters.filter((c) => {
    const al = aliasesFor(c.name);
    // Имя в строке «Персонажи» может быть длиннее подписи («Королева Сафина» при подписи «Сафина») или другой формой.
    return frame.chars.some((t) => al.includes(t.toLowerCase()) || al.some((a) => mentions(t, a)));
  });
}

if (typeof module !== "undefined") module.exports = { parseFrames, charactersInPrompt, charactersForFrame, aliasesFor, extraRolesIn, guessNames, mentions };
