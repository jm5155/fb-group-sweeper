// FB Group Auto-Leave — Content Script
// After each successful leave, reloads the page and auto-resumes.

(function () {
  if (window.__fbLeaveInit) return;
  window.__fbLeaveInit = true;

  let running    = false;
  let stopFlag   = false;

  const GROUPS_URL = 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added';

  // ── Utilities ─────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendUpdate(obj) {
    try { chrome.runtime.sendMessage({ type: 'UPDATE', ...obj }); } catch (e) {}
  }

  async function waitFor(fn, timeout = 5000, interval = 250) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = fn();
      if (el) return el;
      await sleep(interval);
    }
    return null;
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }

  // ── Finding the 3-dot buttons ─────────────────────────────

  function findDotButtons() {
    const results = [];
    const seen = new Set();

    // Strategy 1: Find "View group" links/spans and locate the 3-dot within the same row
    document.querySelectorAll('span, a').forEach((el) => {
      if (el.textContent.trim() !== 'View group') return;

      // Walk up to find the group row container
      let row = el.closest('[role="listitem"]') || el.closest('li');
      if (!row) {
        // Try walking up several levels
        let p = el.parentElement;
        for (let i = 0; i < 8 && p; i++) {
          if (p.querySelectorAll('[role="button"]').length >= 1) { row = p; break; }
          p = p.parentElement;
        }
      }
      if (!row) return;

      // Within the row, find the 3-dot button by aria-label="More" and aria-haspopup
      const moreBtns = row.querySelectorAll('[role="button"][aria-label="More"], [role="button"][aria-haspopup="dialog"]');
      moreBtns.forEach((btn) => {
        if (!seen.has(btn)) { seen.add(btn); results.push(btn); }
      });

      // Fallback: any role=button with aria-label containing more/options
      if (results.length === 0 || !seen.size) {
        row.querySelectorAll('[role="button"]').forEach((btn) => {
          const lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
          if ((lbl.includes('more') || lbl.includes('options')) && !seen.has(btn)) {
            seen.add(btn); results.push(btn);
          }
        });
      }
    });

    // Strategy 2: If nothing found yet, fall back to all aria-label="More" buttons on page
    // that have aria-haspopup (the 3-dot ones specifically)
    if (results.length === 0) {
      document.querySelectorAll('[role="button"][aria-label="More"][aria-haspopup]').forEach((btn) => {
        if (!seen.has(btn)) { seen.add(btn); results.push(btn); }
      });
    }

    return results;
  }

  // ── Leave flow ────────────────────────────────────────────

  async function clickLeaveMenuItem() {
    const item = await waitFor(() => {
      for (const el of document.querySelectorAll('[role="menuitem"], [role="option"]')) {
        if (el.textContent.includes('Leave group') || el.textContent.includes('Leave Group')) return el;
      }
      return document.querySelector('[aria-label="Leave group"], [aria-label="Leave Group"]');
    }, 6000);
    if (!item) return false;
    item.click();
    return true;
  }

  async function clickConfirmButton() {
    const btn = await waitFor(() => {
      for (const el of document.querySelectorAll('[role="button"], button')) {
        const txt = el.textContent.trim();
        if ((txt === 'Leave Group' || txt === 'Leave group') &&
            (el.closest('[role="dialog"]') || el.closest('[aria-modal="true"]'))) {
          return el;
        }
      }
      return null;
    }, 5000);
    if (!btn) return false;
    btn.click();
    return true;
  }

  function getGroupName(dotBtn) {
    try {
      const row = dotBtn.closest('[role="listitem"]') || dotBtn.closest('li') ||
                  dotBtn.parentElement?.parentElement?.parentElement;
      if (!row) return 'a group';
      for (const s of row.querySelectorAll('span, a')) {
        const t = s.textContent.trim();
        if (t.length > 3 && t.length < 120 && t !== 'View group' && !t.includes('member')) return t;
      }
    } catch (e) {}
    return 'a group';
  }

  // ── Wait for the groups page to fully load ────────────────

  async function waitForPageReady(timeout = 15000) {
    // Wait until at least one "View group" span appears — means the list has loaded
    const found = await waitFor(() => {
      const spans = document.querySelectorAll('span');
      for (const s of spans) {
        if (s.textContent.trim() === 'View group') return s;
      }
      return null;
    }, timeout);
    return !!found;
  }

  // ── Main: leave ONE group then reload ─────────────────────

  async function leaveOneAndReload(delaySeconds, leftCount, errorCount) {
    running  = true;
    stopFlag = false;

    // Check stop flag from storage before doing anything
    const stored = await new Promise(r => chrome.storage.local.get(['running', 'stopFlag'], r));
    if (!stored.running || stored.stopFlag) {
      sendUpdate({ status: 'Stopped.', done: true, left: leftCount, errors: errorCount });
      running = false;
      return;
    }

    sendUpdate({ status: 'Page loaded — looking for groups…', cls: 'active', left: leftCount, errors: errorCount });

    // Wait for the page list to render
    const ready = await waitForPageReady(15000);
    if (!ready) {
      sendUpdate({ status: 'Page took too long to load. Retrying…', cls: 'error', left: leftCount, errors: errorCount });
      await sleep(3000);
      window.location.reload();
      return;
    }

    await sleep(1000); // extra settle time

    const dotBtns = findDotButtons();

    if (dotBtns.length === 0) {
      sendUpdate({ status: 'No more groups found — all done! ✓', cls: 'done', done: true, left: leftCount, errors: errorCount });
      chrome.storage.local.set({ running: false });
      running = false;
      return;
    }

    const dotBtn = dotBtns[0];
    const name   = getGroupName(dotBtn);

    sendUpdate({ status: `Leaving: ${name.substring(0, 45)}…`, cls: 'active', left: leftCount, errors: errorCount });

    // Step 1 — click 3-dot
    try {
      // Scroll into view first
      dotBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(400);

      // Use full pointer event sequence that Facebook's React listeners expect
      const evtOpts = { bubbles: true, cancelable: true, composed: true };
      dotBtn.dispatchEvent(new PointerEvent('pointerover', evtOpts));
      dotBtn.dispatchEvent(new MouseEvent('mouseover', evtOpts));
      dotBtn.dispatchEvent(new PointerEvent('pointerenter', evtOpts));
      dotBtn.dispatchEvent(new PointerEvent('pointerdown', evtOpts));
      dotBtn.dispatchEvent(new MouseEvent('mousedown', evtOpts));
      dotBtn.dispatchEvent(new PointerEvent('pointerup', evtOpts));
      dotBtn.dispatchEvent(new MouseEvent('mouseup', evtOpts));
      dotBtn.dispatchEvent(new MouseEvent('click', evtOpts));
      dotBtn.focus();
    } catch (e) {
      errorCount++;
      await chrome.storage.local.set({ errors: errorCount });
      sendUpdate({ errors: errorCount, status: 'Could not click menu button', cls: 'error' });
      await sleep(1500);
      window.location.reload();
      return;
    }

    await sleep(1500);

    // Step 2 — click "Leave group"
    const foundMenu = await clickLeaveMenuItem();
    if (!foundMenu) {
      pressEscape();
      errorCount++;
      await chrome.storage.local.set({ errors: errorCount });
      sendUpdate({ errors: errorCount, status: 'Could not find "Leave group" in menu', cls: 'error' });
      await sleep(1500);
      window.location.reload();
      return;
    }

    await sleep(900);

    // Step 3 — confirm
    const confirmed = await clickConfirmButton();
    if (!confirmed) {
      pressEscape();
      errorCount++;
      await chrome.storage.local.set({ errors: errorCount });
      sendUpdate({ errors: errorCount, status: `Could not confirm leave for: ${name.substring(0, 30)}`, cls: 'error' });
      await sleep(1500);
      window.location.reload();
      return;
    }

    // ✅ Success — save progress then reload
    leftCount++;
    await chrome.storage.local.set({ left: leftCount, errors: errorCount });
    sendUpdate({ left: leftCount, errors: errorCount, status: `✓ Left "${name.substring(0, 40)}" — reloading…`, cls: 'active' });

    // Wait the user-configured delay, then reload to process next group
    await sleep(delaySeconds * 1000);
    window.location.href = GROUPS_URL;
  }

  // ── Auto-resume on page load ──────────────────────────────

  async function checkAndResume() {
    // Only run on the groups/joins page
    if (!window.location.href.includes('/groups/joins')) return;

    const data = await new Promise(r => chrome.storage.local.get(['running', 'delay', 'left', 'errors', 'stopFlag'], r));

    if (!data.running || data.stopFlag) return; // not supposed to be running

    const delaySeconds = data.delay   || 3;
    const leftCount    = data.left    || 0;
    const errorCount   = data.errors  || 0;

    leaveOneAndReload(delaySeconds, leftCount, errorCount);
  }

  // Run auto-resume check immediately when script loads
  checkAndResume();

  // ── Message listener ──────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START' && !running) {
      const delay = msg.delay || 3;
      chrome.storage.local.set({ running: true, left: 0, errors: 0, delay, stopFlag: false }, () => {
        leaveOneAndReload(delay, 0, 0);
      });
    }
    if (msg.type === 'STOP') {
      stopFlag = true;
      chrome.storage.local.set({ running: false, stopFlag: true });
    }
    sendResponse({ ok: true });
    return true;
  });

})();
