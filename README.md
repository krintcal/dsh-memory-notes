# dsh-memory-notes

Hermes 式长期记忆的 DSH Host 插件。它给模型一个 `memory` 工具，并把分层记忆块作为**运行时上下文消息**注入（内容变化时在对话尾部追加新消息，本会话内写入下一轮即可见）。

## 它做什么

- 五条纯文本记忆轨，条目之间用单独一行 `§` 分隔：
  - `MEMORY.md` —— 模型自己的笔记；
  - `USER.md` —— 用户画像 / 偏好 / 期望；
  - `projects/<hash>/KEY.md` —— 按 git 分支过滤的项目要点；
  - `projects/<hash>/PROJECT.md` —— 项目进展日志（不注入快照）；
  - `daily/<YYYY-MM-DD>.md` —— 当天小结（不注入快照）。
- 配额按字符计：`memory` / `user` / `key` / `project` / `daily` 默认 2200 / 1375 / 2200 / 8000 / 6000，含分隔符。超限直接拒绝写入，绝不截断。
- `memory` 工具支持 `add` / `patch` / `remove` / `suggest`，或用 `operations` 数组做原子批处理（配额只按最终结果校验，所以可以先删后加）。`patch` 只替换条目内的一个 span，条目其余保留；整条重写就把整条放进 `old_text`。
- 记忆块通过 `ctx.systemPrompt.context()` 注入：每个 step 现算，**内容变化时**宿主在对话尾部追加一条新的 user-role 消息；同样的数据会生成逐字节相同的文本，所以前缀缓存保持稳定。
- 0.4.0 起带一个**左侧栏「记忆」面板**：看记忆库的条目与配额、就地改写/删除/新增条目、批准后台 review 排队中的破坏性写入、采纳/丢弃回顾建议。
- 0.7.0 起改为**回合内自审**：每 `nudgeInterval` 轮在快照里提示模型自己完成回顾，写完后调用 `memory_review_status complete` 结算；不再启动 fork 子代理。

## 安装

```bash
dsh plugin add <本仓库路径>
```

`cordis.patch.yml` 会把插件插入为 `memory-notes`，配置为空对象即可。

### 改代码后必须同步

`file:` 依赖会被 pnpm **复制**进 profile 的 `node_modules/dsh-memory-notes`（部分文件是硬链接、部分不是）。仓库改了代码而没同步，宿主读到的仍是旧副本，表现为「插件静默不激活」：

```bash
node scripts/sync-to-profile.mjs   # 或 npm run sync
```

然后重启 DSH。判断是否踩了这个坑：`cordis.patch.yml` 的插入行必须写裸包名 `dsh-memory-notes`（绝对 `file://` 路径也能加载，但那是绕过 npm 的调试写法）。

## 配置（全部可选）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dir` | `$DSH_PROFILE_DIR/memories` → `$DSH_MEMORY_DIR` → `$DSH_HOME/memories` → `~/.dsh/memories` | 记忆目录 |
| `profileScoped` | `true` | 有 profile 环境变量时，记忆落在 profile 目录（`DSH_PROFILE_DIR/memories` 或 `DSH_HOME/profiles/<DSH_PROFILE>/memories`） |
| `memoryCharLimit` | `2200` | `MEMORY.md` 配额 |
| `userCharLimit` | `1375` | `USER.md` 配额 |
| `keyCharLimit` | `2200` | `KEY.md` 配额 |
| `projectLogCharLimit` | `8000` | `PROJECT.md` 配额 |
| `dailyLogCharLimit` | `6000` | `daily/<date>.md` 配额 |
| `layeredTargets` | `true` | 关掉后 `memory` 工具只保留 `memory` / `user` 两轨（0.6.0 行为） |
| `nudgeInterval` | `10` | 每多少个用户回合提示一次回顾（旧键名，仍生效） |
| `reviewInterval` | — | 若提供则覆盖 `nudgeInterval` |
| `reviewMode` | `'suggest'` | 回顾写入走建议队列（`suggest`）还是直接写（`auto`） |
| `snapshotOrder` | `9000` | 记忆 context 的注册顺序 |
| `reviewEnabled` | `true` | 关掉回合内回顾与 `memory_review_status` 工具 |
| `memoryEnabled` | `true` | 兼容旧配置；回顾提示里是否强调记忆（0.7.0 主要影响提示文案） |
| `reviewPrompt` | — | 覆盖技能 review 的提示词全文（供外部 review 使用） |
| `provider` | `fork` | **deprecated（0.7.0）**：review 不再启动子代理，仅 curator 合并时使用 |
| `noticeMode` | `'on'` | 回顾完成后的主会话提示：`on` / `verbose`（附 3 条预览）/ `off` |
| `approvalMode` | `'ask'` | 破坏性写入的审批策略：`ask`（`ctx.approval`）/ `stage`（直接排队）/ `auto`（直接写） |
| `skillsDir` | `$DSH_SKILLS_DIR` → `~/.agents/skills` | `skill_manage` 写技能的位置 |
| `skillsEnabled` | `true` | 关掉 `skill_manage` 工具 |
| `curatorEnabled` | `true` | 关掉 curator |
| `curatorIntervalHours` | `168` | 两次整理之间至少隔多久 |
| `curatorStaleAfterDays` | `14` | 多久没动标记 stale |
| `curatorArchiveAfterDays` | `30` | 多久没动归档 |
| `curatorKeepSnapshots` | `5` | 保留几份快照 |
| `curatorPaused` | `false` | 暂停整理 |
| `curatorConsolidate` | `'off'` | `suggest` 时在出现 stale 技能后起 fork，把记忆合并建议以 `stage` 提交 |
| `threatScan` | `true` | 写入口的提示注入粗筛；关掉后不再拒绝疑似注入的内容 |
| `strictReadBeforeWrite` | `true` | 技能写入前必须读过、且读后文件未变 |
| `pendingDir` | `<dir>/pending` | 后台 review 的破坏性写入排队目录 |
| `webPanelEnabled` | `true` | 关掉左侧栏面板与 `/api/dsh-memory-notes/*` 路由 |
| `entryCharLimit` | `200` | 单条 add 的字符上限（0 = 关闭）；超长条目提示拆成一条一事实 |
| `logEntryCharLimit` | `600` | `project`/`daily` 日志轨的单条上限（0 = 关闭）；日志轨不受近似/预算门约束 |
| `addSimilarityLimit` | `0.75` | 单条 add 与既有条目相似度达到该值就拒绝（0 = 关闭），提示用 patch 合并 |
| `budgetGatePercent` | `85` | 单条 add 会让占用超过该百分比时拒绝，要求用一个 batch 先腾空间（0 = 关闭） |
| `searchEnabled` | `true` | 启用 `memory` 工具的 `action:'search'`（跨五轨只读检索；0.11.0 起合并，独立 `memory_search` 工具已删） |

