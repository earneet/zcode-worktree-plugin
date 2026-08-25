#!/usr/bin/env node
// zcode-worktree-guard 生命周期脚本
// create/enter/exit/remove/status/authorize-main/revoke-main/allow
// session 级绑定（bindings/<session_id>.json）+ subagent 继承 + 悬空检查。
// v0.4：默认主副本开放——绑定只由本会话 enter 产生；state.json 仅记录最近活动 + 授权标记。
// v0.4.1：会话 id 依赖注入——正常路径下 guard_hook 会给本脚本的 Bash 命令注入
//        ZCODE_SESSION_ID（见 guard_hook.mjs injectSessionEnv）；env 缺失（终端手工
//        调用/hook 未生效）时落到 cli-manual，该绑定对 ZCode 会话不可见。
import * as C from "./common.mjs";
import path from "node:path";
import fs from "node:fs";

function ok(text) { console.log(JSON.stringify({ content: text })); }
function fail(text) { ok(`❌ ${text}`); }

// TTL 显示用本地时间（v0.4.2）：裸 UTC ISO 串会被对照本地时钟误读成"已过期/秒过期"。
function fmtLocal(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function getSessionId() {
  // 经 Bash 工具调用时由 guard_hook 注入 ZCODE_SESSION_ID；终端手工调用则无。
  return C.sessionIdFromEnv() || C.MANUAL_SESSION_ID;
}

// ---------------------------------------------------------------------------
async function cmdCreate(params, cwd) {
  const { root, common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const cfg = C.loadConfig(root);
  const prefix = C.branchPrefix(cfg);
  const parent = C.worktreeParent(cfg);
  const task = (params.task_name || "").trim();

  if (!C.TASK_NAME_RE.test(task)) {
    return fail(`task_name 非法: '${task}'（要求 ^[a-z0-9][a-z0-9-]{0,49}$）`);
  }
  if (C.inLinkedWorktree(root)) {
    const { stdout: branch } = C.runGit(["branch", "--show-current"], root);
    return fail(`当前已在 worktree 副本内（分支 ${branch || "detached"}）。先退出再创建。`);
  }

  let base = (params.base_branch || "").trim();
  if (!base) {
    const r = C.runGit(["branch", "--show-current"], root);
    base = r.code === 0 && r.stdout ? r.stdout : "HEAD";
  }

  const branch = `${prefix}${task}`;
  const wtPath = path.join(root, parent, branch);

  const existsRef = C.runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
  if (existsRef.code === 0) return fail(`分支 ${branch} 已存在。用 enter 进入现有副本。`);
  if (fs.existsSync(wtPath)) return fail(`目录已存在: ${wtPath}。`);

  const ignoreCheck = C.runGit(["check-ignore", "-q", `${parent}/${branch}`], root);
  const ignored = ignoreCheck.code === 0;
  if (!ignored) C.ensureLocalExclude(root, `${parent}/`);

  try {
    C.runGit(["worktree", "add", wtPath, "-b", branch, base], root, { check: true });
  } catch (e) {
    return fail(`git worktree add 失败: ${e.message}`);
  }

  // v0.3 文件同步：复制文件 + 链接目录（复用 node_modules 等）
  const { copyFiles, symlinkDirs } = C.syncConfig(cfg);
  const syncLines = [];
  if (copyFiles.length || symlinkDirs.length) {
    if (copyFiles.length) {
      const cp = C.syncCopyFiles(root, wtPath, copyFiles);
      if (cp.copied.length) syncLines.push(`复制文件: ${cp.copied.join(", ")}`);
      if (cp.skipped.length) syncLines.push(`跳过文件: ${cp.skipped.join(", ")}`);
      if (cp.failed.length) syncLines.push(`⚠️ 复制失败: ${cp.failed.join("; ")}`);
    }
    if (symlinkDirs.length) {
      const sl = C.syncSymlinkDirs(root, wtPath, symlinkDirs);
      if (sl.linked.length) syncLines.push(`链接目录: ${sl.linked.join(", ")}`);
      if (sl.skipped.length) syncLines.push(`跳过目录: ${sl.skipped.join(", ")}`);
      if (sl.failed.length) syncLines.push(`⚠️ 链接失败: ${sl.failed.join("; ")}`);
    }
  }

  C.saveBaseByCommon(common, branch, base);
  C.ensureMeta(common);

  const lines = [`✅ worktree 已创建\n- 路径: ${wtPath}\n- 分支: ${branch}（基于 ${base}）`];
  if (!ignored) lines.push(`- 已将 ${parent}/ 追加到 .git/info/exclude`);
  if (syncLines.length) {
    lines.push("- 文件同步:");
    for (const sl of syncLines) lines.push(`  ${sl}`);
  }
  lines.push("\n下一步: enter 进入该副本后再做任何文件修改");
  ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
async function cmdEnter(params, cwd) {
  const raw = (params.path || "").trim();
  if (!raw) return fail("缺少 path 参数");
  const { root, common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const absPath = path.isAbsolute(raw) ? raw : path.join(root, raw);

  const wts = C.registeredWorktrees(root);
  const target = wts.find((w) => C.norm(w.path) === C.norm(absPath));
  if (!target) return fail(`${absPath} 不是本仓库已注册的 worktree。`);
  if (!fs.statSync(target.path).isDirectory()) return fail(`worktree 目录不存在: ${target.path}`);

  let branch = target.branch;
  if (!branch) {
    const r = C.runGit(["branch", "--show-current"], target.path);
    branch = r.stdout;
  }
  const cfg = C.loadConfig(root);
  const base = C.loadBasesByCommon(common)[branch] || "master";
  const sessionId = getSessionId();

  // 写 session 级 binding（绑定真值）+ state.json（仅记录最近活动，非绑定真值）
  const binding = { worktree: path.resolve(target.path), branch, base, source: "self" };
  C.saveBinding(common, sessionId, binding);
  C.saveStateByCommon(common, { active: true, path: binding.worktree, branch, base, entered_at: C.nowIso() });
  C.ensureMeta(common);

  ok(
    `✅ 已进入 worktree（会话 ${sessionId} 绑定）\n` +
    `- 路径: ${binding.worktree}\n- 分支: ${branch}\n\n` +
    "现在 agent 写主 checkout 路径会自动重写到该 worktree。\n" +
    "完成后用 exit 退出；合并回主分支必须等用户明确授权。"
  );
}

// ---------------------------------------------------------------------------
// v0.4.4：物理清理共享实现（exit(remove) 与 remove 子命令共用）。
// 职责：安全删链接 → git worktree remove（含 v0.4.2 半成功容错）→ 可选 git branch -d。
// 前置（调用方保证）：confirm_remove、脏检查、其他会话绑定检查均已通过。
// 就地追加输出行；返回 { removedOk }——false 表示 git worktree remove 真失败。
function cleanupWorktree(root, { wtPath, branch, deleteBranch }, lines) {
  // 🔴 v0.3 安全清理：先删除 worktree 内的 symlink/junction，再 git worktree remove。
  // 不先删 junction 直接递归删除可能跟随链接误删主仓库内容（如 node_modules）。
  const cfg = C.loadConfig(root);
  const { symlinkDirs } = C.syncConfig(cfg);
  if (symlinkDirs.length) {
    const rmLink = C.removeSyncedLinks(wtPath, symlinkDirs);
    if (rmLink.removed.length) lines.push(`- 已安全移除链接: ${rmLink.removed.join(", ")}`);
    if (rmLink.failed.length) lines.push(`- ⚠️ 移除链接失败: ${rmLink.failed.join("; ")}`);
  }
  let removedOk = false;
  const r = C.runGit(["worktree", "remove", wtPath], root);
  if (r.code !== 0) {
    // v0.4.2 容错：Windows 下 remove 可能半成功（git 已注销注册、目录删除 EPERM，
    // 如有进程占着副本目录）。此时重试报 "is not a working tree"——视为已注销，
    // 继续清绑定，目录残留提示手动处理，而不是卡死退出流程。
    if (/is not a working tree/i.test(r.stdout)) {
      lines.push(`⚠️ 副本已不在 git 注册表（可能此前 remove 半成功）；目录若有残留请手动删除。`);
      removedOk = true;
    } else {
      lines.push(`git worktree remove 失败: ${r.stdout}`);
      return { removedOk: false };
    }
  } else {
    lines.push(`🗑️ 副本目录已删除`);
    removedOk = true;
  }

  // v0.4.3：删分支（用户反馈——合并后副本已删但分支留着、agent 跑 `git branch -d` 又被
  // hook 无条件拦截、卡在 authorize-main）。此处直接在主 checkout 跑 git branch -d，
  // 绕开 agent Bash 拦截，给合并收尾一条 agent 可自走的正规路径。安全由 -d 闸门保证：
  // 仅删【已合并进 HEAD】的分支，未合并则 git 拒绝（非 -D），无需自定义合并判断。
  if (deleteBranch && removedOk && branch) {
    const del = C.runGit(["branch", "-d", branch], root);
    if (del.code === 0) {
      lines.push(`🌿 分支 ${branch} 已删除（已合并，git branch -d 校验通过）`);
    } else {
      lines.push(`📌 分支 ${branch} 保留：未合并进 HEAD 或仍被引用（${del.stdout.trim()}）。如确认不再需要，需用户授权后手动 git branch -D。`);
    }
  } else if (removedOk && branch) {
    lines.push(`📌 分支 ${branch} 保留（未带 delete_branch=true）。`);
  }
  return { removedOk };
}

// ---------------------------------------------------------------------------
async function cmdExit(params, cwd) {
  const action = params.action || "keep";
  const confirmRemove = params.confirm_remove || false;
  // v0.4.3：合并后收尾正规路径——worktree remove 成功后用 git branch -d 删已合并分支。
  // 仅 action=remove 生效（keep 模式保留副本，删分支会让副本悬空）。严格布尔判定，
  // 避免 "false"/0 等假值误触。
  const deleteBranch = params.delete_branch === true;
  const { common, root } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const sessionId = getSessionId();
  const binding = C.loadBinding(common, sessionId);
  const state = C.loadStateByCommon(common);
  // exit 是显式清理命令：优先用本会话 binding；若 binding 缺失，回退到 state.json
  // 记录的最近活动 worktree（便于清理/汇报），与 resolveBinding 语义无关。
  const active = binding || (state ? { worktree: state.path, branch: state.branch, base: state.base } : null);
  if (!active) return fail("当前会话没有活动 worktree。");

  const wtPath = active.worktree;
  const branch = active.branch || "";
  const base = active.base || "master";
  const lines = [`退出 worktree: ${wtPath}（分支 ${branch}，基于 ${base}）`];

  let nDirty = 0;
  if (fs.existsSync(wtPath) && fs.statSync(wtPath).isDirectory()) {
    // v0.3：dirtySummary 过滤 symlink_dirs（它们是链接，不是真正的未提交改动）
    const cfg = C.loadConfig(root);
    const { symlinkDirs } = C.syncConfig(cfg);
    const dirty = C.dirtySummary(wtPath, symlinkDirs);
    const ahead = C.aheadSummary(wtPath, base);
    nDirty = dirty.count;
    lines.push(`- 领先 ${base} 的提交: ${ahead.count} 个` + (ahead.sample.length ? "\n  " + ahead.sample.join("\n  ") : ""));
    lines.push(`- 未提交改动: ${dirty.count} 个文件` + (dirty.sample.length ? "\n  " + dirty.sample.join("\n  ") : ""));
    if (nDirty) lines.push("⚠️ 有未提交改动！建议先提交。");
  } else {
    lines.push("⚠️ 副本目录已不存在。");
  }

  // v0.2 悬空检查：其他 session 仍绑定该 worktree？
  const otherSessions = C.findBindingsForWorktree(common, wtPath).filter((s) => s !== sessionId);
  if (otherSessions.length > 0) {
    if (action === "remove") {
      return fail(
        `worktree ${wtPath} 仍被其他会话绑定: ${otherSessions.join(", ")}。\n` +
        "请先让那些会话退出，再 remove。当前可用 exit(action='keep') 仅退出本会话绑定。\n" + lines.join("\n")
      );
    }
    lines.push(`⚠️ 注意：该 worktree 仍被其他会话绑定（${otherSessions.join(", ")}），本退出不影响它们。`);
  }

  if (action === "remove") {
    if (!confirmRemove) return fail("action=remove 需要 confirm_remove=true。\n" + lines.join("\n"));
    if (nDirty) return fail("工作区有未提交改动，拒绝删除。\n" + lines.join("\n"));
    const res = cleanupWorktree(root, { wtPath, branch, deleteBranch }, lines);
    if (!res.removedOk) return fail(lines.join("\n"));
  }

  C.clearBinding(common, sessionId);
  if (state && state.path && C.norm(state.path) === C.norm(wtPath)) {
    C.clearStateByCommon(common);
  }
  lines.push("\n✅ 本会话绑定已清除。");
  if (action === "keep") {
    lines.push(`📌 报告口径：worktree \`${branch}\` 已就绪，待您确认是否合并。`);
    if (deleteBranch) {
      lines.push("ℹ️ delete_branch 仅在 action=remove 时生效，本次（keep）已忽略。");
    }
    lines.push(`合并回主分支并确认无误后收尾（删副本目录 + 清理已合并分支，git branch -d 仅删已合并）：`);
    lines.push(`- 仍持绑定时: exit(action='remove', confirm_remove=true, delete_branch=true)`);
    lines.push(`- 本命令之后（已退出）再合并的: {"path":"${wtPath}","confirm_remove":true,"delete_branch":true} 传给 remove 子命令`);
  }
  ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// v0.4.4：remove 子命令——exit-first 流的收尾路径（issue 反馈①）。
// 场景：exit(keep) 先退出 → 主副本自由合并（默认开放）→ 此时本会话已无绑定，
// exit(remove) 报"没有活动 worktree"、state 也已清——清理链路断裂，agent 只能
// 裸跑 git worktree remove（放行）+ git branch -d（被拦）。remove 接受显式 path：
//   ① path 是已注册 worktree → 完整清理（安全删链接 → worktree remove → 可选删分支）
//   ② path 已不在注册表（如 agent 手动 git worktree remove 过）但同名 worktree-*
//      分支仍在 → 仅剩分支清理（-d 闸门：仅删已合并）
async function cmdRemove(params, cwd) {
  const raw = (params.path || "").trim();
  if (!raw) return fail("缺少 path 参数");
  const { root, common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const absPath = path.isAbsolute(raw) ? raw : path.join(root, raw);
  const sessionId = getSessionId();
  const cfg = C.loadConfig(root);
  const prefix = C.branchPrefix(cfg);
  const deleteBranch = params.delete_branch === true;
  const lines = [];

  // 已注册 worktree（排除主 checkout 自身）
  const wts = C.registeredWorktrees(root);
  const target = wts.find((w) => C.norm(w.path) === C.norm(absPath) && C.norm(w.path) !== C.norm(root));
  let branch = "";
  if (target) {
    branch = target.branch || "";
    if (!branch) {
      const r = C.runGit(["branch", "--show-current"], target.path);
      branch = r.stdout;
    }
  } else {
    // 形态②：分支残留。目录名即分支名（create 约定），必须匹配分支前缀且 ref 存在。
    branch = path.basename(absPath.replace(/[\\/]+$/, ""));
    const isRef = C.runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
    if (isRef.code !== 0 || !branch.startsWith(prefix)) {
      return fail(`${absPath} 不是本仓库已注册的 worktree，也未能定位可清理的 ${prefix}* 分支残留。`);
    }
    lines.push(`⚠️ 目录已不在 git worktree 注册表，仅做分支清理: ${branch}`);
    if (!deleteBranch) {
      return fail(`副本已不存在、仅剩分支 ${branch}——请带 delete_branch=true 清理（git branch -d 仅删已合并）。`);
    }
  }

  // 其他会话绑定 → 拒绝（与 exit(remove) 同规矩）
  const otherSessions = C.findBindingsForWorktree(common, absPath).filter((s) => s !== sessionId);
  if (otherSessions.length > 0) {
    return fail(`worktree ${absPath} 仍被其他会话绑定: ${otherSessions.join(", ")}。请先让那些会话退出。`);
  }

  if (params.confirm_remove !== true) {
    return fail("remove 需要 confirm_remove=true。");
  }

  // 已注册形态：脏检查（分支残留形态无工作区，-d 闸门兜底）
  if (target) {
    const { symlinkDirs } = C.syncConfig(cfg);
    const dirty = C.dirtySummary(target.path, symlinkDirs);
    if (dirty.count) return fail(`工作区有未提交改动（${dirty.count} 个文件），拒绝删除。先提交或用 exit 汇报。`);
  }

  const res = cleanupWorktree(root, { wtPath: absPath, branch, deleteBranch }, lines);
  if (!res.removedOk) return fail(lines.join("\n"));

  // 本会话若仍绑定该副本（remove 兼作退出）→ 清绑定；state 记录匹配 → 清除
  const binding = C.loadBinding(common, sessionId);
  if (binding && binding.worktree && C.norm(binding.worktree) === C.norm(absPath)) {
    C.clearBinding(common, sessionId);
    lines.push("本会话绑定已清除。");
  }
  const state = C.loadStateByCommon(common);
  if (state && state.path && C.norm(state.path) === C.norm(absPath)) {
    C.clearStateByCommon(common);
  }
  lines.push("\n✅ remove 完成。");
  ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
async function cmdStatus(params, cwd) {
  const { root, common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const sessionId = getSessionId();
  const lines = [`主 checkout: ${root}`, "", "已注册 worktree:"];
  for (const wt of C.registeredWorktrees(root)) {
    const exists = fs.existsSync(wt.path) && fs.statSync(wt.path).isDirectory() ? "✅" : "❌";
    lines.push(`- ${wt.path}  [${wt.branch || "detached"}]  ${exists}`);
  }

  lines.push("", "会话绑定:");
  const bindings = C.listBindings(common);
  if (bindings.length === 0) {
    lines.push("  （无 session 绑定）");
  } else {
    for (const b of bindings) {
      const mark = b.sessionId === sessionId ? " ← 当前会话" : "";
      // 自诊断（v0.4.1）：cli-manual 绑定来自无会话环境（hook 注入未生效或终端手工调用），
      // ZCode 会话的 hook 读不到它——正是 v0.4.0 回归的现场特征，直接提示修复方式。
      const manualNote = b.sessionId === C.MANUAL_SESSION_ID
        ? " ⚠️ 无会话环境写入：ZCode 会话内不可见（重写不会生效）；在 ZCode 会话内重新 enter 可修复"
        : "";
      lines.push(`  ${b.sessionId}: ${b.worktree} [${b.branch}] (${b.source || "?"})${mark}${manualNote}`);
    }
  }

  const resolved = C.resolveBinding(common, sessionId);
  lines.push("");
  if (resolved) {
    lines.push(`当前会话有效绑定: ${resolved.worktree} [${resolved.branch}] (来源: ${resolved.source})`);
  } else {
    lines.push("当前会话有效绑定: 无（路径重写未启用）");
  }

  const state = C.loadStateByCommon(common);
  lines.push("");
  lines.push(
    state
      ? `最近活动 worktree（仅记录，非绑定）: ${state.path} [${state.branch}]`
      : "最近活动 worktree: 无"
  );
  const allowExp = C.globalAllowExpiry(common);
  if (allowExp) lines.push(`⚠️ 全局授权: 已启用（authorize-main，至 ${fmtLocal(allowExp)} 本地到期）`);
  ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
async function cmdAuthorize(params, cwd) {
  const { common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  // v0.4.4 TTL（外部反馈：revoke 靠自觉，忘了就无限期裸奔）：默认 15 分钟自动失效。
  const ttlRaw = parseInt(params.ttl_minutes ?? "", 10);
  const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : C.AUTH_DEFAULT_TTL_MIN;
  C.setGlobalAllow(common, (params.reason || "用户授权").trim(), ttl);
  const expiresAt = new Date(Date.now() + ttl * 60000).toISOString();
  ok(
    `✅ 已授权全局主 checkout 写入\n` +
    `有效期至: ${fmtLocal(expiresAt)}（本地时间，约 ${ttl} 分钟；ttl_minutes 可调）\n` +
    `注意：到期自动失效；提前完成应立即 revoke-main。`
  );
}

async function cmdRevoke(params, cwd) {
  const { common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  C.clearGlobalAllow(common);
  ok("✅ 已撤销全局主 checkout 写入授权。");
}

// ---------------------------------------------------------------------------
// v0.2 allow 子命令（仓库级临时放行，替代 MCP worktree_allow）
// 仓库级单文件（不按 session 分）：wt.mjs 和 hook 的 session_id 来源不同，按 session 分会错配
async function cmdAllow(params, cwd) {
  const { common, root } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const sessionId = getSessionId();
  const action = params.action || "add";

  if (action === "list") {
    const al = C.loadAllowlist(common);
    if (!al.paths || al.paths.length === 0) return ok(`当前仓库无放行路径。`);
    const lines = [`放行路径:`];
    for (const e of al.paths) {
      const exp = e.expires_at ? ` (至 ${fmtLocal(e.expires_at)} 本地)` : "";
      const by = e.by_session ? ` [by ${e.by_session}]` : "";
      lines.push(`  ${e.path}${exp}${by} — ${e.reason || "无说明"}`);
    }
    return ok(lines.join("\n"));
  }

  if (action === "clear") {
    C.clearAllowlist(common);
    return ok(`✅ 已清空放行列表。`);
  }

  // add
  const targetPath = (params.path || "").trim();
  if (!targetPath) return fail("缺少 path 参数");
  const reason = (params.reason || "").trim();

  // 注入防护：拒绝危险路径
  const dangerous = [".", "/", ".git", "*", "**", "./", ".\\"];
  const slashStripped = targetPath.replace(/[/\\]/g, "");
  if (dangerous.includes(targetPath) || [".git", "git"].includes(slashStripped) || slashStripped === "*") {
    return fail(`拒绝放行危险路径: '${targetPath}'（.git/根/通配符全匹配禁止）。`);
  }
  if (targetPath.includes(".git")) {
    return fail(`拒绝放行 .git 相关路径: '${targetPath}'。`);
  }

  const ttlMin = parseInt(params.ttl_minutes || "60", 10);
  const expiresAt = new Date(Date.now() + ttlMin * 60000).toISOString();
  C.addAllowlistEntry(common, {
    path: targetPath, reason, by_session: sessionId, created_at: C.nowIso(), expires_at: expiresAt,
  });
  C.appendAudit(common, { type: "allow_add", sessionId, path: targetPath, reason, expires_at: expiresAt });
  ok(`✅ 已放行: ${targetPath}\n原因: ${reason || "无"}\n有效期至: ${fmtLocal(expiresAt)}（本地时间，约 ${ttlMin} 分钟；by ${sessionId}）\n审计已记录。`);
}

// ---------------------------------------------------------------------------
async function main() {
  const action = process.argv[2] || "";
  const raw = await C.readStdinJson(50);
  const params = C.parseHookPayload(raw);
  const cwd = process.cwd();

  if (C.gitCommonDir(cwd) === null) {
    return fail(`当前目录不在 git 仓库内（${cwd}）。请在 git 仓库目录运行 wt.mjs。`);
  }

  const handlers = {
    create: cmdCreate, enter: cmdEnter, exit: cmdExit, remove: cmdRemove, status: cmdStatus,
    "authorize-main": cmdAuthorize, "revoke-main": cmdRevoke, allow: cmdAllow,
  };
  const handler = handlers[action];
  if (!handler) return fail(`未知子命令 '${action}'（可用: ${Object.keys(handlers).join(", ")}）`);
  try {
    await handler(params, cwd);
  } catch (e) {
    fail(`工具内部错误: ${e.constructor.name}: ${e.message}`);
  }
}

main();
