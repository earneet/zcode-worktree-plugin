#!/usr/bin/env node
// zcode-worktree-guard 生命周期脚本 v0.2
// create/enter/exit/status/authorize-main/revoke-main/allow
// v0.2：session 级绑定（bindings/<session_id>.json）+ state.json 兜底 + 悬空检查
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

  C.saveBaseByCommon(common, branch, base);
  C.ensureMeta(common);

  const lines = [`✅ worktree 已创建\n- 路径: ${wtPath}\n- 分支: ${branch}（基于 ${base}）`];
  if (!ignored) lines.push(`- 已将 ${parent}/ 追加到 .git/info/exclude`);
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

  // v0.2：写 session 级 binding + state.json 兜底
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
  const active = binding || (state ? { worktree: state.path, branch: state.branch, base: state.base } : null);
  if (!active) return fail("当前会话没有活动 worktree。");

  const wtPath = active.worktree;
  const branch = active.branch || "";
  const base = active.base || "master";
  const lines = [`退出 worktree: ${wtPath}（分支 ${branch}，基于 ${base}）`];

  let nDirty = 0;
  if (fs.existsSync(wtPath) && fs.statSync(wtPath).isDirectory()) {
    const dirty = C.dirtySummary(wtPath);
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
  lines.push(state ? `state.json 兜底: ${state.path} [${state.branch}]` : "state.json 兜底: 无");
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
// v0.2 allow 子命令（会话级临时放行，替代 MCP worktree_allow）
async function cmdAllow(params, cwd) {
  const { common, root } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const sessionId = getSessionId();
  const action = params.action || "add";

  if (action === "list") {
    const al = C.loadAllowlist(common, sessionId);
    if (!al.paths || al.paths.length === 0) return ok(`会话 ${sessionId} 当前无放行路径。`);
    const lines = [`会话 ${sessionId} 放行路径:`];
    for (const e of al.paths) {
      const exp = e.expires_at ? ` (至 ${e.expires_at})` : "";
      lines.push(`  ${e.path}${exp} — ${e.reason || "无说明"}`);
    }
    return ok(lines.join("\n"));
  }

  if (action === "clear") {
    C.clearAllowlist(common, sessionId);
    return ok(`✅ 已清空会话 ${sessionId} 的放行列表。`);
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
  C.addAllowlistEntry(common, sessionId, {
    path: targetPath, reason, created_at: C.nowIso(), expires_at: expiresAt,
  });
  C.appendAudit(common, { type: "allow_add", sessionId, path: targetPath, reason, expires_at: expiresAt });
  ok(`✅ 已为会话 ${sessionId} 放行: ${targetPath}\n原因: ${reason || "无"}\n有效期至: ${expiresAt}\n审计已记录。`);
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
