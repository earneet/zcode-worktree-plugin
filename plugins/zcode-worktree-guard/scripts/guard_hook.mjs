#!/usr/bin/env node
// zcode-worktree-guard PreToolUse hook v0.2
// 透明路径重写 + 拦截防御，基于决策表 + resolveBinding 绑定解析。
// v0.4：默认主副本开放——无绑定时 Write/Edit/本地 git 操作放行（不拦截、不重写）；
//       仅 enter 绑定后才启用透明重写与受保护分支拦截。fail-open（进程异常放行）。
//       跨副本写入、`.git` 写、git push 到 master/main、删 worktree 分支——始终拦截。
// v0.4.1：① 会话身份注入——wt.mjs 经 Bash 调用拿不到 ZCode 的 session_id（环境变量
//       不注入），hook 是唯一知道真实会话 id 的组件，对其 Bash 命令注入
//       `export ZCODE_SESSION_ID=<id>; ` 前缀（修复 v0.4.0 绑定永远解析失败的回归）；
//       ② Read 去武器化——.git/跨副本拒绝仅对写生效，读操作永不拦截、不重写错位。
import * as C from "./common.mjs";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WT_TOOL = path.join(__dirname, "wt.mjs");

// git 危险操作正则
const GIT_PREFIX = String.raw`\bgit\s+(?:(?:-C|-c)\s+\S+\s+)*`;
const GIT_MUTATE_RE = new RegExp(GIT_PREFIX + String.raw`(merge|rebase|pull)\b`, "i");
const GIT_MERGE_TARGET_RE = new RegExp(
  GIT_PREFIX + String.raw`(merge|rebase)\s+(worktree-[^\s;|&"'<>()]+)\b`, "i"
);
const GIT_PUSH_PROTECTED_RE = /\bgit\s+push\b.*\b(master|main)\b/i;
const GIT_PUSH_DEFAULT_RE = /^\s*git\s+push\s*$/i;
const GIT_DEL_WORKTREE_RE = new RegExp(
  String.raw`\bgit\s+branch\s+(-[dD])\s+(worktree-[^\s;|&"'<>()]+)\b`, "i"
);
const GIT_CHECKOUT_RE = new RegExp(
  GIT_PREFIX + String.raw`(checkout|switch)\s+([^\s;|&"'<>()-][^\s;|&"'<>()]*)`, "i"
);

function emitRewrite(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput },
  }));
  process.exit(0);
}

