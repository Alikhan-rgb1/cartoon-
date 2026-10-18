// Генерация промптов раскадровки через Gemini API (бесплатный ключ из Google AI Studio).
// Заменяет шаг «сценарий → Gem → промпты»: Gem писал длинные английские промпты по шаблону, мы делаем то же самое,
// но в два этапа, чтобы кадры были согласованы между собой:
//   1) «библия»: места действия, одежда персонажей в каждом месте (одна и та же во всех кадрах этого места) и
//      внешность тех героев, у которых нет фото (сын, дочка…): придумывается один раз и повторяется во всех кадрах;
//   2) кадры пачками по 6 (параллельно): эмоции, действие, свет, камера, атмосфера, планы.
// Итоговый текст промпта собирается шаблоном в коде (так же, как у Gem: строки «Use the attached reference
// photos for the father…», «Master Location: …», одежда, эмоции, действие, свет, камера, атмосфера, планы, стиль),
// поэтому структура всегда одинаковая, а ИИ отвечает только содержанием полей.
// Режим «ai» никогда молча не подменяется шаблоном: при неудаче пользователь видит причину и может повторить.
// Шаблон без ИИ — только по явному режиму «template».
// Обёртка IIFE нужна, чтобы не конфликтовать с именами в sidepanel.js.
(() => {
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"]; // пробуем по порядку при 404/503/429
const BATCH = 12; // до 12 кадров — один запрос на всё (бесплатный тариф: ~20 запросов в сутки на модель)
const CONCURRENCY = 3;
const TIMEOUT_MS = 90000; // структурированный ответ на пачку кадров может идти заметно дольше 25 с
const ROUNDS = 3;         // кругов по моделям при перегрузке, между кругами короткая пауза
const DEFAULT_STYLE = "3D animated movie, Big Hero 6–like rendering style, aspect ratio 16:9, ultra high resolution 4K.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// keepOutfit: у героя с референсом одежду не придумываем, а берём с картинки-референса (иначе придуманная ИИ одежда
// перебивает ту, что нарисована у героя на референсе).
const identityLine = (role, keepOutfit = false) =>
  `Use the attached reference photos for the ${role}. Character identity locked. Maintain 100% exact facial geometry. ` +
  `Preserve exact facial proportions. Do not reinterpret or stylize faces. Do not beautify. Do not modify age. ` +
  `Apply 3D animated movie style only to rendering, lighting, shading and materials, not to facial structure. ` +
  `Identity consistency required across all scenes.` +
  (keepOutfit
    ? ` Keep the ${role}'s exact clothing, hairstyle, accessories, colors and body proportions exactly as shown in the reference image, unchanged in every scene.`
    : "");

// «папа» → «father»: роль в промпте по-английски (расширение потом находит персонажа по синониму).
function roleFor(label) {
  const eng = aliasesFor(label).find((w) => /^[a-z]+$/i.test(w));
  return eng || label.trim();
}

// Один запрос без внутренних ожиданий: при перегрузке выше по стеку переходим на другую модель.
async function callOnce({ key, model, system, user, schema, timeoutMs = TIMEOUT_MS }) {
  const url = `${API_BASE}${model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 16000, responseMimeType: "application/json", responseSchema: schema },
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(e.name === "TimeoutError" ? `Gemini не ответил за ${timeoutMs / 1000} с` : `Нет связи с Gemini API: ${e.message}`);
    err.overloaded = true; // временно недоступно: можно попробовать другую модель / позже
    throw err;
  }
  if (res.ok) {
    const data = await res.json();
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) {
      const err = new Error(`Gemini вернул пустой ответ (${cand?.finishReason || data.promptFeedback?.blockReason || "причина неизвестна"})`);
      err.overloaded = true;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error(`Gemini вернул некорректный JSON (${cand?.finishReason || "?"})`);
      err.overloaded = true; // обрезанный/кривой ответ: повтор или другая модель обычно помогают
      throw err;
    }
  }
  const errBody = await res.json().catch(() => ({}));
  const msg = errBody.error?.message || res.statusText;
  const fatal = (m) => Object.assign(new Error(m), { fatal: true }); // ожиданием не лечится: нужно действие пользователя
  if (res.status === 400 && /API key/i.test(msg)) throw fatal("Ключ Gemini API не подошёл. Проверьте ключ в Google AI Studio (aistudio.google.com/apikey).");
  if (res.status === 403) throw fatal(`Доступ запрещён (403): ${msg}`);
  if (res.status === 404) throw Object.assign(new Error("MODEL_NOT_FOUND"), { modelNotFound: true });
  // 429 бывает двух видов: «слишком часто» (проходит за секунды) и «исчерпана суточная квота» («Quota exceeded …
  // retry in 4h55m»). Второй вид повторять бессмысленно: переходим к другой модели (квоты у моделей отдельные) и
  // запоминаем, до какого времени эту пропускать.
  if (res.status === 429 && /quota/i.test(msg) && /retry in\s*\d+\s*h|retry in\s*\d+\s*m\s*\d/i.test(msg)) {
    const m = msg.match(/retry in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i) || [];
    const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
    throw Object.assign(new Error(`Суточный лимит бесплатного тарифа исчерпан (${model})`), { quota: true, retryInMs: ms, model });
  }
  if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`Лимит или сбой Gemini API (${res.status}): ${msg}`), { overloaded: true });
  throw fatal(`Gemini API ${res.status}: ${msg}`);
}

// Если модель не найдена (404) или перегружена (503/429/таймаут), переходим к следующей: у Google разные модели
// перегружаются в разное время. Если перегружены все — до ROUNDS кругов с паузой 8/16 с.
let workingModel = null;
const exhaustedUntil = {}; // модель → время (мс), до которого её суточная квота кончилась
const humanDuration = (ms) => {
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
};
async function call(opts) {
  const order = [...new Set([workingModel, opts.model, ...MODELS].filter(Boolean))];
  let last = null;
  let quotaErr = null;
  for (let round = 1; round <= ROUNDS; round++) {
    let tried = 0;
    let anyExists = false;
    for (const model of order) {
      if ((exhaustedUntil[model] || 0) > Date.now()) { quotaErr = quotaErr || { model, ms: exhaustedUntil[model] - Date.now() }; continue; } // уже знаем: лимит кончился
      tried++;
      try {
        const out = await callOnce({ ...opts, model });
        workingModel = model;
        return out;
      } catch (e) {
        if (e.quota) { exhaustedUntil[model] = Date.now() + (e.retryInMs || 3600000); quotaErr = { model, ms: e.retryInMs || 3600000 }; }
        else if (e.overloaded) { last = e; anyExists = true; }
        else if (!e.modelNotFound) throw e;
      }
    }
    if (!tried) break;       // все модели уже исчерпаны: ждать бессмысленно
    if (!anyExists) break;   // остались только исчерпанные/несуществующие модели
    if (round < ROUNDS) {
      opts.onProgress?.(`Gemini занят (${last.message}). Пауза ${8 * round} с и повтор — круг ${round + 1} из ${ROUNDS}…`);
      await sleep(8000 * round);
    }
  }
  const quotaMsg = quotaErr ? `Суточный лимит бесплатного тарифа Gemini API исчерпан (сбросится примерно через ${humanDuration(quotaErr.ms)}).` : "";
  if (last) throw Object.assign(new Error(`Gemini сейчас не отвечает: ${last.message}.${quotaMsg ? " " + quotaMsg : ""}`), { unavailable: true });
  if (quotaMsg) throw Object.assign(new Error(quotaMsg), { unavailable: true, quota: true });
  throw Object.assign(new Error("Модель Gemini не найдена. Впишите актуальное имя модели в настройках (например gemini-2.5-flash)."), { unavailable: true });
}

const S = (description) => ({ type: "STRING", description });
const BIBLE_SCHEMA = {
  type: "OBJECT",
  properties: {
    cast: {
      type: "ARRAY",
      description: "every recurring character of the story, with and without reference photos",
      items: {
        type: "OBJECT",
        properties: {
          name: S("the name exactly as written in the story, nominative case; if the story gives no name use the Russian role word, e.g. 'папа'"),
          role: S("role in English, e.g. father, mother, son, daughter, friend"),
        },
        required: ["name", "role"],
      },
    },
    characters: {
      type: "ARRAY",
      description: "only for roles WITHOUT reference photos",
      items: { type: "OBJECT", properties: { role: S("role exactly as given"), appearance: S("noun phrase completing 'The <role> is ...': age, build, hair, face, skin tone") }, required: ["role", "appearance"] },
    },
    locations: {
      type: "ARRAY",
      description: "Master Location blocks: one per distinct place + time of day + weather + lighting setup",
      items: {
        type: "OBJECT",
        properties: {
          key: S("short id, e.g. park_morning, restaurant_night"),
          description: S("complete standalone Master Location: interior/exterior, city or general setting, time of day, weather if exterior, main architecture, floor/ground material, key furniture and objects, background depth, atmospheric elements, visible practical lights, decorations, spatial layout"),
        },
        required: ["key", "description"],
      },
    },
    wardrobes: {
      type: "ARRAY",
      description: "Wardrobe sets: one per day / season / occasion of the story",
      items: {
        type: "OBJECT",
        properties: {
          key: S("short id, e.g. day1_casual, dinner_formal"),
          outfits: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                role: S("character role exactly as given"),
                outfit: S("noun phrase completing 'The <role> wears ...': outerwear if any, top, bottom, shoes, accessories, dominant colors, materials, fit, formal or casual"),
              },
              required: ["role", "outfit"],
            },
          },
        },
        required: ["key", "outfits"],
      },
    },
  },
  required: ["locations", "wardrobes"],
};
const FRAMES_SCHEMA = {
  type: "OBJECT",
  properties: {
    frames: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          n: { type: "INTEGER" },
          location_key: S("key of one of the given locations"),
          wardrobe_key: S("key of one of the given wardrobe sets"),
          roles: { type: "ARRAY", items: { type: "STRING" }, description: "roles visible in this frame, from the given list only" },
          emotions: S("the emotional state of EACH visible character (never facial features)"),
          action: S("a clear physical action of EACH visible character and where they stand in the frame"),
          lighting: S("light sources with color temperature in K, shadows, highlights"),
          camera: S("shot type, lens in mm, camera height/angle, composition"),
          atmosphere: S("mood of the scene in one sentence"),
          layers: S("'In the foreground ...; in the midground ...; in the background ...'"),
        },
        required: ["n", "location_key", "wardrobe_key", "roles", "emotions", "action", "lighting", "camera", "atmosphere", "layers"],
      },
    },
  },
  required: ["frames"],
};

// Правила взяты из инструкций вашего исходного Gem «Раскадровка»: Master Location копируется дословно, пока не меняются
// место/время суток/погода/свет; одежда одна и та же в течение одного дня и новая в новый день или по особому поводу;
// у каждого героя в кадре своё физическое действие; лица героев с фото не описываются (только эмоции и язык тела).
const BIBLE_SYSTEM =
  "You are the director and continuity supervisor of a cinematic storyboard for a 3D animated family film (Big Hero 6 look). " +
  "You receive the story as numbered frames (in story order) and the list of character roles. Respect the chronology: never reorder frames. " +
  "1) locations: define every distinct Master Location. A new location entry is required whenever the place, the room, the time of day, the weather or the lighting setup changes. " +
  "Each entry is complete and stands alone (never 'same as before'). Frames in the same setup will reuse the same key, so the text is repeated verbatim. " +
  "2) wardrobes: define one wardrobe set per day, season, year or special occasion (ceremony, trip, formal dinner, sport, hospital, wedding, birthday...). " +
  "Within one day every role keeps exactly the same outfit; a new day, season, year or occasion needs a new, clearly different outfit. " +
  "Give every role that appears (with or without photo) a concrete outfit: outerwear if any, top, bottom, shoes, accessories, dominant colors, materials, fit, formal or casual. Suit the weather and the occasion. " +
  "0) cast: list EVERY recurring character of the story, including those with reference photos: the name exactly as written in the story (nominative case; if the story gives no name, the Russian role word such as 'папа') and the English role. " +
  "3) characters: some roles have no reference photos. For each of those invent ONE fixed appearance (age, build, hair, face, skin tone) that fits the family and reuse it unchanged in every frame. " +
  "Never describe the faces of roles that DO have reference photos. Write everything in English. Do not invent characters that are not in the role lists.";

const FRAMES_SYSTEM =
  "You are the storyboard artist of a cinematic storyboard for a 3D animated family film (Big Hero 6 look). For each given frame write the cinematic fields. " +
  "Follow the frame text exactly: do not invent plot events, do not add characters, keep the story order. Use only roles from the given list, and include every listed role that is in the frame text. " +
  "location_key and wardrobe_key must be keys from the given lists: pick the location whose place, time of day and lighting match the frame, and the wardrobe set of that day/occasion. " +
  "Every visible character has a clear physical action (standing, turning, holding, walking, reaching, embracing, watching, listening, dancing, lifting, speaking, cooking, waiting, entering...) and the emotion matches that action. " +
  "Describe only emotional state and body language, never facial features (eyes, nose, lips, jaw, skin, beauty, age). Each frame communicates one clear emotional beat. " +
  "No text, signs or logos in the image. Each field is 1-2 vivid sentences in English with concrete visual detail. " +
  "Lighting must name light sources and color temperature (e.g. 5500K). Camera must name shot type, lens in mm and camera height. " +
  "Keep the same visual language across frames. Write everything in English.";

// photoRoles — герои с фото (строка identity lock), extras — {роль: внешность} для героев без фото.
// detRoles — роли, найденные в самом тексте кадра (надёжнее, чем ответ ИИ: он мог назвать «dad» вместо «father»
// или пропустить героев с фото). Ответ ИИ только дополняет этот список.
function assemble(fr, bible, photoRoles, extras, style, detRoles = [], outfitFromRef = true) {
  const { locations, wardrobes = [] } = bible;
  const loc = locations.find((l) => l.key === fr.location_key) || locations[0];
  // Набор одежды: по ключу кадра; для старого формата (одежда внутри места) — из места.
  const wardrobe = wardrobes.find((w) => w.key === fr.wardrobe_key) || wardrobes[0] || loc;
  const outfitList = wardrobe.outfits || loc.outfits || [];
  const allRoles = [...photoRoles, ...Object.keys(extras)];
  const canon = (r) => {
    const s = String(r).toLowerCase();
    return allRoles.find((x) => x.toLowerCase() === s) || allRoles.find((x) => aliasesFor(x).includes(s));
  };
  const found = new Set([...detRoles, ...(fr.roles || []).map(canon)].filter(Boolean));
  const present = allRoles.filter((r) => found.has(r)); // порядок: сначала герои с фото, потом без фото
  const lines = present.filter((r) => photoRoles.includes(r)).map((r) => identityLine(r, outfitFromRef));
  for (const r of present) if (extras[r]) lines.push(`The ${r} is ${String(extras[r]).replace(/^is\s+/i, "").replace(/\.$/, "")}. Keep this exact appearance in every scene.`);
  lines.push(`Master Location: ${loc.description}`);
  const outfits = present
    .filter((r) => !(outfitFromRef && photoRoles.includes(r))) // герои с референсом: одежда берётся с картинки
    .map((r) => {
      const o = outfitList.find((x) => String(x.role).toLowerCase() === r.toLowerCase());
      return o ? `The ${r} wears ${o.outfit.replace(/^wears\s+/i, "").replace(/\.$/, "")}.` : null;
    })
    .filter(Boolean);
  if (outfits.length) lines.push(outfits.join(" "));
  for (const k of ["emotions", "action", "lighting", "camera", "atmosphere", "layers"]) if (fr[k]) lines.push(String(fr[k]).trim());
  lines.push(style);
  return { prompt: lines.join("\n"), present };
}

// Короткая подпись персонажа для строки «Персонажи: …» (первый вариант из подписи; остальные — синонимы).
const primaryLabel = (c) => c.name.split(/[,/;|]/)[0].trim();

async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await worker(items[i], i);
      }
    })
  );
}

// Запасной вариант без ИИ (только по явному режиму «template»): мгновенно и всегда работает.
function templatePrompt(f, characters, style, notes, outfitFromRef = true) {
  const present = charactersInPrompt(f.prompt, characters);
  const lines = present.map((c) => identityLine(roleFor(c.name), outfitFromRef));
  const extras = extraRolesIn(f.prompt, characters).map((x) => x.role);
  lines.push(`Scene: ${f.prompt.replace(/\s+/g, " ").trim()}`);
  for (const r of extras) lines.push(`The ${r} appears in this scene (no reference photo): keep the same look for the ${r} in every scene.`);
  if (notes?.trim()) lines.push(`Requirements: ${notes.trim()}`);
  lines.push(
    "Keep the same wardrobe, hairstyles and location details as in the other frames of this story. " +
    "Expressive natural emotions, cinematic composition, soft natural lighting, shallow depth of field."
  );
  lines.push(style);
  return lines.join("\n");
}

const COMBINED_SCHEMA = {
  type: "OBJECT",
  properties: {
    cast: BIBLE_SCHEMA.properties.cast,
    characters: BIBLE_SCHEMA.properties.characters,
    locations: BIBLE_SCHEMA.properties.locations,
    wardrobes: BIBLE_SCHEMA.properties.wardrobes,
    frames: FRAMES_SCHEMA.properties.frames,
  },
  required: ["locations", "wardrobes", "frames"],
};
const COMBINED_SYSTEM = `${BIBLE_SYSTEM} In the same answer, ${FRAMES_SYSTEM.charAt(0).toLowerCase()}${FRAMES_SYSTEM.slice(1)}`;

// Внешность героев без фото: из ответа ИИ (в т.ч. найденные им самим повторяющиеся герои) + запасное описание.
function buildExtras(bibleChars, photoRoles, extraRoleNames) {
  const extras = {};
  for (const c of bibleChars || []) {
    if (!c.role || !c.appearance) continue;
    const known = extraRoleNames.find((x) => x.toLowerCase() === String(c.role).toLowerCase());
    const isPhoto = photoRoles.some((x) => x.toLowerCase() === String(c.role).toLowerCase());
    if (known) extras[known] = c.appearance;
    else if (!isPhoto) extras[String(c.role)] = c.appearance;
  }
  for (const r of extraRoleNames) if (!extras[r]) extras[r] = `a ${r} character with a consistent look`;
  return extras;
}

// Русская подпись роли для показа: grandmother → «бабушка»; имена и неизвестные роли остаются как есть.
function ruLabelFor(role) {
  const g = typeof SYNONYMS !== "undefined" ? SYNONYMS.find((x) => x.includes(String(role).toLowerCase())) : null;
  return g ? g[0] : role;
}

// Сборка итоговых промптов из ответа ИИ.
function finish({ frames, results, bible, extras, photoRoles, characters, style, extra, done, outfitFromRef = true }) {
  const missing = frames.filter((f) => !results.has(f.n)).map((f) => f.n);
  if (missing.length) throw Object.assign(new Error(`Gemini не написал кадры ${missing.join(", ")}`), { unavailable: true });
  const list = frames.map((f) => {
    const detRoles = [
      ...charactersInPrompt(f.prompt, characters).map((c) => roleFor(c.name)),
      ...extraRolesIn(f.prompt, characters).map((x) => x.role),
    ];
    const { prompt, present } = assemble(results.get(f.n), bible, photoRoles, extras, style, detRoles, outfitFromRef);
    // ВСЕ герои кадра (с фото из блока 2 и без): их имена пишутся в строку «Персонажи: …» в блоке 1. Фото для Flow
    // расширение подбирает по этим именам среди добавленных персонажей, поэтому фото можно добавить уже после промптов.
    const chars = present.map((r) => {
      const c = characters.find((ch) => roleFor(ch.name) === r);
      return c ? primaryLabel(c) : ruLabelFor(r);
    });
    return { n: f.n, scene: f.prompt, prompt, chars, source: "ai" };
  });
  // Список героев истории: прямо от ИИ (поле cast), а если его нет (старая инструкция Gem) — собираем из того, что ИИ
  // уже вернул: все герои, встретившиеся в кадрах, плюс герои без фото, которых он описал.
  let cast = bible.cast || [];
  if (!cast.length) {
    const names = [...new Set(list.flatMap((f) => f.chars))];
    cast = names.map((name) => ({ name, role: "" }));
    for (const role of Object.keys(extras)) {
      const label = ruLabelFor(role);
      if (!names.includes(label)) cast.push({ name: label, role });
    }
  }
  return done(list, extra, cast);
}

// Общая подготовка текста запроса для любого «ИИ-канала» (API или ваш Gem в приложении Gemini): кто с фото, кто без,
// пожелания клиента и сама история. Одинаковые правила и там, и там.
function prepare(frames, characters, notes) {
  const extra = extraRolesIn(frames.map((f) => f.prompt).join("\n"), characters);
  const photoRoles = characters.map((c) => roleFor(c.name));
  const extraRoleNames = extra.map((x) => x.role);
  const framesText = frames.map((f) => `Frame ${f.n}: ${f.prompt.replace(/\s+/g, " ").trim()}`).join("\n");
  const notesText = notes?.trim() ? `\n\nClient requirements (must be respected): ${notes.trim()}` : "";
  // Герои с фото вместе с тем, как их могут называть в истории (имя, роль, синонимы): ИИ должен узнавать их и по имени,
  // и по роли, и в любом склонении («Алексея», «папе»), и по местоимению в контексте.
  const photoDescr = characters.map((c) => {
    const role = roleFor(c.name);
    const also = aliasesFor(c.name).filter((a) => a.toLowerCase() !== role.toLowerCase());
    return also.length ? `${role} (may be called in the story: ${also.join(", ")})` : role;
  });
  const roles =
    `Characters WITH reference photos (do not describe their faces; refer to each ONLY by the exact role name before the bracket): ${photoDescr.length ? photoDescr.join("; ") : "none"}.\n` +
    `Characters WITHOUT reference photos (invent one fixed appearance each): ${extraRoleNames.length ? extraRoleNames.join(", ") : "none"}.\n` +
    `If the story has other recurring characters not listed above (e.g. a named friend or grandmother), add them to "characters" with a fixed appearance.`;
  return { extra, photoRoles, extraRoleNames, framesText, notesText, roles };
}

// ----- Канал «ваш собственный Gem в приложении Gemini» (без API и суточных лимитов) -----
// Gem по инструкции из gem-instructions.md отвечает одним JSON; промпты из него собираем тем же кодом, что и для API.
const promptKit = {
  BATCH,
  // Первое сообщение в Gem: роли, пожелания, история целиком (или первая пачка).
  requestText(frames, characters, notes) {
    const { framesText, notesText, roles } = prepare(frames, characters, notes);
    return `${roles}\n\nStory:\n${framesText}${notesText}\n\nWrite ALL ${frames.length} frames (n = ${frames.map((f) => f.n).join(", ")}).`;
  },
  // Следующие пачки длинной истории: Gem помнит места и внешность из первого ответа.
  nextRequestText(frames) {
    return `Next frames (same story, same locations, wardrobe and fixed appearances as before). Return ONLY one JSON object {"frames": [...]} for exactly these frames:\n` +
      frames.map((f) => `Frame ${f.n}: ${f.prompt.replace(/\s+/g, " ").trim()}`).join("\n");
  },
  // Достаёт JSON из ответа Gem: игнорирует подписи блока кода («JSON», «Copy») и любой текст вокруг.
  parseJsonReply(text) {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
  },
  // replies — разобранные ответы Gem по порядку (первый содержит места и героев без фото).
  fromReplies({ frames, characters, replies, style, outfitFromRef = true }) {
    const { extra, photoRoles, extraRoleNames } = prepare(frames, characters, "");
    const first = replies[0] || {};
    const bible = { locations: first.locations || [], wardrobes: first.wardrobes || [], cast: first.cast || [] };
    if (!bible.locations.length) throw new Error("Gem не вернул места действия");
    const results = new Map(replies.flatMap((r) => (r.frames || []).map((fr) => [Number(fr.n), fr])));
    const done = (list, ex, cast = []) => ({ frames: list, ai: list.length, template: 0, extraRoles: ex, cast });
    return finish({ frames, results, bible, extras: buildExtras(first.characters, photoRoles, extraRoleNames), photoRoles, characters, style: style || DEFAULT_STYLE, extra, done, outfitFromRef });
  },
};
window.promptKit = promptKit;

// frames: [{n, prompt}] — описания кадров из сценария; characters: [{name}] из панели.
// mode "ai" (по умолчанию): все кадры пишет Gemini API; при неудаче бросает ошибку с понятной причиной
//   (вызывающий код решает, что делать дальше: запасной путь через Gem на сайте Gemini и т. п.).
// mode "template": всё по шаблону, без ключа и без ИИ.
// Запросов к API: ≤12 кадров — один; больше — один на «основу» + по одному на каждые 12 кадров.
// Возвращает { frames: [{n, scene, prompt, chars, source}], ai, template, extraRoles }.
async function generatePrompts({ frames, characters, key, model, style, notes, mode = "ai", outfitFromRef = true, onProgress = () => {} }) {
  const st = style || DEFAULT_STYLE;
  const done = (list, extra = [], cast = []) => ({
    frames: list,
    ai: list.filter((x) => x.source === "ai").length,
    template: list.filter((x) => x.source === "template").length,
    extraRoles: extra,
    cast, // герои истории по версии ИИ: [{name, role}] (в режиме «без ИИ» пусто)
  });
  const allText = frames.map((f) => f.prompt).join("\n");
  const extra = extraRolesIn(allText, characters); // герои из сценария без фото (сын, дочка…)

  if (mode === "template") {
    return done(frames.map((f) => ({
      n: f.n, scene: f.prompt, prompt: templatePrompt(f, characters, st, notes, outfitFromRef),
      chars: charactersInPrompt(f.prompt, characters).map(primaryLabel), source: "template",
    })), extra);
  }
  if (!key) throw Object.assign(new Error("Вставьте ключ Gemini API (бесплатный, aistudio.google.com/apikey) или включите режим «Без ИИ»."), { unavailable: true });

  const { photoRoles, extraRoleNames, framesText, notesText, roles } = prepare(frames, characters, notes);
  const ctx = { frames, characters, photoRoles, style: st, extra, done, outfitFromRef };

  // Короткая история: один запрос даёт и «основу», и все кадры.
  if (frames.length <= BATCH) {
    onProgress("Пишу промпты (один запрос к Gemini)…");
    const out = await call({
      onProgress, key, model, system: COMBINED_SYSTEM, schema: COMBINED_SCHEMA,
      user: `${roles}\n\nStory:\n${framesText}${notesText}\n\nReturn the cast, the locations, the wardrobe sets, the characters without photos and ALL ${frames.length} frames (n = ${frames.map((f) => f.n).join(", ")}).`,
    });
    const bible = { locations: out.locations || [], wardrobes: out.wardrobes || [], cast: out.cast || [] };
    if (!bible.locations.length) throw Object.assign(new Error("Gemini не вернул места действия"), { unavailable: true });
    const extras = buildExtras(out.characters, photoRoles, extraRoleNames);
    return finish({ ...ctx, results: new Map((out.frames || []).map((fr) => [Number(fr.n), fr])), bible, extras });
  }

  // Длинная история: сначала «основа» (места, одежда, внешность), затем кадры пачками, чтобы всё было согласовано.
  onProgress("Продумываю места, одежду и внешность героев…");
  const bible = await call({ onProgress, key, model, system: BIBLE_SYSTEM, schema: BIBLE_SCHEMA, user: `${roles}\n\nStory:\n${framesText}${notesText}` });
  const bibleOut = { locations: bible.locations || [], wardrobes: bible.wardrobes || [], cast: bible.cast || [] };
  if (!bibleOut.locations.length) throw Object.assign(new Error("Gemini не вернул места действия"), { unavailable: true });
  const extras = buildExtras(bible.characters, photoRoles, extraRoleNames);
  const locText = JSON.stringify({ locations: bibleOut.locations, wardrobes: bibleOut.wardrobes, appearance: extras });

  const batches = [];
  for (let i = 0; i < frames.length; i += BATCH) batches.push(frames.slice(i, i + BATCH));
  const results = new Map();
  let finished = 0;
  let failure = null;
  await pool(batches, CONCURRENCY, async (batch) => {
    try {
      const out = await call({
        onProgress, key, model, system: FRAMES_SYSTEM, schema: FRAMES_SCHEMA,
        user: `${roles}\nFinal list of characters without photos: ${Object.keys(extras).join(", ") || "none"}.\n\nLocations, wardrobe sets and fixed appearances (use their keys): ${locText}\n\nFrames to write:\n${batch.map((f) => `Frame ${f.n}: ${f.prompt.replace(/\s+/g, " ").trim()}`).join("\n")}${notesText}`,
      });
      for (const fr of out.frames || []) results.set(Number(fr.n), fr);
    } catch (e) {
      failure = failure || e;
    }
    onProgress(`Пишу промпты: обработано ${++finished} из ${batches.length} частей`);
  });
  if (failure && frames.some((f) => !results.has(f.n))) throw failure;
  return finish({ ...ctx, results, bible: bibleOut, extras });
}

window.generatePrompts = generatePrompts;
window.DEFAULT_STYLE = DEFAULT_STYLE;
})();
