# mpa4gpt Scheduled Auto Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `assets/mpa4gpt` 增加可持久化的常驻定时自动运行能力，并在侧边栏提供新的运行控制卡片来配置 `RunCount` 与 `Interval(min)`。

**Architecture:** 继续复用现有 `background.js` 里的单批次自动运行主流程，但把“调度”与“执行”拆开：`chrome.alarms` 负责周期触发，统一批次入口负责手动和定时两种来源。批次状态增加 `batchId` 与 `lastProgressAt`，用于 stale 判定、旧消息隔离以及下一周期的安全接管。

**Tech Stack:** Chrome Extension Manifest V3、Service Worker、`chrome.alarms`、`chrome.storage.local`、`chrome.storage.session`、Side Panel、原生 JavaScript

---

## 文件结构

### 需要修改的现有文件

- `assets/mpa4gpt/manifest.json`
  - 增加 `alarms` 权限
- `assets/mpa4gpt/background.js`
  - 增加 schedule 配置持久化
  - 增加 alarm 创建/恢复/删除
  - 抽出统一批次入口
  - 增加 `batchId`、`lastProgressAt`、stale 接管逻辑
  - 扩展消息协议
- `assets/mpa4gpt/sidepanel/sidepanel.html`
  - 精简 header
  - 增加运行控制卡片
  - 增加 `Interval(min)`、定时状态、下一次触发展示
- `assets/mpa4gpt/sidepanel/sidepanel.css`
  - 删除旧 header 运行组布局
  - 增加运行控制卡片布局与状态样式
- `assets/mpa4gpt/sidepanel/sidepanel.js`
  - 恢复/保存 schedule 配置
  - 监听新输入项
  - 渲染模式、下一次触发时间、批次状态
- `assets/mpa4gpt/content/utils.js`
  - 为所有 content script 的消息补 `batchId`
  - 增加进展上报工具函数
- `assets/mpa4gpt/content/signup-page.js`
  - 通过新的工具函数上报 progress
  - 透传 `batchId`
- `assets/mpa4gpt/content/vps-panel.js`
  - 通过新的工具函数上报 progress
  - 透传 `batchId`
- `assets/mpa4gpt/content/duck-mail.js`
  - 通过新的工具函数上报 progress
  - 透传 `batchId`
- `assets/mpa4gpt/content/qq-mail.js`
  - 在轮询开始、发现结果时上报 progress
  - 透传 `batchId`
- `assets/mpa4gpt/content/mail-163.js`
  - 在轮询开始、发现结果时上报 progress
  - 透传 `batchId`
- `assets/mpa4gpt/content/inbucket-mail.js`
  - 在轮询开始、发现结果时上报 progress
  - 透传 `batchId`
- `assets/mpa4gpt/content/icloud.js`
  - 在轮询开始、发现结果时上报 progress
  - 透传 `batchId`

### 不新增代码文件的原则

当前扩展主要逻辑集中在现有文件中，且代码体量仍可接受。本次实现优先沿用既有结构，不额外拆新模块，避免为了这次功能引入不必要抽象。

### 测试方式说明

仓库里当前没有现成的 JS 单元测试框架或 `package.json`。本计划以：

1. 手动加载扩展到 Chrome
2. 通过 side panel 交互验证
3. 用 Service Worker console + side panel log 验证行为

作为主测试路径。

---

### Task 1: 扩展清单与持久化配置骨架

**Files:**
- Modify: `assets/mpa4gpt/manifest.json`
- Modify: `assets/mpa4gpt/background.js`

- [ ] **Step 1: 在 manifest 中加入 alarms 权限**

```json
{
  "permissions": [
    "sidePanel",
    "tabs",
    "webNavigation",
    "debugger",
    "storage",
    "scripting",
    "activeTab",
    "cookies",
    "declarativeNetRequest",
    "declarativeNetRequestWithHostAccess",
    "alarms"
  ]
}
```

- [ ] **Step 2: 在 `background.js` 顶部增加 schedule 常量与 local 配置默认值**

```js
const SCHEDULE_ALARM_NAME = 'multipage-auto-schedule';

const DEFAULT_LOCAL_SETTINGS = {
  scheduledRunCount: 1,
  scheduleIntervalMinutes: 0,
  scheduleEnabled: false,
  scheduleNextRunAt: null,
  scheduleLastStartedAt: null,
  scheduleLastSkippedAt: null,
};
```

- [ ] **Step 3: 在 `background.js` 中增加 local 配置读写函数**

```js
async function getLocalSettings() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULT_LOCAL_SETTINGS));
  return { ...DEFAULT_LOCAL_SETTINGS, ...saved };
}

async function setLocalSettings(updates) {
  await chrome.storage.local.set(updates);
}
```

- [ ] **Step 4: 扩展 `GET_STATE` 返回结构，先把 local 配置合并回 UI 状态**

