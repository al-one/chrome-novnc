# mpa4gpt 定时自动运行设计

日期：2026-04-13
状态：已确认设计，待写实现计划

## 背景

当前扩展已经支持两类运行方式：

- 单步执行 1~9 步流程
- 点击 `Auto` 后连续执行多轮完整流程，轮数由 `RunCount` 决定

现状限制：

1. `Auto` 只会立刻连续跑完 `RunCount` 轮，不支持“每隔 N 分钟触发一个批次”
2. 运行配置主要依赖 `chrome.storage.session`，不适合作为浏览器重启后仍可恢复的常驻定时配置
3. 侧边栏 header 已经较拥挤，不适合继续在顶部单行中塞入新的定时输入项

本设计为 `assets/mpa4gpt` 增加常驻定时能力，并重新规划侧边栏上方布局。

## 目标

1. 支持配置 `Interval(min)`，按固定分钟间隔自动触发批次运行
2. 支持配置 `RunCount`，每次触发时执行 `RunCount` 轮完整流程
3. `Interval = 0` 时不启用定时，仅支持手动 `Auto`
4. `Interval > 0` 时启用常驻定时，并在启用后立即先跑一个批次
5. 若上一个批次仍在执行，到下一个触发点时跳过该批次，不排队、不并发、不补跑
6. 定时配置需要持久化，浏览器重启后仍能恢复
7. 侧边栏排版需要在窄宽度下保持清晰，不把新增控件继续塞进 header

## 非目标

1. 不改动 1~9 步本身的业务流程与页面自动化逻辑
2. 不实现“错过批次补跑”
3. 不实现“多批次并发执行”
4. 不新增复杂的调度策略（整点对齐、工作日定时等）
5. 不把 `Stop` 扩展为“关闭未来所有定时”；关闭未来定时仍由 `Interval = 0` 控制

## 用户确认的产品规则

### 运行模型

- `RunCount` 表示单个批次内执行多少轮完整流程
- `Interval(min)` 表示每隔多少分钟触发一个新批次
- 用户期望的是：
  - 在一个 N 分钟周期内执行 `RunCount` 轮
  - 到下一个 N 分钟周期时，再执行 `RunCount` 轮

### 定时启停

- `Interval = 0`：不启用定时，需要手动点击 `Auto`
- `Interval > 0`：启用定时
- 从 `0 -> 正数`：启用定时；若当前空闲，则立即先跑一个批次
- 从 `正数 -> 另一个正数`：只更新后续周期，不额外立即触发批次
- 从 `正数 -> 0`：关闭未来调度，但不终止当前批次

### 重叠与卡住策略

- 当新的周期已到时，不再只看“上一个批次是否还没结束”，而是区分“仍有进展”和“已无进展”
- 如果上一个批次在最近一个完整周期内仍有进展：
  - 直接跳过本周期
  - 记录日志
  - 不排队、不并发、不补跑
- 如果上一个批次在最近一个完整周期内完全没有进展：
  - 判定为 `stale`
  - 放弃旧批次
  - 由新周期接管并启动新批次
- 该规则是通用卡住判定，不只针对 `waiting_email` 这一个等待点

### 持久化

- 定时配置需要在浏览器重启后仍然保留并恢复

### 首次触发

- 启用定时后，立即先跑一个批次

### Interval 输入约束

- 使用 `input[type=number]` 的原生限制
- `step = 5`
- `min = 0`
- 合法值示例：`0 / 5 / 10 / 15 / 20 ...`
- 非法步长值不保存为有效配置

## 设计总览

整体采用两层结构：

1. **批次执行层**：继续负责“执行一整个批次”，即连续跑 `RunCount` 轮完整流程
2. **调度层**：使用 `chrome.alarms` 每隔 N 分钟触发一次批次执行

手动 `Auto` 和定时 alarm 共用同一个批次入口，避免分叉出两套相似逻辑。

## UI 设计

### 总体布局调整

当前 header 中包含标题、主题切换、重置、`RunCount`、`Auto`、`Stop`，在侧边栏宽度下已经偏拥挤。

调整后采用 **方案 A：Header 精简 + 独立运行控制卡片**。

### Header

Header 仅保留：

- 标题 `MultiPage`
- `Reset`
- 主题切换

从 header 移除：

- `RunCount`
- `Auto`
- `Stop`

### 新增运行控制卡片

在 `header` 与当前数据卡片之间新增一张“运行控制卡片”，分为两层。

