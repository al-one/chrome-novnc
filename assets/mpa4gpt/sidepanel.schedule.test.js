const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SIDEPANEL_PATH = path.resolve(__dirname, 'sidepanel/sidepanel.js');

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class FakeElement {
  constructor({ id = '', className = '', dataset = {}, value = '', type = 'text' } = {}) {
    this.id = id;
    this.dataset = { ...dataset };
    this.value = value;
    this.disabled = false;
    this.style = { display: '' };
    this.parentNode = null;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._textContent = '';
    this._innerHTML = '';
    this._classSet = new Set();
    this.type = type;
    this.className = className;
  }

  get className() {
    return [...this._classSet].join(' ');
  }

  set className(value) {
    this._classSet = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  get classList() {
    return {
      add: (...names) => {
        names.forEach((name) => this._classSet.add(name));
      },
      remove: (...names) => {
        names.forEach((name) => this._classSet.delete(name));
      },
      contains: (name) => this._classSet.has(name),
    };
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this._innerHTML = escapeHtml(this._textContent);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    this.scrollHeight = this.children.length;
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index !== -1) siblings.splice(index, 1);
    this.parentNode = null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(listener);
  }

  dispatchEvent(type, event = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.forEach((listener) => listener(event));
  }

  querySelector(selector) {
    if (selector === '.toast-close') {
      return new FakeElement({ className: 'toast-close' });
    }
    return null;
  }

  checkValidity() {
    return this._checkValidity !== false;
  }

  setCustomValidityResult(isValid) {
    this._checkValidity = isValid;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
}

function createDocument() {
  const byId = new Map();
  const stepRows = new Map();
  const stepStatuses = new Map();
  const stepButtons = new Map();

  const ids = [
    'log-area',
    'display-oauth-url',
    'display-localhost-url',
    'display-status',
    'status-bar',
    'input-email',
    'input-password',
    'btn-fetch-email',
    'btn-toggle-password',
    'btn-stop',
    'btn-reset',
    'steps-progress',
    'btn-auto-run',
    'btn-auto-continue',
    'auto-continue-bar',
    'btn-clear-log',
    'input-vps-url',
    'select-mail-provider',
    'row-inbucket-host',
    'input-inbucket-host',
    'row-inbucket-mailbox',
    'input-inbucket-mailbox',
    'input-run-count',
    'input-run-interval',
    'display-schedule-mode',
    'display-schedule-status',
    'display-next-run',
    'toast-container',
    'btn-theme',
  ];

  for (const id of ids) {
    byId.set(id, new FakeElement({ id }));
  }

  byId.get('input-password').type = 'password';
  byId.get('input-run-count').value = '1';
  byId.get('input-run-interval').value = '0';
  byId.get('btn-stop').disabled = true;
  byId.get('auto-continue-bar').style.display = 'none';
  byId.get('status-bar').className = 'status-bar';
  byId.get('select-mail-provider').value = '163';
  byId.get('row-inbucket-host').style.display = 'none';
  byId.get('row-inbucket-mailbox').style.display = 'none';

  for (let step = 1; step <= 9; step++) {
    const row = new FakeElement({ className: 'step-row', dataset: { step: String(step) } });
    const status = new FakeElement({ className: 'step-status', dataset: { step: String(step) } });
    const button = new FakeElement({ className: 'step-btn', dataset: { step: String(step) } });
    stepRows.set(String(step), row);
    stepStatuses.set(String(step), status);
    stepButtons.set(String(step), button);
  }

  const documentElement = new FakeElement({});
  const body = new FakeElement({});

  const document = {
    activeElement: null,
    body,
    documentElement,
    getElementById(id) {
      return byId.get(id) || null;
    },
    createElement() {
      return new FakeElement({});
    },
    querySelector(selector) {
      let match = selector.match(/^\.step-status\[data-step="(\d+)"\]$/);
      if (match) return stepStatuses.get(match[1]) || null;
      match = selector.match(/^\.step-row\[data-step="(\d+)"\]$/);
      if (match) return stepRows.get(match[1]) || null;
      match = selector.match(/^\.step-btn\[data-step="(\d+)"\]$/);
      if (match) return stepButtons.get(match[1]) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.step-row') return [...stepRows.values()];
      if (selector === '.step-status') return [...stepStatuses.values()];
      if (selector === '.step-btn') return [...stepButtons.values()];
      return [];
    },
  };

  return {
    document,
    elements: Object.fromEntries(byId.entries()),
    stepRows,
    stepStatuses,
    stepButtons,
  };
}

function createLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadSidepanelContext(options = {}) {
  const source = fs.readFileSync(SIDEPANEL_PATH, 'utf8');
  const dom = createDocument();
  const sendCalls = [];
  const state = {
    oauthUrl: null,
    localhostUrl: null,
    email: null,
    password: null,
    customPassword: '',
    vpsUrl: '',
    mailProvider: '163',
    inbucketHost: '',
    inbucketMailbox: '',
    scheduledRunCount: 1,
    scheduleIntervalMinutes: 0,
    scheduleEnabled: false,
    scheduleNextRunAt: null,
    scheduleLastStartedAt: null,
    scheduleLastSkippedAt: null,
    autoRunPhase: null,
    autoRunning: false,
    stepStatuses: {},
    logs: [],
    ...(options.initialState || {}),
  };

  const runtime = {
    listener: null,
    async sendMessage(message) {
      sendCalls.push(JSON.parse(JSON.stringify(message)));
      if (options.onSendMessage) {
        const result = await options.onSendMessage(message);
        if (result !== undefined) return result;
      }
      if (message.type === 'GET_STATE') {
        return { ...state };
      }
      return {};
    },
    onMessage: {
      addListener(listener) {
        runtime.listener = listener;
      },
    },
  };

  const context = vm.createContext({
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    document: dom.document,
    localStorage: createLocalStorage(),
    window: {
      matchMedia: () => ({ matches: false }),
    },
    chrome: {
      runtime,
    },
    confirm: () => true,
  });

  new vm.Script(source, { filename: SIDEPANEL_PATH }).runInContext(context);
  await flush();

  return {
    context,
    runtime,
    sendCalls,
    elements: dom.elements,
    emitRuntimeMessage(message) {
      if (!runtime.listener) {
        throw new Error('runtime.onMessage listener not registered');
      }
      runtime.listener(message);
    },
  };
}

function overrideFunction(context, name, valueName, value) {
  context[valueName] = value;
  vm.runInContext(`${name} = ${valueName};`, context);
}

test('restoreState shows manual schedule defaults', async () => {
  const { elements } = await loadSidepanelContext({
    initialState: {
      scheduledRunCount: 1,
      scheduleIntervalMinutes: 0,
      scheduleEnabled: false,
      scheduleNextRunAt: null,
      autoRunPhase: null,
      autoRunning: false,
    },
  });

  assert.equal(elements['input-run-count'].value, '1');
  assert.equal(elements['input-run-interval'].value, '0');
  assert.equal(elements['display-schedule-mode'].textContent, 'Manual only');
  assert.equal(elements['display-schedule-status'].textContent, 'Idle');
  assert.equal(elements['display-next-run'].textContent, 'Not scheduled');
});

test('restoreState uses waiting_email phase for schedule status', async () => {
  const nextRunAt = Date.now() + 15 * 60 * 1000;
  const { elements } = await loadSidepanelContext({
    initialState: {
      scheduledRunCount: 2,
      scheduleIntervalMinutes: 15,
      scheduleEnabled: true,
      scheduleNextRunAt: nextRunAt,
      autoRunPhase: 'waiting_email',
      autoRunning: true,
    },
  });

  assert.equal(elements['display-schedule-mode'].textContent, 'Every 15 min');
  assert.equal(elements['display-schedule-status'].textContent, 'Waiting email');
  assert.notEqual(elements['display-next-run'].textContent, 'Not scheduled');
});

test('saveScheduleSettings sends schedule payload and updates UI from response', async () => {
  const scheduleNextRunAt = Date.now() + 20 * 60 * 1000;
  const scheduleLastStartedAt = Date.now() - 60 * 1000;
  const toastCalls = [];
  const harness = await loadSidepanelContext({
    initialState: {
      scheduledRunCount: 1,
      scheduleIntervalMinutes: 0,
      scheduleEnabled: false,
    },
    onSendMessage: async (message) => {
      if (message.type === 'SAVE_SCHEDULE_SETTINGS') {
        return {
          ok: true,
          scheduleNextRunAt,
          scheduleLastStartedAt,
          scheduleLastSkippedAt: null,
        };
      }
      return undefined;
    },
  });

  overrideFunction(harness.context, 'showToast', '__testShowToast', (message, type) => {
    toastCalls.push({ message, type });
  });

  harness.elements['input-run-count'].value = '3';
  harness.elements['input-run-interval'].value = '15';

  const saveScheduleSettings = vm.runInContext('saveScheduleSettings', harness.context);
  const formatScheduleTime = vm.runInContext('formatScheduleTime', harness.context);
  await saveScheduleSettings();

  const saveRequest = harness.sendCalls.find((call) => call.type === 'SAVE_SCHEDULE_SETTINGS');
  assert.deepEqual(saveRequest, {
    type: 'SAVE_SCHEDULE_SETTINGS',
    source: 'sidepanel',
    payload: { scheduledRunCount: 3, scheduleIntervalMinutes: 15 },
  });
  assert.equal(harness.elements['display-schedule-mode'].textContent, 'Every 15 min');
  assert.equal(harness.elements['display-next-run'].textContent, formatScheduleTime(scheduleNextRunAt));
  assert.equal(
    harness.elements['display-schedule-status'].textContent,
    `Last ran ${formatScheduleTime(scheduleLastStartedAt)}`
  );
  assert.deepEqual(toastCalls, [{ message: 'Scheduled every 15 min', type: 'success' }]);
});

test('AUTO_RUN_STATUS waiting_email shows paused schedule UI', async () => {
  const harness = await loadSidepanelContext({
    initialState: {
      scheduledRunCount: 2,
      scheduleIntervalMinutes: 15,
      scheduleEnabled: true,
    },
  });

  harness.emitRuntimeMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'waiting_email', currentRun: 1, totalRuns: 2 },
  });

  assert.equal(harness.elements['auto-continue-bar'].style.display, 'flex');
  assert.equal(harness.elements['display-schedule-status'].textContent, 'Waiting email');
  assert.equal(harness.elements['btn-stop'].disabled, false);
  assert.equal(harness.elements['btn-auto-run'].innerHTML, 'Paused (1/2)');
});