## 0.2.0：两道安全门

抄 Hermes 的 `memory_tool.py`（stage_write / background_delete_gate）与 `skill_manager_guards.py`
（read-before-write），因为这两类错误都是「悄悄写坏、事后难查」：

1. **技能写入必须先读**：`patch` / `delete` / `write_file` 之前必须 `action=read` 过同一技能，
   且读完之后文件没被改过（比对 sha256）。没读过 → `read the skill first`；读过但内容变了 →
   `changed on disk since you read it`。`strictReadBeforeWrite: false` 可关。
2. **后台 review 不能直接改已有条目**：review fork 里 `add` 照常直写，但 `patch` / `remove`（含 batch
   里出现这两种）会被自动转成 stage 提案，记录落在 `pendingDir`，由主会话 `list_pending` 看完再
   `apply_pending` 落盘。排队期间磁盘完全不变。

## 0.3.0：对齐 Hermes Agent 0.22.5

对标上游 `tools/memory_tool.py` / `memory_tool_store.py` 的语义变更：

- **`replace` 从模型面下线**：模型调用会拿到「use 'patch'」的报错；`patch` 用 `old_text` 精确定位条目内
  的 span 并只替换它（span 在条目内必须唯一，否则报「appears N times … include more surrounding text」），
  条目其余保留，成功时额外返回 `patched_entry_before/after`。`replace` 只保留给 0.2.0 的旧 pending 记录重放。
- **错误语义对齐**：超限文案区分 add / patch / replace 三种、batch 错误带 `Operation N (action)` 前缀、
  `No entry matched` 附带 `closest_entries`、多命中附 `matches`（每条截 80 字符）。
- **staged 写入带 pin**：stage 时把命中的**完整条目**记进 `matched_entry`，批准时按它精确定位——审阅期间
  条目变了就报 `changed since it was staged` 并保留记录；0.2.0 之前没有 pin 的旧记录会被拒绝重放。
- **pending 队列补齐**：`list_pending` / `apply_pending` / 新增 `discard_pending`（对应上游 `/memory pending`
  的 approve/discard）；batch 也能整批 stage 后一次批准。
- **review 提示词对齐** `agent/background_review.py`：默认用合并版（Memory 双库路由 + Skills「Be ACTIVE」），
  文案、偏好序、read-before-write 要求、不该捕获清单都按上游移植；工具名换成本插件的 `memory` / `skill_manage`。

## 0.4.0：左侧栏记忆面板

宿主半边与客户端半边都自带，装完插件重启 DSH，左侧栏（技能中心那一排）会多一个「记忆」入口。

- **宿主** `src/web.js`：注册三条只走回环的 JSON 路由
  - `GET /api/dsh-memory-notes/state` —— 两个库的条目、用量、百分比，以及排队中的 pending 提案；
  - `POST /api/dsh-memory-notes/write` —— `{target, action: add|patch|remove, old_text?, content?}`，直接走 `MemoryStore`，成功回带最新 state；
  - `POST /api/dsh-memory-notes/pending` —— `{id, decision: 'apply'|'discard'}`，批准时按 stage 时 pin 的 `matched_entry` 重放，条目变过就拒绝且保留记录。
  守卫：只接受回环来源（拒绝 `x-forwarded-for` / 跨站 `sec-fetch-site` / 外站 origin），请求体上限 1 MiB，写失败回 `{ok:false, error}`。
- **客户端** `client.js`：`window.__ModuleLoader__.load` 格式的 bundle（`dsh.client.platform: "web"`），注册
  `sidebar.panellist`（图标 + 文案「记忆」）与 `main` 面板页；页面用文档相对路径 `api/dsh-memory-notes/*` 取数，
  所以子路径部署也正常。面板里能直接看到「记忆块作为运行时上下文消息注入，本会话内写入下一轮即可见」的提示。