#### 第一层：状态 + 操作

左侧展示运行状态：

- `Manual`
- 或 `Scheduled every 15 min`

可附加辅助信息：

- `Next: 14:30`
- `State: Idle / Running batch / Skipped this slot`

右侧放两个动作按钮：

- `Auto`：立即执行一个批次
- `Stop`：停止当前正在执行的批次

#### 第二层：配置输入

两个输入框并排显示：

- `RunCount`
- `Interval(min)`

在 `Interval(min)` 附近增加短提示：

- `0 = manual only`

### UI 语义约束

- `Auto` 永远表示“马上执行一个批次”
- `Stop` 永远表示“停止当前批次”
- `Interval(min)` 决定未来是否自动调度：
  - `0`：未来不自动运行
  - `>0`：未来按周期自动运行

### 视觉与样式方向

沿用当前 sidepanel 的视觉风格：

- 使用现有卡片体系、圆角、边框、阴影变量
- 运行控制卡片与数据卡片同层级但可稍加强调状态区
- 保持窄侧边栏下单列可读性，不引入复杂响应式布局

## 数据设计

### 持久化配置：`chrome.storage.local`

新增并迁移以下配置到 `chrome.storage.local`：

- `scheduledRunCount: number`
- `scheduleIntervalMinutes: number`
- `scheduleEnabled: boolean`
- `scheduleNextRunAt: number | null`
- `scheduleLastStartedAt: number | null`
- `scheduleLastSkippedAt: number | null`

说明：

- `RunCount` 需要持久化，因此也不再只依赖当前输入框瞬时值
- `scheduleEnabled` 在语义上可由 `interval > 0` 推导，但保留独立字段可让 UI 和恢复逻辑更直接

### 会话运行态：`chrome.storage.session`

继续保留现有流程运行态：

- `autoRunning`
- `currentStep`
- `stepStatuses`
- `oauthUrl`
- `email`
- `password`
- `localhostUrl`
- `accounts`
- `logs`
- 等现有字段

会话运行态仍只描述“当前或最近一次批次执行过程”，不承担长期调度配置职责。

### 内存态

继续保留 service worker 内存变量，例如：

- `autoRunActive`
- `autoRunCurrentRun`
- `autoRunTotalRuns`
- `currentBatchId`
- `currentBatchStartedAt`
- `currentBatchLastProgressAt`
- `currentBatchStatus`
- `currentBatchTrigger`

这些变量只作为当前 worker 生命周期内的快速控制状态；配置真值仍以 storage 为准。

### 进展判定字段

为了做“通用卡住判定”，批次需要记录进展时间：

- `currentBatchLastProgressAt`：最近一次明确业务进展的时间戳

“进展”指的是流程向前推进，而不是单纯代码仍活着。例如：

- 进入新 step
- step 完成
- 成功拿到邮箱
- 成功拿到验证码
- waiting 状态恢复后继续推进
- 其他能证明流程确实向前移动的事件

注意：

- heartbeat / 轮询存活信号不算业务进展
- stale 判定必须基于 `lastProgressAt`，而不是“线程还活着”

## 后台调度架构

### manifest 权限调整

在 `manifest.json` 中新增：

- `alarms`

用于创建和恢复周期任务。

### 批次执行器

把现有 `autoRunLoop(totalRuns)` 收敛为统一批次入口，例如概念上变为：

- `startAutoBatch({ totalRuns, trigger })`

其中：

- `totalRuns`：当前批次应执行的轮数，来源于持久化 `scheduledRunCount`
- `trigger`：`manual` 或 `schedule`

要求：

1. 手动 `Auto` 与 alarm 触发都走同一入口
2. 若已有批次在跑，则拒绝启动新的批次
3. 批次内仍沿用现有步骤编排逻辑，依次执行 Step 1 ~ Step 9

### 调度层

新增固定 alarm 名称，例如：

- `multipage-auto-schedule`

调度规则：

1. `Interval > 0`：创建或更新 alarm
2. `Interval = 0`：删除 alarm
3. alarm 到点后：
   - 若当前没有批次在跑，启动一个新的批次
   - 若当前批次在最近一个完整周期内仍有进展，跳过本周期
   - 若当前批次在最近一个完整周期内完全没有进展，判定旧批次为 `stale`，由新周期接管并启动新批次

### 启用定时

当用户把 `Interval` 从 `0` 改为正数时：