function block(reason, ctx) {
  const target = ctx.target || ctx.command || "(无)";
  process.stderr.write(
    "\n🔴🔴🔴 worktree-guard 拦截 🔴🔴🔴\n\n" +
    "当前上下文:\n" +
    `  当前分支: ${ctx.branch}\n` +
    `  当前位置: ${ctx.cwd}\n` +
    `  主 checkout 根: ${ctx.root}\n` +
    `  活动 worktree: ${ctx.binding ? ctx.binding.worktree : "无"}\n` +
    `  目标/命令: ${target}\n\n` +
    `拦截原因: ${reason}\n\n` +
    "修正方式（按需）:\n" +
    "1. 写主 checkout 一般是允许的（默认开放）——若你正持有 enter 绑定又想写主副本，先 exit 退出该会话绑定；\n" +
    "2. 跨副本/`.git` 写是硬拦截——确认目标路径正确；\n" +
    "3. git push 到 master/main、删 worktree 分支需用户明确授权：echo '{\"reason\":\"...\"}' | node \"" + WT_TOOL + "\" authorize-main；若该 worktree 分支已合并进主分支，也可用 exit(action='remove', confirm_remove=true, delete_branch=true) 在删副本时一并安全清理（git branch -d 仅删已合并）。\n" +
    "4. 需临时写主目录某文件（已绑定时）：echo '{\"action\":\"add\",\"path\":\"<相对路径>\",\"reason\":\"...\"}' | node \"" + WT_TOOL + "\" allow；\n" +
    `（脚本: node "${WT_TOOL}" <create|enter|exit|allow|authorize-main|revoke-main>，stdin 传 JSON）\n`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 决策表：Write/Edit/Read 的 file_path 判定（纯函数）
// 返回 {action: "allow"|"deny"|"rewrite", reason, newTarget?, source?}
// v0.4：默认主副本开放——无绑定写主 checkout 放行；跨副本写入始终拦截。

// 跨副本写入保护：目标落在"另一个"已注册 worktree 副本内 → 写 deny / 读 allow。
// worktree 副本常在 root 内（默认 .worktrees/ 下），不检查会导致：
//   - 无绑定时：写到别的副本（路径漂移）；
//   - 有绑定时：被错误重写到自身副本（静默错位）。
// 此检查无论有无绑定都生效。跳过主 checkout（path===root）与（有绑定时）自身副本。
// v0.4.1：读别的副本无害（对比/排障常需要），改为放行——v0.4.0 曾因绑定解析失败
// 把 agent 连自己副本的读操作都拦死。放行而非落入重写分支，避免路径错拼到自身副本下。
function crossWorktreeDeny(nTarget, ctx) {
  const nRoot = C.norm(ctx.root);
  const nWt = ctx.binding ? C.norm(ctx.binding.worktree) : null;
  for (const wt of C.registeredWorktrees(ctx.root)) {
    const nOther = C.norm(wt.path);
    if (nOther === nRoot) continue; // 跳过主 checkout
    if (nOther === nWt) continue;   // 跳过自身绑定的副本
    if (C.isInside(nTarget, nOther)) return true;
  }
  return false;
}

function decideWrite(target, ctx, isWrite) {
  const nTarget = C.norm(target);
  const nRoot = C.norm(ctx.root);
  const binding = ctx.binding; // resolveBinding 结果，可能 null

  // 1. .git 保护（硬规则；写拒绝。读取 .git 内文件无害且常用于排障 → 放行原路径）
  const nGit = C.norm(path.join(ctx.root, ".git"));
  if (C.isInside(nTarget, nGit)) {
    if (isWrite) return { action: "deny", reason: "目标路径在 .git 下，禁止操作（保护 git 元数据）。" };
    return { action: "allow", source: "read-git-dir" };
  }

  // 2. 仓库外放行
  if (!C.isInside(nTarget, nRoot)) {
    return { action: "allow", source: "outside-repo" };
  }

  // 3. 白名单（声明式，sidecar 配置）
  if (C.matchWhitelist(target, ctx.root, ctx.whitelist)) {
    return { action: "allow", source: "whitelist" };
  }

  // 4. 临时放行（wt.mjs allow，仓库级单文件）
  if (C.isAllowlisted(ctx.common, target, ctx.root)) {
    return { action: "allow", source: "allowlist" };
  }

  // 5. 全局 authorize-main
  if (ctx.globalAllow) {
    return { action: "allow", source: "global-authorize" };
  }

  // 6. 跨副本写入保护（始终生效，不论有无绑定；写拒绝，读放行——见 crossWorktreeDeny 注释）
  if (crossWorktreeDeny(nTarget, ctx)) {
    if (isWrite) {
      return {
        action: "deny",
        reason: "目标路径在其他 worktree 副本内，不允许跨副本写入。若要在此副本内工作，先用 wt.mjs enter 进入该副本；若目标本就该是当前副本，请核对路径。",
      };
    }
    return { action: "allow", source: "read-cross-worktree" };
  }

  // 7. 有绑定：写副本内放行；写主 checkout 根下 → 透明重写
  if (binding && binding.worktree) {
    const nWt = C.norm(binding.worktree);
    if (C.isInside(nTarget, nWt)) {
      return { action: "allow", source: "inside-worktree" };
    }
    // 目标在主 checkout 根下（已排除其他副本）→ 透明重写。
    // 🔴 rel 必须用【原始大小写】的 root/target 计算，不能用 nRoot/nTarget（norm 小写过）——
    // 否则文件名被小写，破坏大小写敏感的契约（如 Java 的 类名↔文件名）。norm 只用于上面的
    // isInside 比对（大小写/分隔符不敏感的包含判断），不参与构造输出路径。
    const rel = path.relative(ctx.root, target);
    return { action: "rewrite", newTarget: path.join(binding.worktree, rel), source: "rewrite" };
  }

  // 8. 无绑定：默认开放——主副本 Write/Edit/Read 全放行，不重写、不拦截
  return { action: "allow", source: isWrite ? "unbound-main" : "read-unbound" };
}

// ---------------------------------------------------------------------------
function handleFilePathTool(toolInput, context, isWrite) {
  const target = toolInput.file_path || "";
  if (!target) return;

  const targetAbs = path.isAbsolute(target) ? target : path.join(context.cwd, target);
  context.target = targetAbs;

  const decision = decideWrite(targetAbs, context, isWrite);
  if (decision.action === "allow") return;
  if (decision.action === "rewrite") {
    emitRewrite({ ...toolInput, file_path: decision.newTarget });
  }
  // deny
  block(decision.reason, context);
}

// ---------------------------------------------------------------------------
function handleSearchPathTool(toolInput, context) {
  const binding = context.binding;
  if (!binding) return; // 无绑定放行（搜索只读）

  const p = toolInput.path;
  if (!p) {
    // path 缺省 → 注入 worktree
    emitRewrite({ ...toolInput, path: binding.worktree });
  }

  const pAbs = path.isAbsolute(p) ? p : path.join(context.cwd, p);
  const nP = C.norm(pAbs);
  const nRoot = C.norm(context.root);
  const nWt = C.norm(binding.worktree);

  if (C.isInside(nP, nWt)) return;
  if (!C.isInside(nP, nRoot)) return;
  // 🔴 用原始大小写算 rel（同 decideWrite），避免搜索路径被小写。norm 只用于 isInside 比对。
  const rel = path.relative(context.root, pAbs);
  emitRewrite({ ...toolInput, path: path.join(binding.worktree, rel) });
}

// ---------------------------------------------------------------------------
// 会话身份注入（v0.4.1 主修）：
// wt.mjs 由 agent 经 Bash 工具调用，而 ZCode 不向 Bash 子进程注入任何会话环境变量，
// wt.mjs 自身只能落到 cli-manual 兜底 id——与 hook（payload 真实 session_id）错位，
// 导致 enter 写入的绑定对 hook 永远不可见（v0.4.0 回归：重写失效 + 跨副本误拦）。
// 唯一知道真实会话 id 的组件是 hook，因此由它把 id 注入 wt.mjs 命令的环境前缀，
// 身份随进程确定性传递（无锁文件、无竞态）。ZCode 引擎对 updatedInput 的应用是
// 工具无关的 input 级替换（已核实 zcode.cjs 源码），Bash.command 重写天然支持。

const WT_CMD_RE = /\bwt\.mjs\b/;

function injectSessionEnv(command, sessionId) {
  // 返回注入后的命令；不满足条件返回 null（调用方按原命令继续）。
  if (!WT_CMD_RE.test(command)) return null;               // 只处理 wt.mjs 调用
  if (!sessionId || sessionId === C.MANUAL_SESSION_ID) return null; // 手工/无会话上下文
  if (!C.SAFE_SESSION_ID_RE.test(sessionId)) return null;  // 异常 id 不拼 shell（防注入）
  if (command.includes(`${C.SESSION_ENV}=`)) return null;  // 已有注入/显式设置（幂等）
  return `export ${C.SESSION_ENV}=${sessionId}; ${command}`;
}

// ---------------------------------------------------------------------------
function handleBash(toolInput, context) {
  const command = toolInput.command || "";
  if (!command) return;
  context.command = command;

  // 全局授权放行
  if (context.globalAllow) return;

  const branch = context.branch;
  const branchL = branch.toLowerCase();
  const protected_ = context.protected_;
  const hasBinding = context.binding != null;

  // 1. git push 到 master/main
  if (GIT_PUSH_PROTECTED_RE.test(command) || (GIT_PUSH_DEFAULT_RE.test(command) && protected_.has(branchL))) {
    block("git push 到受保护分支（master/main），必须用户明确授权。", context);
  }

  // 2. 有绑定时禁止切到受保护分支
  if (hasBinding || context.in_worktree) {
    const m = GIT_CHECKOUT_RE.exec(command);
    if (m && protected_.has(m[2].toLowerCase())) {
      block(`当前有 worktree 绑定，禁止 git checkout/switch ${m[2]}。`, context);
    }
  }

  // 3. 删 worktree 分支
  if (GIT_DEL_WORKTREE_RE.test(command)) {
    block("删除 worktree 分支必须用户明确授权。", context);
  }

  // 4. merge/rebase/pull 检查（仅绑定/在副本内时拦截；默认开放态主副本 git 自由）
  if ((hasBinding || context.in_worktree) && GIT_MUTATE_RE.test(command)) {
    if (protected_.has(branchL)) {
      block(`当前有 worktree 绑定/在副本内，在受保护分支 ${branch} 上 merge/rebase/pull 需用户明确授权。`, context);
    }
    const m = GIT_MERGE_TARGET_RE.exec(command);
    if (m) {
      block(`检测到合并 ${m[2]} 到 ${branch}。worktree 分支只能合并到主分支，且须用户授权。`, context);
    }
  }

  // 5. 会话身份注入（放在所有拦截检查之后——绝不因注入而跳过任何拦截）。
  //    对 `node .../wt.mjs enter` 这类命令注入 export 前缀后由 updatedInput 生效。
  const injected = injectSessionEnv(command, context.sessionId);
  if (injected != null) {
    emitRewrite({ ...toolInput, command: injected });
  }
}

// ---------------------------------------------------------------------------
// fail-open 审计锚点：main() 内解析出 git 上下文后记录，异常路径据此写审计日志。
let auditCommon = null;

async function main() {
  const raw = await C.readStdinJson();
  const ctx = C.parseHookPayload(raw);
  const cwd = ctx.cwd || process.cwd();
  const sessionId = C.resolveSessionId(ctx);
  const toolName = ctx.tool_name || "";
  const toolInput = ctx.tool_input || {};

  // 定位 git 上下文
  let common, root, branch, inWt;
  if (toolName === "Bash") {
    const command = toolInput.command || "";
    const cdTarget = C.extractCdTarget(command, cwd);
    // v0.4.2：git -C <path> 是最特异的 git 语境指示（优先于 cd/会话 cwd）。
    // 此前忽略它导致绑定态 `git -C <worktree> merge ...` 在主 checkout 语境下被误判
    // 为"受保护分支上 merge"而误拦（反馈症状③）。-C 目标不可解析（动态 $VAR 解析失败
    // /路径不存在）时回退 cd/cwd 语境。
    const gitCTarget = C.extractGitCTarget(command, cdTarget || cwd);
    const effectiveCwd = gitCTarget || cdTarget || cwd;
    ({ common, root } = C.findGitContextForCwd(effectiveCwd));
    branch = C.currentBranch(effectiveCwd);
    inWt = C.inLinkedWorktree(effectiveCwd);
  } else {
    const pathField = toolName === "Glob" || toolName === "Grep" ? "path" : "file_path";
    const targetPath = toolInput[pathField];
    ({ common, root } = targetPath ? C.findGitContext(targetPath, cwd) : C.findGitContextForCwd(cwd));
    branch = C.currentBranch(root);
    inWt = C.inLinkedWorktree(root);
  }
  if (!common) return; // 非 git → 放行
  auditCommon = common; // 供异常路径审计

  // v0.2：三层降级解析绑定
  const binding = C.resolveBinding(common, sessionId);
  const cfg = C.loadConfig(root);
  const globalAllow = C.loadGlobalAllow(common);
  const whitelist = C.whitelistPatterns(cfg);
  const protected_ = C.protectedBranches(cfg);
  if (binding && binding.base) protected_.add(binding.base.toLowerCase());

  const context = {
    cwd, root, branch, in_worktree: inWt,
    binding, sessionId, common,
    whitelist, globalAllow, protected_,
  };

  if (toolName === "Write" || toolName === "Edit") {
    handleFilePathTool(toolInput, context, true);
  } else if (toolName === "Read") {
    handleFilePathTool(toolInput, context, false);
  } else if (toolName === "Glob" || toolName === "Grep") {
    handleSearchPathTool(toolInput, context);
  } else if (toolName === "Bash") {
    handleBash(toolInput, context);
  }
}

// fail-open：内部异常一律放行（不阻塞用户工具调用），但留审计 + stderr 痕迹，
// 避免 v0.4.0 那样"静默吞异常伪装成放行"（排障时极不友好）。
main().catch((e) => {
  const msg = e && e.message ? `${e.constructor?.name}: ${e.message}` : String(e);
  try {
    if (auditCommon) C.appendAudit(auditCommon, { type: "hook_error", error: msg });
  } catch { /* 审计失败不影响放行 */ }
  process.stderr.write(`worktree-guard: 内部错误（已放行）: ${msg}\n`);
  process.exit(0);
});
