# dsh-memory-notes

Hermes 式长期记忆的 DSH Host 插件。它给模型一个 `memory` 工具，并在系统提示词里注入一段「冻结快照」式的记忆块。

## 它做什么

- 两个纯文本记忆库，条目之间用单独一行 `§` 分隔：
  - `<dshHome>/memories/MEMORY.md` —— 模型自己的笔记；
  - `<dshHome>/memories/USER.md` —— 用户画像 / 偏好 / 期望。
- 配额按字符计：`memory` 默认 2200，`user` 默认 1375，含分隔符。超限直接拒绝写入，绝不截断。
- `memory` 工具支持 `add` / `patch` / `remove`，或用 `operations` 数组做原子批处理（配额只按最终结果校验，所以可以先删后加）。`patch` 只替换条目内的一个 span，条目其余保留；整条重写就把整条放进 `old_text`。
- 系统提示里的记忆块在**会话开始时冻结**：本会话内的写入不会改变已注入的文本，改动从下一个会话开始可见（prompt-cache 语义）。
- 0.4.0 起带一个**左侧栏「记忆」面板**：看两个库的条目与配额、就地改写/删除/新增条目、批准后台 review 排队中的破坏性写入。

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
| `nudgeInterval` | `10` | 每多少个回合触发一次后台 review |
| `reviewEnabled` | `true` | 关掉后台 review |
| `memoryEnabled` | `true` | 后台 review 里是否包含记忆回顾 |
| `reviewPrompt` | — | 覆盖后台 review 的提示词全文 |
| `provider` | `fork` | review 子会话用 `fork`（继承父上下文）还是 `spawn` |
| `noticeMode` | `'on'` | review 完成后的主会话提示：`on` / `verbose`（附 3 条预览）/ `off` |
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
| `strictReadBeforeWrite` | `true` | 技能写入前必须读过、且读后文件未变 |
| `pendingDir` | `<dir>/pending` | 后台 review 的破坏性写入排队目录 |
| `webPanelEnabled` | `true` | 关掉左侧栏面板与 `/api/dsh-memory-notes/*` 路由 |

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
  所以子路径部署也正常。面板里能直接看到「写入立即落盘，但本会话提示词是冻结快照」的提示。
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

后台 review 跑完后，`src/nudge.js` 会给主会话 `inject` 一条 developer 消息（不是普通 user 消息，
不会污染对话历史里的用户意图），并在面板里留一条记录：

- `noticeMode: 'on'`（默认）显示「记忆已更新」与两库计数，例如
  `MEMORY +1 ~0 -0 · USER +0 ~0 -0`；
- `noticeMode: 'verbose'` 额外附最多 3 条变更预览（`+` 新增 / `-` 删除 / `~` 修改）；
- `noticeMode: 'off'` 只记账本，不打扰主会话。
- 提示走 `@deepseek-ai/dsh-llm` 的 `createDeveloperMessage`；宿主没导出时退化成同结构的
  `{ role: 'developer', content: [{ type: 'text', text }], source: { kind: 'memory-review' } }`。
- inject 失败只 `console.warn`，不影响 review 结果与账本。
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

## Phase 2：后台 review（已实现）

`src/nudge.js` 监听 `session/event` 的 `turn/end`，按 `nudgeInterval` 计数，到点用
`ctx.subagents.startActivation({ provider, request: { parent }, delivery: 'caller' })` 起一个后台子会话，
让它在不打扰主对话的前提下把「值得长期记住的东西」写进记忆。

- 计数存在 `<dir>/nudge-state.json`，宿主重启后接着数。
- review 子会话自己的 `turn/end` 不计入（否则会自我触发）。
- 子会话跑完即丢弃，主会话的 prompt cache 不受影响 —— 和 Hermes 的做法一致。
- `subagents` 服务懒取：精简宿主没有它时只打一条 warning，不让插件整体失效。

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

- **review 用 fork 会继承整段父上下文**（`startActivation({ provider: 'fork' })`）。这是为了
  让它真的"看见"对话，但长会话下每 10 轮会把整段历史再喂一次模型，代价随长度线性上涨。
  需要省 token 时把 `provider` 改成 `spawn`（子会话看不到历史，只适合做纯整理）。
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
curator 建议制与降级。当前全量 **105 pass / 0 fail**。