1. 保存新配置到 `storage.local`
2. 创建/更新 alarm
3. 如果当前空闲：立即启动一个批次
4. 如果当前已有批次在跑：只启用后续调度，不插队、不额外启动批次

### 修改定时间隔

当用户把 `Interval` 从一个正数改为另一个正数时：

1. 保存新配置到 `storage.local`
2. 重建 alarm
3. 更新 `scheduleNextRunAt`
4. 不立即执行一个新批次

### 关闭定时

当用户把 `Interval` 从正数改为 `0` 时：

1. 保存配置为手动模式
2. 删除 alarm
3. 清空 `scheduleNextRunAt`
4. 不终止当前批次

### 浏览器重启恢复

新增初始化逻辑，例如：

- worker 启动时读取 `storage.local`
- 在 `runtime.onStartup` / `runtime.onInstalled` / worker 初始化时调用恢复函数

恢复规则：

1. 如果 `scheduleEnabled && scheduleIntervalMinutes > 0`
   - 重新创建 alarm
   - 重新计算并写入 `scheduleNextRunAt`
2. 不补跑浏览器关闭期间错过的批次
3. 恢复后按新的 alarm 节奏继续

## 侧边栏数据流设计

### 初始化恢复

侧边栏打开时，不仅恢复会话运行态，还要恢复持久化调度配置：

- `scheduledRunCount`
- `scheduleIntervalMinutes`
- `scheduleEnabled`
- `scheduleNextRunAt`
- `scheduleLastStartedAt`
- `scheduleLastSkippedAt`

UI 展示所需状态由后台统一返回，避免前端分别直读 `session/local` 再自行拼装。

### 建议的后台消息

在保留现有消息风格的前提下，新增或扩展以下消息：

- `GET_STATE`
  - 返回 UI 所需的合并状态：运行态 + 调度配置 + 展示字段
- `SAVE_SCHEDULE_SETTINGS`
  - 保存 `RunCount` 与 `Interval`
  - 根据变更内容决定是否创建/更新/删除 alarm
- `AUTO_RUN`
  - 保留为“手动立即执行一个批次”
- `AUTO_RUN_STATUS`
  - 扩展 payload，增加 `trigger`、`nextRunAt`
- `SCHEDULE_UPDATED`
  - 当调度配置变化时广播到侧边栏，用于局部刷新

### UI 刷新来源

侧边栏依赖两种来源刷新：

1. 初次打开时，通过 `GET_STATE` 恢复完整状态
2. 运行中，通过广播消息增量更新：
   - `STEP_STATUS_CHANGED`
   - `AUTO_RUN_STATUS`
   - `SCHEDULE_UPDATED`
   - `LOG_ENTRY`

## 关键行为定义

### 手动 Auto

- 点击 `Auto` 时，启动一个批次
- 使用当前持久化的 `RunCount`
- 若当前已有批次在跑：
  - 不启动第二个批次
  - 给出 toast / 日志提示，例如“Batch already running”

### Stop

- 只停止当前批次
- 不自动关闭未来定时
- 如果用户要彻底关闭未来定时，必须把 `Interval` 改为 `0`

### 定时重叠与 stale 接管

当 alarm 到点且当前已有批次在跑时：

1. 读取 `currentBatchLastProgressAt`
2. 若在最近一个完整周期内有进展：
   - 本周期跳过
   - 写日志：`skip scheduled batch because previous batch is still making progress`
   - 更新 `scheduleLastSkippedAt`
3. 若在最近一个完整周期内完全没有进展：
   - 把旧批次标记为 `stale`
   - 清理旧批次的 waiter / pending command / waiting UI
   - 写日志：`previous batch marked stale and replaced by scheduled batch`
   - 启动新批次

### batchId 隔离

为了避免被放弃的旧批次在稍后返回消息污染新批次，需要为每个批次分配唯一 `batchId`。

规则：

- 启动批次时生成新的 `batchId`
- 后台只接受当前活动 `batchId` 的进度、完成、失败消息
- 旧批次被替换后，即使稍后又返回消息，也必须忽略

### 非法输入

- `RunCount`：沿用原数字输入限制
- `Interval(min)`：使用 `type=number + min=0 + step=5`
- 只有合法值才触发保存与调度更新
- 输入处于原生非法状态时，不更新有效配置

## 代码改动范围

### `manifest.json`

- 新增 `alarms` 权限

### `sidepanel/sidepanel.html`

- 精简 header
- 移除 header 内现有 `run-group`
- 新增“运行控制卡片”
- 新增 `Interval(min)` 输入
- 增加定时状态展示区域

