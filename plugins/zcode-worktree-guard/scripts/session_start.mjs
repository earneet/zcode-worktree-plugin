#!/usr/bin/env node
// SessionStart hook v0.2：自动注入 worktree 纪律 + 迁移检测 + 绑定状态显示。
import * as C from "./common.mjs";
import path from "node:path";
import fs from "node:fs";
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
  const sessionId = ctx.session_id || process.env.ZCODE_SESSION_ID || "cli-manual";

  const common = C.gitCommonDir(cwd);
  if (!common) return; // 非 git → 静默
  const root = path.dirname(common);
  C.ensureMeta(common);

  // v0.2 迁移检测：有旧 state.json 但无 meta.json 记录（meta 在 ensureMeta 刚创建）
  // 若 state.json 存在且有 active，提示用户 re-enter
  const state = C.loadStateByCommon(common);
  const existingBinding = C.loadBinding(common, sessionId);

  let prompt;
  if (existingBinding && existingBinding.worktree) {
    // 当前 session 已有绑定（可能是继承快照）
    prompt =
      `【worktree-guard 激活中】会话 ${sessionId} 绑定 worktree：\n` +
      `  路径: ${existingBinding.worktree}\n  分支: ${existingBinding.branch}（来源: ${existingBinding.source}）\n\n` +
      `Write/Edit 写主 checkout 路径会自动重写到该 worktree。\n` +
      `退出: echo '{"action":"keep"}' | node "${WT_TOOL}" exit`;
  } else {
    const resolved = C.resolveBinding(common, sessionId);
    if (resolved) {
      prompt =
        `【worktree-guard 继承绑定】会话 ${sessionId} 通过继承绑定到 worktree：\n` +
        `  路径: ${resolved.worktree}\n  分支: ${resolved.branch}（来源: ${resolved.source}）\n\n` +
        `Write/Edit 写主 checkout 路径会自动重写到该 worktree。\n` +
        `如需换绑: echo '{"path":"<worktree路径>"}' | node "${WT_TOOL}" enter`;
    } else if (state) {
      // 迁移场景：旧 state.json 有活动 worktree，但当前 session 未绑定
      prompt =
        `【worktree-guard 迁移提示】检测到 v0.1 遗留活动 worktree：\n` +
        `  ${state.path} [${state.branch}]\n\n` +
        `v0.2 改为会话级绑定。请重新绑定：\n` +
        `  echo '{"path":"${path.relative(root, state.path) || state.path}"}' | node "${WT_TOOL}" enter\n` +
        `或退出清理: echo '{"action":"keep"}' | node "${WT_TOOL}" exit`;
    } else {
      // 无绑定无遗留
      prompt =
        `【worktree-guard】当前仓库 ${root} 已启用 worktree 强制工作流。\n` +
        `核心纪律：所有开发必须在隔离 worktree 副本进行，主 checkout 写保护。\n\n` +
        `开始代码修改前：\n` +
        `  echo '{"task_name":"<slug>"}' | node "${WT_TOOL}" create\n` +
        `  echo '{"path":".worktrees/worktree-<slug>"}' | node "${WT_TOOL}" enter\n` +
        `（task_name 必须是小写字母/数字/连字符的 slug）\n\n` +
        `如需临时写主目录文件: echo '{"action":"add","path":"<相对路径>"}' | node "${WT_TOOL}" allow`;
    }
  }

  process.stdout.write(JSON.stringify({ hookEventName: "SessionStart", additionalContext: prompt }));
}

main().catch(() => process.exit(0));
