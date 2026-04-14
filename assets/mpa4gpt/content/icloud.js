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

async function openInbox() {
  const mailboxItem = document.querySelector('.mailbox-list-item');
  if (mailboxItem) {
    simulateClick(mailboxItem);
    await sleep(1500);
  }
}

async function refreshMailbox() {
  // Try clicking the inbox sidebar item to refresh
  // Fallback: try a refresh button if one exists
  const refreshSel = '[title="Refresh"], [title="刷新"], [aria-label="Refresh"], [aria-label="刷新"]';
  const refreshBtn = document.querySelector(refreshSel);
  if (refreshBtn) {
    simulateClick(refreshBtn);
    await sleep(2000);
    return;
  }
  else {
    console.warn(ICLOUD_PREFIX, 'Could not find inbox refresh button');
  }
  const inboxItem = document.querySelector('.mailbox-list-item[aria-selected="false"]');
  if (inboxItem) {
    simulateClick(inboxItem);
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
    await sleep(800);

    // Click the delete button from context menu
    const popover = document.querySelector('.action-menu-popover ui-popover');
    const deleteBtn = popover ? popover.querySelector('[aria-label="删除邮件"], [aria-label="Trash Message"], .destructive') : null;
    if (deleteBtn) {
      simulateClick(deleteBtn, 'mouseup');
      log(`Step ${step}: Deleted iCloud mail message`, 'ok');
      await sleep(300);
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
    batchId = null,
  } = payload || {};

  log(`Step ${step}: Starting email poll on iCloud Mail (max ${maxAttempts} attempts)`);
  reportProgress(step, 'poll-start', batchId);

  // Click to open inbox
  await openInbox();

  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    log(`Polling iCloud Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshMailbox();
    }

    let result = null;
    const entries = Array.from(findMailEntries()).map(parseMailEntry);

    for (const mail of entries) {
      if (seenMailIds.has(mail.mailId)) continue;

      const match = rowMatchesFilters(mail, senderFilters, subjectFilters, targetEmail);
      if (!match.matched) continue;

      const code = match.code || extractVerificationCode(mail.combinedText);
      if (!code) continue;

      if (result) {
        // Delete old codes
        await deleteMailEntry(mail.entry, step);
        continue;
      }

      seenMailIds.add(mail.mailId);
      await persistSeenMailIds();

      log(
        `Step ${step}: Code found: ${code} (sender: ${mail.sender || 'unknown'}, subject: ${(mail.subject || '').slice(0, 60)})`,
        'ok'
      );
      reportProgress(step, 'code-found', batchId);
      // Try to delete the verification email
      await deleteMailEntry(mail.entry, step);

      result = {
        ok: true,
        code,
        emailTimestamp: Date.now(),
        mailId: mail.mailId,
        batchId,
      };
    }

    if (result) {
      return result;
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
  log(`Received message: ${message.type} ${location.href}`);
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
    const batchId = message.payload?.batchId || null;
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      reportError(message.step, err.message, batchId);
      sendResponse({ error: err.message });
    });
    return true;
  }
});