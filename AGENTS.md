# AGENTS.md

本仓库（zcode-worktree-plugin）的 agent 工作纪律与项目要点。

## 版本发布须用户授权（硬性规则）

**未得用户明确授权，不得进行版本发布。** 本仓库的"版本发布"包括以下任一动作：

- `git push` 到 `master`（含 merge 提交的推送）；
- 创建/推送版本 tag（`v0.4.x` 等）；
- 升版本号（`plugin.json` 的 `version`）并对外提供（commit/push）；
- 更新插件发布缓存（`~/.zcode/cli/plugins/cache/zcode-worktree-plugin/...` 及
  `installed_plugins.json` 的版本指向）。

规则边界：

- **允许**：在本地分支上 commit、跑测试、写代码与文档——这些不构成发布；
- **须逐次授权**：每次发布动作都需要用户当次明确同意（"发布 X 版本"），历史授权
  不延续到下一次发布；
- 实现 + 测试全绿后，**停在待发布状态**（本地分支就绪、CHANGELOG 写好），向用户
  汇报并等待授权，再执行 push / 缓存更新。

发布相关的既有流程惯例（分支 `fix/vX.Y.Z-*` → commit → merge --no-ff → push →
手动更新缓存）保持不变——只是每个发布环节须先获用户授权。

## 仓库结构与架构边界

- 仓库用途：ZCode 的 git worktree 隔离插件 `zcode-worktree-guard`（marketplace
  目录源，根 `marketplace.json` 指向 `plugins/zcode-worktree-guard/`）。
- `plugins/zcode-worktree-guard/scripts/`：
  - `common.mjs` —— 共享工具（git 封装、路径归一化 norm、绑定解析、状态读写），
    wt.mjs 与 guard_hook.mjs 共用；**纯 Node 标准库、零依赖、ESM .mjs**（禁止引依赖）；
  - `wt.mjs` —— 生命周期 CLI（create/enter/exit/remove/status/authorize-main/
    revoke-main/allow）；
  - `guard_hook.mjs` —— PreToolUse hook：透明路径重写（`hookSpecificOutput.updatedInput`）
    + 危险 git 拦截；**fail-open**（内部异常放行 + 审计），勿改成 fail-closed；
  - `session_start.mjs` —— SessionStart hook：注入绑定状态提示。
- `tests/v2.test.mjs` —— 全部测试在单文件：spawn 真实子进程 + 真实 git、自建临时
  仓库；**既有用例零翻转是发布惯例**。
- `docs/design.md` —— 设计文档；**改 `scripts/` 前先读它和 `CHANGELOG.md`**。
- 敏感点：`guard_hook.mjs` 的 `block()` 文案、`decideWrite` 返回的 reason/remedy
  字符串被测试逐字断言（`assertBlock` 子串）——改文案先查测试。

## 常用命令

- 全量测试：`node --test tests/v2.test.mjs`（约 2 分钟，204 用例）
- 聚焦测试：`node --test --test-name-pattern "P[0-9]+:" tests/v2.test.mjs`
- 语法检查：`node --check plugins/zcode-worktree-guard/scripts/<x>.mjs`
- 引擎级插件校验：`node "<ZCode 安装目录>/resources/glm/zcode.cjs" plugins validate
  plugins/zcode-worktree-guard`（也可加 plugin-creator 的 `validate-plugin.mjs` 预检）
- 无构建/lint 步骤（零依赖，直接跑 node）。

## 发布流程（获用户授权后执行）

分支 `fix/vX.Y.Z-*` → commit（`feat/fix(vX.Y.Z): ...`）→ master 上 `merge --no-ff`
（`Merge vX.Y.Z: ...`）→ push → 本机生效走**引擎市场流**（勿再手动 cp 缓存/手改
`installed_plugins.json`——引擎自带完整账本，手改会绕过缓存交易与旧版本清理）：

- UI 流：插件市场 → 市场源 → 刷新 `zcode-worktree-plugin`（本仓库根目录已注册为
  directory 市场）→ 个人 → 插件详情 → **更新** → 确认版本 → 重启 ZCode。
- CLI 流（无 PATH 上的 zcode 命令时用引擎包入口）：
  `node "<ZCode>/resources/glm/zcode.cjs" plugins marketplace update zcode-worktree-plugin`
  → `node "<ZCode>/resources/glm/zcode.cjs" plugins update zcode-worktree-guard@zcode-worktree-plugin`
  → 重启 ZCode。命令与全链路已在隔离环境（`ZCODE_STORAGE_DIR=<临时目录>`）实测过
  （add → install → manifest 升版 → marketplace update → plugins update，0.1.0→0.2.0 成功）。

版本发布前同步四处版本：`plugin.json` 的 `version`、`marketplace.json` 条目的
`version`（引擎安装/更新以**插件清单**为准，条目 version 是规范遵循与展示冗余）、
`CHANGELOG.md` 新小节、README 测试数（如用例数变化）。`CHANGELOG.md` 每版本一节。

> 历史更正（2026-09-22 复核）：本节曾记载"zcode CLI 无 install 子命令"——该前提已
> 过时。引擎 `zcode.cjs 0.16.9`（Desktop 3.14.1）带完整 `plugins
> install|uninstall|enable|disable|update|validate|marketplace` CLI。2026-08-27 前
> 的手动 cp 流程是当时的权宜，此后弃用。

## 已知坑（本仓库特有）

- **ZCode 运行缓存副本而非本仓库源码**：源码改绿后运行时不变；须走上面的市场刷新+
  更新（或 `plugins.dirs` 本地加载）才生效，且已启动的会话仍用旧 hook，新会话才生效。
- **插件会拦自己的发布 push**：push master 被 push 安全网拦 → `authorize-main` →
  push → `revoke-main`，**三次独立 Bash 调用**（组合命令整条被拦，设计行为）。
- **Bash 整行正则会误拦字符串数据**：heredoc/命令文本里含字面 `git push origin
  master`、`git branch -d worktree-*` 会被误判为命令——写含这类文本的文件用
  Write 工具落盘再 `cat` 追加，别走 Bash heredoc。
- **Git Bash 吃反斜杠**：`echo`/`printf` 管道传含反斜杠路径的 JSON 会损坏；
  改 `installed_plugins.json` 这类 JSON 一律用 Write 落 node 脚本文件再运行，
  别 `node -e` 内联。
- **wt.mjs 会话身份机制勿破坏**：ZCode 不向 Bash 子进程注入会话变量，
  `guard_hook` 对调用 wt.mjs 的 Bash 命令注入 `export ZCODE_SESSION_ID=<id>; `
  前缀（`injectSessionEnv`）——这是绑定按会话生效的根基。

## 文档同步纪律

改行为/发版本时同步：`CHANGELOG.md`、`README.md`、`SKILL.md`、
`commands/worktree.md`、脚本内提示文案（session_start / exit 回执 / block 文案）
——历史上多次只改代码漏改文档，审查时这些是固定检查项。
