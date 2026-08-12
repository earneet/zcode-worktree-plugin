# zcode-worktree-guard 设计文档

> **生成日期**: 2026-08-10
> **状态**: v0.1 实现完成，待端到端验证

> **更新（v0.4，2026-08-11）**：哲学从"强制 worktree"改为"**默认主副本开放，按需隔离**"。
> 本文档下方描述的是 v0.1 的原始设计（强制模型）。相对 v0.1 的行为差异：
> - 无绑定时 Write/Edit/Read 主 checkout 从 🔴拦截 → ✅放行（默认开放）；
> - 无绑定时本地 `git merge/rebase/pull/checkout` 放行（push 到 master/main 仍拦截）；
> - 绑定只来自本会话 `enter`（+ subagent 继承父链）；`state.json` 不再作为绑定真值；
> - 跨副本写入、写 `.git`、push 到 master/main、删 worktree 分支——始终拦截（安全网）。
> 下方的决策表与目标表述保留为 v0.1 历史；以 README 与 SKILL.md 为准。

## 1. 目标

为 ZCode 构建一个 worktree 强制插件，解决 agent 在 worktree 模式下的两大痛点：
1. **路径漂移**——agent 以为自己写到了 worktree，实际写到了主 checkout（或反之）；
2. **遵循度**——即使有 SKILL 指导，agent 也可能忘记进入 worktree 就直接改主分支。

## 2. 方案选型：双层架构

| 层 | 机制 | 作用 | 来源 |
|---|---|---|---|
| 透明重写（主） | PreToolUse + Form 3 `updatedInput` | agent 无感知地重写路径 R→W | opencode 思路 |
| 拦截防御（辅） | 同 hook 内 deny / exit 2 | 写保护 + 危险 git 操作拦截 | kimi 思路 |

两者融合：重写覆盖不了的场景（写其他副本、危险 git 操作）才拦截。

## 3. 契约证据（全部经实测或源码确认）

