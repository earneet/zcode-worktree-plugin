#!/usr/bin/env node
// zcode-worktree-guard PreToolUse hook：透明路径重写 + 拦截防御（TypeScript 同源版）。
// 双层架构：重写层把主 checkout 路径透明改写到 worktree；拦截层 deny 危险操作。
// 设计原则：fail-open。ZCode 字段名：Write/Edit/Read=file_path；Glob/Grep=path；Bash=command。
import * as C from "./common.mjs";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WT_TOOL = path.join(__dirname, "wt.mjs");

// git 全局选项（-C/-c）可出现于子命令之前
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
  const active = ctx.active_wt || "无";
  process.stderr.write(
    "\n🔴🔴🔴 worktree-guard 拦截 🔴🔴🔴\n\n" +
    "当前上下文（操作前请务必确认）：\n" +
    `  当前分支: ${ctx.branch}\n` +
    `  当前位置: ${ctx.cwd}\n` +
    `  主 checkout 根: ${ctx.root}\n` +
    `  活动 worktree: ${active}\n` +
    `  目标/命令: ${target}\n\n` +
    `拦截原因: ${reason}\n\n` +
    "修正方式（按推荐顺序）：\n" +
    "1. 若这是普通开发任务 → 先 create 创建副本，再 enter 进入（之后写主 checkout 路径会自动重写到副本）；\n" +
    "2. 若用户明确授权在主 checkout 上修改或合并 →\n" +
    `   运行: echo '{"reason":"用户授权 XXX"}' | node "${WT_TOOL}" authorize-main\n` +
    `   完成后运行: echo '{}' | node "${WT_TOOL}" revoke-main\n` +
    `（工具用法详见 worktree-workflow 技能；脚本: node "${WT_TOOL}" <create|enter|exit|status>，stdin 传 JSON）\n`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Write/Edit/Read 的 file_path 处理
function handleFilePathTool(toolInput, context, isWrite) {
  const target = toolInput.file_path || "";
  if (!target) return;

  const cwd = context.cwd;
  const root = context.root;
  const activeWt = context._active_wt;

  const targetAbs = path.isAbsolute(target) ? target : path.join(cwd, target);
  const nTarget = C.norm(targetAbs);
  const nRoot = C.norm(root);

  // 仓库外路径放行
  if (!C.isInside(nTarget, nRoot)) return;
  context.target = targetAbs;

  // .git 保护
  const nGit = C.norm(path.join(root, ".git"));
  if (C.isInside(nTarget, nGit)) {
    block("目标路径在 .git 下，禁止操作（保护 git 元数据）。", context);
  }

  // 授权放行
  if (context._allow_main) return;

  if (activeWt) {
    const nWt = C.norm(activeWt.path);
    if (C.isInside(nTarget, nWt)) return; // 已在副本内放行
    // 主 checkout 根下 → 透明重写 R→W
    const rel = path.relative(nRoot, nTarget);
    const newAbs = path.join(activeWt.path, rel);
    const newInput = { ...toolInput, file_path: newAbs };
    emitRewrite(newInput);
  }

  // 无活动 worktree：Write/Edit 拦截（写保护）；Read 放行
  if (isWrite) {
    block("当前无活动 worktree，且未授权。按工作流约定，一般修改禁止在主 checkout 进行。", context);
  }
}

// ---------------------------------------------------------------------------
// Glob/Grep 的 path 处理
function handleSearchPathTool(toolInput, context) {
  const activeWt = context._active_wt;
  if (!activeWt) return;

  const cwd = context.cwd;
  const root = context.root;
  const p = toolInput.path;

  if (!p) {
    // path 缺省 → 注入 path = worktree
    emitRewrite({ ...toolInput, path: activeWt.path });
  }

  const pAbs = path.isAbsolute(p) ? p : path.join(cwd, p);
  const nP = C.norm(pAbs);
  const nRoot = C.norm(root);
  const nWt = C.norm(activeWt.path);

  if (C.isInside(nP, nWt)) return; // 已在副本内
  if (!C.isInside(nP, nRoot)) return; // 仓库外
  // 主 checkout 根下 → 重写 R→W
  const rel = path.relative(nRoot, nP);
  const newAbs = path.join(activeWt.path, rel);
  emitRewrite({ ...toolInput, path: newAbs });
}

// ---------------------------------------------------------------------------
// Bash：不重写，只拦危险 git 操作
function handleBash(toolInput, context) {
  const command = toolInput.command || "";
  if (!command) return;
  context.command = command;

  if (context._allow_main) return;

  const branch = context.branch;
  const branchL = branch.toLowerCase();
  const protected_ = context._protected;
  const hasActive = context._active_wt != null;

  // 1. git push 到 master/main
  if (GIT_PUSH_PROTECTED_RE.test(command) || (GIT_PUSH_DEFAULT_RE.test(command) && protected_.has(branchL))) {
    block("git push 到受保护分支（master/main），必须用户明确授权。", context);
  }

  // 2. 有活动 worktree 时禁止切到受保护分支
  if (hasActive || context.in_worktree) {
    const m = GIT_CHECKOUT_RE.exec(command);
    if (m && protected_.has(m[2].toLowerCase())) {
      block(
        `当前有活动 worktree，禁止执行 git checkout/switch ${m[2]}。副本应始终工作在 worktree-<task> 分支；如需切换任务，先 exit 再 enter。`,
        context
      );
    }
  }

  // 3. 删 worktree 分支
  if (GIT_DEL_WORKTREE_RE.test(command)) {
    block("删除 worktree 分支必须用户明确授权。通常通过 exit(action='remove') 删除副本目录，分支保留。", context);
  }

  // 4. git merge / rebase / pull
  if (GIT_MUTATE_RE.test(command)) {
    if (protected_.has(branchL)) {
      block(`当前在受保护分支 ${branch}，git merge / rebase / pull 会改变其历史或内容。把 worktree 分支合并进来必须获得用户明确授权。`, context);
    }
    const m = GIT_MERGE_TARGET_RE.exec(command);
    if (m) {
      block(`检测到尝试把 ${m[2]} 合并到当前分支 ${branch}。worktree 分支只能合并到主分支，且必须用户明确授权。`, context);
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

  const activeWt = C.loadStateByCommon(common);
  const override = C.loadOverrideByCommon(common);
  const allowMain = !!(override && override.allow_main_writes);

  const cfg = C.loadConfig(root);
  const protected_ = C.protectedBranches(cfg);
  if (activeWt && activeWt.base) protected_.add(activeWt.base.toLowerCase());

  const context = {
    cwd, root, branch, in_worktree: inWt,
    active_wt: activeWt ? activeWt.path : null,
    _active_wt: activeWt, _allow_main: allowMain, _protected: protected_,
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
process.on("exit", (code) => { if (code === undefined) process.exit(0); });