```js
case 'GET_STATE': {
  const sessionState = await getState();
  const localSettings = await getLocalSettings();
  return {
    ...sessionState,
    ...localSettings,
  };
}
```

- [ ] **Step 5: 手动 reload 扩展确认 manifest 生效**

Run: 在 `chrome://extensions/` 里点击 Reload 当前扩展
Expected: 扩展成功重载，无 manifest 权限错误

- [ ] **Step 6: 在 Service Worker console 验证 local 默认值可读**

Run: 在扩展的 Service Worker DevTools console 执行
```js
chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'manual-test' })
```
Expected: 返回对象包含 `scheduledRunCount`, `scheduleIntervalMinutes`, `scheduleEnabled`

- [ ] **Step 7: Commit**

```bash
git add assets/mpa4gpt/manifest.json assets/mpa4gpt/background.js
git commit -m "feat: add schedule settings storage for mpa4gpt"
```

### Task 2: 统一批次入口与批次元数据

**Files:**
- Modify: `assets/mpa4gpt/background.js`

- [ ] **Step 1: 在 `background.js` 中增加批次元数据内存变量**

```js
let currentBatchId = null;
let currentBatchStartedAt = null;
let currentBatchLastProgressAt = null;
let currentBatchStatus = 'idle';
let currentBatchTrigger = null;
```

- [ ] **Step 2: 增加生成 `batchId` 与更新 progress 的工具函数**

```js
function createBatchId() {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function markBatchProgress(reason = 'progress') {
  currentBatchLastProgressAt = Date.now();
  console.log(LOG_PREFIX, `Batch progress: ${reason}`, {
    currentBatchId,
    currentBatchLastProgressAt,
  });
}
```

- [ ] **Step 3: 抽出统一入口 `startAutoBatch`**

```js
async function startAutoBatch({ totalRuns, trigger }) {
  if (autoRunActive) {
    await addLog(`Batch already running, skip ${trigger} trigger`, 'warn');
    return { ok: false, reason: 'already-running' };
  }

  currentBatchId = createBatchId();
  currentBatchStartedAt = Date.now();
  currentBatchLastProgressAt = currentBatchStartedAt;
  currentBatchStatus = 'running';
  currentBatchTrigger = trigger;

  autoRunLoop(totalRuns, {
    batchId: currentBatchId,
    trigger,
  });

  return { ok: true, batchId: currentBatchId };
}
```

- [ ] **Step 4: 把原 `AUTO_RUN` 消息改成调用统一入口**

过渡规则（已确认）：在 Task 9 接管 sidepanel 持久化之前，先兼容现有 sidepanel 传入的 `payload.totalRuns`，避免手动 `Auto` 行为回归；若未提供有效值，再回退到持久化的 `scheduledRunCount`。

```js
case 'AUTO_RUN': {
  clearStopRequest();
  const localSettings = await getLocalSettings();
  const payloadRuns = Number(message.payload?.totalRuns);
  const totalRuns = Number.isInteger(payloadRuns) && payloadRuns > 0
    ? payloadRuns
    : (localSettings.scheduledRunCount || 1);
  return await startAutoBatch({ totalRuns, trigger: 'manual' });
}
```

- [ ] **Step 5: 调整 `autoRunLoop` 签名，让它接收批次上下文**

```js
async function autoRunLoop(totalRuns, batchContext) {
  const { batchId, trigger } = batchContext;
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  currentBatchStatus = 'running';
  markBatchProgress(`batch-start:${trigger}`);
  // 其余原逻辑继续保留
}
```

- [ ] **Step 6: 在批次成功、停止、失败结束时统一清理状态**

```js
function finishCurrentBatch(status) {
  currentBatchStatus = status;
  autoRunActive = false;
  currentBatchTrigger = null;
}
```

- [ ] **Step 7: 手动点击 Auto 验证批次入口仍可工作**

Run: 打开 side panel，点击现有 `Auto`
Expected: 仍然开始跑批次；Service Worker log 中能看到新的 `batchId`

- [ ] **Step 8: Commit**

```bash
git add assets/mpa4gpt/background.js
git commit -m "refactor: unify manual and scheduled batch entry"
```

### Task 3: content script 消息协议增加 batchId 与 progress 上报

**Files:**
- Modify: `assets/mpa4gpt/content/utils.js`
- Modify: `assets/mpa4gpt/content/signup-page.js`
- Modify: `assets/mpa4gpt/content/vps-panel.js`
- Modify: `assets/mpa4gpt/content/duck-mail.js`
- Modify: `assets/mpa4gpt/content/qq-mail.js`
- Modify: `assets/mpa4gpt/content/mail-163.js`
- Modify: `assets/mpa4gpt/content/inbucket-mail.js`
- Modify: `assets/mpa4gpt/content/icloud.js`

- [ ] **Step 1: 在 `content/utils.js` 中新增 progress 上报函数**

