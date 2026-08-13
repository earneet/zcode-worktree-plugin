# Changelog

本文件记录 zcode-worktree-guard 的版本演进。详细设计见 [docs/design.md](docs/design.md)。

## [0.4.1] — 2026-08-13

### 🔴 修复 v0.4.0 线上回归：绑定永远解析失败（会话身份错位）

外部 agent 实际使用中报告（高危）：`wt.mjs status` 显示会话已绑定，guard hook 却报
"活动 worktree: 无"——三连锁症状：

1. `enter` 后写主 checkout 路径**不重写**，改动直写 master（需手工回滚）；
2. 直接以 worktree 绝对路径 Edit/Read 被**误拦**（"目标路径在其他 worktree 副本内"）；
3. 拦截上下文误报 `(detached HEAD)` 等虚假 git 状态。

**根因**：ZCode 只把 `session_id` 放进 hook 的 stdin payload，**从不注入 Bash 工具子进程
的环境变量**（已实测穷举）。`wt.mjs`（agent 经 Bash 调用）的 `getSessionId()` 只能落到
`cli-manual` 兜底，而 hook 用 payload 里的真实 `sess_*` 查询 `bindings/`——两侧 key 永远
对不上。v0.3 的 `state.json` 兜底恰好掩盖了这一错位；v0.4 为修跨会话残留而移除兜底，
错位随即致命。测试套件没抓到是因为用例直接把 `session_id` 注入 hook payload，写侧与读侧
构造上同 id，无法暴露"两侧来源不同"的结构问题。

**修复（会话身份注入）**：hook 是唯一知道真实会话 id 的组件。`guard_hook` 在 PreToolUse
检测到 Bash 命令调用 `wt.mjs` 时，经 `updatedInput` 给命令注入
`export ZCODE_SESSION_ID=<id>; ` 前缀——身份随进程环境确定性传递，无锁文件、无竞态，
保留 per-session 绑定与 subagent DB 继承的全部语义。已核实 ZCode 引擎（zcode.cjs）对
`updatedInput` 的应用是工具无关的 input 级替换，Bash.command 重写天然支持。防注入：id
仅放行 `^[A-Za-z0-9._-]+$`；幂等：命令已含 `ZCODE_SESSION_ID=` 时跳过；次序：注入在
全部拦截检查**之后**，绝不因注入跳过保护。新增 N04 端到端回归锁（注入 → enter → hook
以 payload id 解析 → 透明重写）。

### 行为变化：Read 去武器化

与"默认开放"哲学对齐——**读操作永不拦截**：

| 场景 | v0.4.0 | v0.4.1 |
|---|---|---|
| Read / Glob / Grep 其他 worktree 副本（无论有无绑定） | 🔴 拦截 | ✅ 放行（对比/排障常需） |
| Read `.git` 内文件 | 🔴 拦截 | ✅ 放行（写仍拦截） |
| 有绑定 Read 主 checkout 路径 | ✅ 透明重写 | ✅ 不变（视图一致性） |

有绑定 Read 其他副本时放行而非重写，避免把 `.worktrees/other/...` 错拼到自身副本下。

### 其他修复

- **MSYS 路径归一化**：Git Bash 里 `cd /f/...`、`/cygdrive/f/...` 是合法 Windows 路径，
  但 `extractCdTarget` 直接 `path.resolve` 会得到 `F:\f\...` 垃圾路径 → `currentBranch`
  误报 `(detached HEAD)`、Bash 防护整段静默跳过。现归一化为 `F:\...`；且 cd 目标不存在时
  返回 null（对齐真实 bash "cd 失败停留在原 cwd"的语义）。
- **currentBranch 区分失败**：git 调用失败（code≠0）报 `(git 调用失败)`，不再与真
  detached HEAD（code=0 空输出）混淆——拦截上下文不再撒谎。
- **fail-open 可诊断**：hook 内部异常原先被 `catch(() => exit 0)` 静默吞掉（排障时伪装成
  放行）；现写 `audit.jsonl`（`type:"hook_error"`）+ stderr 单行，放行语义不变。
- **status 自诊断**：检测到 `cli-manual` 绑定时提示"该绑定来自无会话环境，ZCode 会话
  不可见；在会话内重新 enter 可修复"——本次事故的现场特征直接变成下次的自提示。
