# zcode-worktree-guard

> Transparent git-worktree enforcement for [ZCode](https://z.ai) — the agent never has to remember paths, because the plugin rewrites them at the tool layer.

强制 git worktree 工作流的 ZCode 插件。**路径透明重写 + 主分支写保护 + 危险操作拦截**，三层防御让 AI agent 在 worktree 模式下不再漂移。

---

## 为什么需要它

让 AI agent 在 git 仓库里干活时，有两个挥之不去的痛点：

- **路径漂移（path drift）**：agent 以为自己写进了 worktree，实际写到了主 checkout——或反之。这是 worktree 工作流的头号挫折来源。
- **遵循度**：即使有提示词指导，agent 也常常忘记"先进 worktree 再改代码"，直接在主分支上动手，污染主分支。

`zcode-worktree-guard` 从**机制层**消除这两个问题——不靠 agent 记住规则，而是让违规在物理上不可能发生。

## 它怎么工作

三层防御，强度递增：

```
 ┌─────────────────────────────────────────────────────────┐
 │  ① SessionStart 软提示                                   │
 │     会话启动时自动注入 worktree 纪律（agent 默认知晓）    │
 ├─────────────────────────────────────────────────────────┤
 │  ② PreToolUse 透明重写（核心）                            │
 │     Write/Edit/Read/Glob/Grep 的路径                     │
 │     从主 checkout 根 → 自动改写到活动 worktree            │
 │     agent 无需改路径，文件就落在正确位置                   │
 ├─────────────────────────────────────────────────────────┤
 │  ③ PreToolUse 硬拦截（兜底）                              │
 │     无 worktree 时写主分支 → deny                         │
 │     master/main 上 git merge/rebase/push → deny          │
 │     worktree 内 git checkout master → deny               │
 └─────────────────────────────────────────────────────────┘
```

**最关键的一层是 ② 透明重写**：agent 写 `src/app.js`，插件把它改写成 `.worktrees/worktree-xxx/src/app.js`，文件直接落进 worktree。agent 全程无感知——这正是"路径漂移从机制上消除"的含义。即使 agent 偶尔疏忽，第 ③ 层会硬拦住真正危险的操作。

## 特性

| 特性 | 说明 |
|---|---|
| 🔄 **透明路径重写** | 主 checkout 路径自动改写到活动 worktree，agent 无感知 |
| 🔴 **主分支写保护** | 无活动 worktree 时，写主 checkout 一律拦截 |
| 🛡️ **危险操作拦截** | merge/rebase/push 到 master/main、副本内 checkout master、删 worktree 分支 |
| 🧠 **自动纪律注入** | SessionStart hook 让每个会话默认知道 worktree 工作流 |
| 📦 **完整生命周期** | create / enter / exit / status / authorize-main / revoke-main |
| 🔍 **Bash cd 解析** | 从命令串提取 `cd` 目标，跨会话目录也能定位真实工作位置 |
| 🗂️ **仓库级绑定** | 状态存 git common dir，重启自动恢复，子代理自动继承 |
| 🪶 **零依赖** | 纯 Node.js 标准库，与 ZCode 同栈 |

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
| 有活动 worktree，写主 checkout 路径 | ✅ **自动重写**到 worktree |
| 有活动 worktree，写副本内路径 | ✅ 放行 |
| 有活动 worktree，Glob/Grep 无 path | ✅ 自动注入 path=worktree |
| 无活动 worktree，Write/Edit 主 checkout | 🔴 拦截（写保护） |
| 无活动 worktree，Read 主 checkout | ✅ 放行（只读不拦） |
| 写 `.git` 路径 | 🔴 拦截（保护 git 元数据） |
| master/main 上 `git merge/rebase/pull` | 🔴 拦截（需授权） |
| `git push` 到 master/main | 🔴 拦截（需授权） |
| 副本内 `git checkout master/main` | 🔴 拦截 |
| 删除 worktree 分支 | 🔴 拦截 |
| `authorize-main` 授权期间 | ✅ 全部放行 |
| 仓库外路径、非 git 目录 | ✅ 放行 |

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

## 设计与实现

- **[docs/design.md](docs/design.md)** — 完整设计文档：契约证据（PreToolUse 改写能力的实测验证）、架构决策、审计修正记录、已知边界
- 纯 TypeScript（`.mjs`），与 ZCode 同栈，零运行时依赖
- 已端到端验证：24 个命令行场景 + 真实 hook 管道全流程（create → enter → 透明重写 → exit → 授权合并）

## License

[MIT](LICENSE)
