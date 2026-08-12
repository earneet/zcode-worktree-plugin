---
name: worktree-workflow
description: 可选的 git worktree 隔离工作流。默认在主 checkout 自由工作（不拦截、不重写）；当用户想隔离一个任务到独立分支副本时，create + enter 后本会话的写路径会自动透明重写到该副本，合并回主分支需用户明确授权。用于进入/退出 worktree 副本、查询状态。
---

# 可选的 git worktree 隔离工作流

## 默认工作方式（重要）

**默认在主 checkout 自由工作。** 没有明确 `enter` 一个 worktree 之前：
- 你对主 checkout 的 `Write` / `Edit` / `Read`、以及本地 `git` 操作（merge / rebase / pull / checkout 等）**一律放行，不重写、不拦截**——这就是正常的主仓库工作流。
- 唯二的常驻安全网：`git push` 到 `master`/`main` 始终需用户授权；删除 `worktree-*` 分支始终需授权。

**一旦你 `enter` 一个 worktree（本会话绑定），本会话才进入"锁定到副本"模式：**
- 写主 checkout 的路径会被**透明重写**到该副本；
- 跨副本写入、副本内 `git checkout master/main`、受保护分支上的 `merge/rebase/pull` 被拦截；
- `git push` 到 master/main、删 worktree 分支仍需授权。

绑定只来自**本会话**的 `enter`（或子代理经父会话继承）。上个会话的 `enter` 不会自动延续到新会话。

## 路径约定

本技能引用的脚本位于本 skill 的 base directory 往上两级的 `scripts/` 目录。即脚本路径是：

```
<Base directory for this skill>/../../scripts/wt.mjs
```

（上下文末尾会给出本 skill 的 base directory 绝对路径，据此拼出 `wt.mjs` 的绝对路径。）

后续命令中 `<WT>` 代表 `wt.mjs` 的绝对路径。先确认它存在：
```bash
ls "<base>/../../scripts/wt.mjs"   # 应输出该文件路径
```

## 核心纪律（enter 之后）

- `enter` 之后，本会话的文件改动透明重写到绑定的 worktree 副本（分支名 `worktree-<task>`）；
- 合并回主分支（master/main）必须等待用户明确授权；
- 在 worktree 副本内禁止 `git checkout/switch` 到 master/main；
- 退出副本（`exit`）即回到默认开放模式。

## 透明重写机制（enter 之后的核心特性）

**`enter` 之后，你无需手动修改文件路径。** PreToolUse hook 会自动：
- 把你 `Write` / `Edit` / `Read` 的 `file_path`、`Glob` / `Grep` 的 `path` 从主 checkout 根
  **透明重写**到绑定的 worktree 目录。你写 `src/app.js`，实际落到 worktree 里。
- 工具返回值会显示重写后的真实路径——这是正常的，文件确实落在了 worktree。

所以：**照常写主 checkout 的路径即可，hook 替你重定向。** 这正是"无路径漂移"的保证。

唯一例外：`Bash` 工具的工作目录无法被重写（ZCode 限制）。所以 Bash 里的文件操作要自己注意路径；
但更推荐——用 `Write`/`Edit` 工具写文件（会自动重写），少用 `echo > file` 这类 bash 重定向。

**若被 hook 拦截**（写错位置或危险操作），拦截消息里会给出 `node <绝对路径> wt.mjs` 的完整命令——
可直接复用，无需自己拼脚本路径。

## 工具脚本调用

所有 worktree 操作通过 `wt.mjs` 执行（stdin 收 JSON，stdout 出 `{"content": ...}`）。

**运行前提**：所有 `wt.mjs` 命令必须在目标 git 仓库内运行（任意子目录均可，脚本会自动定位仓库根）。
若你的会话 cwd 不在目标仓库内，先 `cd` 到目标项目目录再执行。

**task_name 命名规则**（重要，不合规会创建失败）：必须匹配 `^[a-z0-9][a-z0-9-]{0,49}$`——
即**只能用小写字母、数字、连字符**，禁止大写字母/下划线/空格/中文。
把用户的自然语言请求规范化为 slug，例如"加登录功能"→`add-login`、"修复支付 bug"→`fix-payment`。

```bash
# 查看所有副本和活动状态（每个任务开始前先跑这个）
echo '{}' | node "<WT>" status

# 创建 worktree（默认基于主 checkout 当前分支；拒绝在副本内嵌套创建）
# task_name 必须是小写字母/数字/连字符的 slug
echo '{"task_name": "add-drop-module"}' | node "<WT>" create

# 可选参数：base_branch 指定基线分支；worktree_parent 指定副本父目录（默认 .worktrees）
echo '{"task_name": "fix-login", "base_branch": "main", "worktree_parent": ".worktrees"}' | node "<WT>" create

# 进入已存在的 worktree（登记活动状态后，路径透明重写生效）
echo '{"path": ".worktrees/worktree-add-drop-module"}' | node "<WT>" enter

# 退出当前活动 worktree（保留副本，汇报领先提交与未提交改动）
echo '{"action": "keep"}' | node "<WT>" exit

# 删除副本（需显式确认且工作区干净；只删目录，分支保留）
echo '{"action": "remove", "confirm_remove": true}' | node "<WT>" exit

# 授权在主 checkout 上修改/合并（需用户明确授权后才可调用）
echo '{"reason": "用户授权合并 worktree-add-drop-module"}' | node "<WT>" authorize-main

# 撤销授权（授权操作完成后立即执行）
echo '{}' | node "<WT>" revoke-main

# 会话级临时放行（仅在已 enter 副本时，想例外写主目录某文件）
echo '{"action": "add", "path": "README.md", "reason": "临时改文档"}' | node "<WT>" allow
echo '{"action": "list"}' | node "<WT>" allow     # 查看当前会话放行列表
echo '{"action": "clear"}' | node "<WT>" allow    # 清空放行
```