```js
function reportProgress(step, detail = 'progress', batchId = null) {
  chrome.runtime.sendMessage({
    type: 'STEP_PROGRESS',
    source: SCRIPT_SOURCE,
    step,
    payload: { detail, batchId, timestamp: Date.now() },
    error: null,
  });
}
```

- [ ] **Step 2: 修改 `reportComplete`，让它可附带 batchId**

```js
function reportComplete(step, data = {}) {
  chrome.runtime.sendMessage({
    type: 'STEP_COMPLETE',
    source: SCRIPT_SOURCE,
    step,
    payload: data,
    error: null,
  });
}
```

改成：

```js
function reportComplete(step, data = {}, batchId = null) {
  chrome.runtime.sendMessage({
    type: 'STEP_COMPLETE',
    source: SCRIPT_SOURCE,
    step,
    payload: { ...data, batchId },
    error: null,
  });
}
```

- [ ] **Step 3: 修改 `reportError`，同样附带 batchId**

```js
function reportError(step, errorMessage, batchId = null) {
  chrome.runtime.sendMessage({
    type: 'STEP_ERROR',
    source: SCRIPT_SOURCE,
    step,
    payload: { batchId },
    error: errorMessage,
  });
}
```

- [ ] **Step 4: 在 `signup-page.js` 的命令处理入口先取出 batchId**

```js
async function handleCommand(message) {
  const batchId = message.payload?.batchId || null;
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister(batchId);
        case 3: return await step3_fillEmailPassword(message.payload, batchId);
        case 5: return await step5_fillNameBirthday(message.payload, batchId);
        case 6: return await step6_login(message.payload, batchId);
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
```

- [ ] **Step 5: 在 `signup-page.js` 的每个 step 开始与关键节点调用 `reportProgress`**

```js
async function step3_fillEmailPassword(payload, batchId) {
  reportProgress(3, 'step-start', batchId);
  // ...
  reportProgress(3, 'email-filled', batchId);
  // ...
  reportProgress(3, 'password-filled', batchId);
  reportComplete(3, { email }, batchId);
}
```

- [ ] **Step 6: 在 `vps-panel.js`、`duck-mail.js` 中同样透传 batchId 并上报 progress**

```js
async function step1_getOAuthLink(batchId) {
  reportProgress(1, 'step-start', batchId);
  // ...
  reportProgress(1, 'oauth-url-found', batchId);
  reportComplete(1, { oauthUrl }, batchId);
}
```

```js
async function fetchDuckEmail(payload = {}) {
  const { generateNew = true, batchId = null } = payload;
  reportProgress(0, 'duck-fetch-start', batchId);
  // ...
  reportProgress(0, 'duck-email-ready', batchId);
  return { email: nextEmail, generated: true, batchId };
}
```

- [ ] **Step 7: 在各邮件轮询脚本中为“开始轮询”“发现验证码”打点**

以 `qq-mail.js` 为例：

```js
async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs, batchId = null } = payload;
  reportProgress(step, 'poll-start', batchId);
  // ...
  if (code) {
    reportProgress(step, 'code-found', batchId);
    return { ok: true, code, emailTimestamp: Date.now(), mailId, batchId };
  }
}
```

- [ ] **Step 8: 在 `background.js` 中先增加 `STEP_PROGRESS` 处理，更新 `currentBatchLastProgressAt`**

```js
case 'STEP_PROGRESS': {
  const messageBatchId = message.payload?.batchId || null;
  if (!messageBatchId || messageBatchId !== currentBatchId) {
    return { ok: true, ignored: true };
  }
  markBatchProgress(`${message.source}:${message.step}:${message.payload?.detail || 'progress'}`);
  return { ok: true };
}
```

- [ ] **Step 9: reload 扩展后手动跑一轮，验证 Service Worker 能收到 progress**

Run: 点击单步按钮或 Auto
Expected: Service Worker console 出现 `Batch progress:` 日志，且 detail 随步骤推进变化

- [ ] **Step 10: Commit**

```bash
git add assets/mpa4gpt/content/utils.js assets/mpa4gpt/content/signup-page.js assets/mpa4gpt/content/vps-panel.js assets/mpa4gpt/content/duck-mail.js assets/mpa4gpt/content/qq-mail.js assets/mpa4gpt/content/mail-163.js assets/mpa4gpt/content/inbucket-mail.js assets/mpa4gpt/content/icloud.js assets/mpa4gpt/background.js
git commit -m "feat: track batch progress across content scripts"
```

### Task 4: background 中实现 batchId 隔离

**Files:**
- Modify: `assets/mpa4gpt/background.js`

- [ ] **Step 1: 增加当前消息 batchId 提取函数**

```js
function getMessageBatchId(message) {
  return message?.payload?.batchId || null;
}
```

- [ ] **Step 2: 在 `STEP_COMPLETE` 中忽略旧批次消息**

```js
case 'STEP_COMPLETE': {
  const messageBatchId = getMessageBatchId(message);
  if (messageBatchId && messageBatchId !== currentBatchId) {
    await addLog(`Ignored STEP_COMPLETE from stale batch ${messageBatchId}`, 'warn');
    return { ok: true, ignored: true };
  }
  // 原有完成逻辑
}
```

