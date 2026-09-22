# Changelog

本文件记录 zcode-worktree-guard 的版本演进。详细设计见 [docs/design.md](docs/design.md)。

## [0.4.6] — 2026-09-22

### 背景：plugin-creator 标准审查 + 二次复核修正

按 plugin-creator 技能标准对本插件做了一次全面审查，随后对审查结论逐条二次复核。
**复核推翻了审查的一条主要论断**，如实记录以防误引：审查曾认为 `marketplace.json`
条目缺 `version` 会导致外部用户装成 0.0.0 且丢失更新提示——隔离环境（`ZCODE_STORAGE_DIR`）
端到端实测证明**不成立**：引擎安装/更新都以**插件清单**的 `version` 为准
（add → install → manifest 升版 → marketplace update → plugins update，0.1.0→0.2.0
正常）。本机 `context7` 装成 0.0.0 的根因是它自己的 `plugin.json` 没有 version 字段。

### 修复：ApplyPatch 分发覆盖——补丁式写工具不再绕过守卫（审查复核后成立）

引擎（zcode.cjs 0.16.9）的工具注册表含 `ApplyPatch`（OpenAI responses 提供方的补丁式
写工具，`isWriteTool` 与 Write/Edit/Bash 同类）。hook 触发本就有效——引擎对 hook matcher
做**别名展开**（ApplyPatch→[Write,Edit]，命中即触发，stdin 上仍是真实名）——但
`guard_hook.mjs` 分发层没有该分支，绑定态下 ApplyPatch 写主 checkout **静默放行**：
不重写、无跨副本/`.git` 写保护（正是本插件要消灭的路径漂移）。现补齐：与 Write 同一
`decideWrite` 决策表（create/update/delete 三种 operation 都视为写），重写只替换
`operation.path`（`callId`/`diff`/`type` 原样保留以过 schema 校验），畸形输入 fail-open
放行。hooks.json matcher 显式补 `ApplyPatch`（自文档化；引擎别名下行为不变）。
GLM 等走 Write/Edit 的提供方不产生该工具，无感知。

### 新增：市场条目展示元数据 + LICENSE 随插件分发

- `marketplace.json` 条目补 `version`/`description`/`displayName`/`displayName_i18n`/
  `description_i18n`/`category`（plugin-creator 规范形态；displayName/i18n/category
  只能来自条目——引擎不从清单回填这些展示字段）。
- `plugin.json` 显式声明 `"hooks": "hooks/hooks.json"`（自文档化；引擎自动发现 +
  显式声明按 realpath 去重，行为不变）。
- LICENSE 复制进插件目录（市场安装只复制插件目录，此前分发副本不含许可文本）。

### 文档：发布流程更正 + 边界补记

