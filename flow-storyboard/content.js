// Работает внутри страницы Google Flow. Здесь вся «привязка» к интерфейсу.
// Селекторы сняты с реального интерфейса (flow.google.com/project/<id>), окт. 2026.
// Flow меняет вёрстку, поэтому при поломках правится только этот блок.
//
//  - промпт: ProseMirror contenteditable, ввод через execCommand, а не .value
//  - персонажи, способ 1 (быстрый): выбрать уже загруженный файл из окна «+» по ТОЧНОМУ имени.
//    После выбора картинка в запросе сверяется с фото персонажа (отпечаток 8×8), при несовпадении
//    всё очищается и работает способ 2. Раньше выбор без проверки цеплял не того персонажа.
//  - персонажи, способ 2 (надёжный): фото ВСТАВЛЯЕТСЯ в поле промпта событием paste (как Ctrl+V),
//    Flow прикрепляет ровно этот файл (проверено). Файл при этом добавляется в проект, поэтому
//    имя запоминается, и в следующих кадрах используется способ 1.
//  - кнопка «Начать генерацию» принимает только настоящий клик (его делает background через debugger)
//  - после генерации Flow очищает запрос вместе с ингредиентами: персонажей нужно добавлять каждый кадр
//  - на странице есть g-recaptcha-response: возможна проверка на бота
// Обёртка нужна: панель может подгрузить этот файл повторно (см. ensureInjected в sidepanel.js).
(() => {
if (window.__flowAutoContent) return;
window.__flowAutoContent = true;

const SEL = {
  promptInput: 'div[role="textbox"][aria-label="Что вы хотите создать?"]',
  addIngredientsBtn: 'button[aria-label="Добавить ингредиенты в окно запроса"]',
  generateBtn: 'button[aria-label="Начать генерацию"]',
  clearBtn: 'button[aria-label="Очистить запрос"]',
  chip: 'button.chip-container[aria-label="Ингредиент"]',
  chipImage: "img.chip-image",
  // Окно «+»: широкое — flow-add-menu-popover-content (после выбора строки нужно «Добавить в запрос»),
  // узкое (масштаб Windows) — flow-mobile-add-menu (клик по строке сразу прикрепляет и закрывает окно).
  menuRoot: "flow-add-menu-popover-content, flow-mobile-add-menu",
  row: "flow-add-menu-popover-content button.asset-item, flow-mobile-add-menu button.asset-item",
  rowTitle: ".asset-title",
  addToPromptBtn: "button.detail-add-to-prompt-btn",
  mobileClose: "flow-mobile-add-menu button.close-button",
  // Готовая картинка: <img class="image"> с src flow-content.google/image/<uuid>?..., ~1376px, ~25 с, ×2 варианта.
  resultImage: 'img.image[src*="flow-content.google/image/"]',
  limitMessage: null,  // TODO: текст при исчерпании лимита ещё не наблюдался
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, stepMs = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

const currentImages = () => new Set([...document.querySelectorAll(SEL.resultImage)].map((i) => i.src.split("?")[0]));
const chipCount = () => document.querySelectorAll(SEL.chip).length;
const fileNameFor = (c) => `char_${c.name.replace(/[^\p{L}\p{N}_-]+/gu, "_").toLowerCase()}.png`;
const projectId = () => (location.pathname.match(/\/project\/([^/]+)/) || [])[1] || "unknown";
const progress = (text) => chrome.runtime.sendMessage({ type: "progress", text }).catch(() => {});

// Состояние страницы для сообщений об ошибках (чтобы по одной строке журнала понять, что на экране).
const pageState = () =>
  `страница ${location.pathname}; поля: ${[...document.querySelectorAll('[role="textbox"]')].map((e) => e.getAttribute("aria-label")).join(" | ") || "нет"}`;

// ---------- проверка «тот ли персонаж» ----------
// Отпечаток 8×8 в градациях серого без среднего: устойчив к пережатию картинки Flow.
async function fingerprint(blob) {
  const bm = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bm, 0, 0, 8, 8);
  const d = g.getImageData(0, 0, 8, 8).data;
  const v = [];
  for (let i = 0; i < d.length; i += 4) v.push((d[i] + d[i + 1] + d[i + 2]) / 3);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return v.map((x) => x - mean);
}
const distance = (a, b) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length;
const expectedCache = new Map();
async function expectedFingerprint(c) {
  if (!expectedCache.has(c.dataUrl)) expectedCache.set(c.dataUrl, await fingerprint(await (await fetch(c.dataUrl)).blob()));
  return expectedCache.get(c.dataUrl);
}
async function lastChipMatches(c) {
  const chips = document.querySelectorAll(SEL.chip);
  const img = chips[chips.length - 1]?.querySelector(SEL.chipImage);
  if (!img) return false;
  const actual = await fingerprint(await (await fetch(img.src)).blob());
  return distance(actual, await expectedFingerprint(c)) < 10;
}

const chipLoaded = (before) => () => {
  const chips = document.querySelectorAll(SEL.chip);
  if (chips.length <= before) return false;
  const img = chips[chips.length - 1].querySelector(SEL.chipImage);
  return img && img.complete && img.naturalWidth > 0;
};

// ---------- способ 2: вставка фото в поле промпта ----------
async function attachByPaste(c) {
  const box = document.querySelector(SEL.promptInput);
  if (!box) throw new Error(`Не нашёл поле промпта Flow (${pageState()})`);
  const before = chipCount();
  const blob = await (await fetch(c.dataUrl)).blob();
  const file = new File([blob], fileNameFor(c), { type: blob.type || "image/png" });
  const dt = new DataTransfer();
  dt.items.add(file);
  box.focus();
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  if (!(await waitFor(chipLoaded(before), 90000))) throw new Error(`Не удалось прикрепить «${c.name}»: фото не загрузилось во Flow`);
}

// ---------- способ 1: выбор уже загруженного файла из окна «+» ----------
async function closeMenu() {
  if (!document.querySelector(SEL.menuRoot)) return;
  const mobile = document.querySelector(SEL.mobileClose);
  if (mobile) mobile.click();
  else document.querySelector(SEL.addIngredientsBtn)?.click(); // в широком окне «+» превращается в «×»
  await waitFor(() => !document.querySelector(SEL.menuRoot), 3000);
}

// Открывает окно «+», фильтрует список по имени файла и возвращает строку этого файла (окно остаётся открытым).
// Если файла в библиотеке проекта нет — закрывает окно и возвращает null.
async function findInLibrary(fileName) {
  document.querySelector(SEL.addIngredientsBtn)?.click();
  if (!(await waitFor(() => document.querySelector(SEL.menuRoot), 5000))) return null;
  await sleep(800); // список объектов подгружается после открытия окна

  // Фильтруем список по имени и ждём, пока фильтр применится (в списке остаются только подходящие строки).
  const input = document.querySelector(SEL.menuRoot)?.querySelector("input");
  if (input) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, fileName);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const rowFor = () =>
    [...document.querySelectorAll(SEL.row)].find((r) => (r.querySelector(SEL.rowTitle)?.textContent || "").trim().toLowerCase() === fileName);
  await waitFor(() => rowFor() && [...document.querySelectorAll(SEL.row)].every((r) => r.textContent.toLowerCase().includes(fileName)), 4000);
  const row = rowFor();
  if (!row) await closeMenu();
  return row || null;
}

async function attachFromLibrary(c) {
  const fileName = fileNameFor(c);
  const before = chipCount();
  const row = await findInLibrary(fileName);
  if (!row) return false;

  row.click();
  const step = await waitFor(() => document.querySelector(SEL.addToPromptBtn) || (chipCount() > before ? "chip" : null), 4000);
  if (step && step !== "chip") step.click();
  if (!(await waitFor(chipLoaded(before), 15000))) { await closeMenu(); return false; }
  await closeMenu();
  return await lastChipMatches(c);
}

// Добавляет всех персонажей кадра. Известных проекту — быстро из библиотеки (с проверкой), иначе вставкой.
async function attachCharacters(characters) {
  if (!characters.length) return;
  const key = `uploaded:${projectId()}`;
  const known = (await chrome.storage.local.get(key))[key] || {};

  if (characters.every((c) => known[fileNameFor(c)])) {
    let ok = true;
    for (const c of characters) {
      if (!(await attachFromLibrary(c))) { ok = false; break; }
    }
    if (ok) return;
    progress("Выбор из библиотеки не подтвердился, загружаю фото заново");
    document.querySelector(SEL.clearBtn)?.click(); // сбрасываем всё, что успело прикрепиться
    await sleep(700);
  }

  for (const c of characters) {
    await attachByPaste(c);
    known[fileNameFor(c)] = true;
  }
  await chrome.storage.local.set({ [key]: known });
}

// Подготовка перед раскадровкой: все нужные герои заранее загружаются в проект Flow (один раз, по именам файлов), чтобы
// кадры брали их из библиотеки, а не загружали заново в каждом кадре. Уже загруженные (по имени) пропускаются.
async function prepareCharacters(characters) {
  const key = `uploaded:${projectId()}`;
  const known = (await chrome.storage.local.get(key))[key] || {};
  let uploaded = 0;
  for (const [i, c] of characters.entries()) {
    const name = fileNameFor(c);
    progress(`Загружаю персонажей во Flow: ${c.name} (${i + 1} из ${characters.length})…`);
    const row = await findInLibrary(name);
    if (row) { await closeMenu(); known[name] = true; continue; } // уже есть в проекте
    document.querySelector(SEL.clearBtn)?.click();
    await sleep(400);
    await attachByPaste(c);                       // загружает файл в проект (и прикрепляет к запросу)
    document.querySelector(SEL.clearBtn)?.click(); // сам ингредиент сейчас не нужен: файл уже в проекте
    await sleep(700);
    known[name] = true;
    uploaded++;
  }
  await chrome.storage.local.set({ [key]: known });
  return { ok: true, uploaded };
}

// Если после прошлого кадра Flow оказался не на странице с полем запроса (например, в режиме редактирования
// картинки), пробуем вернуться в проект.
async function ensureComposer() {
  if (document.querySelector(SEL.promptInput)) return true;
  if (/\/edit\//.test(location.pathname)) {
    history.back();
    if (await waitFor(() => document.querySelector(SEL.promptInput), 8000)) return true;
  }
  return false;
}

async function generate({ prompt, characters }) {
  if (!(await ensureComposer())) return { ok: false, error: `Не нашёл поле промпта Flow (${pageState()})` };
  const box = document.querySelector(SEL.promptInput);
  const btn = () => document.querySelector(SEL.generateBtn);
  if (!btn()) return { ok: false, error: `Не нашёл кнопку генерации Flow (${pageState()})` };

  document.querySelector(SEL.clearBtn)?.click(); // убрать прошлые ингредиенты и текст
  await sleep(500);
  if (chipCount() > 0) return { ok: false, error: "Не удалось очистить прошлые ингредиенты в запросе" };

  try {
    progress(characters.length ? "Добавляю персонажей…" : "Персонажей в кадре нет");
    await attachCharacters(characters);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (chipCount() !== characters.length) {
    return { ok: false, error: `В запросе ${chipCount()} ингредиентов вместо ${characters.length}, пропускаю кадр, чтобы не получить не тех персонажей` };
  }

  const before = currentImages();

  const composer = document.querySelector(SEL.promptInput);
  if (!composer) return { ok: false, error: `Поле промпта пропало после добавления персонажей (${pageState()})` };
  composer.focus();
  document.execCommand("selectAll", false);
  document.execCommand("delete", false);
  document.execCommand("insertText", false, prompt);
  if (!(await waitFor(() => btn() && !btn().disabled, 5000))) return { ok: false, error: `Кнопка генерации не активировалась (${pageState()})` };

  // Программный .click() Flow игнорирует (проверено): нужен настоящий клик через background (chrome.debugger).
  progress("Нажимаю «Создать»…");
  // Снимок текста страницы до нажатия: всё, что появится потом и похоже на отказ, считаем ответом Flow на этот кадр.
  const pageLines = () => document.body.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
  const seenLines = new Set(pageLines());
  const r = btn().getBoundingClientRect();
  const click = await chrome.runtime.sendMessage({ type: "trustedClick", x: r.x + r.width / 2, y: r.y + r.height / 2 });
  if (!click?.ok) return { ok: false, error: `Не удалось нажать «Создать»: ${click?.error || "нет ответа"}` };

  progress("Жду картинку от Flow…");
  const FAIL = /не удалось|ошибк|заблокирован|нарушает|не можем|не получилось|попробуйте ещ|попробуйте еще|failed|couldn.?t|can.?t generate|blocked|policy|violat|something went wrong|try again|лимит|quota/i;
  let fresh = null;
  let failText = null;
  let failHits = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    fresh = [...document.querySelectorAll(SEL.resultImage)].find((i) => !before.has(i.src.split("?")[0]));
    if (fresh) break;
    // Сообщение об отказе должно продержаться несколько секунд подряд, чтобы не принять за отказ мелькнувшую подсказку.
    const hit = pageLines().find((l) => !seenLines.has(l) && FAIL.test(l));
    if (hit) { failHits++; failText = hit; if (failHits >= 4) break; } else { failHits = 0; failText = null; }
    await sleep(1000);
  }
  if (!fresh && failText && failHits >= 4) {
    return { ok: false, error: `Flow не сделал кадр, написал: «${failText.slice(0, 180)}»`, limit: /лимит|quota|bonus|бонус/i.test(failText) };
  }
  if (!fresh) return { ok: false, error: `Не дождался результата за 3 минуты (возможно, лимит или проверка на бота; ${pageState()})` };
  return { ok: true, imageUrl: fresh.src };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "prepare") {
    ensureComposer()
      .then((ok) => (ok ? prepareCharacters(msg.characters) : { ok: false, error: `Не нашёл поле запроса Flow (${pageState()})` }))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "generate") {
    generate(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
})();