## 何时用 allow / 白名单（仅在已 enter 副本时才需要）

**默认（未 enter）写主 checkout 本来就放行，不需要 allow。** 只有当你已经 `enter` 了一个
worktree、又想例外写主 checkout 某路径（绕过重写），才用逃生口：

- **白名单（永久、声明式）**：在 `<repo>/.zcode/worktree-guard.json` 配置
  `"main_write_whitelist": ["AGENTS.md", "docs/**/*.md"]`。这些路径即使 enter 后也写主目录。
- **allow 子命令（临时、本次会话）**：上面示例，放行 60 分钟（可配 `ttl_minutes`）。
  拒绝放行 `.git`、仓库根、`*` 等危险路径（注入防护）。每次调用记审计日志。

## 开发任务标准流程

**默认在主 checkout 自由工作——不需要任何前置操作。** 只有当用户明确想隔离任务到 worktree
（或你判断任务适合隔离）时，才走下面的 enter 流程：

1. **任务开始时**：先跑 `status` 查看当前会话是否已绑定 worktree。
   - 已绑定 → 继续在该副本工作（路径重写已生效，照常写主 checkout 路径）。
   - 未绑定、且想隔离 → `create` 创建新副本，然后 `enter`。

2. **创建副本后**：`enter` 登记为本会话绑定，路径透明重写才生效。

3. **在副本内工作**：
   - **直接用 Write/Edit 写主 checkout 的路径即可**，hook 自动重写到 worktree；
   - 不要主动加 worktree 前缀，也不要 cd 进 worktree——保持路径自然，hook 处理一切。

4. **任务结束时**：`exit(action="keep")` 汇报状态，**等待用户授权合并**。
   - 不要自行 `git merge` / `git rebase` 到主分支（绑定态会被 hook 拦截）。
   - 报告口径：`worktree <name> 已就绪，待您确认是否合并`。

5. **合并 worktree 到主分支**（用户明确说"合并"后）：
   - 分**三次独立的 Bash 调用**执行（切勿合并到同一命令！）：
     1. `authorize-main` 记录授权原因；
     2. `git merge worktree-<task>` 执行合并；
     3. `revoke-main` 立即撤销授权。
   - **为什么必须分开**：hook 在命令执行**前**做静态扫描，若 authorize 与 git merge 写在同一命令里，
     authorize 的授权还没生效，merge 就会被拦截。分三次调用确保授权先落盘、再放行操作。
   - 合并经用户确认后，才可 `exit(action="remove")` 清理副本目录（分支保留）。

6. **不进 worktree、直接改主 checkout**（最常见情况）：
   - 默认就是允许的，直接用 Write/Edit/git 操作即可，无需任何授权。
   - `git push` 到 master/main 仍需 `authorize-main` → push → `revoke-main`（安全网）。

## 拦截规则一览

| 场景 | 结果 |
|---|---|
| 未 enter，Write/Edit/Read 主 checkout | ✅ 放行（默认开放，不重写不拦截） |
| 未 enter，本地 `git merge/rebase/pull/checkout` | ✅ 放行 |
| 未 enter，`git push` 到 master/main | 🔴 拦截（安全网，需授权） |
| 有绑定，写主 checkout 路径 | ✅ **自动重写**到 worktree（你无感知） |
| 有绑定，写副本内路径 | ✅ 放行 |
| 有绑定，Glob/Grep 无 path | ✅ 自动注入 path=worktree |
| 有绑定/在副本内，写其他副本 | 🔴 拦截（跨副本保护） |
| 未 enter 或有绑定，写其他副本 | 🔴 拦截（跨副本保护，始终生效） |
| 写 `.git` 路径 | 🔴 拦截（保护 git 元数据，硬规则） |
| 有绑定/在副本内，受保护分支上 `git merge/rebase/pull` | 🔴 拦截（需授权） |
| 有绑定/在副本内，`git checkout master/main`、删 `worktree-*` 分支 | 🔴 拦截 |
| 任何位置 `git push` 到 master/main | 🔴 拦截（需授权） |
| 副本内 `git merge master`（同步基线） | ✅ 放行 |
| `authorize-main` 授权期间 | ✅ 全部放行（`.git` 仍拦） |
| 仓库外路径、非 git 目录 | ✅ 放行 |

已知边界：hook 是 fail-open（脚本异常放行）；Bash 工作目录无法被重写，只拦危险 git 操作。

## 与纪律的对照表

| 操作 | 允许位置 | 是否需要用户明确授权 |
|---|---|---|
| 写代码/改文件（默认） | 主 checkout 或 enter 后的 worktree 副本 | 否 |
| enter 后改主 checkout | 自动重写到副本（或用 allow/whitelist 例外） | 否 |
| `git push` → master/main | 主 checkout | 是 |
| `git merge worktree-xxx` → 主分支 | 主 checkout | 是 |
| `git merge master` → 副本 | worktree 副本 | 否（同步基线） |
| `git checkout master/main` | worktree 副本内禁止 | 是 |
| 删除 worktree 分支 | 任何位置 | 是 |