- **AGENTS.md 发布流程重写**：原"zcode CLI 无 install 子命令 → 手动 cp 缓存 + 手改
  `installed_plugins.json`"前提已过时（引擎 0.16.9 带完整 `plugins install/update/
  marketplace` CLI，且本仓库根目录早已注册为 directory 市场）。本机生效改为
  市场刷新 + 插件更新（UI 或 CLI），授权门（不 push/不升版对外提供/不动安装态须
  用户逐次授权）不变。手动 cp 流程弃用。
- README/SKILL.md/design.md：拦截规则表补 ApplyPatch 行；已知边界补记"经 MCP 工具
  写盘（如 node-repl）不在守卫范围"（tool_input 无路径语义，等同 Bash 边界）；
  design.md §3.2 工具字段表补 ApplyPatch 行及引擎证据（别名展开 + `{callId,
  operation:{type,path,diff}}` 形状）；README 测试数 157 → 204（陈旧，实际已 195，
  本版 R 组再 +9）。
- AGENTS.md 本身入库（此前一直未跟踪，发布纪律文档不在版本库是中间态）。

### 测试

新增 R 组 9 例：ApplyPatch 绑定态重写（update/create/delete/相对路径）、副本内放行、
`.git` 拦截、无绑定跨副本拦截、无绑定主 checkout 放行、畸形输入 fail-open。
既有用例零翻转（195 例不变），总计 **204 例全绿**。

## [0.4.5] — 2026-09-17

### 背景：issues #3-#7（清理链路的安全与生命周期反馈）

五位使用者的实测反馈，本版按评估结论逐条处理：#3 链接穿透（高危）、#4 exit 猜测删除
目标（高危）、#5 死会话绑定无回收、#6 文件锁半成功缺指引、#7 status 缺收尾盘点。
#5 的根治方案（SessionEnd 钩子）经核实不可行——ZCode 插件 hook 仅支持 SessionStart/
UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop 七种
事件（`Stop` 每轮回复结束都触发，不能当会话结束用），改为"死会话判定 + prune + stale
标注"组合。

### 修复：remove 前全量摘除副本内链接——未声明的 junction 不再穿透（issue #3）

`cleanupWorktree()` 此前只摘 config 声明的 `symlink_dirs`；agent/用户手工创建的
junction/symlink（`mklink /J`、`New-Item -ItemType Junction`——Windows 共享大体积依赖
的常规操作）不在保护范围，`git worktree remove` 的递归删除会跟随链接**删掉目标目录的
内容**（目标通常在副本之外：共享缓存/工具链/主 checkout）。现在 `git worktree remove`
之前对副本目录树做**全量 lstat 扫描**（跳过 `.git`），发现任何链接一律先 unlink
（`lstatSync().isSymbolicLink()` 对 junction 同样为 true；unlink 不跟随不递归）——目录
本来就要整体删除，先摘链接严格更安全。摘除清单进回执供审计。性能敏感场景
（pnpm 式符号链接农场）可配 `sync.link_scan: "declared"` 回退仅摘声明项（v0.4.4 行为）。

### 修复：exit 接受显式 path，remove 不再从 state.json 猜目标（issue #4）

`exit` 从不读 `path` 参数；无绑定时（exit-first 流）`action=remove` 回退用 state.json
记录的"最近活动 worktree"当删除目标——而 state 是**仓库级单文件，任何会话的 enter 都会
覆写它**，清理请求可能落到无关副本上（实测仅靠悬空检查侥幸未误删）。现在：

- `exit` 接受显式 `path`：有绑定时须与绑定一致（不一致报错，绝不静默改目标）；无绑定时
  须是本仓库已注册副本；
- 无绑定 + `action=remove` 且不传 `path` → 直接拒绝，指引改用 `remove` 子命令；
- `keep` 的 state 回退保留（仅汇报用途，无害）。

### 新增：死绑定回收——判定豁免 + stale 标注 + prune 子命令（issue #5）

绑定文件只在该会话自己 exit/remove 时清除；会话异常结束/上下文耗尽/被直接关闭后绑定
**永久残留**，把 `findBindingsForWorktree()` 的"其他会话绑定"检查变成永久阻断。兜底：

- **死会话判定**（`common.deadBindingReason`）：①绑定指向的副本目录与 git 注册表均已
  消失；或 ②所属会话在 ZCode DB 有记录、但 `time_updated`（每轮回复刷新）已静默超过
  阈值（默认 24h）。DB 无记录（cli-manual、DB 不可用）保守视为活——判定失败方向是
  "继续阻断"，不会误豁免。
- **不阻断**：`exit(remove)` / `remove` 遇死绑定不再拒绝，就地回收绑定文件并在回执留痕
  （`已忽略并回收死绑定: <sid>（<死因>）`）。
- **标注**：`status` 对死绑定打 `⚠️ stale: <死因>（prune 可清理）`。
- **`prune` 子命令**：按同一判定显式清理全部死绑定，输出清理清单；`{"dry_run":true}`
  仅盘点，`idle_hours` 可调静默阈值（默认 24）。

### 新增：Windows 文件锁失败的处置指引（issue #6）

`git worktree remove` 在 Windows 下可能半成功（git 已注销注册、目录删除被构建 daemon/
IDE/文件监视器打断），首次失败的回执只有一行原始输出，调用方无从知道"关掉占用进程重试
即可命中容错路径"。现在识别 `EPERM`/`being used by another process`/`Access is denied`
等文件锁特征（`common.isLockError`），失败回执直接给出三步处置：关占用进程重试 → 重试
报 "is not a working tree" 属预期 → 残留目录可手动删除（链接已预摘除，不会穿透）。
`force_residual` 类接管删除方案评估后不做：手动删除一步之遥，接管删除扩大破坏面。

### 新增：status 收尾盘点（issue #7）

长期多会话并行的仓库必然累积收尾债，此前全部依赖人工发现。`status` 新增"收尾盘点"小节：

- **已合并可清理副本**：注册副本的分支已完全合入默认分支（`git branch --merged`，默认
  分支经 origin/HEAD → master → main 探测）且工作区干净 → 标注 `✅ 可 remove 收尾`；
- **孤儿目录**：worktree 父目录下、不在 git 注册表的目录（半删除残留等）；
- **无副本的 `worktree-*` 分支**：目录已删分支残留，标注可用 remove 子命令清理。

### 测试

`tests/v2.test.mjs` 新增 Q 组 15 用例：Q01/Q03 链接全量扫描（端到端穿透防护 + 嵌套
链接/嵌套 `.git` 链接摘除、根 `.git` 与真目录不动的单元）、Q02 linkScanMode、Q04-Q08
exit 目标闸门（一致/不一致/无绑定 remove 拒绝/keep 回退保留/无绑定显式 path 收尾）、
Q09-Q11 死绑定（stale 豁免、DB 静默豁免——用 `ZCODE_STORAGE_DIR` 指向构造 DB 做确定
性测试、prune dry_run/实删/保留）、Q12/Q13 status 盘点与 stale 标注、Q14 isLockError、
Q15 损坏副本降级标注。全量 **195 用例全绿**（既有 180 零翻转）。实现中还修复了分支名
列表解析漏剥 `+ `/`- ` 行首标记（被其他 worktree 检出/离线）的 bug——该 bug 会让盘点
把 `worktree-*` 分支误判为无副本。

### 审查修复（同日，v0.4.5 自查）

- **文件锁指引的"残留目录可手动删除"改为条件化措辞**：原先无条件声称"链接已预摘除、
  删除不会穿透"——在 `sync.link_scan="declared"` 回退模式或扫描有失败项时是不安全
  建议（残余链接仍可能被手动删除穿透）。现在只有全量扫描零失败才打包票，否则提示
  先摘除残余 junction/symlink；"is not a working tree" 容错分支的残留目录提示同口径。
- **全量链接扫描只跳过副本根的 `.git`**：原先按名字在任意深度跳过——vendored 嵌套
  仓库内的链接（含嵌套 `.git` 本身是 symlink 的罕见形态）不在保护范围。现在嵌套
  `.git` 若是链接一律摘除、若是真目录则照常扫描其内容。Q03 补断言。
- **status 盘点对单个副本的脏检查失败降级标注**：`dirtySummary` 内部 `git status`
  失败（副本损坏，如 `.git` 指针悬空）原先会让整个 status 以"工具内部错误"崩掉——
  status 是排障入口，必须比被盘点对象更健壮。现在该条标注"脏检查失败（副本可能
  损坏）→ 人工确认后再收尾"，其余盘点照常输出。Q15 回归锁（注：损坏形态须用悬空
  `.git` 指针——直接删 `.git` 文件时 `git -C` 会向上遍历找到主仓库 `.git`、静默对
  主 checkout 求值，测不出该路径；且该文件带 Git for Windows 特殊属性，改写须
  unlink 后重建）。
- **exit 无绑定回执不再谎称"绑定已清除"**：经显式 path / state 回退执行且本会话
  原无绑定时，改提示"本会话原无绑定"；有绑定时保持原文案（既有断言不变）。
- **测试夹具隔离（稳定性）**：`makeRepo` 显式 `core.fsmonitor false`——本机系统级
  `core.fsmonitor=true` 会让 git 在每个临时仓库拉起 detached 的 fsmonitor--daemon，
  守护进程继承 stdio 管道句柄，把无超时的 `spawnSync` 永久挂起（本轮实测卡死
  makeRepo 的 `git commit`，kill 后复跑即绿；此前一轮全量跑的偶发单失败同源）。

### 文档

README（特性表、工作流速览、`sync.link_scan` 配置、prune/死绑定说明）、SKILL.md（exit
path、prune 命令、收尾流程补盘点与死绑定回收）、commands/worktree.md（路由表补 prune
与 exit path）同步更新；拦截文案 footer 的子命令列表补 `prune`。

## [0.4.4] — 2026-08-25

### 背景：issue #1（v0.4.2 全生命周期实测反馈）

外部 agent 实测反馈四点：①清理链路断裂（exit 后无 remove 路径）；②authorize-main
粒度过粗且 revoke 靠自觉；③拦截提示单行长文本、放行命令被截断到不可见（最终靠读源码
找到命令）；④组合命令整行匹配、无"请拆开执行"说明。本版按评估结论逐条处理（①remove
子命令 + ②TTL + ③④文案重构；按操作授权/`&&` 语义拆分/svn 拦截评估为不做）。

### 新增：`remove` 子命令——exit-first 流的收尾正规路径（反馈①）

报告者的自然流是 `exit(keep) 先退出 → 主副本自由合并（默认开放，无需授权）→ 清理`。
但 exit 后绑定与 state 均已清空，`exit(remove)` 报"没有活动 worktree"；agent 只能裸跑
`git worktree remove`（放行）+ `git branch -d`（被拦）——清理链路断裂。v0.4.3 的
`exit(delete_branch)` 只覆盖"绑定中收尾"，未覆盖此流。

**修复**：`wt.mjs remove {path, confirm_remove, delete_branch}` 接受显式 path，无需
活动绑定。两种形态：①path 是已注册 worktree → 完整清理（安全删链接 → worktree
remove → 可选删分支）；②path 已不在注册表（如已手动 remove）但同名 `worktree-*`
分支仍在（目录名=分支名约定 + 前缀校验）→ 仅剩分支清理。安全闸门与 exit(remove)
一致：其他会话绑定拒绝、脏工作区拒绝、`confirm_remove` 必需、分支删除仅 `git
branch -d`（未合并自动保留）。自身绑定态调用 remove 兼作退出（清绑定）。

```bash
# exit-first 流收尾：删副本目录 + 清理已合并分支
echo '{"path":".worktrees/worktree-<slug>","confirm_remove":true,"delete_branch":true}' | node "<WT>" remove
```

### 新增：authorize-main TTL（反馈②）

`allow_main_writes` 此前无过期机制——revoke 全靠调用方自觉，忘了就无限期裸奔
（实测确认）。现在授权默认 **15 分钟自动失效**（`ttl_minutes` 可调），输出与
`status` 显示本地到期时间。旧版本写入的无 `allow_expires_at` 授权按已过期处理
（收紧方向）。按操作收窄授权（`--op branch-delete`）评估后不做：`exit(delete_branch)`
+ `remove` 已覆盖高频场景，剩余授权场景（绑定态 merge/push master）本就是全局写性质。

### 重构：拦截文案——解法前置 + 可复制命令 + 拆分执行提示（反馈③④）

旧文案把可执行的放行命令埋在"修正方式"第 3 条、排在 5 行上下文之后，终端截断后
不可见。新版结构：**拦截原因置顶 → 针对性解法（含可整行复制的命令）紧随 → 上下文
压缩为一行后置**。每类拦截给专属解法（push → authorize 三步、删分支 → exit/remove
两条收尾路径、跨副本写 → enter 命令、受保护分支 mutate → exit 或授权）。Bash 拦截
追加提示：**组合命令（A && B）在执行前被整条静态检查，authorize/exit 不会先生效，
请拆开分步执行**（反馈④：`authorize-main && git branch -d` 被拦且无解释，agent 靠
试错才发现要拆）。按 `&&`/`;` 语义拆分评估为不可行：PreToolUse hook 在任何一段执行
前求值，"预知"授权将发生等于允许命令行内自我授权。

### 测试

`tests/v2.test.mjs` 新增 P 组 17 用例：P01-P09 remove 子命令（exit-first 全流程、
未合并保留、confirm 闸门、形态②分支残留、他席占用、脏区、自绑定兼退出、未注册拒绝）、
P10-P14 TTL（默认 15min/过期判负/hook 恢复拦截/ttl_minutes/旧数据收紧/revoke 清字段）、
P15-P17 文案（解法前置、authorize/remove/enter 指引、拆分执行提示）。全量 **177 用例
全绿**（160 既有零翻转）。

### 审查修复（同日，v0.4.4 自查）

- **exit(keep) 回执的 remove 示例改为合法 JSON**：原先拼 Windows 绝对路径进 JSON
  字符串——反斜杠未转义是非法 JSON 转义，agent 照抄执行会 `JSON.parse` 失败、
  remove 报"缺少 path 参数"。改为仓库内相对路径（正斜杠）+ `JSON.stringify`
  兜底转义，P18 回归锁（从回执提取示例并 parse）。
- **remove 形态② 增加"路径须在本仓库内"约束**：仓库外路径仅凭 basename 与分支
  撞名即可进入清理流程（-d 闸门虽兜底，语义上不应受理），现在直接拒绝。P19 覆盖
  主 checkout 本身与仓库外路径两个拒绝面。
- **P20 补形态②未合并分支用例**（-d 拒删、分支保留）；P16 断言收紧（原"含
  remove"过弱——footer 子命令列表也含 remove，现断言 remove 命令行本体）。
- **文档同步**：`commands/worktree.md` 路由表补 `remove` 与 `exit remove
  delete-branch`；SKILL description 补"收尾清理"。

## [0.4.3] — 2026-08-14

### 新增：`exit` 的 `delete_branch` —— 合并后收尾的 agent 正规路径（外部反馈）

外部用户反馈：合并完成的 worktree 收尾时，agent 删不掉分支——
`exit(action="remove")` 只 `git worktree remove` **保留分支**；agent 跑 `git branch -d`
又命中 `guard_hook` 的**无条件拦截**（`GIT_DEL_WORKTREE_RE`，安全网），只能卡在
`authorize-main` 等用户手动。三个正确设计组合出一个空隙：合并后收尾没有 agent 可自走的路径。

**修复**：`exit` 新增 `delete_branch` 参数（仅 `action="remove"` 生效）。`git worktree remove`
成功后，在主 checkout 直跑 `git branch -d <branch>`（**非 `-D`**）。安全性由 `-d` 闸门保证——
仅删**已合并进 HEAD** 的分支，未合并则 git 拒绝并提示保留，无需自定义合并判断。删分支在
`wt.mjs` 进程内用 `runGit` 直跑，**不经 agent Bash**，故不触发 hook 拦截——这正是把删分支从
"被拦的 agent 操作"迁移到"exit 内部的安全步骤"。

```bash
# 合并完成后一步收尾：删副本目录 + 清理已合并分支
echo '{"action":"remove","confirm_remove":true,"delete_branch":true}' | node "<WT>" exit
```

**可发现性**：`guard_hook` 拦截 `git branch -d` 的提示补了 `exit(delete_branch)` 引导；
`exit(action="keep")` 回执预告合并后的一步收尾命令；SessionStart 锁定态提示同补。

**未改动**：`GIT_DEL_WORKTREE_RE` 拦截**保留**（agent 侧 `git branch -d` 仍是安全网）；
建议3（`wt.mjs remove <path>` 事后清理子命令）暂不做——合并后 `exit(remove, delete_branch)`
已闭环，新增子命令徒增维护面。

## [0.4.2] — 2026-08-13

### 修复：`git -C <path>` 语境被忽略 → 副本内 git 闭环误拦（外部反馈③）

外部 agent 在 v0.4.1 上反馈：绑定态 `git -C <worktree> merge --ff-only <分支>` 被拦截，
副本内的"改码 → git 提交 → 编译 → 测试"闭环走不通。根因：`guard_hook` 的 Bash 分支求值
分支/是否在副本内时只看 `cd`/会话 cwd，**完全忽略 `git -C <path>` 目标**——该命令在主
checkout 语境下求值出"master + 有绑定"→ 误判为"受保护分支上 merge"而拦截。

**修复**：新增 `extractGitCTarget()`（取最后一次 `git -C <path>`，引号/裸词/`-c` 前缀/
链式取最后；相对路径基于 cd 后语境；MSYS 归一化；目标不存在 → null 回退），Bash 分支
语境优先级变为 **`git -C` > `cd` > 会话 cwd**。效果：`git -C <WT> merge master`（同步
基线）放行；`git -C <主checkout> merge` 仍拦；`git -C <WT> checkout master` 仍拦
（防副本被劫持到受保护分支）。

**同命令 shell 变量解析**：ZCode Bash 每次调用都是全新 shell，跨调用变量不保留；反馈
实发命令形态为同一命令内 `WT="<路径>"` 赋值 + `git -C "$WT"`。新增窄作用域解析器
（收集 `NAME=值` 赋值，替换 `$NAME`/`${NAME}`，仅用于 cd/-C 目标提取，不执行任何东西），
该实发形态现已正确放行。

### 反馈①②定位为语义教学缺口（非代码缺陷），已补齐文档与提示

引擎源码核实（zcode.cjs）：ZCode Bash **每次调用全新 shell**（env/变量不保留，仅 profile
别名重放），但**工作目录跨调用持久**（命令 exit 0 且落在 workspace 内时，引擎经 `pwd -P`
捕获 → `setWorkingDirectory` 延续）。因此：

- 症状②（`cd "$WT"` 后 `pwd` 仍是主副本）＝ `$WT` 变量跨调用丢失所致，非目录不持久；
- 症状①（bash 重定向写主 checkout 不重写）＝ bash 命令字符串不做透明重写（设计边界，
  shell 语法无法安全改写）。

正确闭环姿势（已写入 session_start 锁定提示、SKILL.md「Bash 工作流」、README「Bash 行为
与已知边界」）：单条 `cd "<worktree 绝对路径>"` 切入副本（会话目录随之持久切换），之后
git/编译/测试用相对路径；单条 git 操作可用 `git -C`；**bash 里写绝对主 checkout 路径不会
被重写**，写文件用 Write/Edit 工具。

### 其他修复

- **allow TTL 显示**（反馈④）：有效期输出从裸 UTC ISO 串（`2026-08-13T10:38:18.768Z`，
  对照本地时钟像"秒过期"）改为本地时间 + 时长（`约 60 分钟`）；`allow list` 同步。
- **跨副本拦截文案**：追加可操作指引「若要在此副本内工作，先用 wt.mjs enter 进入该副本」。
- **exit(remove) 半成功容错**（v0.4.1 live 验证发现的 Windows 边缘）：remove 可能半成功
  （git 已注销、目录删除 EPERM），重试报 "is not a working tree" 原先会卡死退出流程；
  现视为已注销，继续清绑定并提示手动清理残留目录。

### 测试

`tests/v2.test.mjs` 新增 O 组 9 用例：O01/O05 为反馈③复现（字面量与 `$VAR` 实发形态，
先红后绿）、O02-O04 语境正确性三向验证、O06 `extractGitCTarget` 八形态单元、O07 TTL
本地显示、O08 exit 容错、O09 文案指引。全量 **157 用例全绿**（148 既有零翻转）。

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