- **工程整理**：会话 id 解析（`resolveSessionId`/`sessionIdFromEnv`）与 hook stdin
  读取/解析（`readStdinJson`/`parseHookPayload`）收敛到 `common.mjs`，消除三脚本重复。

### 测试

`tests/v2.test.mjs` 新增 N 组 13 用例（会话注入格式/幂等/防注入/端到端回归锁/exit 会话
隔离/status 提示/Read 三态/拦截优先级/MSYS 归一化/cd 语义/分支误报），全量 **148 用例
全绿**（135 既有零翻转——既有 Read 用例与新语义天然兼容）。

### 升级提示

live 运行时是 ZCode 的插件缓存副本：升级安装/重载插件后修复才生效。旧版本留下的
`bindings/cli-manual.json` 对会话不可见，`wt.mjs status` 现在会明确提示，在会话内重新
`enter` 即可修复。

## [0.4.0] — 2026-08-12

### 哲学转变：强制 → 默认开放

**这是本插件最重要的语义变化。** 此前（v0.1–v0.3）插件采用"强制 worktree"模型：无绑定时写主
checkout 被 fail-closed 拦截。v0.4 改为"**默认主副本开放，按需隔离**"——

> 用户/agent 应当被允许直接在主 checkout（主副本分支）中修改；只有当明确 `enter` 一个
> worktree 之后，本会话才锁定到该副本。

### 行为变化

| 场景 | v0.3（强制） | v0.4（默认开放） |
|---|---|---|
| 无绑定，Write/Edit/Read 主 checkout | 🔴 拦截（fail-closed） | ✅ 放行（默认开放，不重写不拦截） |
| 无绑定，本地 `git merge/rebase/pull/checkout` | 🔴 拦截 | ✅ 放行（主副本正常工作流） |
| 无绑定，`git push` 到 master/main | 🔴 拦截 | 🔴 仍拦截（push 安全网常驻） |
| 无绑定，删除 `worktree-*` 分支 | 🔴 拦截 | 🔴 仍拦截（安全网） |
| 无绑定，写到其他 worktree 副本 | 🔴 拦截 | 🔴 仍拦截（跨副本保护上提为始终生效） |
| 写 `.git` | 🔴 拦截 | 🔴 仍拦截（硬规则） |
| `enter` 绑定后，写主 checkout 路径 | ✅ 透明重写到副本 | ✅ 透明重写到副本（不变） |
| `enter` 绑定后/在副本内，受保护分支 mutate、checkout master | 🔴 拦截 | 🔴 仍拦截（不变） |

### 决策依据（两个关键子选择）

1. **push 安全网常驻 / 本地操作放开**：`git push` 到 master/main 是对外发布动作，始终需授权；
   本地 `merge/rebase/pull/checkout` 在无绑定时放开（主副本正常工作流不应被打断）。
   `enter` 后所有受保护分支拦截恢复。
2. **绑定只来自本会话明确 `enter`**：移除 `state.json` 作为绑定真值的兜底。这修复了跨会话残留
   bug——上个会话的 `enter` 会通过 `state.json` 把新会话自动锁进副本。新模型下，新会话默认无绑定
   =开放，必须本会话显式 `enter` 才锁定。`state.json` 保留作 `globalAllow` / 审计 / 状态显示载体，
   不再参与绑定解析。subagent 经 DB `parent_id` 链继承父绑定（不变）。

### 实现要点

- **`common.mjs`**：`resolveBinding`/`resolveInherited` 移除 state.json 兜底分支。
- **`guard_hook.mjs`**：`decideWrite` 无绑定分支 `deny`→`allow`；新增 `crossWorktreeDeny()` 辅助函数
  把跨副本写入保护**上提为始终生效**（原仅 bound 态的 §7 逻辑）；`handleBash` 的 merge/rebase/pull
  检查改为仅 `hasBinding‖in_worktree` 时拦截；`git push` 到 master/main、删 worktree 分支保持无条件拦截。
- **`session_start.mjs`**：四分支文案重写（默认开放 / 已锁定 / 已锁定（继承） / 遗留信息提示）。
- **`SKILL.md` / `plugin.json` / `README.md`**：叙事从"强制"改为"可选隔离"，决策表与绑定解析节同步。
- **`docs/design.md` / `docs/comparison-between-opencode-and-zcode.md`**：加 v0.4 更新说明，保留历史对比。
- **`tests/v2.test.mjs`**：135 用例全绿。翻转 A16/A17/K04/D04/D07/I04/I01/I03/L10；新增 A21
  （无绑定跨副本写仍拦）、C15–C21（无绑定本地 git 放行 + push/删分支安全网仍拦）、A13b/c/d
  （重写保留原始大小写文件名，见下）。

