# Changelog

本文件记录 zcode-worktree-guard 的版本演进。详细设计见 [docs/design.md](docs/design.md)。

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
- **`tests/v2.test.mjs`**：132 用例全绿。翻转 A16/A17/K04/D04/D07/I04/I01/I03/L10；新增 A21
  （无绑定跨副本写仍拦）、C15–C21（无绑定本地 git 放行 + push/删分支安全网仍拦）。

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
