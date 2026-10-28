const $ = (id) => document.getElementById(id);
const state = { characters: [], paused: false, running: false, cast: null };

const save = () => chrome.storage.local.set({
  script: $("script").value,
  count: $("count").value,
  characters: state.characters,
  scenario: $("scenario").value,
  apiKey: $("apiKey").value,
  noAi: $("noAi").checked,
  download: $("download").checked,
  outfitRef: $("outfitRef").checked,
  source: $("source").value,
  gemUrl: $("gemUrl").value,
  model: $("model").value,
  style: $("style").value,
  notes: $("notes").value,
});

async function load() {
  const s = await chrome.storage.local.get(["script", "count", "characters", "scenario", "apiKey", "noAi", "download", "outfitRef", "source", "gemUrl", "model", "style", "notes"]);
  $("outfitRef").checked = s.outfitRef !== false; // по умолчанию включено
  $("noAi").checked = !!s.noAi;
  $("download").checked = !!s.download; // по умолчанию выключено
  $("source").value = s.source || "auto";
  $("gemUrl").value = s.gemUrl || "https://gemini.google.com/gem/1JgbT2sirRXIT2Srx7KD3xnkaAvAKLhg-";
  $("script").value = s.script || "";
  $("scenario").value = s.scenario || "";
  $("apiKey").value = s.apiKey || "";
  $("model").value = s.model || "";
  $("style").value = s.style || DEFAULT_STYLE;
  $("notes").value = s.notes || "";
  $("count").value = s.count || 24;
  state.characters = s.characters || [];
  renderChars();
  updateFound();
}

function updateFound() {
  const frames = parseFrames($("script").value);
  $("found").textContent = frames.length ? `Найдено кадров: ${frames.length}` : "";
  updateCharStats(frames.length ? frames : scenarioFrames());
  updateCast();
}

// Герои сценария и их имена. После «Сделать промпты» список даёт ИИ (state.cast); до этого — предварительная догадка:
// имена с большой буквы, повторяющиеся в тексте, а если имён нет — роли (папа, мама, сын…). Рядом пометка,
// есть ли у героя фото в блоке 2.
function updateCast() {
  const el = $("castInfo");
  let cast = state.cast;
  if (!cast || !cast.length) {
    const text = scenarioFrames().map((f) => f.prompt).join("\n");
    if (!text.trim()) { el.textContent = ""; return; }
    cast = guessNames(text);
    if (!cast.length) cast = extraRolesIn(text, []).map((x) => ({ name: x.label, role: x.role }));
  }
  // Только имена: никакой привязки к блоку 2. Фото добавляете вы сами, по этому списку.
  el.textContent = cast.length ? `Персонажи в сценарии (${cast.length}): ${cast.map((c) => c.name).join(", ")}` : "";
}

// Сколько кадров с каждым персонажем (по тексту кадров, с синонимами: папа = father) и какие кадры без персонажей.
function updateCharStats(frames) {
  const el = $("foundChars");
  if (!frames.length) { el.textContent = ""; return; }
  if (!state.characters.length) { el.textContent = ""; return; } // нет фото в блоке 2: статистики по кадрам нет, список имён показывает строка выше
  const counts = state.characters.map((c) => `${c.name} — ${frames.filter((f) => charactersForFrame(f, [c]).length).length}`);
  const without = frames.filter((f) => !charactersForFrame(f, state.characters).length).map((f) => f.n);
  const extra = extraRolesIn(frames.map((f) => f.prompt).join("\n"), state.characters).map((x) => x.label);
  el.textContent =
    `Персонажи в кадрах: ${counts.join(", ")}` +
    (without.length ? `. Без персонажей: кадры ${without.join(", ")}` : "") +
    (extra.length ? `. Без фото (в сценарии есть, в блоке 2 нет): ${extra.join(", ")}, внешность придумает ИИ` : "");
}

function renderChars() {
  $("chars").innerHTML = "";
  state.characters.forEach((c, i) => {
    const d = document.createElement("div");
    d.className = "char";
    d.innerHTML = `<img src="${c.dataUrl}"><span>${c.name}</span><button>удалить</button>`;
    d.querySelector("button").onclick = () => { state.characters.splice(i, 1); renderChars(); save(); };
    $("chars").appendChild(d);
  });
  updateFound(); // статистика персонажей зависит от списка
}