### Bug 修复：透明重写不再小写化文件名

用户报告（Fantasia 项目）：`enter` worktree 后，Write/Edit 写主 checkout 的混合大小写文件名
被透明重写时**强制小写**（`AgentType.java` → `agenttype.java`），破坏 Java 类名↔文件名契约，
导致编译失败。根因：`decideWrite`/`handleSearchPathTool` 用 `norm()` 过的（已小写）路径计算
重写的相对路径。修复：rel 改用原始大小写路径计算（`norm` 只用于 `isInside` 比对）。新增
A13b/c/d 回归测试。`path.win32.relative` 对中间段大小写不敏感，故原 A13 仍通过。

### 不变的部分（保留）

透明重写机制（bound 态）、跨副本写入保护、`.git` 保护、allowlist / whitelist / authorize-main
逃生口、v0.3 文件同步（copyFiles / symlinkDirs / Windows junction / 清理安全）、subagent DB 继承
（快照语义）、task_name slug 校验、悬空检查、TTL GC、原子写入、路径穿越防护。

### ⚠️ 升级注意（cache 与 source）

ZCode 运行时加载的是 **cache 副本**（`~/.zcode/cli/plugins/cache/.../<version>/`），不是仓库源文件
（`plugins/...`）。本版改动落在源文件，测试也针对源文件。**必须重启 ZCode / 重新加载插件**，
cache 才会从源同步、新语义才在运行时生效。版本号从 `0.3.0` 升到 `0.4.0`，cache 目录随之变更，
有助于冲掉旧 `0.3.0` 的残留代码。

---

## [0.3.0] — 2026-08-11

### 文件同步 + Windows junction + 清理安全

- 新增 `sync.copy_files` / `sync.symlink_dirs` 配置：worktree `create` 后自动复制文件（如 `.env`）
  与链接目录（如 `node_modules`）。Windows 用 junction（无需管理员），失败回退 dir symlink。
- **清理安全**：`exit(remove)` 先 `removeSyncedLinks()`（lstat + unlink）再 `git worktree remove`，
  防止递归删除跟随 junction 误删主仓库的 `node_modules`。`dirtySummary` 过滤 symlink_dirs 条目。
- 测试套件扩充至 124 用例（M 组：copyFiles/symlinkDirs/junction + 清理安全端到端）。

## [0.2.1] — 2026-08-11

### 代码审查修复（P0–P5）

- P0 session_id 路径穿越防护（`safeFileName`）；P1 `writeJson` 原子化（tmp+rename）；
  P2 allowlist 过期条目 lazy GC；P3 decideWrite §8 死代码修复（rewrite 前检查 `registeredWorktrees`，
  正确拒绝跨副本写入）；P4 `validateWhitelist` 接入 `whitelistPatterns`；P5 注释 typo。
- 测试套件扩充至 112 用例（L 组：审查修复验证）。`cleanupRepo` 针对 Windows EPERM 加重试。

## [0.2.0] — 2026-08-10

### 会话级绑定 + 双层逃生口 + DB 继承

- **会话级绑定** `bindings/<session_id>.json`（每 session 一文件，无写竞争）。
- **DB parent_id 继承**：subagent 经 `node:sqlite` 查 `session.parent_id` 自动继承父绑定，快照到自身。
- **双层逃生口**：声明式白名单（`main_write_whitelist`）+ `wt.mjs allow` 临时放行（TTL + 注入防护 + 审计）。
- **决策表**：`decideWrite`/`handleBash` 纯函数替代 v0.1 顺序 if-else。
- 悬空检查、迁移检测、authorize-main/revoke-main。
- 修复关键 bug：`queryParentId` 在 ESM 内裸 `require("node:sqlite")` → ReferenceError → DB 继承静默失效；
  改用 `module.createRequire`。

## [0.1.0] — 2026-08-10

### 初始版本

- 透明路径重写（PreToolUse `updatedInput` Form 3）+ 拦截防御双层架构。
- 强制 worktree 模型（无绑定写主分支 fail-closed 拦截）。
- SessionStart hook 自动注入纪律；Bash cd 解析；仓库级单活动 state.json。
- Python → Node.js ESM（`.mjs`，零依赖）重写。