- **共用 pending 队列** `src/pending.js`：`memory` 工具的三个 pending 动作与面板共用同一批 `<dir>/pending/*.json`，
  抽出后 `tool.js` 不再各自实现一份。
- 面板写入与工具调用完全同语义（同一 `MemoryStore` 方法、同一超限/歧义/stale 错误文案），区别只是入口是 GUI。

## 0.4.1

- **写入校验补全**：`patch`、`replace` 与 batch 里的写入现在和 `add` 共用同一道 `§` 校验；内容里出现 `§` 直接抛 `MemoryError`，整批拒绝且不落盘，避免一条记忆被静默拆成多条。
- **路由随插件卸载回收**：`registerWebPanel` 改用 `webCtx.effect(...)` 注册三条路由，cleanup 里逐个调用 `webServer.register` 返回的 disposer；拿不到 `webServer` 或没有 `register` 时保持静默。
- **POST 强制 JSON**：`/write` 与 `/pending` 要求 `content-type` 以 `application/json` 开头（大小写不敏感，允许 `; charset=utf-8`），否则返回 415；GET 不校验。
- **客户端依赖瘦身**：去掉 `@deepseek-ai/dsh-client-ui-layout`（面板只用 `slots`），同时删掉 layout 的空订阅。
- **面板自动刷新**：打开期间每 10 秒轮询一次，并在窗口 `focus` / 标签页重新可见时刷新；自动刷新失败静默丢弃，不覆盖界面。
- **drop 失败可感知**：pending 的 `drop()` 返回 boolean；apply / discard 成功后若文件没删掉，响应带 `drop_failed: true`。

## 0.5.0：会话流里的记忆提示

Hermes 的终端会打印 `💾 Memory updated`；DSH 的等价面是**每次工具调用那一行**。0.5.0 用客户端的
per-tool presentation slot（`tool.call.toolview`，按工具名 keyed 替换默认行）把 `memory` 与
`skill_manage` 的调用渲染成一行提示：

- `memory`：运行中显示「正在记住一条新记忆 / 正在修改…」，完成后显示
  「已记住 / 已更新一条记忆 / 已删除一条记忆 / 已批量更新 N 条」并带目标库与配额（`MEMORY 82% — 1,800/2,200 chars`）；
  `patch` 显示 `old → new` 摘要；后台 review 转 stage 的写入显示「记忆修改已提交，等待确认」；
  `list_pending` / `apply_pending` / `discard_pending` 各有对应文案；失败显示红字原因。
- `skill_manage`：`create` / `patch` / `delete` / `write_file` / `read` / `list` 显示「已创建技能 · <name>」这类提示。
- 点行（`详情` / `收起`）展开完整动作、原片段、写入内容与结果 JSON（截断 1600 字符）。
- 组件只读 `block`（运行中 `{phase, args, argsRaw}`；已结束 `{kind, call:{argsRaw}, args, content, isError, error}`），
  不做任何写入；结果 JSON 从 `content` 的 text block 解析，解析不出就只显示标题。
- 注册走 `ctx.slots.inject("tool.call.toolview", …)`，和面板一起在 `ctx.effect` 的 cleanup 里逐个 dispose。

## 0.6.0：review 可见、审批、profile 隔离与写入账本

### Phase 1：review 完成后的主会话提示

后台 review 跑完后，`src/nudge.js` 会给主会话补一条 user 角色的 `notice` 上下文
（不是 developer 消息，见 0.9.1 的说明），并在面板里留一条记录：

- `noticeMode: 'on'`（默认）显示「记忆已更新」与两库计数，例如
  `MEMORY +1 ~0 -0 · USER +0 ~0 -0`；
- `noticeMode: 'verbose'` 额外附最多 3 条变更预览（`+` 新增 / `-` 删除 / `~` 修改）；
- `noticeMode: 'off'` 只记账本，不打扰主会话。
- 提示优先走工具上下文的 `exec.deferContext`（随 `memory_review_status` 的结果进入下一步，
  客户端折叠成一行 notice）；宿主没给 `deferContext` 时退回 `agent.inject`。
- 消息形状：`{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'memory-review', form: 'notice', summary } }`，
  显式字段避免命中 `createDeveloperMessage` / 旧版 developer 路径。
- 投递失败只 `console.warn`，不影响 review 结果与账本。
- 账本 `<dir>/review-log.json` 保留最近 50 条（`src/review-log.js`），记录 child/session id、
  channel（`review` / `curator`）、两库 before/after 与 `summary`。

### Phase 2：破坏性写入接入 `ctx.approval`

`memory` 的 `patch` / `replace` / `remove` 以及含破坏性操作的 batch，在 `approvalMode: 'ask'`
（默认）且宿主提供 `ctx.approval` 时会先请求审批：

- `allowed-once` 放行；`rejected` / `cancelled` 不写盘并返回拒绝文案；
- `effectivePolicy === 'never'` 时跳过审批直接写；
- 审批服务缺失或 `request` 抛错时降级为 stage（写入 `/pending`），绝不隐式落盘；
- `approvalMode: 'stage'` 直接排队，`approvalMode: 'auto'` 直接写；
- 后台 review（`unattended`）的破坏性写入始终转 stage，`add` 仍直写。
- 纯 `add` 不触发审批。

