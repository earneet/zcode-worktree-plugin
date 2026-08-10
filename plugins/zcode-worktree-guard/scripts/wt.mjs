#!/usr/bin/env node
// zcode-worktree-guard 生命周期脚本：create / enter / exit / status / authorize-main / revoke-main
// 通信协议：stdin 收 JSON，stdout 打 {"content": ...}。所有异常兜底正常退出。
import * as C from "./common.mjs";
import path from "node:path";
import fs from "node:fs";

function ok(text) {
  console.log(JSON.stringify({ content: text }));
}
function fail(text) {
  ok(`❌ ${text}`);
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // 无 stdin 时立即 resolve
    setTimeout(() => resolve(data), 50);
  });
}

// ---------------------------------------------------------------------------
async function cmdCreate(params, cwd) {
  const root = C.findGitContextForCwd(cwd).root;
  const cfg = C.loadConfig(root);
  const prefix = C.branchPrefix(cfg);
  const parent = C.worktreeParent(cfg);
  const task = (params.task_name || "").trim();

  if (!C.TASK_NAME_RE.test(task)) {
    return fail(`task_name 非法: '${task}'（要求 ^[a-z0-9][a-z0-9-]{0,49}$）`);
  }

  if (C.inLinkedWorktree(root)) {
    const { stdout: branch } = C.runGit(["branch", "--show-current"], root);
    return fail(
      `当前已在 worktree 副本内（分支 ${branch || "detached"}）。先完成/退出当前副本（exit），不要嵌套创建。`
    );
  }

  let base = (params.base_branch || "").trim();
  if (!base) {
    const r = C.runGit(["branch", "--show-current"], root);
    base = r.code === 0 && r.stdout ? r.stdout : "HEAD";
  }

  const branch = `${prefix}${task}`;
  const wtPath = path.join(root, parent, branch);

  const existsRef = C.runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
  if (existsRef.code === 0) {
    return fail(`分支 ${branch} 已存在。如要继续该任务，用 enter 进入现有副本。`);
  }
  if (fs.existsSync(wtPath)) {
    return fail(`目录已存在: ${wtPath}。如是残留副本，请人工核查后处理。`);
  }

  const ignoreCheck = C.runGit(["check-ignore", "-q", `${parent}/${branch}`], root);
  const ignored = ignoreCheck.code === 0;
  if (!ignored) C.ensureLocalExclude(root, `${parent}/`);

  try {
    C.runGit(["worktree", "add", wtPath, "-b", branch, base], root, { check: true });
  } catch (e) {
    return fail(`git worktree add 失败: ${e.message}`);
  }

  const common = C.gitCommonDir(cwd);
  C.saveBaseByCommon(common, branch, base);

  const lines = [`✅ worktree 已创建\n- 路径: ${wtPath}\n- 分支: ${branch}（基于 ${base}）`];
  if (!ignored) lines.push(`- 已将 ${parent}/ 追加到 .git/info/exclude（本地排除，防 add -A 卷入）`);
  lines.push("\n下一步:\n1. enter 进入该副本后再做任何文件修改\n2. 如项目需要编译环境设置（复制未跟踪资源等），在副本内自行执行");
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
  if (!target) return fail(`${absPath} 不是本仓库已注册的 worktree（见 git worktree list）。`);
  if (!fs.statSync(target.path).isDirectory()) {
    return fail(`worktree 目录不存在: ${target.path}（可能被人工删除，先 git worktree prune）`);
  }

  let branch = target.branch;
  if (!branch) {
    const r = C.runGit(["branch", "--show-current"], target.path);
    branch = r.stdout;
  }
  const cfg = C.loadConfig(root);
  const base = (C.loadBasesByCommon(common)[branch]) || "master";

  const state = {
    active: true,
    path: path.resolve(target.path),
    branch,
    base,
    entered_at: C.nowIso(),
  };
  C.saveStateByCommon(common, state);
  ok(
    `✅ 已进入 worktree（活动副本已登记，写文件透明重写与硬约束生效）\n` +
    `- 路径: ${state.path}\n- 分支: ${branch}\n\n` +
    "纪律提醒：\n- 现在 agent 写主 checkout 路径会被 hook 自动重写到该 worktree（无需手改路径）\n" +
    "- 完成后用 exit 退出；合并回主分支必须等用户明确授权"
  );
}

