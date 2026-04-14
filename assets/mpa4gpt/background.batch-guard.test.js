const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BACKGROUND_PATH = path.resolve(__dirname, 'background.js');

function createEventStub() {
  const listeners = [];
  return {
    addListener: (listener) => {
      listeners.push(listener);
    },
    removeListener: (listener) => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    dispatch: async (...args) => {
      for (const listener of [...listeners]) {
        await listener(...args);
      }
    },
    listeners,
  };
}

function createChromeStub() {
  const runtimeOnMessage = createEventStub();
  const runtimeOnStartup = createEventStub();
  const runtimeOnInstalled = createEventStub();
  const alarmsOnAlarm = createEventStub();
  const tabsOnUpdated = createEventStub();
  const webNavigationOnBeforeNavigate = createEventStub();

  return {
    __events: {
      runtimeOnMessage,
      runtimeOnStartup,
      runtimeOnInstalled,
      alarmsOnAlarm,
      tabsOnUpdated,
      webNavigationOnBeforeNavigate,
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => {},
        clear: async () => {},
        setAccessLevel: async () => {},
      },
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    runtime: {
      onMessage: runtimeOnMessage,
      onStartup: runtimeOnStartup,
      onInstalled: runtimeOnInstalled,
      sendMessage: () => Promise.resolve(),
      lastError: null,
    },
    alarms: {
      onAlarm: alarmsOnAlarm,
      clear: async () => {},
      create: async () => {},
    },
    tabs: {
      onUpdated: tabsOnUpdated,
      update: async () => {},
      query: async () => [],
      create: async () => ({ id: 1 }),
      remove: async () => {},
      sendMessage: async () => ({}),
      get: async () => ({ id: 1 }),
      reload: async () => {},
    },
    webNavigation: {
      onBeforeNavigate: webNavigationOnBeforeNavigate,
    },
    cookies: {
      getAll: async () => [],
    },
    scripting: {
      executeScript: async () => {},
    },
    debugger: {
      attach: async () => {},
      sendCommand: async () => {},
      detach: async () => {},
    },
    declarativeNetRequest: {
      updateSessionRules: async () => {},
    },
    sidePanel: {
      setPanelBehavior: async () => {},
    },
  };
}

function loadBackgroundContext() {
  const source = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const chrome = createChromeStub();
  const context = vm.createContext({
    console,
    Math,
    Date,
    Promise,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      throw new Error('fetch not stubbed for this test');
    },
    navigator: { userAgent: 'node-test' },
    importScripts: () => {},
    chrome,
  });

  new vm.Script(source, { filename: BACKGROUND_PATH }).runInContext(context);
  context.__chromeEvents = chrome.__events;
  return context;
}

function setBatchState(context, batchId, status = 'running') {
  vm.runInContext(
    `currentBatchId = ${JSON.stringify(batchId)}; currentBatchStatus = ${JSON.stringify(status)}; stopRequested = false;`,
    context
  );
}