### Phase 3：profile 隔离与提示词补全

- `profileScoped: true`（默认）且存在 `DSH_PROFILE_DIR` 时，记忆目录为
  `DSH_PROFILE_DIR/memories`；只有 `DSH_PROFILE` 时为 `DSH_HOME/profiles/<profile>/memories`；
  显式配置的 `dir` 永远优先。
- 首次在 profile 路径启动时，若 profile 目录还没有记忆，会把旧版共享目录里的
  `MEMORY.md` / `USER.md` 复制过去（只复制，不删除旧文件）。
- `MEMORY_TASK` 与工具说明补上 `session_search`，明确「跨会话历史查找」是 review 的合法输入。

### Phase 4：写入账本、撤销、重复检测与 curator 建议制

- **写入日志** `<dir>/write-log.jsonl`（`src/write-log.js`）：每次落盘记一条
  `{ ts, action, target, before, after, source, batch }`，最多 200 行；`source` 来自
  `store.lastSource`（`tool` / `review` / `panel`；curator 的合并建议先 stage，用户在面板应用时记 `panel`）。
  写日志失败不影响真实写入。
- **面板撤销**：左侧栏「最近变更」对单条 `add` / `remove` / `patch` / `replace` 提供撤销按钮，
  分别映射为 `remove` / `add` / `patch`；batch 操作显示「批量操作不可撤销」。
- **重复检测** `similarity()`：按 Unicode 字母数字分词后算 Jaccard，阈值 `0.6`。`add` / `patch`
  命中近似条目时在结果里附 `warnings`，但**照常写入**，不替代确定性的重复拦截。
- **curator 建议制** `curatorConsolidate: 'suggest'`：curator 发现有 stale 技能后起一个 fork，
  要求它把「可合并/可删除」的建议以 `stage` 动作提交，而不是直接改写技能库；
  默认 `'off'`，与 Hermes 的保守默认一致。

## 0.13.0：记忆面板重设计（标签页 + 行内编辑）

面板原来是一条长滚动：五个库各占一张卡，每张卡都有标题、说明、进度条、条目和添加框，下面再堆待确认、建议、回顾、变更、疑似重复、同步六块。条目多时一屏放不下，重要的「待确认」反而被压在下面。这次按「先减结构，再减视觉」重做：

- **一条轨一个标签页**：记忆 / 用户 / 关键 / 项目日志 / 每日，标签上带条数。一次只显示当前轨，页面高度不再随库数量线性增长。
- **条目行内编辑**：默认是两行截断的紧凑条目（右侧「编辑」按钮，点文本也能进编辑）；进入编辑后才是 textarea + 保存 / 取消 / 删除，删除仍要二次确认（3 秒后自动还原）。
- **活动区收进「更多」**：待确认仍在页面主体（有待确认时才出现）；建议、最近 review、最近变更、疑似重复、同步合并收进 `<details>`，标题行显示各自条数，空区块不渲染（只保留同步入口）。
- **用量行压缩**：每条轨只有一行「N 条 · 百分比」+ 一条 3px 进度条；完整字符数放在 title 悬停提示里。
- **视觉收敛**：去掉多层卡片嵌套（活动区里的分区不再带边框），面板内容最大宽度 780px 居中，标题 15px/600，正文 13px，行高 1.5；空轨显示「还没有条目。」。

截图（临时 profile 上跑真实 GUI 抓的）：见 `docs/panel-0.13.0.png`。

## 0.12.0：记忆入口前置（输入框 dock + 侧栏徽标）

记忆不再只藏在左侧栏里：入口挪到输入框正下方，输入 `/memory` 就能看到提示。

- **输入框 dock**（`conversation.composer.dock`）：常驻一行「🧠 记忆」，每 20 秒拉一次
  `state`（窗口重新获得焦点时也拉），有待确认改动时显示红色「· 待确认 N」；点「打开面板」
  直接跳到记忆面板。
- **命令提示**：输入以 `/memory` 或 `/记忆` 开头时，dock 追加「· 命令：打开面板 / 清空输入」，
  并出现「清空输入」按钮（走 `inputActions.clear`，没有就退回 `setText('')`）。
- **侧栏徽标**（`sidebar.toggle.badge`）：侧栏折叠时，展开按钮里用红点提示还有待确认的记忆。
- **回顾提示文案**：`reviewNoticeText` 改为指向输入框上方的新入口。

DSH 未提供插件级命令注册面，这是目前能做到的最接近形态。

修过的坑（0.12.3）：pending 记录会 pin 住提案那一刻的完整条目，条目后来变了就永远应用不了（stale）。以前面板照样显示「批准」，点了只在服务端失败、前端把错误吞掉，看起来就是「点不动」。现在后端在 `/state` 里直接给每条 pending 打 `stale` + `stale_reason`，面板把这类记录标成「已过期」、禁用「批准」、只留「丢弃」，并在条目下方显示原因；失败提示也贴在按钮旁边而不是只出现在面板顶部。

