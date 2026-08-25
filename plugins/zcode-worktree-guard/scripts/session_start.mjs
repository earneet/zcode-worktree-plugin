#!/usr/bin/env node
// SessionStart hook：注入当前会话的 worktree 绑定状态（默认主副本开放 / 已 enter 则锁定）。
import * as C from "./common.mjs";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WT_TOOL = path.join(__dirname, "wt.mjs");

async function main() {
  const raw = await C.readStdinJson();
  const ctx = C.parseHookPayload(raw);
  const cwd = ctx.cwd || process.cwd();
  const sessionId = C.resolveSessionId(ctx);

  const common = C.gitCommonDir(cwd);
  if (!common) return; // 非 git → 静默
  const root = path.dirname(common);
  C.ensureMeta(common);

  // v0.4：默认主副本开放——无绑定即在主副本自由工作（不拦截、不重写）。
  // 绑定只来自本会话 enter（或 subagent 继承父链 enter）。state.json 不再产生绑定，
  // 仅作为"最近一次活动 worktree"的信息性提示，不自动锁定。
  const state = C.loadStateByCommon(common);
  const existingBinding = C.loadBinding(common, sessionId);

  let prompt;
  if (existingBinding && existingBinding.worktree) {
    // 当前 session 已有直绑
    prompt =
      `【worktree-guard 已锁定】会话 ${sessionId} 绑定到 worktree：\n` +
      `  路径: ${existingBinding.worktree}\n  分支: ${existingBinding.branch}（来源: ${existingBinding.source}）\n\n` +
      `Write/Edit 写主 checkout 路径会自动重写到该 worktree；跨副本写、git push 到 master/main 仍拦截。\n` +
      `Bash 提示：每次调用都是新 shell（变量不跨调用保留）；要在副本内跑 git/编译/测试，先单条 cd "${existingBinding.worktree}"（会话工作目录会持久切换），再用相对路径操作；bash 里写绝对主 checkout 路径不会被重写。\n` +
      `退出（回到主副本开放）: echo '{"action":"keep"}' | node "${WT_TOOL}" exit\n` +
      `合并后收尾（删副本目录 + 清理已合并分支，git branch -d 仅删已合并）: echo '{"action":"remove","confirm_remove":true,"delete_branch":true}' | node "${WT_TOOL}" exit`;
  } else {
    const resolved = C.resolveBinding(common, sessionId);
    if (resolved) {
      // subagent 经父链继承到绑定
      prompt =
        `【worktree-guard 已锁定（继承）】会话 ${sessionId} 通过父会话继承绑定到 worktree：\n` +
        `  路径: ${resolved.worktree}\n  分支: ${resolved.branch}（来源: ${resolved.source}）\n\n` +
        `Write/Edit 写主 checkout 路径会自动重写到该 worktree。\n` +
        `Bash 提示：每次调用都是新 shell（变量不跨调用保留）；要在副本内跑 git/编译/测试，先单条 cd "${resolved.worktree}"（会话工作目录会持久切换），再用相对路径操作；bash 里写绝对主 checkout 路径不会被重写。\n` +
        `如需换绑: echo '{"path":"<worktree路径>"}' | node "${WT_TOOL}" enter`;
    } else {
      // 默认开放：主副本自由工作
      prompt =
        `【worktree-guard 默认开放】当前仓库 ${root}。\n` +
        `默认在主 checkout 自由工作——Write/Edit/本地 git 操作不拦截、路径不重写。\n` +
        `需要隔离一个任务到独立分支副本时，再：\n` +
        `  echo '{"task_name":"<slug>"}' | node "${WT_TOOL}" create\n` +
        `  echo '{"path":".worktrees/worktree-<slug>"}' | node "${WT_TOOL}" enter\n` +
        `（enter 后本会话的写主 checkout 路径会自动重写到副本）\n` +
        `（task_name 必须是小写字母/数字/连字符的 slug）`;
      if (state) {
        // 信息性提示：上个会话遗留的活动 worktree（不会自动锁定本会话）
        prompt +=
          `\n\n提示：检测到上次会话曾进入 worktree：\n  ${state.path} [${state.branch}]\n` +
          `（不会自动延续绑定；如需继续该副本，重新 enter）`;
      }
    }
  }

  process.stdout.write(JSON.stringify({ hookEventName: "SessionStart", additionalContext: prompt }));
}

main().catch(() => process.exit(0));