- [ ] **Step 3: 在 `STEP_ERROR` 中同样忽略旧批次消息**

```js
case 'STEP_ERROR': {
  const messageBatchId = getMessageBatchId(message);
  if (messageBatchId && messageBatchId !== currentBatchId) {
    await addLog(`Ignored STEP_ERROR from stale batch ${messageBatchId}`, 'warn');
    return { ok: true, ignored: true };
  }
  // 原有失败逻辑
}
```

- [ ] **Step 4: 在所有 `sendToContentScript` / `FETCH_PROVIDER_EMAIL` / `POLL_EMAIL` / `FILL_CODE` 消息里补上当前 `batchId`**

```js
await sendToContentScript('signup-page', {
  type: 'EXECUTE_STEP',
  step: 3,
  source: 'background',
  payload: { email: state.email, password, batchId: currentBatchId },
});
```

```js
const result = await sendToContentScript(mail.source, {
  type: 'POLL_EMAIL',
  step: 4,
  source: 'background',
  payload: {
    filterAfterTimestamp: state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply'],
    subjectFilters: ['verify', 'code'],
    targetEmail: state.email,
    maxAttempts: 100,
    intervalMs: 6000,
    batchId: currentBatchId,
  },
});
```

- [ ] **Step 5: 让 `fetchDuckEmail` / `fetchProviderEmail` 也用当前 batchId**

```js
const result = await sendToContentScript('duck-mail', {
  type: 'FETCH_DUCK_EMAIL',
  source: 'background',
  payload: { generateNew, batchId: currentBatchId },
});
```

- [ ] **Step 6: 人工制造 stale batch 消息场景并验证忽略逻辑**

Run: 在 Service Worker console 手动调用一个旧 `batchId` 的 `handleMessage` 模拟消息，或在代码里临时 `console.log` 验证
Expected: 日志出现 `Ignored ... from stale batch`，UI 不被污染

- [ ] **Step 7: Commit**

```bash
git add assets/mpa4gpt/background.js
git commit -m "feat: ignore stale batch messages"
```

### Task 5: chrome.alarms 调度层与 schedule 保存消息

**Files:**
- Modify: `assets/mpa4gpt/background.js`

- [ ] **Step 1: 增加创建/删除 alarm 的工具函数**

```js
async function clearScheduleAlarm() {
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
}

async function createScheduleAlarm(intervalMinutes) {
  await chrome.alarms.create(SCHEDULE_ALARM_NAME, {
    periodInMinutes: intervalMinutes,
  });
}
```

- [ ] **Step 2: 增加下一次触发时间的持久化更新函数**

```js
async function updateNextRunAt(intervalMinutes) {
  const nextRunAt = intervalMinutes > 0
    ? Date.now() + intervalMinutes * 60 * 1000
    : null;

  await setLocalSettings({ scheduleNextRunAt: nextRunAt });
  return nextRunAt;
}
```

- [ ] **Step 3: 在 `background.js` 中实现 `SAVE_SCHEDULE_SETTINGS` 消息**

```js
case 'SAVE_SCHEDULE_SETTINGS': {
  const runCount = Number(message.payload?.scheduledRunCount || 1);
  const intervalMinutes = Number(message.payload?.scheduleIntervalMinutes || 0);

  if (!Number.isInteger(runCount) || runCount < 1) {
    return { error: 'Invalid run count' };
  }
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes % 5 !== 0) {
    return { error: 'Invalid interval minutes' };
  }

  const prev = await getLocalSettings();
  const enableSchedule = intervalMinutes > 0;
  await setLocalSettings({
    scheduledRunCount: runCount,
    scheduleIntervalMinutes: intervalMinutes,
    scheduleEnabled: enableSchedule,
  });

  if (!enableSchedule) {
    await clearScheduleAlarm();
    await setLocalSettings({ scheduleNextRunAt: null });
  } else {
    await clearScheduleAlarm();
    await createScheduleAlarm(intervalMinutes);
    await updateNextRunAt(intervalMinutes);
  }

  chrome.runtime.sendMessage({
    type: 'SCHEDULE_UPDATED',
    payload: {
      scheduledRunCount: runCount,
      scheduleIntervalMinutes: intervalMinutes,
      scheduleEnabled: enableSchedule,
    },
  }).catch(() => {});

  return { ok: true, previousInterval: prev.scheduleIntervalMinutes };
}
```

- [ ] **Step 4: 在 `SAVE_SCHEDULE_SETTINGS` 中实现 0→正数 的立即首批逻辑**

```js
if (prev.scheduleIntervalMinutes === 0 && intervalMinutes > 0 && !autoRunActive) {
  await startAutoBatch({ totalRuns: runCount, trigger: 'schedule' });
}
```