修过的坑（0.12.2）：`sidebar.toggle.badge` 是 single slot 且被宿主占用（`replaceRisk: shadows-shipped-ui`），注册它会在浏览器里抛 `single slot "sidebar.toggle.badge" already has a registration`，把整个 apply 打断——dock 可能整个不出现。已不再注册徽标（待确认数量显示在 dock 上），并把 dock 的 register 回调包了 try/catch。

修过的坑（0.12.1）：`layout` 服务是面板跳转的前提。原来的 apply 里 `ctx.get('layout')` 取一次就把结果缓存了，若 layout 尚未就绪就会永久是 null——「打开面板」点了没反应。现在 client bundle 的 `inject` 声明了 `layout`（`dsh.client.inject` 也加回 `@deepseek-ai/dsh-client-ui-layout`），并且点击时还会懒解析一次；缺 layout 时按钮只 console.warn，不抛错。

## 0.11.0：工具面减法、日志轨与快照稳定

两件事：**上下文成本**和**日志写不进去**。

- **T1 回顾计数器移出快照**（`src/snapshot.js`）：`记忆回顾 N/10 轮` 里的计数每轮都变，
  而 DSH 只在渲染文本变化时追加一条 user-role 消息 —— 结果每轮白追加一整块快照（还废掉
  前缀缓存）。现在未到点**完全不输出**这一行，到点输出固定文案（不含计数）。
- **T2 检索合并进 `memory`**：`memory_search` 独立工具下线，改为 `memory` 的
  `action:'search'`（参数 `query` / `target` / `limit` 1–20）。省掉一份工具 schema
  （约 1.4K 字符/请求），同时把 `memory` 的 description 从 1765 压到约 1.1K 字符。
- **T4 工具返回值截断**（`src/store.js`）：错误里的 `current_entries` 最多 3 条
  （另给 `entry_count` / `entries_truncated`）；`patched_entry_before/after`、
  `replaced_entry`、`removed_entry` 以及 batch 的各 `*_entries` 都截到 160 字符加 `…`。
  写盘/日志仍用完整内容。
- **日志轨豁免**：`project`/`daily` 用独立上限 `logEntryCharLimit`（默认 600），且不参与
  近似门（0.75）与 85% 预算门 —— 之前 200 字门把日志轨一起挡了，拒绝文案却劝「写不下放
  project/daily」，自相矛盾。batch 仍不受单条 gate 约束。

## 0.10.0：记忆选择性（写入门 + 检索）

问题：0.9.x 的 `MEMORY` 到 99% 只有 8 条（平均 274 字符/条），其中还有「0.9.1 版本变更日志」——
历史写进了长期记忆。根因是只有注入没有淘汰、只拒完全重复、写入门槛只写在提示词里。

- **写入门（store 层，单条 `add` 生效）**
  - `entryCharLimit`（默认 200）：超长条目直接拒绝，提示一条一事实、日志进 `project`/`daily`。
  - `addSimilarityLimit`（默认 0.75）：与既有条目近重复（相似度 ≥ 0.75）时**拒绝 add**，
    返回既有条目并要求用 `patch` 合并；0.6–0.75 仍只给 `warnings`。
  - `budgetGatePercent`（默认 85）：add 会让占用超过该百分比时拒绝，要求用一个 `operations`
    batch 先 patch/remove 腾空间（batch 本身是补救通道，不受单条 gate 拦截）。
  - 全部阈值可配置、可置 0 关闭；只约束新写入，不动已有条目。
- **提示词（`src/nudge.js`）**：review 加三问门槛（跨会话仍成立 / 能避免真错 / 未被 AGENTS.md
  等覆盖），显式禁止版本号、日期、PR 号、changelog 叙事（→ `project` 轨），并说明被拒后不要
  原样重试，应拆成单条事实或改 `patch`。
- **冷热分层**：`memory`/`user`/`key` 仍注入；`project`/`daily` 与更早条目**不注入**，
  需要时检索（跨五轨，子串加权 + 词元重叠，`{target, entry, score}`，只读）。0.11.0 起检索
  并入 `memory` 工具的 `action:'search'`。`src/search.js`。

## 0.9.0：记忆同步与疑似重复

- **同步（导出/合并）** `src/sync.js`：把全部轨的条目打成 `dsh-memory-notes/v1` bundle
  （`{format, device_id, exported_at, targets}`）。合并是保守的「三方基线 + 只加不删」：
  - 本地 = 当前条目，远端 = bundle 条目，基线 = 上次合并后的条目集合（`<dir>/sync-state.json`）；
  - 只有「远端新增、本地没有、基线也没有」才写入；单条失败（配额/校验）计入 `summary.skipped`，
    不影响其他条目；
  - 远端删除只报告（`remote_deleted`），默认不执行；本地删掉的条目不会被远端复活
    （`local_deleted_kept`）；需要真删时调用方传 `applyDeletions: true`；
  - 合并成功后把当前条目写回基线，下一次以它为参照；同一 bundle 重复合并幂等。
- **面板入口**：`GET/POST /api/dsh-memory-notes/sync`（同样走 loopback + GUI token 鉴权），
  面板新增「SYNC · 同步 / 迁移」区块：导出 JSON、粘贴另一台设备的 JSON 合并。