// ---------------------------------------------------------------------------
async function cmdExit(params, cwd) {
  const action = params.action || "keep";
  const confirmRemove = params.confirm_remove || false;
  const { common, root } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const state = C.loadStateByCommon(common);
  if (!state) return fail("当前没有活动 worktree（状态文件不存在或已退出）。");

  const wtPath = state.path;
  const branch = state.branch || "";
  const base = state.base || "master";
  const lines = [`退出 worktree: ${wtPath}（分支 ${branch}，基于 ${base}）`];

  let nDirty = 0;
  if (fs.existsSync(wtPath) && fs.statSync(wtPath).isDirectory()) {
    const dirty = C.dirtySummary(wtPath);
    const ahead = C.aheadSummary(wtPath, base);
    nDirty = dirty.count;
    lines.push(`- 领先 ${base} 的提交: ${ahead.count} 个` + (ahead.sample.length ? "\n  " + ahead.sample.join("\n  ") : ""));
    lines.push(`- 未提交改动: ${dirty.count} 个文件` + (dirty.sample.length ? "\n  " + dirty.sample.join("\n  ") : ""));
    if (nDirty) lines.push("⚠️ 有未提交改动！建议先在副本内提交（git add <具体文件> 精确提交）。");
  } else {
    lines.push("⚠️ 副本目录已不存在。");
  }

  if (action === "remove") {
    if (!confirmRemove) return fail("action=remove 需要 confirm_remove=true 显式确认。\n" + lines.join("\n"));
    if (nDirty) return fail("工作区有未提交改动，拒绝删除。请先提交或人工清理。\n" + lines.join("\n"));
    const r = C.runGit(["worktree", "remove", wtPath], root);
    if (r.code !== 0) return fail(`git worktree remove 失败: ${r.stdout}\n` + lines.join("\n"));
    lines.push(`🗑️ 副本目录已删除（分支 ${branch} 保留；删分支需用户明确授权后人工执行）`);
  }

  C.clearStateByCommon(common);
  lines.push("\n✅ 活动状态已清除。");
  if (action === "keep") {
    lines.push(
      `📌 报告口径：worktree \`${branch}\` 已就绪，待您确认是否合并。` +
      "未获用户明确授权前，禁止 merge / rebase 进主分支，也禁止删除分支。"
    );
  }
  ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
async function cmdStatus(params, cwd) {
  const { root, common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  const lines = [`主 checkout: ${root}`, "", "已注册 worktree:"];
  for (const wt of C.registeredWorktrees(root)) {
    const exists = fs.existsSync(wt.path) && fs.statSync(wt.path).isDirectory() ? "✅" : "❌ 目录缺失";
    lines.push(`- ${wt.path}  [${wt.branch || "detached"}]  ${exists}`);
  }

  const state = C.loadStateByCommon(common);
  lines.push("");
  if (state) {
    const base = state.base || "master";
    lines.push(`活动 worktree: ${state.path}（分支 ${state.branch}，基于 ${base}，进入于 ${state.entered_at}）`);
    if (fs.existsSync(state.path)) {
      const dirty = C.dirtySummary(state.path);
      const ahead = C.aheadSummary(state.path, base);
      lines.push(`  领先 ${base} ${ahead.count} 个提交，未提交改动 ${dirty.count} 个文件`);
    }
    lines.push("路径重写：生效中（写主 checkout 路径自动改写到活动 worktree）");
  } else {
    lines.push("活动 worktree: 无（路径重写未启用）");
  }

  const override = C.loadOverrideByCommon(common);
  if (override && override.allow_main_writes) {
    lines.push(`⚠️ 主 checkout 写入授权: 已启用（原因: ${override.reason || "未说明"}）`);
  } else {
    lines.push("主 checkout 写入授权: 未启用（默认禁止在主 checkout 写入项目文件）");
  }
  ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
async function cmdAuthorize(params, cwd) {
  const reason = (params.reason || "用户授权").trim();
  const { common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  C.saveOverrideByCommon(common, {
    allow_main_writes: true,
    reason,
    created_at: C.nowIso(),
  });
  ok(
    `✅ 已授权在主 checkout 写入项目文件\n原因: ${reason}\n` +
    "注意：授权期间写文件硬约束对主 checkout 放行，完成修改后应立即 revoke-main。"
  );
}

async function cmdRevoke(params, cwd) {
  const { common } = C.findGitContextForCwd(cwd);
  if (!common) return fail("当前目录不在 git 仓库内。");
  C.clearOverrideByCommon(common);
  ok("✅ 已撤销主 checkout 写入授权。后续在主 checkout 写入项目文件将再次被拦截。");
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
    "authorize-main": cmdAuthorize, "revoke-main": cmdRevoke,
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