### `sidepanel/sidepanel.css`

- 新增运行控制卡片布局样式
- 为窄宽度侧边栏优化两列输入和状态区排版
- 删除或收缩旧 header `run-group` 相关样式

### `sidepanel/sidepanel.js`

- 恢复持久化调度配置
- 监听 `RunCount` 与 `Interval(min)` 变更
- 发送调度保存消息
- 响应 `SCHEDULE_UPDATED` / 扩展后的 `AUTO_RUN_STATUS`
- 更新运行模式、下一次触发时间、状态文案

### `background.js`

- 新增 `chrome.alarms` 调度逻辑
- 新增本地持久化配置读写逻辑
- 改造 `AUTO_RUN` 为统一批次执行入口
- 增加 schedule 恢复、更新、删除逻辑
- 维护 `nextRunAt / lastStartedAt / lastSkippedAt`
- 扩展 `GET_STATE` 返回结构

## 错误处理

### 调度保存失败

- 若保存到 `storage.local` 或创建 alarm 失败：
  - 记录 error 日志
  - 侧边栏显示 toast
  - 保持旧配置不变

### alarm 触发失败

- 若 alarm 触发后启动批次失败：
  - 记录错误日志
  - 不崩溃，不关闭后续定时
  - 下一周期继续尝试

### worker 重启后的状态不一致

- 若内存态为空但 `storage.local` 表示 schedule 已启用：
  - 以 `storage.local` 为准恢复 alarm
- 若当前没有运行中的批次：
  - UI 视为 `Idle`

### 通用卡住场景

该方案需要覆盖的不只是 `waiting_email`，还包括：

- 等元素时长期无结果
- 邮件轮询长期无新结果
- 页面结构变化导致逻辑挂起但未明确失败
- 某个 waiter / resume 长时间不返回
- debugger 点击后迟迟没有后续推进
- 其他“代码仍活着，但流程一个周期都没有推进”的情况

因此 stale 判定只看“一个完整周期内是否有业务进展”，不依赖具体卡在哪个点。

## 测试方案

### UI / 配置恢复

1. `Interval=0` 时显示 `Manual`
2. `Interval=15` 时显示 `Scheduled every 15 min`
3. 修改 `RunCount` 后关闭再打开侧边栏，值仍能恢复
4. 修改 `Interval` 后关闭再打开侧边栏，值仍能恢复
5. `Interval` 输入框具备 `step=5` 和 `min=0`

### 调度行为

1. `0 -> 15`
   - 立即触发一个批次
   - 生成下一次触发时间
2. `15 -> 20`
   - 不立即触发新批次
   - 后续按 20 分钟周期运行
3. `15 -> 0`
   - 删除 future schedule
   - 当前批次继续
4. 浏览器重启后
   - 定时配置恢复
   - 不补跑错过批次

### 重叠 / 跳过 / stale 接管

1. 人为让某个批次执行时间超过一个周期，但期间仍持续有进展
2. 等待下一个 alarm 触发
3. 验证：
   - 没有启动第二个批次
   - 写入 skip 日志
   - `lastSkippedAt` 更新

4. 人为制造“一个完整周期内无任何进展”的卡住场景
5. 等待下一个 alarm 触发
6. 验证：
   - 旧批次被标记为 `stale`
   - 新批次接管启动
   - 旧批次迟到消息不会污染新批次状态

### 手动与定时共存

1. 定时启用且当前空闲时点击 `Auto`
   - 允许立即启动一个批次
2. 当前已有批次在跑时再次点击 `Auto`
   - 不应并发启动第二个批次
   - 应给出提示
3. 定时批次运行中点 `Stop`
   - 当前批次停止
   - 未来定时仍保持启用

## 实施建议

实现时优先保证两点：

1. **只有一个批次执行入口**，避免手动与定时逻辑分叉
2. **调度配置与运行态分层**，避免 `storage.session` 和 `storage.local` 互相污染职责

建议先完成后台调度和存储分层，再接入 sidepanel 新布局与状态展示。

## 结论

本方案通过：

- `chrome.alarms` 负责常驻定时
- `chrome.storage.local` 负责持久化定时配置
- 统一批次执行入口负责手动与定时共用流程
- Header 精简 + 独立运行控制卡片负责侧边栏可用性

在不改动原有 1~9 步核心自动化逻辑的前提下，为 `mpa4gpt` 增加可恢复的常驻定时自动运行能力。