- **疑似重复** `src/conflicts.js`：同一轨内两两计算 `similarity`（Jaccard，阈值 `0.8`，比写入时
  0.6 的近似告警更严），只提示不合并；`state.conflicts` 带 `{target, a, b, similarity}`，
  面板「疑似重复 · 需要人工合并」区块列出。
- 语义与写入一致：合并写入走 `store.add`（禁 `§`、配额校验、注入粗筛、账本 `source:'sync'`）。

## 0.9.1：修复 review 提示导致的「本轮运行失败」

- **崩溃根因**：0.6.0 起 review 完成提示用 `agent.inject` 推 **developer 角色**消息。
  `inject` 走的是 agent inbox 通道（append `agent/inbox/spliced`），而 inbox splice 只接受
  普通 user 消息；持久化前的 v4 校验随即抛
  `format v4 developer/message and developer role must occur together`，
  异常从 `memory_review_status` 的 execute 冒到本轮，表现为 GUI 里那条「本轮运行失败」。
  （developer 消息本身是合法事件，但只能用 `session.append('developer/message', …)` 且要求
  当前 step 处于 open 状态，插件拿不到这个保证。）
- **修法**：`src/nudge.js` 改成构造 user 角色的 `notice`：
  `source = { kind: 'memory-review', form: 'notice', summary }`，正文前缀 `[memory-review] `；
  `finishReview` 不再自己 inject，而是把 notice 返回给 `src/review-tool.js`，
  由工具层的 `exec.deferContext(notice)` 随结果进入下一步上下文（`additionalContexts`）。
  `exec.deferContext` 不可用或抛错时退回 `agent.inject(notice)`——同样是 user 角色，不会再触发校验。
- **客户端呈现**：`form: 'notice'` 让 GUI 把提示折叠成一行上下文（与 model-selection /
  tool-goal 的原生 notice 一致），摘要来自 `source.summary`（上限 120 字符）。
- **测试**：`tests/nudge.test.js` 校验 notice 形状与投递优先级；
  `tests/review-tool.test.js` 校验 `deferContext` 优先、`inject` 兜底、`noticeMode:'off'` 不投递。

## 0.8.0：面板鉴权、批量预览、安全件与 UI 打磨

- **面板路由接 GUI token 鉴权**：`registerWebPanel` 改为 `ctx.inject(['webServer','connection'])`，
  每条 `/api/dsh-memory-notes/*` 路由在写响应前先调 `connection.requestRejection(req)`
  （DSH 的 `browserAuth`：launch token / 签名 cookie / Host+Origin 校验）。返回 `401`（未登录）
  或 `403`（跨站 / DNS rebinding）时直接回写状态码、不碰数据；宿主没有 `connection` 服务时
  fail-open 并打一条 warn，老宿主仍可用。
- **pending 批量可预览**：面板「待确认」卡片不再只显示「× N」，展开后逐条列出 `action`、
  `old_text`、`content`（各截 120 字符，最多 10 条，超出显示「还有 N 项」）。
- **curator 建议制有回归测试**：`consolidate:'suggest'` 在有 stale 技能时确实调用
  `subagents.startActivation({ provider:'fork', label:'memory-curator', delivery:'caller' })`，
  完成后写 `channel:'curator'` 的 review-log；`'off'` 或缺少 `subagents` / `agents` 服务时安静跳过。
- **安全件（借 evolve）**：
  - `threatScan`（默认 `true`）：写入口先做提示注入粗筛（中文「无视 / 忽略…指令 / 规则」，
    英文 `ignore all previous instructions` 等），命中拒绝写入；`threatScan: false` 可关。
  - `assertCanonical`：原子写前校验 `serialize(parse(text)) === text`，内部产生非规范内容时拒绝落盘。
  - 锁文件带 `owner.json`（`{ pid, at }`）：`isStaleLock` 除超时外，pid 已死
    （`process.kill(pid,0)` → `ESRCH`）也立即视为 stale，避免进程崩溃留下的锁卡住写入。
- **面板 UI 打磨**：错误色改 `#b3261e`；删除改两段式确认（3 秒未确认自动还原，不再用
  `window.confirm`）；刷新按钮忙时显示「刷新中…」；批量删除按钮用 `dangerBtn` 样式。

## 0.7.0：分层记忆 / 回合内自审 / 快照实时化

### A. 分层记忆（五轨）

新增 `src/tracks.js`，记忆根目录下多出四条轨（`<hash>` = `sha256(workspace cwd)` 前 12 位，无 cwd 时为 `global`）：

| track | 文件 | 默认配额 | 注入快照 |
| --- | --- | --- | --- |
| `memory` | `<dir>/MEMORY.md` | 2200 | 是 |
| `user` | `<dir>/USER.md` | 1375 | 是 |
| `key` | `<dir>/projects/<hash>/KEY.md` | 2200 | 是（按分支过滤） |
| `project` | `<dir>/projects/<hash>/PROJECT.md` | 8000 | 否 |
| `daily` | `<dir>/daily/<YYYY-MM-DD>.md` | 6000 | 否 |

- 项目目录写一次 `meta.json`：`{ cwd, label, updated_at }`；cwd 变了才重写。
- `key` 条目末尾可写 `[branch:main,release]`：没有标签 → 注入；有标签且包含当前分支 → 注入；
  **当前分支未知 → 全量注入（绝不隐藏）**。标签原样保留在文件里。
