# zcode-worktree-guard

> Optional git-worktree isolation for [ZCode](https://z.ai) — default to working freely on the main checkout; once you `enter` a worktree, the plugin rewrites paths at the tool layer so the agent never has to remember them.

可选的 git worktree 隔离插件。**默认在主 checkout 自由工作；`enter` 后路径透明重写到副本 + 跨副本/危险 git 操作拦截**，让 AI agent 在 worktree 模式下不再漂移，又不会在不想隔离时被强行拦在主分支外。

---

## 为什么需要它

让 AI agent 在 git 仓库里干活时，有两个挥之不去的痛点：

- **路径漂移（path drift）**：agent 以为自己写进了 worktree，实际写到了主 checkout——或反之。这是 worktree 工作流的头号挫折来源。
- **误改主分支 / 危险 git 操作**：即使有提示词指导，agent 也可能在不想动主分支时动了，或误执行 `git push` 到 master/main。

`zcode-worktree-guard` 的策略是**默认开放，按需隔离**：

- 默认在主 checkout 自由工作，不拦截、不重写——你不想隔离时完全无感；
- 一旦 `enter` 一个 worktree，本会话的写路径透明重写到副本，agent 无感知；
- 始终的安全网：跨副本写入、写 `.git`、`git push` 到 master/main、删 worktree 分支一律拦截。

## 它怎么工作

默认开放，按需隔离。`enter` 一个 worktree 后，本会话才进入"锁定到副本"模式：

```
 ┌─────────────────────────────────────────────────────────┐
 │  ① SessionStart 提示                                     │
 │     会话启动时告知当前是"默认开放"还是"已绑定副本"          │
 ├─────────────────────────────────────────────────────────┤
 │  ② PreToolUse 透明重写（enter 之后的核心）                │
 │     Write/Edit/Read/Glob/Grep 的路径                     │
 │     从主 checkout 根 → 自动改写到绑定的 worktree          │
 │     agent 无需改路径，文件就落在正确位置                   │
 ├─────────────────────────────────────────────────────────┤
 │  ③ 始终生效的硬拦截（安全网）                             │
 │     跨副本写入 / 写 .git → deny                          │
 │     git push 到 master/main、删 worktree 分支 → deny     │
 │     有绑定/在副本内：受保护分支 merge/rebase/pull → deny  │
 └─────────────────────────────────────────────────────────┘
```

**未 `enter` 时：Write/Edit/Read 主 checkout、本地 git 操作一律放行**——这就是正常的主仓库工作流。
**`enter` 之后，最关键的是 ② 透明重写**：agent 写 `src/app.js`，插件改写成 `.worktrees/worktree-xxx/src/app.js`，文件直接落进 worktree，agent 全程无感知。第 ③ 层安全网无论是否 enter 都在。

## 特性

| 特性 | 说明 |
|---|---|
| 🔄 **透明路径重写** | `enter` 后，主 checkout 路径自动改写到绑定 worktree，agent 无感知 |
| 🔓 **默认主副本开放** | 未 `enter` 时，Write/Edit/本地 git 操作自由放行，不重写不拦截 |
| 🛡️ **始终生效的安全网** | 跨副本写入、写 `.git`、`git push` 到 master/main、删 worktree 分支一律拦截；有绑定时再加受保护分支 merge/rebase/pull 拦截 |
| 🧠 **自动纪律注入** | SessionStart hook 让每个会话默认知道 worktree 工作流 |
| 📦 **完整生命周期** | create / enter / exit / status / authorize-main / revoke-main / allow |
| 🔍 **Bash cd 解析** | 从命令串提取 `cd` 目标，跨会话目录也能定位真实工作位置 |
| 🔗 **会话级绑定 + 继承** | 每 session 独立绑定，子代理经 DB parent 链自动继承父 worktree |
| 🚪 **双层逃生口** | 声明式白名单（`main_write_whitelist`）+ 临时 allow 放行（带 TTL + 审计） |
| 📂 **文件同步** | worktree 创建后自动复制文件（`copy_files`）+ 链接目录（`symlink_dirs`，Windows junction 无需管理员权限） |
| 🪶 **零依赖** | 纯 Node.js 标准库（ESM `.mjs`），与 ZCode 同栈 |

## 安装

### 要求

- ZCode 客户端
- Node.js（hook 通过 `node` 调用，需在 PATH 中可用）
- `git` 在 PATH

### 方式 A：从 GitHub 安装（推荐）

Settings → Plugin Management → **Discover** → 右上角 **`+`** → 输入：

```
earneet/zcode-worktree-plugin
```

添加 marketplace 后，在 Discover 找到 `zcode-worktree-guard` 点 **Get**。重启 ZCode 生效。

或指定分支 / tag / commit：

```
earneet/zcode-worktree-plugin/tree/<ref>
```

### 方式 B：从本地目录安装

Settings → Plugin Management → **Discover** → **`+`** → 选择本仓库根目录
（含 `marketplace.json` 的那一层）→ 在 Discover 找到 `zcode-worktree-guard` 点 **Get**。重启 ZCode 生效。

### 方式 C：plugins.dirs 本地加载（纯开发调试）

在 `~/.zcode/cli/config.json` 加：

```json
{ "plugins": { "dirs": ["<本仓库>/plugins/zcode-worktree-guard"] } }
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

> `task_name` 必须是小写字母/数字/连字符的 slug（如 `fix-login`），不接受大写/下划线/空格/中文。

## 拦截规则一览

| 场景 | 结果 |
|---|---|
| 无绑定，Write/Edit/Read 主 checkout | ✅ 放行（默认开放，不重写不拦截） |
| 无绑定，本地 `git merge/rebase/pull/checkout` | ✅ 放行 |
| 无绑定，`git push` 到 master/main | 🔴 拦截（安全网，需授权） |
| 有绑定，写主 checkout 路径 | ✅ **自动重写**到 worktree（Read 同样重写，保持视图一致） |
| 有绑定，写副本内路径 | ✅ 放行 |
| 有绑定，Glob/Grep 无 path | ✅ 自动注入 path=worktree |
| **写**其他 worktree 副本（不论有无绑定） | 🔴 拦截（跨副本保护） |
| **Read** 其他 worktree 副本 / `.git` 内文件 | ✅ 放行（读无害，对比/排障常需；v0.4.1） |
| 路径命中白名单或 allowlist | ✅ 放行（写主目录，不重写） |
| 写 `.git` 路径 | 🔴 拦截（硬规则，优先于一切） |
| 有绑定/在副本内，受保护分支上 `git merge/rebase/pull` | 🔴 拦截（需授权） |
| `git push` 到 master/main | 🔴 拦截（需授权） |
| 有绑定/在副本内，`git checkout master/main` | 🔴 拦截 |
| 删除 worktree 分支 | 🔴 拦截 |
| `authorize-main` 授权期间 | ✅ 全部放行（`.git` 仍拦） |
| 仓库外路径、非 git 目录 | ✅ 放行 |

## 可选配置

仓库根 `<repo>/.zcode/worktree-guard.json`：

```json
{
  "branch_prefix": "worktree-",
  "worktree_parent": ".worktrees",
  "protected_branches": ["master", "main"],
  "main_write_whitelist": ["AGENTS.md", "docs/**/*.md"],
  "sync": {
    "copy_files": [".env", "package.json"],
    "symlink_dirs": ["node_modules", ".venv"]
  }
}
```

| 字段 | 说明 |
|---|---|
| `branch_prefix` | worktree 分支名前缀（默认 `worktree-`） |
| `worktree_parent` | worktree 副本父目录（默认 `.worktrees`） |
| `protected_branches` | 额外受保护分支（默认含 `master`、`main`） |
| `main_write_whitelist` | 声明式白名单：这些路径写主目录不重写不拦截（glob 支持 `*`/`**`/`?`）。危险裸根模式（`*`、`/`、`.` 等）会被自动过滤 |
| `sync.copy_files` | worktree 创建后从主 checkout 复制的文件列表（相对路径，如 `.env`、`package.json`） |
| `sync.symlink_dirs` | worktree 创建后从主 checkout 链接的目录列表（相对路径，如 `node_modules`）。Windows 用 junction（无需管理员权限），其他平台用 dir symlink。清理 worktree 时先安全移除链接，避免递归删除误删主仓库内容 |

### 临时放行（allow 逃生口）

**默认（未 `enter`）写主 checkout 本来就放行，不需要 allow。** 仅当你已 `enter` 一个 worktree、又想例外写主 checkout 某路径（绕过重写）时：

```bash
# 放行单个路径 60 分钟（可配 ttl_minutes），记审计日志
echo '{"action":"add","path":"README.md","reason":"临时改文档"}' | node <plugin>/scripts/wt.mjs allow
echo '{"action":"list"}' | node <plugin>/scripts/wt.mjs allow    # 查看
echo '{"action":"clear"}' | node <plugin>/scripts/wt.mjs allow   # 清空
```

`.git`、根目录、`*` 等危险路径会被拒绝（注入防护）。

## 状态文件位置

```
<git-common-dir>/worktree-guard/
  bindings/       # 会话级绑定（每 session 一文件：<session_id>.json）—— 绑定真值
  state.json      # 最近一次活动 worktree 记录 + 全局授权标记（非绑定真值）
  bases.json      # 各 worktree 的 base 分支
  allowlist.json  # 临时放行条目（带 TTL，过期自动 GC）
  audit.jsonl     # allow 操作审计日志
  meta.json       # schema 版本（迁移检测）
```

不进版本库、所有 worktree 共享（存 git common dir）。绑定只来自本会话 `enter`，不随重启自动恢复（上个会话的 enter 不会延续）。

### 绑定解析

当前会话的 worktree 绑定按优先级解析：

1. **自身直绑** — `bindings/<session_id>.json`（`enter` 写入，最高优先）
2. **DB parent 继承** — 子代理（`sess_subagent_*`）经 ZCode SQLite 的 `parent_id` 链继承父绑定，快照到自身
3. **无绑定** — 主副本自由工作（Write/Edit/本地 git 放行，不重写）

> `state.json` 只记录最近一次活动 worktree，**不产生绑定**——这保证上个会话的 `enter` 不会把新会话自动锁进副本。

### 会话身份注入（v0.4.1）

ZCode 只把 `session_id` 放进 hook 的 stdin payload，**不注入 Bash 工具子进程的环境变量**——
`wt.mjs`（agent 经 Bash 调用）自身拿不到真实会话 id。v0.4.0 曾因此出现"enter 写入的绑定
对 hook 永远不可见"的线上回归（重写失效 + 跨副本误拦）。

修复机制：`guard_hook` 在 PreToolUse 检测到 Bash 命令调用 `wt.mjs` 时，经 `updatedInput`
注入 `export ZCODE_SESSION_ID=<会话id>; ` 命令前缀——身份随进程环境确定性传递（无锁文件、
无竞态）。id 仅放行 `^[A-Za-z0-9._-]+$`（防 shell 注入），已含该变量时跳过（幂等），且注入
发生在全部拦截检查之后（不跳过任何保护）。

终端手工调用 `wt.mjs`（无会话上下文）落到 `cli-manual` 兜底 id——该绑定对 ZCode 会话
不可见，`wt.mjs status` 会明确提示。

## 设计与实现

- **[docs/design.md](docs/design.md)** — 完整设计文档：契约证据（PreToolUse 改写能力的实测验证）、架构决策、审计修正记录、已知边界
- 纯 Node.js ESM（`.mjs`），与 ZCode 同栈，零运行时依赖
- **148 个自动化测试用例**（`node --test tests/v2.test.mjs`）：覆盖决策表、Bash 拦截、绑定三层降级、白名单、allowlist、生命周期、SessionStart、会话身份注入端到端（N 组）等全部子系统

## License

[MIT](LICENSE)