function overrideFunction(context, name, valueName, value) {
  context[valueName] = value;
  vm.runInContext(`${name} = ${valueName};`, context);
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test('fetchDuckEmail rejects stale direct response after batch takeover', async () => {
  const context = loadBackgroundContext();
  const emailWrites = [];

  overrideFunction(context, 'addLog', '__testAddLog', async () => {});
  overrideFunction(context, 'reuseOrCreateTab', '__testReuseOrCreateTab', async () => {});
  overrideFunction(context, 'setEmailState', '__testSetEmailState', async (email) => {
    emailWrites.push(email);
  });
  overrideFunction(context, 'sendToContentScript', '__testSendToContentScript', async () => {
    setBatchState(context, 'batch-new');
    return { email: 'old@example.com', generated: true };
  });

  setBatchState(context, 'batch-old');
  const fetchDuckEmail = vm.runInContext('fetchDuckEmail', context);

  await assert.rejects(
    fetchDuckEmail({ generateNew: true, batchId: 'batch-old' }),
    /Flow superseded by next scheduled batch\./
  );
  assert.deepEqual(emailWrites, []);
});

test('executeStep4 rejects stale poll result before writing state or filling code', async () => {
  const context = loadBackgroundContext();
  const stateWrites = [];
  const sentMessages = [];

  overrideFunction(context, 'addLog', '__testAddLog', async () => {});
  overrideFunction(context, 'isTabAlive', '__testIsTabAlive', async () => true);
  overrideFunction(context, 'getTabId', '__testGetTabId', async () => 42);
  overrideFunction(context, 'setState', '__testSetState', async (updates) => {
    stateWrites.push(updates);
  });
  context.__testMailConfig = {
    source: 'mail-source',
    label: 'Mail Source',
    navigateOnReuse: false,
  };
  vm.runInContext('getMailConfig = () => __testMailConfig;', context);
  overrideFunction(context, 'sendToContentScript', '__testSendToContentScript', async (source, message) => {
    sentMessages.push({ source, type: message.type, step: message.step });
    if (message.type === 'POLL_EMAIL') {
      setBatchState(context, 'batch-new');
      return { code: '123456', emailTimestamp: 1710000000000 };
    }
    return {};
  });

  setBatchState(context, 'batch-old');
  const executeStep4 = vm.runInContext('executeStep4', context);

  await assert.rejects(
    executeStep4({ flowStartTime: 0, email: 'old@example.com' }),
    /Flow superseded by next scheduled batch\./
  );
  assert.deepEqual(stateWrites, []);
  assert.equal(sentMessages.some((entry) => entry.type === 'FILL_CODE' && entry.step === 4), false);
});

test('executeStep7 rejects stale poll result before filling login code', async () => {
  const context = loadBackgroundContext();
  const sentMessages = [];

  overrideFunction(context, 'addLog', '__testAddLog', async () => {});
  overrideFunction(context, 'isTabAlive', '__testIsTabAlive', async () => true);
  overrideFunction(context, 'getTabId', '__testGetTabId', async () => 42);
  context.__testMailConfig = {
    source: 'mail-source',
    label: 'Mail Source',
    navigateOnReuse: false,
  };
  vm.runInContext('getMailConfig = () => __testMailConfig;', context);
  overrideFunction(context, 'sendToContentScript', '__testSendToContentScript', async (source, message) => {
    sentMessages.push({ source, type: message.type, step: message.step });
    if (message.type === 'POLL_EMAIL') {
      setBatchState(context, 'batch-new');
      return { code: '654321', emailTimestamp: 1710000000001 };
    }
    return {};
  });

  setBatchState(context, 'batch-old');
  const executeStep7 = vm.runInContext('executeStep7', context);

  await assert.rejects(
    executeStep7({ flowStartTime: 0, lastEmailTimestamp: 0, email: 'old@example.com' }),
    /Flow superseded by next scheduled batch\./
  );
  assert.equal(sentMessages.some((entry) => entry.type === 'FILL_CODE' && entry.step === 7), false);
});

test('fetchICloudEmail rejects stale direct response after batch takeover', async () => {
  const context = loadBackgroundContext();
  const emailWrites = [];

  overrideFunction(context, 'addLog', '__testAddLog', async () => {});
  overrideFunction(context, 'setEmailState', '__testSetEmailState', async (email) => {
    emailWrites.push(email);
  });
  context.chrome.cookies.getAll = async () => [{ name: 'X-APPLE-WEBAUTH-USER', value: 'dsid', domain: '.icloud.com.cn' }];
  context.fetch = async (url) => {
    if (String(url).includes('/generate?')) {
      return {
        ok: true,
        json: async () => ({ result: { hme: 'icloud-old@example.com' } }),
      };
    }
    setBatchState(context, 'batch-new');
    return {
      ok: true,
      json: async () => ({ success: true }),
    };
  };

  setBatchState(context, 'batch-old');
  const fetchICloudEmail = vm.runInContext('fetchICloudEmail', context);

  await assert.rejects(
    fetchICloudEmail({ batchId: 'batch-old' }),
    /Flow superseded by next scheduled batch\./
  );
  assert.deepEqual(emailWrites, []);
});

test('executeStep marks superseded step as stopped instead of failed', async () => {
  const context = loadBackgroundContext();
  const statuses = [];

  overrideFunction(context, 'addLog', '__testAddLog', async () => {});
  overrideFunction(context, 'humanStepDelay', '__testHumanStepDelay', async () => {});
  overrideFunction(context, 'getState', '__testGetState', async () => ({ flowStartTime: 1, stepStatuses: {} }));
  overrideFunction(context, 'setStepStatus', '__testSetStepStatus', async (step, status) => {
    statuses.push({ step, status });
  });
  overrideFunction(context, 'executeStep4', '__testExecuteStep4', async () => {
    throw new Error('Flow superseded by next scheduled batch.');
  });

  const executeStep = vm.runInContext('executeStep', context);
  await assert.rejects(
    executeStep(4),
    /Flow superseded by next scheduled batch\./
  );

  assert.deepEqual(statuses, [
    { step: 4, status: 'running' },
    { step: 4, status: 'stopped' },
  ]);
});

test('executeStep1 freezes batch identity before async setup', async () => {
  const context = loadBackgroundContext();
  const sentMessages = [];

  overrideFunction(context, 'addLog', '__testAddLog', async () => {});
  overrideFunction(context, 'reuseOrCreateTab', '__testReuseOrCreateTab', async () => {
    setBatchState(context, 'batch-new');
  });
  overrideFunction(context, 'sendToContentScript', '__testSendToContentScript', async (source, message) => {
    sentMessages.push({ source, message });
    return {};
  });

  setBatchState(context, 'batch-old');
  const executeStep1 = vm.runInContext('executeStep1', context);

  await assert.rejects(
    executeStep1({ vpsUrl: 'https://example.test' }),
    /Flow superseded by next scheduled batch\./
  );
  assert.deepEqual(sentMessages, []);
});

test('executeStep8 rejects superseded batch before debugger click', async () => {
  const context = loadBackgroundContext();
  let clickCalled = false;

  const realSetTimeout = context.setTimeout;
  context.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 120000 ? 10 : ms, ...args);

  context.chrome.webNavigation.onBeforeNavigate.addListener = () => {};
  context.chrome.webNavigation.onBeforeNavigate.removeListener = () => {};

  overrideFunction(context, 'addLog', '__testAddLog', async () => {});
  overrideFunction(context, 'getTabId', '__testGetTabId', async () => 42);
  overrideFunction(context, 'clickWithDebugger', '__testClickWithDebugger', async () => {
    clickCalled = true;
  });
  overrideFunction(context, 'sendToContentScript', '__testSendToContentScript', async () => {
    setBatchState(context, 'batch-new');
    return { rect: { centerX: 10, centerY: 10 } };
  });

  setBatchState(context, 'batch-old');
  const executeStep8 = vm.runInContext('executeStep8', context);

  await assert.rejects(
    executeStep8({ oauthUrl: 'https://example.test/oauth' }),
    /Flow superseded by next scheduled batch\./
  );
  assert.equal(clickCalled, false);
});

