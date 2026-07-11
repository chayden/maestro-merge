// Background service worker for Meet Maestro Merge Helper
// Captures auth token from network traffic and shares with content script.

let cachedAuthToken = null;

async function ensureContentScriptLoaded(tabId, url) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
    return;
  } catch {}

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content.css'],
  });

  // Determine which content script to load based on URL
  if (url?.includes('maestro.swimtopia.com')) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/api.js', 'content.js'],
    });
  } else if (url?.includes('/manage/reports/')) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['swimtopia-content.js'],
    });
  }
}

// Intercept Authorization header from any request to the SwimTopia API.
// This works even if the page loaded before the content script — the background
// service worker sees all requests matching the host permission.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'authorization'
    );
    if (authHeader?.value?.startsWith('Bearer ')) {
      cachedAuthToken = authHeader.value.replace('Bearer ', '');
    }
  },
  { urls: ['https://api.swimtopia.org/*'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_AUTH_TOKEN') {
    sendResponse({ token: cachedAuthToken });
  } else if (message.type === 'API_REQUEST') {
    fetch(message.url, {
      credentials: 'include',
      ...message.options,
    })
      .then(async (res) => {
        const text = await res.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {}
        sendResponse({ status: res.status, body, text });
      })
      .catch((err) => {
        sendResponse({ status: 0, error: err.message });
      });
    return true;
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const isMaestro = tab.url?.includes('maestro.swimtopia.com');
  const isSwimtopiaReport = tab.url?.includes('.swimtopia.com/manage/reports/');

  if (!isMaestro && !isSwimtopiaReport) return;

  try {
    await ensureContentScriptLoaded(tab.id, tab.url);
    const messageType = isMaestro ? 'OPEN_MERGE_PANEL' : 'RUN_SWIMTOPIA_ACTION';
    await chrome.tabs.sendMessage(tab.id, { type: messageType });
  } catch (err) {
    console.error('[Merge Helper] failed to open panel from action click:', err);
  }
});