$("addChar").onclick = () => {
  const name = $("charName").value.trim();
  const file = $("charFile").files[0];
  if (!name || !file) return setStatus("Укажите подпись и выберите фото.");
  const r = new FileReader();
  r.onload = () => {
    state.characters.push({ name, dataUrl: r.result });
    $("charName").value = ""; $("charFile").value = "";
    renderChars(); save();
  };
  r.readAsDataURL(file);
};

$("script").oninput = () => { updateFound(); save(); };
$("count").oninput = save;
for (const id of ["apiKey", "gemUrl", "model", "style", "notes"]) $(id).oninput = save;
$("noAi").onchange = save;
$("download").onchange = save;
$("outfitRef").onchange = save;
$("source").onchange = save;
// Число кадров считаем сами по сценарию (по заголовкам «КАДР N»): вручную ставить не нужно.
$("scenario").oninput = () => {
  const n = parseFrames($("scenario").value).length;
  if (n) { $("count").value = n; $("found").textContent = `В сценарии кадров: ${n}`; }
  updateCharStats(n ? scenarioFrames() : []);
  state.cast = null; // сценарий изменился: прежний список героев от ИИ устарел
  updateCast();
  save();
};
$("pause").onclick = () => { state.paused = !state.paused; $("pause").textContent = state.paused ? "Продолжить" : "Пауза"; };

$("reset").onclick = async () => {
  state.stop = true;            // останавливает текущий прогон, если он ещё идёт
  state.running = false;
  state.paused = false;
  $("pause").textContent = "Пауза";
  await chrome.storage.local.remove("done");
  $("log").innerHTML = "";
  setStatus("Прогресс сброшен: «Сделать раскадровку» начнёт с первого кадра.");
};

// Промежуточные сообщения от страницы Flow («Добавляю персонажей…», «Жду картинку…») показываем в статусе.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "progress" && state.running) setStatus(`${state.frameLabel || ""} ${msg.text}`.trim());
});

// Любая неожиданная ошибка должна быть видна и не оставлять панель в состоянии «идёт работа».
window.addEventListener("unhandledrejection", (e) => {
  state.running = false;
  log(`Ошибка: ${e.reason?.message || e.reason}`);
  setStatus("Произошла ошибка, см. журнал ниже. Кнопки снова работают.");
});

const setStatus = (t) => ($("status").textContent = t);
const log = (t) => { const li = document.createElement("li"); li.textContent = t; $("log").prepend(li); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Вкладка с проектом Flow. Адрес бывает с номером аккаунта: flow.google.com/u/1/project/… (второй аккаунт Google).
// Если открыто несколько проектов, берём тот, что сейчас на виду.
async function flowTab() {
  const tabs = (await chrome.tabs.query({ url: "https://flow.google.com/*" })).filter((t) => /\/project\//.test(t.url || ""));
  return tabs.find((t) => t.active) || tabs[0];
}

// Отправка команды в content.js на странице Flow.
function send(tabId, msg) {
  return new Promise((resolve) => chrome.tabs.sendMessage(tabId, msg, (res) => {
    resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
  }));
}

// Вкладка, открытая до установки/перезагрузки расширения, не получает скрипты сама:
// тогда подгружаем их вручную (иначе «Receiving end does not exist»).
async function ensureInjected(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function ask(tabId, msg) {
  let res = await send(tabId, msg);
  if (!res?.ok && /Receiving end does not exist|Could not establish connection/.test(res?.error || "")) {
    try {
      await ensureInjected(tabId);
      res = await send(tabId, msg);
    } catch (e) {
      return { ok: false, error: `Не удалось подключиться к Flow: ${e.message}. Обновите вкладку Flow (F5).` };
    }
  }
  return res;
}

// Кадры из сценария без промптов: по заголовкам «КАДР N»; если заголовков нет — каждая непустая строка = кадр.
function scenarioFrames() {
  const text = $("scenario").value;
  let frames = parseFrames(text);
  if (!frames.length) {
    frames = text.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l, i) => ({ n: i + 1, prompt: l }));
  }
  return frames;
}

// Запись готовых промптов в блок 1. «Персонажи: …» — явный список для выбора фото во Flow
// (можно править руками; «нет» — без персонажей).
function showPrompts(list) {
  $("script").value = list
    .map((o) => `КАДР ${o.n}\n${o.scene}\n\nПерсонажи: ${o.chars.length ? o.chars.join(" | ") : "нет"}\n\nPlaintext\n${o.prompt}`)
    .join("\n\n");
  updateFound(); save();
}

// Путь через Gem в приложении Gemini (без суточных лимитов API). Вкладка Gemini открывается на виду: у скрытой
// Gemini не обновляет ответ (проверено). Два протокола:
//  1) ваш собственный Gem (инструкция в gem-instructions.md): одно сообщение → один ответ в JSON, промпты собираем сами;
//  2) старый Gem «Раскадровка» (спрашивает «Сколько кадров?», отдаёт по ~5 кадров и ждёт «дальше»): если на
//     JSON-запрос он отвечает вопросом, переоткрываем вкладку и общаемся с ним по-старому.
async function openGemTab(gemUrl) {
  const prev = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const tab = await chrome.tabs.create({ url: gemUrl, active: true });
  await new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id === tab.id && info.status === "complete") { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(resolve, 20000);
  });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["gemini.js"] });
  const close = () => {
    chrome.tabs.remove(tab.id).catch(() => {});
    if (prev?.id) chrome.tabs.update(prev.id, { active: true }).catch(() => {});
  };
  return { tab, close };
}