test('restoreScheduleFromStorage recreates enabled schedule alarm on startup', async () => {
  const context = loadBackgroundContext();
  const calls = [];

  overrideFunction(context, 'getLocalSettings', '__testGetLocalSettings', async () => ({
    scheduledRunCount: 3,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: null,
  }));
  overrideFunction(context, 'clearScheduleAlarm', '__testClearScheduleAlarm', async () => {
    calls.push('clear');
  });
  overrideFunction(context, 'createScheduleAlarm', '__testCreateScheduleAlarm', async (intervalMinutes) => {
    calls.push(['create', intervalMinutes]);
  });
  overrideFunction(context, 'setLocalSettings', '__testSetLocalSettings', async (updates) => {
    calls.push(['setLocal', updates]);
  });
  overrideFunction(context, 'addLog', '__testAddLog', async () => {});

  const restoreScheduleFromStorage = vm.runInContext('restoreScheduleFromStorage', context);
  await restoreScheduleFromStorage();

  assert.equal(calls[0], 'clear');
  assert.deepEqual(calls[1], ['create', 15]);
  assert.equal(calls[2][0], 'setLocal');
  assert.equal(typeof calls[2][1].scheduleNextRunAt, 'number');
  assert.ok(calls[2][1].scheduleNextRunAt > Date.now());
});

