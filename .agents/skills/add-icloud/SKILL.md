---
name: add-icloud
description: 添加 iCloud 隐私邮箱支持
---

## 需求描述
按现有扩展架构把 iCloud 当作新的 mail provider 接入，分成两部分实现：
1. **邮箱生成**：在 `assets/mpa4gpt/background.js` 增加 `fetchICloudEmail`，从浏览器 cookies 中读取 `X-APPLE*`，按参考 Python 脚本的请求格式调用 iCloud Hide My Email 接口，先 `generate` 再 `reserve`，最后把生成的地址写回扩展状态。
2. **验证码抓取**：新增 `assets/mpa4gpt/content/icloud.js`，在 `https://www.icloud.com.cn/mail/` 页面轮询收件箱，从主题中提取验证码并返回给后台继续填码流程。

为降低改动范围，`Auto` 按钮保持现有入口不变，但后台改成**按 `mailProvider` 分流**：
- 选中 `icloud` 时走 iCloud 生成逻辑。
- 其他 provider 先保持当前 Duck 生成逻辑不变。

## 关键文件
- `assets/mpa4gpt/sidepanel/sidepanel.html`
- `assets/mpa4gpt/background.js`
- `assets/mpa4gpt/content/icloud.js`（新文件）

## 具体改动

### 1. Side panel 增加 iCloud 选项
修改：`assets/mpa4gpt/sidepanel/sidepanel.html`
- 在 `select-mail-provider` 中新增 `icloud` 选项。
- 把 Email 输入框 / Auto 提示文案改成 provider-neutral，不再只写 Duck。

修改：`assets/mpa4gpt/sidepanel/sidepanel.js`
- 保持 `updateMailProviderUI()` 仅控制 Inbucket 专属字段。
- 将 `fetchDuckEmail()` 改为更通用的 provider fetch 流程（函数名可同步改为 `fetchProviderEmail()`，也可以只改内部逻辑）。
- `btn-fetch-email` 点击后，仍向 background 发消息，但由 background 根据 `mailProvider` 决定走 Duck 还是 iCloud。
- `btn-auto-continue`、toast、placeholder 等提示语改成通用邮箱文案。

### 2. Manifest 增加权限与 iCloud content script
修改：`assets/mpa4gpt/manifest.json`
- 在 `permissions` 中新增 `cookies`，以便 background 用 `chrome.cookies` 读取 `X-APPLE*` cookies。
- 在 `content_scripts` 中新增 iCloud 注入配置：
  - 匹配 `https://www.icloud.com.cn/*`（因为承载邮件列表的 iframe URL 不在 `/mail/*` 下）
  - 注入 `content/utils.js` 和 `content/icloud.js`
  - `all_frames: true`
  - `run_at: "document_idle"`

### 3. background 增加 iCloud 邮箱生成
修改：`assets/mpa4gpt/background.js`

#### 3.1 provider-aware 邮箱生成入口
- 保留现有 sidepanel 消息入口，但把 `FETCH_DUCK_EMAIL` 的处理改成按 provider 分流，或新增一个 `FETCH_PROVIDER_EMAIL` 并让 sidepanel 使用它。
- 推荐最小改动：保留消息名，内部根据 `state.mailProvider` 调用：
  - `fetchICloudEmail()`：当 provider 为 `icloud`
  - `fetchDuckEmail()`：其他 provider 继续复用现有逻辑

#### 3.2 新增 `fetchICloudEmail(options)`
实现逻辑参考 Python 脚本：
- 目标接口：
  - `POST https://p68-maildomainws.icloud.com/v1/hme/generate`
  - `POST https://p68-maildomainws.icloud.com/v1/hme/reserve`
  - （可选调试）`GET https://p68-maildomainws.icloud.com/v2/hme/list`
- 查询参数需要包含：
  - `clientBuildNumber`
  - `clientMasteringNumber`
  - `clientId`
  - `dsid`
- 先从浏览器 cookies 中读取 iCloud 域名下全部 cookies，筛出 `X-APPLE*`。
- 用 cookies 补齐：
  - `Cookie` header
  - `clientId` / `dsid` 参数（如果脚本实现依赖 cookie 值）
- 按参考脚本设置请求头，重点包括：
  - `Origin`
  - `Referer`
  - `Content-Type`
  - `Accept`
  - `User-Agent`
  - `Cookie`
- `generate` 请求 body：`{"langCode":"en-us"}`
- 从 `generate` 返回值里取出生成的地址（实现时按实际 JSON 字段名解析）
- `reserve` 请求 body 至少包含：
  - `hme`
  - `label`
  - `note`
- 成功后调用现有 `setEmailState(email)`，并写日志。
- 异常场景给出明确报错：
  - 没有找到 `X-APPLE*` cookies
  - cookie 里缺少必要字段
  - generate/reserve 返回非成功结果

#### 3.3 默认状态与 reset 保持兼容
- 更新 `DEFAULT_STATE.mailProvider` 注释，把 `icloud` 加入支持范围。
- `resetState()` 保持 `mailProvider` 等设置穿透，不需要额外结构性改造。

### 4. Step 4 / Step 7 路由接入 iCloud
修改：`assets/mpa4gpt/background.js`
- 扩展 `getMailConfig(state)`，新增 `icloud` 分支：
  - `source: 'icloud-mail'`
  - `url: 'https://www.icloud.com.cn/mail/'`
  - `label: 'iCloud Mail'`
- `executeStep4()` / `executeStep7()` 不需要改整体流程，只需复用新的 mail config。
- 先沿用现有 sender/subject filters；若调试中发现 iCloud 邮件主题或发件人特征不同，再微调过滤词。

