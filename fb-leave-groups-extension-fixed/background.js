// Background service worker — relays messages from content script to popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Forward UPDATE messages to the popup (if open)
  if (msg.type === 'UPDATE') {
    chrome.runtime.sendMessage(msg).catch(() => {}); // popup may be closed, ignore error
    // Also persist state so popup can restore when reopened
    if (msg.left   !== undefined) chrome.storage.local.set({ left:   msg.left });
    if (msg.errors !== undefined) chrome.storage.local.set({ errors: msg.errors });
    if (msg.status !== undefined) chrome.storage.local.set({ status: { text: msg.status, cls: msg.cls || '' } });
    if (msg.done)                 chrome.storage.local.set({ running: false });
  }
  sendResponse({ ok: true });
  return true;
});