test('SCHEDULE_UPDATED does not clear stopped phase', async () => {
  const nextRunAt = Date.now() + 20 * 60 * 1000;
  const harness = await loadSidepanelContext({
    initialState: {
      scheduledRunCount: 1,
      scheduleIntervalMinutes: 15,
      scheduleEnabled: true,
    },
  });

  harness.emitRuntimeMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: 1, totalRuns: 1 },
  });
  assert.equal(harness.elements['display-schedule-status'].textContent, 'Stopped');

  harness.emitRuntimeMessage({
    type: 'SCHEDULE_UPDATED',
    payload: {
      scheduledRunCount: 4,
      scheduleIntervalMinutes: 20,
      scheduleEnabled: true,
      scheduleNextRunAt: nextRunAt,
      scheduleLastStartedAt: Date.now() - 1000,
      scheduleLastSkippedAt: null,
    },
  });

  assert.equal(harness.elements['display-schedule-mode'].textContent, 'Every 20 min');
  assert.equal(harness.elements['display-schedule-status'].textContent, 'Stopped');
});

test('SCHEDULE_UPDATED shows skipped label when skip is newer than last run', async () => {
  const scheduleLastStartedAt = Date.now() - 5 * 60 * 1000;
  const scheduleLastSkippedAt = Date.now() - 60 * 1000;
  const harness = await loadSidepanelContext({
    initialState: {
      scheduledRunCount: 1,
      scheduleIntervalMinutes: 15,
      scheduleEnabled: true,
    },
  });

  const formatScheduleTime = vm.runInContext('formatScheduleTime', harness.context);
  harness.emitRuntimeMessage({
    type: 'SCHEDULE_UPDATED',
    payload: {
      scheduledRunCount: 1,
      scheduleIntervalMinutes: 15,
      scheduleEnabled: true,
      scheduleNextRunAt: Date.now() + 15 * 60 * 1000,
      scheduleLastStartedAt,
      scheduleLastSkippedAt,
    },
  });

  assert.equal(
    harness.elements['display-schedule-status'].textContent,
    `Skipped at ${formatScheduleTime(scheduleLastSkippedAt)}`
  );
});