test('restoreScheduleFromStorage clears disabled schedule state on startup', async () => {
  const context = loadBackgroundContext();
  const calls = [];

  overrideFunction(context, 'getLocalSettings', '__testGetLocalSettings', async () => ({
    scheduledRunCount: 1,
    scheduleIntervalMinutes: 0,
    scheduleEnabled: false,
    scheduleNextRunAt: 123,
  }));
  overrideFunction(context, 'clearScheduleAlarm', '__testClearScheduleAlarm', async () => {
    calls.push('clear');
  });
  overrideFunction(context, 'createScheduleAlarm', '__testCreateScheduleAlarm', async (intervalMinutes) => {
    calls.push(['create', intervalMinutes]);
  });
  overrideFunction(context, 'setLocalSettings', '__testSetLocalSettings', async (updates) => {
    calls.push(['setLocal', updates]);
  });
  overrideFunction(context, 'addLog', '__testAddLog', async () => {});

  const restoreScheduleFromStorage = vm.runInContext('restoreScheduleFromStorage', context);
  await restoreScheduleFromStorage();

  assert.equal(calls[0], 'clear');
  assert.equal(calls[1][0], 'setLocal');
  assert.equal(calls[1][1].scheduleNextRunAt, null);
  assert.equal(calls.length, 2);
});

test('SAVE_SCHEDULE_SETTINGS with zero interval disables schedule without starting batch', async () => {
  const context = loadBackgroundContext();
  const alarmCalls = [];
  const localWrites = [];
  const starts = [];
  const broadcasts = [];

  overrideFunction(context, 'getLocalSettings', '__testGetLocalSettings', async () => ({
    scheduledRunCount: 4,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: 123,
    scheduleLastStartedAt: 456,
    scheduleLastSkippedAt: 789,
  }));
  overrideFunction(context, 'clearScheduleAlarm', '__testClearScheduleAlarm', async () => {
    alarmCalls.push('clear');
  });
  overrideFunction(context, 'createScheduleAlarm', '__testCreateScheduleAlarm', async (intervalMinutes) => {
    alarmCalls.push(['create', intervalMinutes]);
  });
  overrideFunction(context, 'setLocalSettings', '__testSetLocalSettings', async (updates) => {
    localWrites.push(updates);
  });
  overrideFunction(context, 'startAutoBatch', '__testStartAutoBatch', async (payload) => {
    starts.push(payload);
    return { ok: true, batchId: 'batch-test' };
  });
  overrideFunction(context, 'broadcastScheduleUpdate', '__testBroadcastScheduleUpdate', async (payload) => {
    broadcasts.push(payload);
  });

  const handleMessage = vm.runInContext('handleMessage', context);
  const response = await handleMessage({
    type: 'SAVE_SCHEDULE_SETTINGS',
    payload: { scheduledRunCount: 2, scheduleIntervalMinutes: 0 },
  });

  assert.equal(response.ok, true);
  assert.equal(response.scheduleNextRunAt, null);
  assert.deepEqual(alarmCalls, ['clear']);
  assert.deepEqual(toPlainJson(localWrites), [{
    scheduledRunCount: 2,
    scheduleIntervalMinutes: 0,
    scheduleEnabled: false,
    scheduleNextRunAt: null,
  }]);
  assert.deepEqual(toPlainJson(starts), []);
  assert.deepEqual(toPlainJson(broadcasts), [{
    scheduledRunCount: 2,
    scheduleIntervalMinutes: 0,
    scheduleEnabled: false,
    scheduleNextRunAt: null,
  }]);
});

test('SAVE_SCHEDULE_SETTINGS switches from manual to scheduled and starts batch immediately', async () => {
  const context = loadBackgroundContext();
  const alarmCalls = [];
  const localWrites = [];
  const starts = [];
  const broadcasts = [];

  overrideFunction(context, 'getLocalSettings', '__testGetLocalSettings', async () => ({
    scheduledRunCount: 1,
    scheduleIntervalMinutes: 0,
    scheduleEnabled: false,
    scheduleNextRunAt: null,
    scheduleLastStartedAt: 9001,
    scheduleLastSkippedAt: null,
  }));
  overrideFunction(context, 'clearScheduleAlarm', '__testClearScheduleAlarm', async () => {
    alarmCalls.push('clear');
  });
  overrideFunction(context, 'createScheduleAlarm', '__testCreateScheduleAlarm', async (intervalMinutes) => {
    alarmCalls.push(['create', intervalMinutes]);
  });
  overrideFunction(context, 'updateNextRunAt', '__testUpdateNextRunAt', async (intervalMinutes) => 1000 + intervalMinutes);
  overrideFunction(context, 'setLocalSettings', '__testSetLocalSettings', async (updates) => {
    localWrites.push(updates);
  });
  overrideFunction(context, 'startAutoBatch', '__testStartAutoBatch', async (payload) => {
    starts.push(payload);
    return { ok: true, batchId: 'batch-now' };
  });
  overrideFunction(context, 'broadcastScheduleUpdate', '__testBroadcastScheduleUpdate', async (payload) => {
    broadcasts.push(payload);
  });

  const handleMessage = vm.runInContext('handleMessage', context);
  const response = await handleMessage({
    type: 'SAVE_SCHEDULE_SETTINGS',
    payload: { scheduledRunCount: 3, scheduleIntervalMinutes: 15 },
  });

  assert.equal(response.ok, true);
  assert.equal(response.previousInterval, 0);
  assert.equal(response.scheduleNextRunAt, 1015);
  assert.deepEqual(alarmCalls, ['clear', ['create', 15]]);
  assert.deepEqual(toPlainJson(localWrites), [{
    scheduledRunCount: 3,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: 1015,
  }]);
  assert.deepEqual(toPlainJson(starts), [{ totalRuns: 3, trigger: 'schedule' }]);
  assert.deepEqual(toPlainJson(broadcasts), [{
    scheduledRunCount: 3,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: 1015,
  }]);
});