- 分支由 `currentBranch(cwd)` 探测：`git -C <cwd> rev-parse --abbrev-ref HEAD`，2 秒超时，
  成功缓存 60 秒；非 git / 失败安静返回 `undefined`。
- `memory` 工具的 `target` 扩到五轨；`layeredTargets: false` 时退回 `memory` / `user` 两轨。
  `operations` 批量仍只允许同一 target，配额只在最终态校验。
- 左侧栏「记忆」面板渲染全部五轨（另有 `KEY · 当前项目/分支要点`、`PROJECT LOG`、`DAILY LOG`
  三段），编辑、删除、新增与 `memory` 工具走同一套写路径。
- 新增配额键：`memoryCharLimit` / `userCharLimit` / `keyCharLimit` / `projectLogCharLimit` /
  `dailyLogCharLimit`。超限依旧拒绝写入、不截断，文案沿用旧 `overflow()` 风格（换成对应 track 名）。

### B. 回合内自我审查（替换 fork review）

- `src/review-state.js` 维护 `<dir>/review-state.json`：
  `{ turns_since_review, total_turns, last_review_at, due_since, last_completed_at }`。
  坏文件/缺失按空状态处理，写失败只 `console.warn`。
- `src/nudge.js` 仍只监听 `session/event` 的 `turn/end`，但**不再启动任何子代理**：
  - 每个用户回合 `recordTurn`；到点后捕获「回顾窗口前」的 memory/user/key 条目快照（内存 Map）。
    实现上按 `turn/end` 计数，所以系统唤醒（followup）的回合也会计入，回顾可能比纯人回合略早触发；
  - review / curator 子会话不计数；
  - 快照里固定提示：「自上次回顾 N/M 轮」；到期时提示本轮先用 `memory` 工具完成回顾，
    完成后调用 `memory_review_status` 的 `complete`。
- `memory_review_status`（`src/review-tool.js`）：
  - `status` 返回 `{ due, turns_since, interval, last_review_at, last_completed_at, mode, suggestions_pending }`；
  - `complete` 只应在真正回顾后调用：读取 before 快照 → 当前条目 → `diffEntries` / `summarizeDiff`
    → 写 `review-log`（`channel:'review'`）→ inject developer 消息 → 清零计数；
  - `reviewEnabled: false` 时不注册。
- **建议队列** `src/suggestions.js`：`<dir>/SUGGESTIONS.jsonl`，最多 200 条，
  记录 `{ id, created_at, target, text, source }`。
  - `memory` 工具新增 `action:'suggest'`（target 仅 memory/user/key），同一内容未处理时幂等；
  - `reviewMode: 'suggest'`（默认）走建议队列，`'auto'` 直接写；
  - 面板 `state` 增加 `suggestions`（最近 20）与 `review`，新增
    `POST /api/dsh-memory-notes/suggestions` `{id, decision:'accept'|'discard'}`；
    采纳失败（如内容含 `§`）时保留建议并回 `{ok:false,...}`；
  - 客户端新增「建议」区块（Pending 之后、Reviews 之前），每条带「采纳」「丢弃」。

### C. 快照实时化

- 删除 `snapshots` Map 与按 session 冻结逻辑，改用：

  ```js
  ctx.systemPrompt.context({
    name: 'memory:snapshot',
    order: config.snapshotOrder ?? 9000,
    text: () => renderLiveSnapshot(...),
  });
  ```

  `context` 是 user-role 尾部消息，agent-loop 只在渲染文本变化时 append 一条；因此本会话内
  写入下一轮即可见，而前缀缓存仍然稳定。
- 组装顺序：`memory` → `user` → `key`（过滤后）→ 空行 → 每回合收尾提示 → 回顾状态行 →
  （分支已知时）分支行。
- 渲染只包含数据与固定文案：没有时间戳、随机 id 或与数据无关的计数，同样数据逐字节一致。
- `renderLiveSnapshot` 全程 `try/catch`，异常返回 `''` 并 `console.warn`，绝不让宿主步骤失败。

## Phase 2（0.6.0 及以前）：后台 fork review（已被 0.7.0 替换）

旧版 `src/nudge.js` 按 `nudgeInterval` 计数，到点用 `ctx.subagents.startActivation(...)` 起一个后台
子会话写记忆。0.7.0 起这条路径已删除，`provider` 配置仅 curator 合并时仍会用到；保留本节只为解释
旧日志与旧配置。

## Phase 3：技能写入（已实现）

`skill_manage`（`src/skill-tool.js` + `src/skills.js`）提供 `list` / `read` / `create` / `patch` /
`delete` / `write_file`，写 `<skillsDir>/<name>/SKILL.md`。护栏照搬 Hermes：

- `name` 必须 kebab-case：`^[a-z0-9][a-z0-9._-]*$`
- `description` ≤ 60 字符（它是技能索引里唯一显示的部分）
- `patch` 必须给出精确的 `old_string`（先 `read`）
- `delete` 必须给 `absorbed_into`，说清知识被谁吸收了
- 所有路径限制在技能根目录内，`write_file` 单文件 ≤ 1 MiB
- `view/patch/use` 计数写 `<dir>/skill-usage.json`

