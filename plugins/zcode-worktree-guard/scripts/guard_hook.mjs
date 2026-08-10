#!/usr/bin/env node
// zcode-worktree-guard PreToolUse hook v0.2
// 透明路径重写 + 拦截防御，基于决策表 + resolveBinding 三层降级。
// fail-open（进程级异常放行）+ fail-closed（绑定解析失败则 block 写）。
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
    "修正方式:\n" +
    "1. 普通开发任务 → 先 create + enter（之后写主 checkout 路径会自动重写到副本）；\n" +
    "2. 需临时写主目录某文件 → echo '{\"action\":\"add\",\"path\":\"<相对路径>\",\"reason\":\"...\"}' | node \"" + WT_TOOL + "\" allow；\n" +
    "3. 用户明确授权全局 → echo '{\"reason\":\"...\"}' | node \"" + WT_TOOL + "\" authorize-main；\n" +
    `（脚本: node "${WT_TOOL}" <create|enter|exit|allow|authorize-main>，stdin 传 JSON）\n`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// v0.2 决策表：Write/Edit/Read 的 file_path 判定（纯函数）
// 返回 {action: "allow"|"deny"|"rewrite", reason, newTarget?, source?}

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

  // 6-8. 有绑定的情况
  if (binding && binding.worktree) {
    const nWt = C.norm(binding.worktree);
    if (C.isInside(nTarget, nWt)) {
      return { action: "allow", source: "inside-worktree" }; // 6. 写副本内
    }
    if (C.isInside(nTarget, nRoot)) {
      // 7. 主 checkout 根下 → 透明重写
      const rel = path.relative(nRoot, nTarget);
      return { action: "rewrite", newTarget: path.join(binding.worktree, rel), source: "rewrite" };
    }
    // 8. 其他位置（其他副本等）
    return { action: "deny", reason: "目标在其他副本内，不允许跨副本写入。" };
  }

  // 9. 无绑定（含 DB 失败降级到底）：Write/Edit fail-closed deny；Read allow
  if (isWrite) {
    return { action: "deny", reason: "当前会话无 worktree 绑定，写主 checkout 被禁止。先 create+enter，或用 allow/authorize-main 放行。" };
  }
  return { action: "allow", source: "read-no-binding" };
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
  const rel = path.relative(nRoot, nP);
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

  // 4. merge/rebase/pull 检查
  if (GIT_MUTATE_RE.test(command)) {
    if (protected_.has(branchL)) {
      block(`当前在受保护分支 ${branch}，merge/rebase/pull 需用户明确授权。`, context);
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
