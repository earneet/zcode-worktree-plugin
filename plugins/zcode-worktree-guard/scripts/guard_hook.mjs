#!/usr/bin/env node
// zcode-worktree-guard PreToolUse hook v0.2
// 透明路径重写 + 拦截防御，基于决策表 + resolveBinding 绑定解析。
// v0.4：默认主副本开放——无绑定时 Write/Edit/本地 git 操作放行（不拦截、不重写）；
//       仅 enter 绑定后才启用透明重写与受保护分支拦截。fail-open（进程异常放行）。
//       跨副本写入、`.git` 写、git push 到 master/main、删 worktree 分支——始终拦截。
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
    "3. git push 到 master/main、删 worktree 分支需用户明确授权：echo '{\"reason\":\"...\"}' | node \"" + WT_TOOL + "\" authorize-main；\n" +
    "4. 需临时写主目录某文件（已绑定时）：echo '{\"action\":\"add\",\"path\":\"<相对路径>\",\"reason\":\"...\"}' | node \"" + WT_TOOL + "\" allow；\n" +
    `（脚本: node "${WT_TOOL}" <create|enter|exit|allow|authorize-main|revoke-main>，stdin 传 JSON）\n`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 决策表：Write/Edit/Read 的 file_path 判定（纯函数）
// 返回 {action: "allow"|"deny"|"rewrite", reason, newTarget?, source?}
// v0.4：默认主副本开放——无绑定写主 checkout 放行；跨副本写入始终拦截。

// 跨副本写入保护：目标落在"另一个"已注册 worktree 副本内 → deny。
// worktree 副本常在 root 内（默认 .worktrees/ 下），不检查会导致：
//   - 无绑定时：写到别的副本（路径漂移）；
//   - 有绑定时：被错误重写到自身副本（静默错位）。
// 此检查无论有无绑定都生效。跳过主 checkout（path===root）与（有绑定时）自身副本。
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

  // 1. .git 保护（硬规则）
  const nGit = C.norm(path.join(ctx.root, ".git"));
  if (C.isInside(nTarget, nGit)) {
    return { action: "deny", reason: "目标路径在 .git 下，禁止操作（保护 git 元数据）。" };
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

  // 6. 跨副本写入保护（始终生效，不论有无绑定）
  if (crossWorktreeDeny(nTarget, ctx)) {
    return { action: "deny", reason: "目标路径在其他 worktree 副本内，不允许跨副本写入。" };
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
}

// ---------------------------------------------------------------------------
async function main() {
  const raw = await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 100);
  });
  let ctx = {};
  try { ctx = raw.trim() ? JSON.parse(raw.replace(/^\ufeff/, "")) : {}; } catch { ctx = {}; }
  const cwd = ctx.cwd || process.cwd();
  const sessionId = ctx.session_id || process.env.ZCODE_SESSION_ID || "cli-manual";
  const toolName = ctx.tool_name || "";
  const toolInput = ctx.tool_input || {};

  // 定位 git 上下文
  let common, root, branch, inWt;
  if (toolName === "Bash") {
    const cdTarget = C.extractCdTarget(toolInput.command || "", cwd);
    const effectiveCwd = cdTarget || cwd;
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

main().catch(() => process.exit(0));