技能写完立刻出现在 DSH 自带的技能索引里（它监听 `~/.agents/skills`），行为和内置技能一致。

## Phase 4：curator（已实现）

`src/curator.js` 在每轮 `turn/end` 问一次「到点了吗」（`due()` 只做一次时间比较，不写盘），
到点才整理技能库。默认节奏照 Hermes：

- 间隔 `curatorIntervalHours` = 168 小时（7 天）才跑一次；`curatorPaused` 可整体暂停
- 14 天没动 → 标记 `stale`（只改遥测状态，不动文件）
- 30 天没动 → 移到 `<skillsDir>/.archive/<name>`，**只归档，永不删除**
- `pin` 过的技能免疫（`skill_manage` 的 `pin` / `unpin` 动作）
- 动手前打快照：优先 `tar -czf`，失败退化成逐项拷到 `.curator_backups/skills-<ts>`，只留最近 5 份
- 每个动作追加一行到 `<skillsDir>/.curator_ledger.jsonl`（before/after sha256）
- 运行状态写 `<dir>/curator-state.json`（last_run_at / run_count / last_summary）
- 默认不做 LLM 合并（Hermes 的 `DEFAULT_CONSOLIDATE=False` 同款保守默认）；
  设 `curatorConsolidate: 'suggest'` 才起 fork，而且只允许以 `stage` 提交建议

`skill_manage` 的 `status` 动作可以看到技能遥测与 curator 状态。

## 已知取舍

- **回合内回顾依赖模型遵守提示**：到点后只有模型主动完成回顾并调用 `memory_review_status complete`
  才会清零；没调用就下一轮继续提示（宁可重复提醒，也不假装完成）。
- **建议队列是 JSONL**：`SUGGESTIONS.jsonl` 采用整文件重写，最多 200 条；适合单机单进程，
  不做跨进程锁。
- **0.7.0 的 review 不再起 fork**：代价从「每 N 轮重喂整段历史」变成「依赖主模型自觉」；
  curator 的合并建议仍可能用 fork（`provider` 仅在那里生效）。
- **curator 的归档有 15s 宽限**：状态文件写失败时用内存时间戳兜底，避免每回合重跑。
- **记忆配额按 UTF-16 码元计**（`String.length`）；Hermes 是 Python 码点，emoji 多时数字会不同。
- **面板写入/撤销不弹审批**：面板路由没有打开中的 agent turn，`ctx.approval.request` 的前置条件不成立，
  因此面板（含撤销）直接走 `MemoryStore`，只把 `source` 标成 `panel` 记账；工具调用仍按 `approvalMode` 走审批。
- **`noticeMode: 'on'` 依赖宿主支持 `agent.inject`**：宿主没有该能力时只记日志，不会伪造消息。

## 测试

```bash
node --test tests/*.test.js      # 全部
node tests/skills.test.js        # 单文件（有些沙箱里 --test 的逐文件子进程会 EPERM）
```

回归用例覆盖了这些曾经会「静默失败」的点：description 的 YAML 转义（用宿主同一个 `yaml`
包 round-trip 校验，见 `E:\dsh\work\_tmp\yaml-roundtrip.mjs`）、`patch` 里 `$&`/`$$` 不被当替换
模式、技能名与宿主同规则、`old_string` 多处命中必须显式 `replace_all`、单条 `remove` 能清空记忆。
0.4.0 的 `tests/web.test.js` 另覆盖面板 API：state 形状、add/patch/remove 往返、非法输入不改数据、
pending 批准按 pin 重放、stale 拒绝并保留记录、缺 pin 的旧记录 fail-closed，以及回环守卫的七种场景。
0.6.0 新增 `tests/review-log.test.js`、`tests/write-log.test.js`，并在 `nudge` / `tool` / `client` /
`store` / `curator` 各补一组：review 提示三档、审批六种返回、面板区块与撤销文案、近似重复只告警不拦截、
curator 建议制与降级。0.7.0 新增 `tests/tracks.test.js`、`tests/review-state.test.js`、
`tests/suggestions.test.js`、`tests/review-tool.test.js`、`tests/snapshot.test.js`，并覆盖 web 的建议采纳/丢弃与客户端的建议区块。
0.8.0 新增 `tests/web.test.js` 的授权拦截用例（401 拒绝 / 放行 / 无 connection fail-open / 批量预览摘要）、
`tests/store.test.js` 的安全件用例（4 类注入文案、`threatScan:false`、batch、canonical、死锁 pid、owner.json）、
`tests/curator.test.js` 的建议制 fork 用例。
0.9.0 新增 `tests/sync.test.js`（导出/合并/基线/本地删除不复活/远端删除只报告/applyDeletions/配额跳过/格式校验）
与 `findConflictGroups` 用例，`tests/web.test.js` 补 sync 两条路由、鉴权拦截与 `state.conflicts`。
0.10.0 新增 `tests/search.test.js`（分词/跨轨命中/target 过滤/limit 与稳定排序/工具入参校验）
以及 store 的写入门用例（长度拒绝、近重复拒绝、0.6–0.75 只警告、85% 预算拒绝、batch 补救、阈值置 0 关闭）。
当前全量 **187 pass / 0 fail**。