test('SAVE_SCHEDULE_SETTINGS updates positive interval without immediate rerun', async () => {
  const context = loadBackgroundContext();
  const alarmCalls = [];
  const localWrites = [];
  const starts = [];

  overrideFunction(context, 'getLocalSettings', '__testGetLocalSettings', async () => ({
    scheduledRunCount: 2,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: 2000,
    scheduleLastStartedAt: 2100,
    scheduleLastSkippedAt: null,
  }));
  overrideFunction(context, 'clearScheduleAlarm', '__testClearScheduleAlarm', async () => {
    alarmCalls.push('clear');
  });
  overrideFunction(context, 'createScheduleAlarm', '__testCreateScheduleAlarm', async (intervalMinutes) => {
    alarmCalls.push(['create', intervalMinutes]);
  });
  overrideFunction(context, 'updateNextRunAt', '__testUpdateNextRunAt', async (intervalMinutes) => 2000 + intervalMinutes);
  overrideFunction(context, 'setLocalSettings', '__testSetLocalSettings', async (updates) => {
    localWrites.push(updates);
  });
  overrideFunction(context, 'startAutoBatch', '__testStartAutoBatch', async (payload) => {
    starts.push(payload);
    return { ok: true, batchId: 'batch-unexpected' };
  });
  vm.runInContext('autoRunActive = false;', context);

  const handleMessage = vm.runInContext('handleMessage', context);
  const response = await handleMessage({
    type: 'SAVE_SCHEDULE_SETTINGS',
    payload: { scheduledRunCount: 5, scheduleIntervalMinutes: 20 },
  });

  assert.equal(response.ok, true);
  assert.equal(response.previousInterval, 15);
  assert.equal(response.scheduleNextRunAt, 2020);
  assert.deepEqual(alarmCalls, ['clear', ['create', 20]]);
  assert.deepEqual(toPlainJson(localWrites), [{
    scheduledRunCount: 5,
    scheduleIntervalMinutes: 20,
    scheduleEnabled: true,
    scheduleNextRunAt: 2020,
  }]);
  assert.deepEqual(toPlainJson(starts), []);
});

test('scheduled alarm starts batch immediately when idle', async () => {
  const context = loadBackgroundContext();
  const broadcasts = [];
  const starts = [];

  overrideFunction(context, 'getLocalSettings', '__testGetLocalSettings', async () => ({
    scheduledRunCount: 4,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: null,
    scheduleLastStartedAt: null,
    scheduleLastSkippedAt: null,
  }));
  overrideFunction(context, 'updateNextRunAt', '__testUpdateNextRunAt', async () => 5555);
  overrideFunction(context, 'broadcastScheduleUpdate', '__testBroadcastScheduleUpdate', async (payload) => {
    broadcasts.push(payload);
  });
  overrideFunction(context, 'startAutoBatch', '__testStartAutoBatch', async (payload) => {
    starts.push(payload);
    return { ok: true, batchId: 'batch-schedule' };
  });
  vm.runInContext('autoRunActive = false;', context);

  await context.__chromeEvents.alarmsOnAlarm.dispatch({ name: 'multipage-auto-schedule' });

  assert.deepEqual(toPlainJson(broadcasts), [{
    scheduledRunCount: 4,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: 5555,
    scheduleLastStartedAt: null,
    scheduleLastSkippedAt: null,
  }]);
  assert.deepEqual(toPlainJson(starts), [{ totalRuns: 4, trigger: 'schedule' }]);
});

