#!/usr/bin/env node
// zcode-worktree-guard 生命周期脚本
// create/enter/exit/status/authorize-main/revoke-main/allow
// session 级绑定（bindings/<session_id>.json）+ subagent 继承 + 悬空检查。
// v0.4：默认主副本开放——绑定只由本会话 enter 产生；state.json 仅记录最近活动 + 授权标记。
import * as C from "./common.mjs";
import path from "node:path";
import fs from "node:fs";

function ok(text) { console.log(JSON.stringify({ content: text })); }
function fail(text) { ok(`❌ ${text}`); }

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 50);
  });
}

function getSessionId() {
  return process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "cli-manual";
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
async function cmdExit(params, cwd) {
  const action = params.action || "keep";
  const confirmRemove = params.confirm_remove || false;
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
    // 🔴 v0.3 安全清理：先删除 worktree 内的 symlink/junction，再 git worktree remove。
    // 不先删 junction 直接递归删除可能跟随链接误删主仓库内容（如 node_modules）。
    const cfg = C.loadConfig(root);
    const { symlinkDirs } = C.syncConfig(cfg);
    if (symlinkDirs.length) {
      const rmLink = C.removeSyncedLinks(wtPath, symlinkDirs);
      if (rmLink.removed.length) lines.push(`- 已安全移除链接: ${rmLink.removed.join(", ")}`);
      if (rmLink.failed.length) lines.push(`- ⚠️ 移除链接失败: ${rmLink.failed.join("; ")}`);
    }
    const r = C.runGit(["worktree", "remove", wtPath], root);
    if (r.code !== 0) return fail(`git worktree remove 失败: ${r.stdout}\n` + lines.join("\n"));
    lines.push(`🗑️ 副本目录已删除（分支 ${branch} 保留）`);
  }

  C.clearBinding(common, sessionId);
  if (state && state.path && C.norm(state.path) === C.norm(wtPath)) {
    C.clearStateByCommon(common);
  }
  lines.push("\n✅ 本会话绑定已清除。");
  if (action === "keep") {
    lines.push(`📌 报告口径：worktree \`${branch}\` 已就绪，待您确认是否合并。`);
  }
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
      lines.push(`  ${b.sessionId}: ${b.worktree} [${b.branch}] (${b.source || "?"})${mark}`);
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
  if (C.loadGlobalAllow(common)) lines.push("⚠️ 全局授权: 已启用（authorize-main）");
  ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
async function cmdAuthorize(params, cwd) {
  const { common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  C.setGlobalAllow(common, (params.reason || "用户授权").trim());
  ok(`✅ 已授权全局主 checkout 写入\n注意：完成后应立即 revoke-main。`);
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
      const exp = e.expires_at ? ` (至 ${e.expires_at})` : "";
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
  ok(`✅ 已放行: ${targetPath}\n原因: ${reason || "无"}\n有效期至: ${expiresAt}（by ${sessionId}）\n审计已记录。`);
}

// ---------------------------------------------------------------------------
async function main() {
  const action = process.argv[2] || "";
  const raw = (await readStdin()).replace(/^\ufeff/, "");
  let params = {};
  try { params = raw.trim() ? JSON.parse(raw) : {}; } catch { params = {}; }
  const cwd = process.cwd();

  if (C.gitCommonDir(cwd) === null) {
    return fail(`当前目录不在 git 仓库内（${cwd}）。请在 git 仓库目录运行 wt.mjs。`);
  }

  const handlers = {
    create: cmdCreate, enter: cmdEnter, exit: cmdExit, status: cmdStatus,
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