// Протокол 1. Возвращает { frames } или null, если Gem ответил не JSON (тогда пробуем протокол 2).
async function promptsViaOwnGem(frames, gemUrl) {
  const { tab, close } = await openGemTab(gemUrl);
  const replies = [];
  const chunks = [];
  for (let i = 0; i < frames.length; i += promptKit.BATCH) chunks.push(frames.slice(i, i + promptKit.BATCH));
  for (const [i, chunk] of chunks.entries()) {
    setStatus(`Gem пишет промпты${chunks.length > 1 ? ` (часть ${i + 1} из ${chunks.length})` : ""}… (вкладку Gemini не закрывайте)`);
    const text = i === 0 ? promptKit.requestText(chunk, state.characters, $("notes").value) : promptKit.nextRequestText(chunk);
    const res = await send(tab.id, { type: "gemini-ask", text });
    if (!res?.ok) { throw new Error(`Gem на сайте Gemini не ответил: ${res?.error || "нет ответа"}. Вкладка Gemini оставлена открытой.`); }
    const reply = promptKit.parseJsonReply(res.text);
    if (!reply) { close(); return null; }
    replies.push(reply);
  }
  close();
  const out = promptKit.fromReplies({ frames, characters: state.characters, replies, style: $("style").value.trim(), outfitFromRef: $("outfitRef").checked });
  return { frames: out.frames, partial: false, extraRoles: out.extraRoles, cast: out.cast };
}

// Протокол 2 (старый Gem): сценарий → «Сколько кадров?» → число → порции с «дальше».
async function promptsViaOldGem(frames, gemUrl) {
  const scenario = frames.map((f) => `КАДР ${f.n}\n${f.prompt}`).join("\n\n");
  setStatus("Открываю ваш Gem на сайте Gemini… (до нескольких минут, вкладку Gemini не закрывайте)");
  const { tab, close } = await openGemTab(gemUrl);
  const res = await send(tab.id, { type: "gemini-run", scenario, count: frames.length });
  if (!res?.text) {
    throw new Error(`Gem на сайте Gemini не ответил: ${res?.error || "нет ответа"}. Вкладка Gemini оставлена открытой.`);
  }
  close();
  // Старый Gem отвечает без нашей строки «Персонажи»: определяем её по тексту сценария и промпта (с синонимами).
  const got = parseFrames(res.text);
  const byN = new Map(frames.map((f) => [f.n, f]));
  const list = got.map((g) => {
    const scene = byN.get(g.n)?.prompt || "";
    const chars = state.characters.filter((c) => charactersInPrompt(`${scene}\n${g.prompt}`, [c]).length).map((c) => c.name.split(/[,/;|]/)[0].trim());
    return { n: g.n, scene, prompt: g.prompt, chars };
  });
  if (!res.ok) log(`Gem: ${res.error}`);
  return { frames: list, partial: !res.ok, extraRoles: [] };
}