- [ ] **Step 5: 确保 正数→正数 只更新后续周期，不立即触发**

```js
if (prev.scheduleIntervalMinutes > 0 && intervalMinutes > 0) {
  // do not start batch here
}
```

- [ ] **Step 6: 注册 alarm 监听器**

```js
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SCHEDULE_ALARM_NAME) return;
  const settings = await getLocalSettings();
  await updateNextRunAt(settings.scheduleIntervalMinutes);
  // stale/skip/start 逻辑在下一个 Task 完成
});
```

- [ ] **Step 7: 在 Service Worker console 手动发送保存消息验证三种切换**

Run:
```js
chrome.runtime.sendMessage({
  type: 'SAVE_SCHEDULE_SETTINGS',
  source: 'manual-test',
  payload: { scheduledRunCount: 3, scheduleIntervalMinutes: 15 }
})
```
Expected: 返回 `{ ok: true }`，`chrome.alarms.get('multipage-auto-schedule')` 可读到 alarm

再运行：
```js
chrome.runtime.sendMessage({
  type: 'SAVE_SCHEDULE_SETTINGS',
  source: 'manual-test',
  payload: { scheduledRunCount: 3, scheduleIntervalMinutes: 0 }
})
```
Expected: alarm 被清掉，`scheduleNextRunAt` 为 `null`

- [ ] **Step 8: Commit**

```bash
git add assets/mpa4gpt/background.js
git commit -m "feat: add persistent schedule settings and alarms"
```

### Task 6: stale 判定与下一周期接管

**Files:**
- Modify: `assets/mpa4gpt/background.js`

- [ ] **Step 1: 增加 stale 判定函数**

```js
function isBatchStale(intervalMinutes) {
  if (!autoRunActive || !currentBatchLastProgressAt || intervalMinutes <= 0) return false;
  return Date.now() - currentBatchLastProgressAt >= intervalMinutes * 60 * 1000;
}
```

- [ ] **Step 2: 增加标记 stale 并清理旧批次的函数**

```js
async function supersedeCurrentBatch() {
  currentBatchStatus = 'stale';
  stopRequested = true;
  cancelPendingCommands('Flow superseded by next scheduled batch.');

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error('Flow superseded by next scheduled batch.'));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error('Flow superseded by next scheduled batch.'));
    resumeWaiter = null;
  }

  await markRunningStepsStopped();
  await addLog('previous batch marked stale and replaced by scheduled batch', 'warn');
  autoRunActive = false;
}
```

- [ ] **Step 3: 在 alarm 监听器里接入 skip / stale / start 三分支**

```js
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SCHEDULE_ALARM_NAME) return;

  const settings = await getLocalSettings();
  await updateNextRunAt(settings.scheduleIntervalMinutes);

  if (!autoRunActive) {
    await startAutoBatch({ totalRuns: settings.scheduledRunCount, trigger: 'schedule' });
    return;
  }

  if (!isBatchStale(settings.scheduleIntervalMinutes)) {
    await setLocalSettings({ scheduleLastSkippedAt: Date.now() });
    await addLog('skip scheduled batch because previous batch is still making progress', 'warn');
    return;
  }

  await supersedeCurrentBatch();
  clearStopRequest();
  await startAutoBatch({ totalRuns: settings.scheduledRunCount, trigger: 'schedule' });
});
```

- [ ] **Step 4: 在 `autoRunLoop` 的关键节点调用 `markBatchProgress`**

```js
await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1 ===`, 'info');
markBatchProgress(`run-${run}-phase-1`);
```

```js
await executeStepAndWait(4, 2000);
markBatchProgress(`run-${run}-step-4-complete`);
```

- [ ] **Step 5: 在进入等待人工恢复的地方不要误报 progress**

```js
if (!emailReady) {
  await addLog(`=== Run ${run}/${totalRuns} PAUSED: Fetch email or paste manually, then continue ===`, 'warn');
  currentBatchStatus = 'waiting_manual_input';
  // do not call markBatchProgress here repeatedly
  await waitForResume();
  currentBatchStatus = 'running';
  markBatchProgress(`run-${run}-resume-after-email`);
}
```

- [ ] **Step 6: 手动制造“有进展但超一个周期”的场景并验证 skip**

Run: 临时把 `scheduleIntervalMinutes` 设小值，在某个长轮询步骤里保持有新进展日志
Expected: 下个周期只写 skip 日志，不会开第二个批次

- [ ] **Step 7: 手动制造“一个周期内无进展”的场景并验证 stale 接管**

Run: 临时在 `waitForResume()` 或某等待点停住，且不再触发 progress
Expected: 下个周期到来时旧批次被 supersede，新批次重新启动

- [ ] **Step 8: Commit**

```bash
git add assets/mpa4gpt/background.js
git commit -m "feat: replace stale batches on scheduled runs"
```

### Task 7: schedule 恢复与 worker 启动初始化

**Files:**
- Modify: `assets/mpa4gpt/background.js`

- [ ] **Step 1: 增加 schedule 恢复函数**

```js
async function restoreScheduleFromStorage() {
  const settings = await getLocalSettings();
  if (!settings.scheduleEnabled || settings.scheduleIntervalMinutes <= 0) {
    await clearScheduleAlarm();
    return;
  }

  await clearScheduleAlarm();
  await createScheduleAlarm(settings.scheduleIntervalMinutes);
  await updateNextRunAt(settings.scheduleIntervalMinutes);
  await addLog(`Schedule restored: every ${settings.scheduleIntervalMinutes} minutes`, 'info');
}
```

- [ ] **Step 2: 在 worker 启动位置调用恢复函数**

```js
restoreScheduleFromStorage().catch(err => {
  console.error(LOG_PREFIX, 'Failed to restore schedule:', err);
});
```

- [ ] **Step 3: 注册 `runtime.onStartup` 和 `runtime.onInstalled` 钩子**

```js
chrome.runtime.onStartup.addListener(() => {
  restoreScheduleFromStorage().catch(err => console.error(LOG_PREFIX, err));
});