test('scheduled alarm skips when active batch is still making progress', async () => {
  const context = loadBackgroundContext();
  const localWrites = [];
  const broadcasts = [];
  const starts = [];
  const logs = [];

  overrideFunction(context, 'getLocalSettings', '__testGetLocalSettings', async () => ({
    scheduledRunCount: 2,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: null,
    scheduleLastStartedAt: 4000,
    scheduleLastSkippedAt: null,
  }));
  overrideFunction(context, 'updateNextRunAt', '__testUpdateNextRunAt', async () => 6666);
  overrideFunction(context, 'setLocalSettings', '__testSetLocalSettings', async (updates) => {
    localWrites.push(updates);
  });
  overrideFunction(context, 'broadcastScheduleUpdate', '__testBroadcastScheduleUpdate', async (payload) => {
    broadcasts.push(payload);
  });
  overrideFunction(context, 'startAutoBatch', '__testStartAutoBatch', async (payload) => {
    starts.push(payload);
    return { ok: true, batchId: 'batch-should-not-start' };
  });
  overrideFunction(context, 'addLog', '__testAddLog', async (message, level) => {
    logs.push({ message, level });
  });
  vm.runInContext('autoRunActive = true; currentBatchLastProgressAt = Date.now();', context);

  await context.__chromeEvents.alarmsOnAlarm.dispatch({ name: 'multipage-auto-schedule' });

  assert.equal(localWrites.length, 1);
  assert.equal(typeof localWrites[0].scheduleLastSkippedAt, 'number');
  assert.deepEqual(toPlainJson(broadcasts), [{
    scheduledRunCount: 2,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: 6666,
    scheduleLastStartedAt: 4000,
    scheduleLastSkippedAt: localWrites[0].scheduleLastSkippedAt,
  }]);
  assert.deepEqual(toPlainJson(starts), []);
  assert.deepEqual(toPlainJson(logs), [{
    message: 'skip scheduled batch because previous batch is still making progress',
    level: 'warn',
  }]);
});

test('scheduled alarm supersedes stale batch and starts a new one', async () => {
  const context = loadBackgroundContext();
  const broadcasts = [];
  const starts = [];
  const supersedes = [];
  const clears = [];

  overrideFunction(context, 'getLocalSettings', '__testGetLocalSettings', async () => ({
    scheduledRunCount: 6,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: null,
    scheduleLastStartedAt: 3000,
    scheduleLastSkippedAt: 3500,
  }));
  overrideFunction(context, 'updateNextRunAt', '__testUpdateNextRunAt', async () => 7777);
  overrideFunction(context, 'broadcastScheduleUpdate', '__testBroadcastScheduleUpdate', async (payload) => {
    broadcasts.push(payload);
  });
  overrideFunction(context, 'supersedeCurrentBatch', '__testSupersedeCurrentBatch', async () => {
    supersedes.push('supersede');
  });
  overrideFunction(context, 'clearStopRequest', '__testClearStopRequest', () => {
    clears.push('clear');
  });
  overrideFunction(context, 'startAutoBatch', '__testStartAutoBatch', async (payload) => {
    starts.push(payload);
    return { ok: true, batchId: 'batch-replacement' };
  });
  vm.runInContext('autoRunActive = true; currentBatchLastProgressAt = Date.now() - 16 * 60 * 1000;', context);

  await context.__chromeEvents.alarmsOnAlarm.dispatch({ name: 'multipage-auto-schedule' });

  assert.deepEqual(toPlainJson(broadcasts), [{
    scheduledRunCount: 6,
    scheduleIntervalMinutes: 15,
    scheduleEnabled: true,
    scheduleNextRunAt: 7777,
    scheduleLastStartedAt: 3000,
    scheduleLastSkippedAt: 3500,
  }]);
  assert.deepEqual(supersedes, ['supersede']);
  assert.deepEqual(clears, ['clear']);
  assert.deepEqual(toPlainJson(starts), [{ totalRuns: 6, trigger: 'schedule' }]);
});
