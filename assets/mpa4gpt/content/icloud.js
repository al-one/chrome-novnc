// content/icloud.js — Content script for iCloud Mail polling (steps 4, 7)
// Injected statically on https://www.icloud.com.cn/*
//
// Supported page:
// - https://www.icloud.com.cn/mail/
//
// iCloud loads mail content inside iframes. This script runs in all frames
// (all_frames: true) and only activates in the frame that contains mail DOM.

const ICLOUD_PREFIX = '[MultiPage:icloud-mail]';
const isTopFrame = window === window.top;
const SEEN_MAIL_IDS_KEY = 'seenIcloudMailIds';

console.log(ICLOUD_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

let seenMailIds = new Set();

async function loadSeenMailIds() {
  try {
    const data = await chrome.storage.session.get(SEEN_MAIL_IDS_KEY);
    if (Array.isArray(data[SEEN_MAIL_IDS_KEY])) {
      seenMailIds = new Set(data[SEEN_MAIL_IDS_KEY]);
      console.log(ICLOUD_PREFIX, `Loaded ${seenMailIds.size} previously seen mail ids`);
    }
  } catch (err) {
    console.warn(ICLOUD_PREFIX, 'Session storage unavailable, using in-memory seen mail ids:', err?.message || err);
  }
}

async function persistSeenMailIds() {
  try {
    await chrome.storage.session.set({ [SEEN_MAIL_IDS_KEY]: [...seenMailIds] });
  } catch (err) {
    console.warn(ICLOUD_PREFIX, 'Could not persist seen mail ids, continuing in-memory only:', err?.message || err);
  }
}

loadSeenMailIds();

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractVerificationCode(text) {
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

function getMailId(entry, index) {
  const explicitId = entry.getAttribute('data-id') || entry.dataset?.id || '';
  if (explicitId) return explicitId;

  const subject = entry.querySelector('.thread-subject')?.textContent?.trim() || '';
  const sender = entry.querySelector('.thread-participants')?.textContent?.trim() || '';
  const timestamp = entry.querySelector('.thread-timestamp')?.textContent?.trim() || '';

  return `icloud:${index}:${normalizeText(subject)}|${normalizeText(sender)}|${normalizeText(timestamp)}`;
}

function parseMailEntry(entry, index = 0) {
  const subject = entry.querySelector('.thread-subject')?.textContent?.trim() || '';
  const sender = entry.querySelector('.thread-participants')?.textContent?.trim() || '';
  const timestamp = entry.querySelector('.thread-timestamp')?.textContent?.trim() || '';
  const combinedText = [subject, sender, timestamp].filter(Boolean).join(' ');

  return {
    entry,
    timestamp,
    sender,
    subject,
    combinedText,
    mailId: getMailId(entry, index),
  };
}

function rowMatchesFilters(mail, senderFilters, subjectFilters, targetEmail) {
  const sender = normalizeText(mail.sender);
  const subject = normalizeText(mail.subject);
  const combined = normalizeText(mail.combinedText);
  const targetLocal = normalizeText((targetEmail || '').split('@')[0]);

  const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()) || combined.includes(f.toLowerCase()));
  const subjectMatch = subjectFilters.some(f => subject.includes(f.toLowerCase()) || combined.includes(f.toLowerCase()));
  const mailboxMatch = Boolean(targetLocal) && combined.includes(targetLocal);
  const code = extractVerificationCode(mail.combinedText);
  const keywordMatch = /openai|chatgpt|verify|verification|confirm|code|验证码|代码/.test(combined);

  if (mailboxMatch) return { matched: true, mailboxMatch, code };
  if (senderMatch || subjectMatch) return { matched: true, mailboxMatch: false, code };
  if (code && keywordMatch) return { matched: true, mailboxMatch: false, code };

  return { matched: false, mailboxMatch: false, code };
}

function findMailEntries() {
  return document.querySelectorAll('.thread-list-item');
}

function getCurrentMailIds() {
  const ids = new Set();
  Array.from(findMailEntries()).forEach((entry, index) => {
    ids.add(getMailId(entry, index));
  });
  return ids;
}

async function openInbox() {
  const mailboxItem = document.querySelector('.mailbox-list-item');
  if (mailboxItem) {
    simulateClick(mailboxItem);
    await sleep(1500);
  }
}