chrome.runtime.onInstalled.addListener(() => {
  restoreScheduleFromStorage().catch(err => console.error(LOG_PREFIX, err));
});
```

- [ ] **Step 4: 手动 reload 扩展验证定时配置恢复**

Run:
1. 先保存 `scheduleIntervalMinutes = 15`
2. 在 `chrome://extensions/` reload 扩展
Expected: Service Worker log 出现 `Schedule restored: every 15 minutes`，且 alarm 仍存在

- [ ] **Step 5: Commit**

```bash
git add assets/mpa4gpt/background.js
git commit -m "feat: restore alarms after extension startup"
```

### Task 8: Side Panel 新布局与新的运行控制卡片 HTML

**Files:**
- Modify: `assets/mpa4gpt/sidepanel/sidepanel.html`
- Modify: `assets/mpa4gpt/sidepanel/sidepanel.css`

- [ ] **Step 1: 精简 `sidepanel.html` 的 header，移除旧 `run-group`**

把这段：

```html
<div class="run-group">
  <input type="number" id="input-run-count" class="run-count-input" value="1" min="1" max="50" title="Number of runs" />
  <button id="btn-auto-run" class="btn btn-success" title="Run all steps automatically">...</button>
  <button id="btn-stop" class="btn btn-danger" title="Stop current flow" disabled>Stop</button>
</div>
```

从 header 删除，只保留：

```html
<div class="header-btns">
  <button id="btn-reset" class="btn btn-ghost" title="Reset all steps">...</button>
  <button id="btn-theme" class="theme-toggle" title="Toggle theme">...</button>
</div>
```

- [ ] **Step 2: 在 header 与 data section 之间插入新的运行控制卡片**

```html
<section id="run-control-section">
  <div class="run-control-card">
    <div class="run-control-top">
      <div class="run-control-status">
        <span class="section-label">Run Control</span>
        <div id="schedule-mode-text" class="run-mode-text">Manual</div>
        <div id="schedule-next-run" class="run-next-text">Next: —</div>
        <div id="batch-state-text" class="run-state-text">State: Idle</div>
      </div>
      <div class="run-control-actions">
        <button id="btn-auto-run" class="btn btn-success" title="Run one batch now">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Auto
        </button>
        <button id="btn-stop" class="btn btn-danger" title="Stop current batch" disabled>Stop</button>
      </div>
    </div>
    <div class="run-control-grid">
      <label class="run-field">
        <span class="data-label">RunCount</span>
        <input type="number" id="input-run-count" class="data-input" value="1" min="1" max="50" step="1" />
      </label>
      <label class="run-field">
        <span class="data-label">Interval</span>
        <input type="number" id="input-interval-minutes" class="data-input" value="0" min="0" step="5" />
        <span class="field-hint">0 = manual only</span>
      </label>
    </div>
  </div>
</section>
```

- [ ] **Step 3: 在 `sidepanel.css` 中为新卡片增加样式**

```css
#run-control-section { margin-bottom: 14px; }

.run-control-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: var(--shadow-sm);
}

.run-control-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}

.run-control-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.run-control-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
```

- [ ] **Step 4: 删除或压缩旧 `.run-group`、`.run-count-input` 专用样式**

```css
/* remove old header-only layout dependence */
```

保留按钮通用样式，不再依赖 header 横向排布。

- [ ] **Step 5: 打开 side panel 目测布局**

Run: reload 扩展后重新打开 side panel
Expected: header 不再拥挤；运行控制卡片位于数据卡片上方；窄宽度下按钮与输入仍然可用

- [ ] **Step 6: Commit**

```bash
git add assets/mpa4gpt/sidepanel/sidepanel.html assets/mpa4gpt/sidepanel/sidepanel.css
git commit -m "feat: redesign side panel run controls"
```

### Task 9: Side Panel 状态恢复、保存与 schedule 文案渲染