### 3.1 PreToolUse 能改写 tool_input（Form 3）
**实测**（2026-08-07 冒烟测试）：hook 输出
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{...}}}
```
Write 的 file_path 被改写后，文件实际落到改写后路径，原路径未变。`updatedInput` 是整体替换，
替换后过工具 runtime schema 校验（safeParse），所以字段名必须匹配。

源码位置：bundle `zcode.cjs`，函数 `HNi`（line 2900）、`CQ`/`udn`（line 2417/2451）。

### 3.2 工具字段名
| 工具 | 路径字段 | 其它 | strict |
|---|---|---|---|
| Write/Edit/Read | `file_path` | — | 否 |
| Glob/Grep | `path` (optional) | `pattern` | 否 |
| Bash | （无路径字段） | `command` | **是** |

**Bash 无 cwd 字段且 strict**——无法通过 hook 改写其工作目录，这是 ZCode 的硬限制。
故 Bash 只做拦截，不重写。

### 3.3 stdin 字段
`session_id`/`sessionId`、`cwd`、`tool_name`/`tool_input`、`hook_event_name`、`permission_mode`。
**无 parent_session**（关键，见 §4.1）。

### 3.4 模板变量展开（三管道互不相同）
| 管道 | bundle 函数 | 支持变量 | user_config? |
|---|---|---|---|
| Skill 正文 | `E5i` (line 2754) | **仅** `CLAUDE_SKILL_DIR`/`ZCODE_SKILL_DIR` | 否 |
| Hook command/args | `NTe` (line 2943) | SESSION/PROJECT/PLUGIN_ROOT/PLUGIN_DATA | 否 |
| MCP server env | `Vm` | 上述 + env + `user_config.*` | **是** |

**关键约束**：
- `${ZCODE_PLUGIN_ROOT}` 在 hook command/args **会展开**，但在 skill 正文**不展开** → SKILL 用相对路径。
- `${user_config.*}` 只 MCP 可达，hook 读不到 → 配置走 sidecar 文件。

## 4. 审计修正记录（v1 → v2）

v1 计划在实现前经两轮 Explore agent 审计，发现 5 个缺陷并修正：

### 4.1 子代理 session_id 不可继承（致命）
**v1 假设**：用 session_id 做 key，支持并行多 worktree。
**证据**：子代理（Agent/Task 派生）有独立 session_id（`sess_subagent_agent_*`），
PreToolUse stdin 无 parent_session（调用链 `wxn→xcn→xzt`）。session 级绑定对子代理不可继承。
**修正**：改用 **git common dir 仓库级单活动绑定**（状态存 common dir，子代理 cwd 落同仓库自动继承）。
放弃并行多 worktree（且 Bash cwd 不可重写已削弱其价值）。

### 4.2 node 不保证在 PATH
**v1 假设**：hook 用 `"command":"node"`。
**证据**（后被部分推翻）：Explore agent 当时报告"ZCode 不向 hook 暴露内部 node"。
**v2 修正（已被推翻，见下方更新）**：当时改用 Python（`C:/Python314/python.exe`）。
> **2026-08-10 更新**：此判断被用户质疑后复核，实测发现 (a) 系统装有 node v24.15 且在 PATH，
> (b) `ELECTRON_RUN_AS_NODE=1 ZCode.exe` 可作为 node v24.14 运行 TS 脚本。
> 原"node 不可用"判断是基于 Explore 报告未亲自验证的疏漏。**插件已整体重写为 TypeScript（.mjs）**，
> hooks.json 用 `command:"node"`（依赖 PATH），不再硬编码机器路径。详见 [[verify-runtime-assumptions-before-tech-choice]]。

### 4.3 skill 正文不展开 PLUGIN_ROOT
**v1 假设**：SKILL 用 `${ZCODE_PLUGIN_ROOT}/scripts/wt.mjs`。
**证据**：skill 渲染管道 `E5i` 只展开 SKILL_DIR。
**修正**：SKILL 用相对路径 `../../scripts/wt.mjs`（TS 版），依赖 skill base 自动追加行（生态先例：superpowers/brainstorming）。

### 4.4 hook 读不到 user_config
**v1 假设**：manifest userConfig 被 hook 读取。
**证据**：hook 变量是封闭枚举（`NTe`），无 user_config。
**修正**：走 sidecar `<repo>/.zcode/worktree-guard.json`。

### 4.5 manifest hooks 字段
**v1 假设**：`"hooks":"hooks/hooks.json"`。
**证据**：`hooks/hooks.json` 已按约定自动发现。
**修正**：manifest 省略 hooks 字段。

## 5. 拦截/重写规则表

| 场景 | 行为 |
|---|---|
| 有活动 worktree，Write/Edit/Read 主 checkout 路径 | 🔄 重写 R→W |
| 有活动 worktree，Glob/Grep 无 path | 🔄 注入 path=W |
| 有活动 worktree，Glob/Grep path 在主根下 | 🔄 重写 R→W |
| 有活动 worktree，写副本内路径 | ✅ 放行 |
| 有活动 worktree，写其他副本 | 🔴 拦截 |
| 写 `.git` | 🔴 拦截 |
| 无活动 worktree，Write/Edit 主 checkout | 🔴 拦截（写保护） |
| 无活动 worktree，Read 主 checkout | ✅ 放行 |
| 受保护分支上 merge/rebase/pull | 🔴 拦截 |
| push 到 master/main | 🔴 拦截 |
| 副本内 checkout 到受保护分支 | 🔴 拦截 |
| 删 worktree 分支 | 🔴 拦截 |
| authorize-main 期间 | ✅ 全放行 |
| 仓库外/非 git | ✅ 放行 |

## 6. 状态存储

```
<git-common-dir>/worktree-guard/
  state.json      # {active, path, branch, base, entered_at}  仓库级单活动
  override.json   # {allow_main_writes, reason, created_at}
  bases.json      # {"<worktree-branch>": "<base>"}
```

位于 git common dir，天然不进版本库、所有 worktree 共享、重启自动恢复。

## 7. 已知边界

- **fail-open**：hook 脚本异常/超时放行，绝不阻塞 agent。
- **Bash 不重写**：ZCode 硬限制，Bash 只拦危险 git 操作。agent 的 `echo > file` 类操作不会自动重写，
  但 Write/Edit 工具会——SKILL 已指导优先用工具写文件。
- **Bash 正则限制**：只匹配 `git` 直接开头的简单命令，`cd x && git merge` 类组合可能绕过
  （与 kimi 一致的已知限制）。
- **无热重载**：hook 注册在 session bootstrap 完成，改 hooks.json 或安装插件后须重启 ZCode。
  但 hook 脚本逻辑改完即生效（每次调用是新进程）。

## 8. 参考来源

- kimi 参考：`F:\workspace_2\worktree-guard\`（wt.py / guard_worktree.py / SKILL.md，逻辑直接复用）
- opencode 参考：`F:\workspace_2\opencode-worktree-guard\docs\design.md`（重写思路、拦截规则）
- ZCode 契约证据：`C:\Users\Administrator\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs`
- skill 相对路径先例：`claude-plugins-official\superpowers\6.1.1\skills\brainstorming\visual-companion.md`
- PreToolUse 改写能力：本会话冒烟测试实测