async function refreshMailbox() {
  // Try clicking the inbox sidebar item to refresh
  const inboxItem = document.querySelector('.mailbox-list-item');
  if (inboxItem) {
    simulateClick(inboxItem);
    await sleep(1500);
    return;
  }
  // Fallback: try a refresh button if one exists
  const refreshSel = '[title="Refresh"], [title="刷新"], [aria-label="Refresh"], [aria-label="刷新"]';
  const refreshBtn = document.querySelector(refreshSel);
  if (refreshBtn) {
    simulateClick(refreshBtn);
    await sleep(1500);
  }
}

async function deleteMailEntry(entry, step) {
  try {
    // Right-click the entry to open context menu
    const moreBtn = entry.querySelector('.hover-quick-action-button, [aria-label="更多操作"]');
    if (moreBtn) {
      simulateClick(moreBtn);
    }
    else {
      entry.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    }
    await sleep(500);

    // Click the delete button from context menu
    const deleteBtn = entry.querySelector('[aria-label="删除邮件"], [aria-label="Trash Message"], .destructive');
    if (deleteBtn) {
      simulateClick(deleteBtn);
      log(`Step ${step}: Deleted iCloud mail message`, 'ok');
      await sleep(800);
    }
  } catch (err) {
    log(`Step ${step}: Failed to delete iCloud mail message: ${err.message}`, 'warn');
  }
}

async function handlePollEmail(step, payload) {
  const {
    senderFilters = [],
    subjectFilters = [],
    targetEmail = '',
    maxAttempts = 100,
    intervalMs = 6000,
  } = payload || {};

  log(`Step ${step}: Starting email poll on iCloud Mail (max ${maxAttempts} attempts)`);

  // Wait for mail DOM to appear
  try {
    await waitForElement('.thread-list-item, .mailbox-list-item', 15000);
    log(`Step ${step}: iCloud Mail page loaded`);
  } catch {
    throw new Error('iCloud Mail page did not load. Make sure you are logged in and the mail page is open.');
  }

  // If we see mailbox list but not thread list, click to open inbox
  const hasThreadList = document.querySelector('.thread-list-item');
  if (!hasThreadList) {
    await openInbox();
    try {
      await waitForElement('.thread-list-item', 10000);
    } catch {
      throw new Error('Could not open iCloud inbox. Try clicking the inbox manually.');
    }
  }

  // Snapshot existing mail IDs
  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing mail entries`);

  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    log(`Polling iCloud Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshMailbox();
    }

    const entries = Array.from(findMailEntries()).map(parseMailEntry);
    const useFallback = attempt > FALLBACK_AFTER;
    const candidates = [];

    for (const mail of entries) {
      if (seenMailIds.has(mail.mailId)) continue;
      if (!useFallback && existingMailIds.has(mail.mailId)) continue;

      const match = rowMatchesFilters(mail, senderFilters, subjectFilters, targetEmail);
      if (!match.matched) continue;

      candidates.push({ ...mail, code: match.code });
    }

    for (const mail of candidates) {
      const code = mail.code || extractVerificationCode(mail.combinedText);
      if (!code) continue;

      // Try to delete the verification email
      await deleteMailEntry(mail.entry, step);

      seenMailIds.add(mail.mailId);
      await persistSeenMailIds();

      const source = existingMailIds.has(mail.mailId) ? 'fallback' : 'new';
      log(
        `Step ${step}: Code found: ${code} (${source}, sender: ${mail.sender || 'unknown'}, subject: ${(mail.subject || '').slice(0, 60)})`,
        'ok'
      );

      return {
        ok: true,
        code,
        emailTimestamp: Date.now(),
        mailId: mail.mailId,
      };
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new iCloud mail messages yet, falling back to older matching messages`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No matching verification email found in iCloud Mail after ${maxAttempts} attempts. ` +
    'Check the mail page manually.'
  );
}

// Only handle messages in frames that could contain mail UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log(`Received message: ${message.type} ${location.href}`)
  if (message.type === 'POLL_EMAIL') {
    // Check if this frame has mail DOM — skip if not
    const hasMailDom = document.querySelector('.thread-list-item, .mailbox-list-item');
    if (!hasMailDom && isTopFrame) {
      // Top frame without mail DOM — might need to wait or skip
      sendResponse({ ok: false, reason: 'no-mail-dom-in-top-frame' });
      return;
    }
    if (!hasMailDom && !isTopFrame) {
      sendResponse({ ok: false, reason: 'wrong-frame' });
      return;
    }

    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});