### 5. utils 增加 iCloud source 与 iframe 策略
修改：`assets/mpa4gpt/content/utils.js`
- 在 `SCRIPT_SOURCE` 检测中加入 iCloud 页面，返回 `icloud-mail`。
- 调整底部 READY 上报逻辑：
  - 现有逻辑会屏蔽 mail child frame 的 `CONTENT_SCRIPT_READY`
  - iCloud 主内容在 iframe 内，因此 **不能直接复用现有 child-frame 屏蔽策略**
- 推荐实现：
  - 对 `qq-mail` / `mail-163` / `inbucket-mail` 继续屏蔽 child frame READY
  - 对 `icloud-mail` 允许真正包含邮件 DOM 的 frame 上报 READY

这样 background 的 tab registry 才能把命令发到正确 frame 所在的 tab 上。

### 6. 新增 `content/icloud.js`
新增：`assets/mpa4gpt/content/icloud.js`

实现方式对齐现有 `qq-mail.js` / `inbucket-mail.js`：
- 监听 `POLL_EMAIL`
- 进入轮询前先确认当前 frame 是否包含 iCloud 邮件 DOM
- 打开收件箱：
  - `document.querySelector('.mailbox-list-item').click()`
- 邮件列表元素：
  - 列表项：`.thread-list-item`
  - 时间：`.thread-timestamp`
  - 主题：`.thread-subject`
  - 发件人：`.thread-participants`
- 从主题优先提取验证码，必要时再回退到 sender/time 拼接文本。

建议实现细节：
- 增加 `normalizeText()`、`extractVerificationCode()`，复用现有 provider 的 6 位码提取规则。
- 首次轮询先快照现有列表项，后续优先查找“新邮件”；若多轮后仍无新邮件，再回退到列表中的首个匹配邮件，避免页面已提前打开时漏掉验证码。
- 若 iCloud 列表项没有稳定 id，则用 `subject + sender + timestamp + index` 合成 `mailId`。
- 使用 `chrome.storage.session` 记录 `seenIcloudMailIds`，避免重复取同一封邮件。
- 当抓到验证码后，右击所有符合筛选条件且能提取出验证码的邮件条目，再点击 `aria-label="删除邮件"` 清理这些验证码邮件；返回最终采用的那封邮件对应的 `mailId` 和验证码。
- 删除策略参考 163 的“处理后清理”模式，但 iCloud 采用用户给定的 UI 交互：**右击邮件条目 -> 点击 `aria-label="删除邮件"`**。
- 返回结构保持和现有 provider 一致：`{ ok, code, emailTimestamp, mailId }`。

### 7. reset 中保留 iCloud 去重状态
修改：`assets/mpa4gpt/background.js`
- `resetState()` 需要把 `seenIcloudMailIds` 纳入保留/恢复键集合，和 `seenInbucketMailIds` 一样处理。

## 实施顺序
1. 修改 side panel provider 选项与文案。
2. 修改 manifest：加 `cookies` 权限和 iCloud content script。
3. 在 `background.js` 增加 provider-aware 邮箱生成入口。
4. 实现 `fetchICloudEmail()`：cookies 读取、generate、reserve、状态写回。
5. 扩展 `getMailConfig(state)` 使 step 4/7 能打开 iCloud Mail。
6. 修改 `content/utils.js`，让 iCloud iframe 场景能正确上报 READY。
7. 新增 `content/icloud.js` 完成邮箱轮询与验证码提取。
8. 补上 `resetState()` 对 `seenIcloudMailIds` 的保留。
9. 做端到端验证并回归测试 163 / QQ / Inbucket。

## 验证方案

### A. iCloud 邮箱生成
- 重新加载 unpacked extension。
- 在 Chrome 中先登录 `https://www.icloud.com.cn/mail/`。
- Side panel 选择 `icloud`，点击 `Auto`。
- 预期：
  - background 能读到 `X-APPLE*` cookies
  - 成功调用 iCloud generate/reserve 接口
  - Email 输入框自动填入新地址
  - 日志显示生成成功

### B. iCloud 验证码抓取
- 保持 provider = `icloud`。
- 打开 `https://www.icloud.com.cn/mail/` 并确保邮件界面已加载。
- 触发 step 4 或 step 7。
- 预期：
  - `icloud.js` 能在正确 iframe 中收到 `POLL_EMAIL`
  - 自动进入收件箱并轮询 `.thread-list-item`
  - 从 `.thread-subject` 中提取 6 位验证码
  - background 收到结果并回填到 signup/auth 页面

### C. 全流程联调
- 选择 iCloud provider，运行 Auto。
- 预期：
  - Auto 在取邮箱阶段调用 iCloud 生成逻辑
  - Step 4 能抓到注册验证码
  - Step 7 能抓到登录验证码
  - 不重复使用旧邮件验证码

### D. 回归检查
- Smoke test 现有 `163`、`qq`、`inbucket`：
  - provider 切换与设置保存正常
  - 原有 step 4 / 7 不回归
  - 非 iCloud provider 仍可继续使用当前 Duck 取邮箱逻辑

## 关键注意点
- iCloud 主内容位于 iframe，`CONTENT_SCRIPT_READY` 的 frame 选择是本次改动最关键的兼容点。
- iCloud Hide My Email 接口的参数字段要以参考 Python 脚本和实际 cookies 为准，不要凭空猜字段名。
- 初版优先保证“生成 + 抓码”闭环可用，不额外引入邮件删除等高耦合 UI 操作。
