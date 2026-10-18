// Работает на странице Gemini (gemini.google.com): отправляет сценарий в Gem «Раскадровка»,
// отвечает на вопрос «Сколько кадров нужно?» и возвращает готовый ответ с промптами.
// Селекторы сняты с реальной страницы (окт. 2026). Редактор — Quill (div[role=textbox]),
// отправка программным кликом работает (в отличие от Flow), ответ — элементы <model-response>.
(() => {
  if (window.__geminiAuto) return;
  window.__geminiAuto = true;

  const SEL = {
    editor: 'div[role="textbox"][aria-label="Введите запрос для Gemini"], rich-textarea div[role="textbox"]',
    send: 'button[aria-label="Отправить сообщение"], button[aria-label="Send message"]',
    response: "model-response",
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
  const isGenerating = () =>
    [...document.querySelectorAll("button")].some((b) => /Останов|Stop/i.test(b.getAttribute("aria-label") || ""));
  const responses = () => [...document.querySelectorAll(SEL.response)];
  // Текст последнего ответа без служебной шапки («Мой Gem-бот / Ответ Gem-бота …»), которая появляется
  // сразу, ещё до самого ответа: иначе пустой ответ принимается за готовый.
  const lastText = () => {
    const r = responses().at(-1);
    return (r?.querySelector("message-content")?.innerText ?? "").trim();
  };

  async function setEditorText(text) {
    const ed = document.querySelector(SEL.editor);
    const put = async (t) => {
      ed.focus();
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      await sleep(150);
      document.execCommand("insertText", false, t);
      await sleep(500);
    };
    await put(text);
    // Многострочный ввод в редактор иногда теряет строки: тогда повторяем одной строкой.
    if (ed.innerText.replace(/\s/g, "").length < text.replace(/\s/g, "").length * 0.95) {
      await put(text.replace(/\s*\n\s*/g, " "));
    }
  }

  // Отправляет сообщение и ждёт, пока Gem закончит ответ. Возвращает текст нового ответа.
  async function sendAndWait(text) {
    if (!(await waitFor(() => document.querySelector(SEL.editor), 30000))) throw new Error("Не нашёл поле ввода Gemini (войдите в аккаунт?)");
    const before = responses().length;
    await setEditorText(text);
    const send = await waitFor(() => document.querySelector(SEL.send), 5000);
    if (!send) throw new Error("Не нашёл кнопку отправки Gemini");
    send.click();
    if (!(await waitFor(() => responses().length > before, 60000))) throw new Error("Gem не начал отвечать");

    // Ответ готов, когда кнопки «Остановить» нет, а длина текста не меняется несколько секунд подряд.
    let last = -1, stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 6 * 60 * 1000) {
      await sleep(1000);
      const len = lastText().length;
      stable = !isGenerating() && len > 0 && len === last ? stable + 1 : 0;
      last = len;
      if (stable >= 3) return lastText();
    }
    throw new Error("Gem слишком долго отвечает (больше 6 минут)");
  }

  const hasStoryboard = (t) => /КАДР\s*\d/i.test(t) && /plaintext/i.test(t);

  const frameNumbers = (t) => new Set([...t.matchAll(/КАДР\s*(\d+)/gi)].map((m) => Number(m[1])));
  const progress = (text) => chrome.runtime.sendMessage({ type: "progress", text }).catch(() => {});

  // Gem выдаёт промпты порциями (по ~5 кадров) и ждёт слова «дальше» для следующей порции.
  // Повторяем «дальше», пока не наберём нужное число кадров. Если порция не добавила ни одного нового
  // кадра дважды подряд — останавливаемся (иначе зациклимся).
  async function run({ scenario, count }) {
    let text = await sendAndWait(scenario);
    const parts = [];
    const have = new Set();
    let stalls = 0;
    for (let round = 0; round < 40; round++) {
      if (hasStoryboard(text)) {
        parts.push(text);
        const before = have.size;
        frameNumbers(text).forEach((n) => have.add(n));
        progress(`Gemini: получено кадров ${have.size} из ${count}`);
        if (have.size >= count) return { ok: true, text: parts.join("\n\n") };
        stalls = have.size === before ? stalls + 1 : 0;
        if (stalls >= 2) break;
        text = await sendAndWait("дальше");
      } else if (/сколько кадров/i.test(text)) {
        text = await sendAndWait(String(count));
      } else break;
    }
    if (parts.length) {
      return { ok: false, error: `Gem выдал кадров: ${have.size} из ${count}`, text: parts.join("\n\n") };
    }
    return { ok: false, error: `Gem ответил не так, как ожидалось: «${text.slice(0, 200)}»`, text };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Одно сообщение в Gem — один ответ (для вашего Gem, который сам отвечает одним JSON без вопросов).
    if (msg?.type === "gemini-ask") {
      progress("Gem пишет ответ…");
      sendAndWait(msg.text)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    if (msg?.type === "gemini-run") {
      run(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
  });
})();
