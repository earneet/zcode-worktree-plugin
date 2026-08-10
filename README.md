# zcode-worktree-guard

> A ZCode plugin that enforces a strict git-worktree workflow with **transparent path rewriting**:
> when a worktree is active, every `Write` / `Edit` / `Read` / `Glob` / `Grep` call is silently
> rerouted into the worktree — the agent never notices. The main checkout is write-protected,
> and dangerous git operations (merge/push to master/main, etc.) are intercepted.

强制 git worktree 工作流的 ZCode 插件，采用**透明路径重写**架构：

- 🔄 **透明重写（主层）**：有活动 worktree 时，PreToolUse hook 把 `Write`/`Edit`/`Read` 的
  `file_path`、`Glob`/`Grep` 的 `path` 从主 checkout 根自动改写到 worktree 目录。agent 无需记
  忆、无感知，路径漂移从机制上消除。
- 🔴 **写保护 + 危险操作拦截（防御层）**：无活动 worktree 时禁止写主 checkout；有活动 worktree
  时禁止写其他副本；在受保护分支上拦截 `git merge`/`rebase`/`pull`/`push`。
- 📦 **生命周期脚本**：`create` / `enter` / `exit` / `status` / `authorize-main` / `revoke-main`。
- 🗂️ **仓库级单活动绑定**：状态存 git common dir，所有 worktree 共享，客户端重启自动恢复，
  子代理（Agent/Task 派生）自动继承。

## 要求

- ZCode 客户端（PreToolUse hook + `updatedInput` Form 3 支持已实测确认）
- Node.js（hook 通过 `node` 调用，需在 PATH 中可用）
- `git` 在 PATH

## 安装

### 方式 A：从本地目录安装（推荐，开发/自用）

Settings → Plugin Management → **Discover** → 右上角 **`+`** → 选择本仓库根目录
（`F:\workspace_2\zcode-worktree-plugin`）→ 安装后在 Discover 找到 `zcode-worktree-guard`
点 **Get**。重启 ZCode 生效。

### 方式 B：plugins.dirs 本地加载（纯开发调试）

在 `~/.zcode/cli/config.json` 加：

```json
{ "plugins": { "dirs": ["F:\\workspace_2\\zcode-worktree-plugin\\plugins\\zcode-worktree-guard"] } }
```

重启 ZCode 即加载（inline，默认启用）。

## 工作流速览

```bash
# 创建并进入 worktree（SKILL 加载后 agent 会自动按此流程操作）
echo '{"task_name": "fix-login"}' | node <plugin>/scripts/wt.mjs create
echo '{"path": ".worktrees/worktree-fix-login"}' | node <plugin>/scripts/wt.mjs enter

# ... 在 worktree 内开发（文件自动落到 worktree）...

# 退出并汇报，等待用户授权合并
echo '{"action": "keep"}' | node <plugin>/scripts/wt.mjs exit

# 用户授权后合并（分三次独立 Bash 调用，切勿合并到同一命令）
echo '{"reason": "用户授权合并 fix-login"}' | node <plugin>/scripts/wt.mjs authorize-main
# git merge worktree-fix-login …
echo '{}' | node <plugin>/scripts/wt.mjs revoke-main
```

## 可选配置

仓库根 `<repo>/.zcode/worktree-guard.json`：

```json
{
  "branch_prefix": "worktree-",
  "worktree_parent": ".worktrees",
  "protected_branches": ["master", "main"]
}
```

## 状态文件位置

```
<git-common-dir>/worktree-guard/
  state.json      # 活动 worktree 登记（仓库级单活动）
  override.json   # 主 checkout 写入授权
  bases.json      # 各 worktree 的 base 分支
```

不进版本库、所有 worktree 共享、重启自动恢复。

## 设计文档

见 [docs/design.md](docs/design.md)（契约证据、架构决策、审计修正记录）。