async function promptsViaGem(frames) {
  const gemUrl = $("gemUrl").value.trim();
  if (!/^https:\/\/gemini\.google\.com\//.test(gemUrl)) {
    throw new Error("Вставьте ссылку на ваш Gem (Настройки промптов → gemini.google.com/gem/…).");
  }
  state.frameLabel = "Gem:";
  setStatus("Открываю ваш Gem на сайте Gemini…");
  const own = await promptsViaOwnGem(frames, gemUrl);
  if (own) return own;
  log("Gem ответил не JSON (это старый Gem): общаюсь с ним по-старому, через «дальше».");
  return await promptsViaOldGem(frames, gemUrl);
}

// Шаг промптов. Источник — настройка «Источник промптов»:
//   «Авто»: сначала Gemini API (быстро); если лимит исчерпан, Gemini занят или ключа нет — Gem на сайте Gemini;
//   «Только API» / «Только Gem». Режим «Без ИИ» собирает промпты по шаблону мгновенно.
// Возвращает true при успехе.
async function fetchPrompts() {
  const frames = scenarioFrames().slice(0, Number($("count").value) || undefined);
  if (!frames.length) { setStatus("Вставьте сценарий по кадрам в блок 0."); return false; }
  if (!state.characters.length) log("Предупреждение: персонажи не добавлены, кадры будут без референсов.");
  const source = $("source").value || "auto";
  const generate = (mode, key = "") => generatePrompts({
    frames, characters: state.characters, key, mode, outfitFromRef: $("outfitRef").checked,
    model: $("model").value.trim(), style: $("style").value.trim(), notes: $("notes").value,
    onProgress: (t) => setStatus(t),
  });

  if ($("noAi").checked) {
    state.frameLabel = "Промпты:";
    setStatus("Собираю промпты по шаблону…");
    const res = await generate("template");
    state.cast = null; // без ИИ списка героев нет: остаётся предварительная догадка
    showPrompts(res.frames);
    log(`Промпты готовы по шаблону: ${res.frames.length} кадров`);
    return true;
  }

  // Ключ Google выглядит как «AIza…» (старый формат) или «AQ.…» (новый). Если вместе с ним вставился лишний
  // текст, вырезаем сам ключ.
  const rawKey = $("apiKey").value;
  const key = (rawKey.match(/AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_-]{20,}/) || [])[0] || rawKey.trim();
  const keyOk = !!key && /^[\x21-\x7e]+$/.test(key);
  if (keyOk && key !== rawKey.trim()) { $("apiKey").value = key; save(); log("В поле ключа был лишний текст, оставил только сам ключ."); }

  let apiError = null;
  if (source !== "gem") {
    if (!keyOk) {
      apiError = new Error(key ? "в поле ключа есть лишние символы" : "ключ Gemini API не вставлен");
    } else {
      state.frameLabel = "Промпты:";
      setStatus("Пишу промпты через Gemini API…");
      try {
        const res = await generate("ai", key);
        state.cast = res.cast;
        showPrompts(res.frames);
        log(`Промпты готовы через Gemini API: ${res.frames.length} кадров`);
        if (res.extraRoles.length) log(`Герои без фото: ${res.extraRoles.map((x) => x.label).join(", ")}. Внешность придумана ИИ и одинакова во всех кадрах; фото можно добавить в блоке 2.`);
        return true;
      } catch (e) {
        apiError = e;
      }
    }
    if (source === "api") throw apiError;
    log(`Gemini API не подошёл: ${apiError.message}`);
    setStatus("Gemini API недоступен, беру промпты у вашего Gem на сайте Gemini…");
  }

  const res = await promptsViaGem(frames);
  state.cast = res.cast?.length ? res.cast : null; // старый Gem списка героев не даёт: остаётся догадка
  showPrompts(res.frames);
  log(`Промпты готовы через Gem на сайте: ${res.frames.length} кадров из ${frames.length}`);
  if (res.partial) { setStatus(`Gem выдал не все кадры (${res.frames.length} из ${frames.length}). Проверьте блок 1.`); return false; }
  return true;
}

