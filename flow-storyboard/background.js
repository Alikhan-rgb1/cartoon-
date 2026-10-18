chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Скачивание готового кадра по запросу панели.
// Flow игнорирует программные клики (isTrusted=false) на кнопке «Начать генерацию»,
// поэтому настоящий клик отправляем через chrome.debugger (Input.dispatchMouseEvent).
// Chrome при этом показывает на вкладке плашку «расширение отлаживает этот браузер».
async function trustedClick(tabId, x, y) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const base = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "trustedClick" && sender.tab) {
    trustedClick(sender.tab.id, msg.x, msg.y)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "download") {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, conflictAction: "uniquify" },
      (id) => sendResponse({ ok: !chrome.runtime.lastError, id })
    );
    return true;
  }
});
