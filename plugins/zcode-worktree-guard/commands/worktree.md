---
description: 管理 git worktree 工作流（创建/进入/退出/收尾清理/状态/授权）。加载 worktree-workflow 技能获取完整指引。
---

加载 `worktree-workflow` 技能，然后按用户意图执行对应的 worktree 操作。

## 子命令路由

用户输入 `/worktree <subcommand> [args]`，按下面映射执行（脚本路径用本 skill 的 base directory 拼出）：

| 用户说 | 执行 |
|---|---|
| `/worktree status` 或 `/worktree` | `echo '{}' | node <base>/../../scripts/wt.mjs status` |
| `/worktree create <task>` | `echo '{"task_name":"<task>"}' | node <base>/../../scripts/wt.mjs create` |
| `/worktree enter <path>` | `echo '{"path":"<path>"}' | node <base>/../../scripts/wt.mjs enter` |
| `/worktree exit` | `echo '{"action":"keep"}' | node <base>/../../scripts/wt.mjs exit` |
| `/worktree exit remove` | `echo '{"action":"remove","confirm_remove":true}' | node <base>/../../scripts/wt.mjs exit` |
| `/worktree exit remove delete-branch` | `echo '{"action":"remove","confirm_remove":true,"delete_branch":true}' | node <base>/../../scripts/wt.mjs exit`（合并后收尾：删副本目录 + 清理已合并分支） |
| `/worktree remove <path>` | `echo '{"path":"<path>","confirm_remove":true,"delete_branch":true}' | node <base>/../../scripts/wt.mjs remove`（已退出后的收尾，无需活动绑定） |
| `/worktree authorize-main <reason>` | `echo '{"reason":"<reason>"}' | node <base>/../../scripts/wt.mjs authorize-main`（默认 15 分钟自动失效） |
| `/worktree revoke-main` | `echo '{}' | node <base>/../../scripts/wt.mjs revoke-main` |

> `<base>` 是本 skill 的 base directory（见上下文末尾的 "Base directory for this skill" 行）。
> 脚本实际位于 `<plugin>/scripts/wt.mjs`，从 skill base 看是 `../../scripts/wt.mjs`。

## 执行后

把脚本输出的 JSON（`{"content": ...}`）里的 content 解析出来，以可读形式汇报给用户，
并按 worktree-workflow 技能里的"报告口径"给出下一步建议。
