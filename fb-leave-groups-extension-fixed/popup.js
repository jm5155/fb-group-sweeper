let delay = 3;

const startBtn   = document.getElementById('startBtn');
const stopBtn    = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const leftCount  = document.getElementById('leftCount');
const errorCount = document.getElementById('errorCount');
const totalCount = document.getElementById('totalCount');
const delayVal   = document.getElementById('delayVal');
const delayMinus = document.getElementById('delayMinus');
const delayPlus  = document.getElementById('delayPlus');

// ── Restore state when popup opens ───────────────────────
chrome.storage.local.get(['delay','left','errors','running','status','stopFlag'], (data) => {
  if (data.delay  !== undefined) { delay = data.delay; delayVal.textContent = delay + 's'; }
  if (data.left   !== undefined) leftCount.textContent  = data.left;
  if (data.errors !== undefined) errorCount.textContent = data.errors;
  if (data.status) setStatus(data.status.text, data.status.cls);
  if (data.running && !data.stopFlag) {
    startBtn.disabled = true;
    stopBtn.disabled  = false;
  }
});

// ── Live updates from background.js ──────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'UPDATE') return;
  if (msg.left   !== undefined) leftCount.textContent  = msg.left;
  if (msg.errors !== undefined) errorCount.textContent = msg.errors;
  if (msg.total  !== undefined) totalCount.textContent = msg.total;
  if (msg.status !== undefined) setStatus(msg.status, msg.cls || '');
  if (msg.done) {
    startBtn.disabled = false;
    stopBtn.disabled  = true;
  }
});

function setStatus(text, cls = '') {
  statusText.textContent = text;
  statusText.className   = cls;
}

// ── Delay controls ────────────────────────────────────────
delayMinus.addEventListener('click', () => {
  if (delay > 1) { delay--; delayVal.textContent = delay + 's'; chrome.storage.local.set({ delay }); }
});
delayPlus.addEventListener('click', () => {
  if (delay < 15) { delay++; delayVal.textContent = delay + 's'; chrome.storage.local.set({ delay }); }
});

// ── Start ─────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes('facebook.com')) {
    setStatus('Please open Facebook first!', 'error');
    return;
  }

  const TARGET = 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added';

  // Save initial state BEFORE navigating so content script can auto-resume
  await new Promise(r => chrome.storage.local.set({ running: true, left: 0, errors: 0, delay, stopFlag: false }, r));

  leftCount.textContent  = '0';
  errorCount.textContent = '0';
  startBtn.disabled = true;
  stopBtn.disabled  = false;
  setStatus('Navigating to groups page…', 'active');

  if (!tab.url.includes('/groups/joins')) {
    // Navigate — content script will auto-resume when page loads
    chrome.tabs.update(tab.id, { url: TARGET });
  } else {
    // Already on the page — inject and send START
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) {}
    chrome.tabs.sendMessage(tab.id, { type: 'START', delay }).catch(() => {});
  }
});

// ── Stop ──────────────────────────────────────────────────
stopBtn.addEventListener('click', async () => {
  await new Promise(r => chrome.storage.local.set({ running: false, stopFlag: true }, r));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'STOP' }).catch(() => {});
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  setStatus('Stopped by user.', '');
});