**Files:**
- Modify: `assets/mpa4gpt/sidepanel/sidepanel.js`

- [ ] **Step 1: 增加新 DOM 引用**

```js
const inputIntervalMinutes = document.getElementById('input-interval-minutes');
const scheduleModeText = document.getElementById('schedule-mode-text');
const scheduleNextRun = document.getElementById('schedule-next-run');
const batchStateText = document.getElementById('batch-state-text');
```

- [ ] **Step 2: 在 `restoreState()` 中恢复 `scheduledRunCount` 与 `scheduleIntervalMinutes`**

```js
if (typeof state.scheduledRunCount === 'number') {
  inputRunCount.value = String(state.scheduledRunCount);
}
if (typeof state.scheduleIntervalMinutes === 'number') {
  inputIntervalMinutes.value = String(state.scheduleIntervalMinutes);
}
updateScheduleDisplay(state);
```

- [ ] **Step 3: 新增 `updateScheduleDisplay(state)`**

```js
function formatNextRun(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function updateScheduleDisplay(state) {
  const interval = Number(state.scheduleIntervalMinutes || 0);
  scheduleModeText.textContent = interval > 0
    ? `Scheduled every ${interval} min`
    : 'Manual';
  scheduleNextRun.textContent = `Next: ${formatNextRun(state.scheduleNextRunAt)}`;

  if (state.autoRunning) {
    batchStateText.textContent = 'State: Running batch';
  } else {
    batchStateText.textContent = 'State: Idle';
  }
}
```

- [ ] **Step 4: 监听 `RunCount` 和 `Interval` change 事件，发送 `SAVE_SCHEDULE_SETTINGS`**

```js
async function saveScheduleSettings() {
  if (!inputIntervalMinutes.validity.valid) {
    showToast('Interval must use 5-minute steps', 'warn');
    return;
  }

  const scheduledRunCount = parseInt(inputRunCount.value, 10) || 1;
  const scheduleIntervalMinutes = parseInt(inputIntervalMinutes.value, 10) || 0;

  const response = await chrome.runtime.sendMessage({
    type: 'SAVE_SCHEDULE_SETTINGS',
    source: 'sidepanel',
    payload: { scheduledRunCount, scheduleIntervalMinutes },
  });

  if (response?.error) {
    showToast(response.error, 'error');
    return;
  }
}

inputRunCount.addEventListener('change', saveScheduleSettings);
inputIntervalMinutes.addEventListener('change', saveScheduleSettings);
```

- [ ] **Step 5: 调整 Auto 按钮点击逻辑，让它不再直接从输入框临时取 totalRuns**

把：

```js
const totalRuns = parseInt(inputRunCount.value) || 1;
await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns } });
```

改成：

```js
await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: {} });
```

- [ ] **Step 6: 响应 `SCHEDULE_UPDATED` 广播**

```js
case 'SCHEDULE_UPDATED': {
  const state = {
    scheduledRunCount: message.payload.scheduledRunCount,
    scheduleIntervalMinutes: message.payload.scheduleIntervalMinutes,
    scheduleEnabled: message.payload.scheduleEnabled,
    scheduleNextRunAt: message.payload.scheduleNextRunAt,
    autoRunning: btnAutoRun.disabled,
  };
  updateScheduleDisplay(state);
  break;
}
```

- [ ] **Step 7: 扩展 `AUTO_RUN_STATUS` 渲染**

```js
case 'AUTO_RUN_STATUS': {
  const { phase, currentRun, totalRuns, nextRunAt } = message.payload;
  // 继续保留旧按钮状态切换
  updateScheduleDisplay({
    autoRunning: phase === 'running' || phase === 'waiting_email',
    scheduleIntervalMinutes: Number(inputIntervalMinutes.value || 0),
    scheduleNextRunAt: nextRunAt || null,
  });
  break;
}
```

- [ ] **Step 8: 手动验证 UI 保存与刷新恢复**

Run:
1. side panel 中设置 `RunCount = 3`
2. 设置 `Interval = 15`
3. 关闭再重新打开 side panel
Expected: 值恢复，模式文案显示 `Scheduled every 15 min`

- [ ] **Step 9: Commit**

```bash
git add assets/mpa4gpt/sidepanel/sidepanel.js
git commit -m "feat: wire side panel schedule controls"
```

### Task 10: 最终联调与验证

**Files:**
- Modify: `assets/mpa4gpt/background.js`
- Modify: `assets/mpa4gpt/sidepanel/sidepanel.js`
- Modify: `assets/mpa4gpt/sidepanel/sidepanel.html`
- Modify: `assets/mpa4gpt/sidepanel/sidepanel.css`
- Modify: `assets/mpa4gpt/content/utils.js`
- Modify: `assets/mpa4gpt/content/signup-page.js`
- Modify: `assets/mpa4gpt/content/vps-panel.js`
- Modify: `assets/mpa4gpt/content/duck-mail.js`
- Modify: `assets/mpa4gpt/content/qq-mail.js`
- Modify: `assets/mpa4gpt/content/mail-163.js`
- Modify: `assets/mpa4gpt/content/inbucket-mail.js`
- Modify: `assets/mpa4gpt/content/icloud.js`
- Modify: `assets/mpa4gpt/manifest.json`

