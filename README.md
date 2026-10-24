# dsh-memory-notes

Hermes 式长期记忆的 DSH Host 插件。它给模型一个 `memory` 工具，并在系统提示词里注入一段「冻结快照」式的记忆块。

## 它做什么

- 两个纯文本记忆库，条目之间用单独一行 `§` 分隔：
  - `<dshHome>/memories/MEMORY.md` —— 模型自己的笔记；
  - `<dshHome>/memories/USER.md` —— 用户画像 / 偏好 / 期望。
- 配额按字符计：`memory` 默认 2200，`user` 默认 1375，含分隔符。超限直接拒绝写入，绝不截断。
- `memory` 工具支持 `add` / `patch` / `remove`，或用 `operations` 数组做原子批处理（配额只按最终结果校验，所以可以先删后加）。`patch` 只替换条目内的一个 span，条目其余保留；整条重写就把整条放进 `old_text`。
- 系统提示里的记忆块在**会话开始时冻结**：本会话内的写入不会改变已注入的文本，改动从下一个会话开始可见（prompt-cache 语义）。

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
| `dir` | `$DSH_MEMORY_DIR` → `$DSH_HOME/memories` → `~/.dsh/memories` | 记忆目录 |
| `memoryCharLimit` | `2200` | `MEMORY.md` 配额 |
| `userCharLimit` | `1375` | `USER.md` 配额 |
| `nudgeInterval` | `10` | 每多少个回合触发一次后台 review |
| `reviewEnabled` | `true` | 关掉后台 review |
| `memoryEnabled` | `true` | 后台 review 里是否包含记忆回顾 |
| `reviewPrompt` | — | 覆盖后台 review 的提示词全文 |
| `provider` | `fork` | review 子会话用 `fork`（继承父上下文）还是 `spawn` |
| `skillsDir` | `$DSH_SKILLS_DIR` → `~/.agents/skills` | `skill_manage` 写技能的位置 |
| `skillsEnabled` | `true` | 关掉 `skill_manage` 工具 |
| `curatorEnabled` | `true` | 关掉 curator |
| `curatorIntervalHours` | `168` | 两次整理之间至少隔多久 |
| `curatorStaleAfterDays` | `14` | 多久没动标记 stale |
| `curatorArchiveAfterDays` | `30` | 多久没动归档 |
| `curatorKeepSnapshots` | `5` | 保留几份快照 |
| `curatorPaused` | `false` | 暂停整理 |
| `strictReadBeforeWrite` | `true` | 技能写入前必须读过、且读后文件未变 |
| `pendingDir` | `<dir>/pending` | 后台 review 的破坏性写入排队目录 |

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
- 不做 LLM 合并（Hermes 的 `DEFAULT_CONSOLIDATE=False` 同款保守默认）

`skill_manage` 的 `status` 动作可以看到技能遥测与 curator 状态。

## 已知取舍

- **review 用 fork 会继承整段父上下文**（`startActivation({ provider: 'fork' })`）。这是为了
  让它真的"看见"对话，但长会话下每 10 轮会把整段历史再喂一次模型，代价随长度线性上涨。
  需要省 token 时把 `provider` 改成 `spawn`（子会话看不到历史，只适合做纯整理）。
- **curator 的归档有 15s 宽限**：状态文件写失败时用内存时间戳兜底，避免每回合重跑。
- **记忆配额按 UTF-16 码元计**（`String.length`）；Hermes 是 Python 码点，emoji 多时数字会不同。

## 测试

```bash
node --test tests/*.test.js      # 全部
node tests/skills.test.js        # 单文件（有些沙箱里 --test 的逐文件子进程会 EPERM）
```

回归用例覆盖了这些曾经会「静默失败」的点：description 的 YAML 转义（用宿主同一个 `yaml`
包 round-trip 校验，见 `E:\dsh\work\_tmp\yaml-roundtrip.mjs`）、`patch` 里 `$&`/`$$` 不被当替换
模式、技能名与宿主同规则、`old_string` 多处命中必须显式 `replace_all`、单条 `remove` 能清空记忆。
