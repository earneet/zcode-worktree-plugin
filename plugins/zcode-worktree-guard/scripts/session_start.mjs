#!/usr/bin/env node
// SessionStart hook：会话启动时自动注入 worktree 工作流纪律。
// 在 git 仓库内启动 → 注入提示；非 git → 静默放行。fail-open。
import * as C from "./common.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WT_TOOL = path.join(__dirname, "wt.mjs");

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

  const common = C.gitCommonDir(cwd);
  if (!common) return; // 非 git → 静默放行

  const root = path.dirname(common);
  const state = C.loadStateByCommon(common);
  let prompt;
  if (state && state.active) {
    prompt =
      `【worktree-guard 激活中】当前仓库 ${root} 有活动 worktree：\n` +
      `  路径: ${state.path}\n  分支: ${state.branch}\n\n` +
      `你现在用 Write/Edit 写主 checkout 的路径，会被自动重写到该 worktree（无需手改路径）。\n` +
      `任务完成后用 \`echo '{"action":"keep"}' | node "${WT_TOOL}" exit\` 退出并汇报，等待用户授权合并。`;
  } else {
    prompt =
      `【worktree-guard】当前仓库 ${root} 已启用 worktree 强制工作流。\n` +
      `核心纪律：所有开发必须在隔离的 git worktree 副本中进行，主 checkout 写保护。\n\n` +
      `开始任何代码修改前，先创建并进入 worktree：\n` +
      `  echo '{"task_name":"<slug>"}' | node "${WT_TOOL}" create\n` +
      `  echo '{"path":".worktrees/worktree-<slug>"}' | node "${WT_TOOL}" enter\n` +
      `（task_name 必须是小写字母/数字/连字符的 slug，如 fix-login）\n\n` +
      `进入后，Write/Edit 的路径会自动重写到 worktree，你无需手动改路径。\n` +
      `如不遵守，写主 checkout 会被 PreToolUse hook 拦截。`;
  }

  process.stdout.write(JSON.stringify({ hookEventName: "SessionStart", additionalContext: prompt }));
}

main().catch(() => process.exit(0));