$("fetchPrompts").onclick = async () => {
  if (state.running) return;
  state.running = true;
  try { if (await fetchPrompts()) setStatus("Промпты готовы. Проверьте их в блоке 1 и нажмите «Сделать раскадровку»."); }
  catch (e) { setStatus(`Ошибка: ${e.message}`); }
  state.running = false;
};

$("start").onclick = () => startFlow();

async function startFlow() {
  if (state.running) return;
  const frames = parseFrames($("script").value).slice(0, Number($("count").value));
  if (!frames.length) return setStatus("Не нашёл кадров в сценарии. Нужны заголовки «КАДР 1», «КАДР 2»… (как в ответе Gemini).");
  const tab = await flowTab();
  if (!tab) return setStatus("Откройте проект Google Flow (flow.google.com/project/…) в соседней вкладке и войдите в аккаунт.");

  state.running = true;
  state.stop = false;
  $("bar").max = frames.length; $("bar").value = 0;
  const done = (await chrome.storage.local.get("done")).done || {};

  try {
  // Шаг 1: сначала загружаем во Flow ВСЕХ героев, которые понадобятся в кадрах (один раз). Шаг 2 — сами кадры,
  // они берут уже загруженных героев из библиотеки проекта.
  const needed = new Map();
  for (const f of frames) if (!done[f.n]) for (const c of charactersForFrame(f, state.characters)) needed.set(c.name, c);
  if (needed.size) {
    state.frameLabel = "Персонажи:";
    setStatus(`Загружаю персонажей во Flow (${needed.size})…`);
    const prep = await ask(tab.id, { type: "prepare", characters: [...needed.values()] });
    if (prep?.ok) log(`Персонажи во Flow: ${needed.size} (новых загрузок: ${prep.uploaded})`);
    else log(`Персонажи: ${prep?.error || "нет ответа"}. Продолжаю: кадры добавят героев сами.`);
  }

  for (const [i, f] of frames.entries()) {
    while (state.paused && !state.stop) await sleep(500);
    if (state.stop) break;
    if (done[f.n]) { log(`Кадр ${f.n}: пропущен, уже сделан (кнопка «Начать заново» сбрасывает)`); $("bar").value = i + 1; continue; }

    const chars = charactersForFrame(f, state.characters);
    state.frameLabel = `Кадр ${f.n} (${chars.map((c) => c.name).join(", ") || "без персонажей"}):`;
    setStatus(`${state.frameLabel} запускаю…`);

    const res = await ask(tab.id, { type: "generate", prompt: f.prompt, characters: chars });
    if (!res?.ok) {
      log(`Кадр ${f.n}: ошибка — ${res?.error || "нет ответа"}`);
      if (res?.limit) { setStatus("Лимит Flow исчерпан. Нажмите «Сделать раскадровку» позже — продолжу с этого кадра."); break; }
      continue;
    }
    // Скачивание — только если включено галочкой («Скачивать кадры…»): по умолчанию кадры остаются во Flow.
    if ($("download").checked) {
      await chrome.runtime.sendMessage({
        type: "download", url: res.imageUrl,
        filename: `Cartoon/frame_${String(f.n).padStart(3, "0")}.png`,
      });
    }
    done[f.n] = true;
    await chrome.storage.local.set({ done });
    log(`Кадр ${f.n}: готов`);
    $("bar").value = i + 1;
  }
  } catch (e) {
    log(`Ошибка: ${e.message || e}`);
  } finally {
    state.running = false; // что бы ни случилось, кнопки должны снова работать
  }
  if (state.stop) return;
  // Если все выбранные кадры готовы — сбрасываем память, чтобы следующий запуск не пропускал их.
  if (frames.every((f) => done[f.n])) {
    await chrome.storage.local.remove("done");
    setStatus($("download").checked ? "Готово: все кадры сделаны. Файлы лежат в «Загрузки/Cartoon»." : "Готово: все кадры сделаны, они во Flow (в вашем проекте).");
  } else {
    setStatus("Остановлено до конца. «Сделать раскадровку» продолжит с первого неготового кадра.");
  }
}

load();