- [ ] **Step 1: reload 扩展并确认 side panel 正常打开**

Run: `chrome://extensions/` → Reload 扩展 → 打开 side panel
Expected: 无白屏，无语法错误

- [ ] **Step 2: 验证 `Interval=0` 手动模式**

Run:
1. 设置 `Interval = 0`
2. 观察模式文案
3. 点击 `Auto`
Expected:
- 文案显示 `Manual`
- 只启动一个批次
- 后续不会创建 alarm

- [ ] **Step 3: 验证 `0 -> 15` 的启用逻辑**

Run:
1. 先设置 `Interval = 0`
2. 再改为 `15`
Expected:
- 立即启动一个批次
- `chrome.alarms.get('multipage-auto-schedule')` 存在
- side panel 显示下一次触发时间

- [ ] **Step 4: 验证 `15 -> 20` 的更新逻辑**

Run:
1. 当前 schedule 已启用
2. 把 `Interval` 改成 `20`
Expected:
- 不会因为修改而立刻再起一个批次
- 下一次触发时间更新为新周期

- [ ] **Step 5: 验证“有进展则跳过”**

Run:
1. 在一个批次内保持步骤持续推进
2. 等待下一个 alarm 触发
Expected:
- 不会开第二个批次
- 日志显示 `skip scheduled batch because previous batch is still making progress`

- [ ] **Step 6: 验证“无进展则 stale 接管”**

Run:
1. 让批次停在一个不会继续推进的位置
2. 确保一个完整周期内没有新的 `STEP_PROGRESS`
3. 等待下一个 alarm
Expected:
- 旧批次被标记 stale
- 新批次启动
- 旧消息被忽略

- [ ] **Step 7: 验证浏览器/扩展重载后的恢复**

Run:
1. 保持 `Interval = 15`
2. reload 扩展
Expected:
- schedule 配置仍存在
- alarm 恢复
- 不会立即补跑关闭期间错过的批次

- [ ] **Step 8: 检查日志与按钮状态**

Run: 在 side panel 观察状态栏和日志
Expected:
- Auto/Stop 按钮状态合理
- 模式、下一次触发时间、运行状态文案一致
- 无明显重复 toast、无旧批次污染 UI

- [ ] **Step 9: Commit**

```bash
git add assets/mpa4gpt/manifest.json assets/mpa4gpt/background.js assets/mpa4gpt/sidepanel/sidepanel.html assets/mpa4gpt/sidepanel/sidepanel.css assets/mpa4gpt/sidepanel/sidepanel.js assets/mpa4gpt/content/utils.js assets/mpa4gpt/content/signup-page.js assets/mpa4gpt/content/vps-panel.js assets/mpa4gpt/content/duck-mail.js assets/mpa4gpt/content/qq-mail.js assets/mpa4gpt/content/mail-163.js assets/mpa4gpt/content/inbucket-mail.js assets/mpa4gpt/content/icloud.js
git commit -m "feat: add scheduled auto run to mpa4gpt"
```

## 计划自检

### Spec coverage

已覆盖以下设计要求：

- `chrome.alarms` 常驻定时：Task 1, 5, 7
- `Interval(min)=0` 手动模式：Task 5, 9, 10
- `Interval>0` 启用定时：Task 5, 10
- 启用后立即先跑一个批次：Task 5
- 一个周期内跑 `RunCount` 轮：Task 2, 10
- 正数改正数只更新后续周期：Task 5, 10
- 有进展的长批次跳过：Task 6, 10
- 无进展一整个周期判定 stale：Task 6, 10
- `batchId` 隔离旧消息：Task 3, 4
- Header 精简 + 独立运行控制卡片：Task 8
- `Interval` 使用 `step=5`：Task 8, 9, 10
- 浏览器重启恢复 schedule：Task 7, 10

### Placeholder scan

已检查并移除以下占位风险：

- 没有使用 TBD/TODO
- 所有修改步骤都给了明确代码片段
- 所有验证步骤都给了具体操作与预期
- 没有使用“类似 Task N”这类引用式占位

### Type consistency

关键命名统一如下：

- `scheduledRunCount`
- `scheduleIntervalMinutes`
- `scheduleEnabled`
- `scheduleNextRunAt`
- `scheduleLastStartedAt`
- `scheduleLastSkippedAt`
- `currentBatchId`
- `currentBatchLastProgressAt`
- `STEP_PROGRESS`
- `SAVE_SCHEDULE_SETTINGS`
- `SCHEDULE_UPDATED`
- `SCHEDULE_ALARM_NAME = 'multipage-auto-schedule'`

这些名称在各任务中保持一致。
