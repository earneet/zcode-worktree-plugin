#!/usr/bin/env node
// zcode-worktree-guard v0.2 全量功能测试套件
//
// 运行: node --test tests/v2.test.mjs
//
// 覆盖矩阵（~80 用例）：
//   J  matchGlob 纯函数白盒单测
//   A  decideWrite 决策表（Write/Edit/Read）
//   B  Glob/Grep 搜索路径重写
//   C  Bash 危险操作拦截（5 条正则规则）
//   D  resolveBinding 三层降级（含真实 DB 继承）
//   E  allowlist 临时放行 + TTL + 注入防护
//   F  whitelist 声明式白名单 + validateWhitelist
//   G  authorize-main / revoke-main
//   H  wt.mjs 生命周期子命令
//   I  SessionStart hook 4 分支
//   K  鲁棒性 / 边界
//   N  会话身份贯通（v0.4.1 回归锁）+ Read 去武器化 + MSYS 路径/分支误报
//   O  git -C 语境解析（v0.4.2 反馈③）+ TTL 本地显示 + exit 容错 + 拦截文案

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import module from "node:module";
import * as C from "../plugins/zcode-worktree-guard/scripts/common.mjs";

// ESM 没有 require，用 createRequire（与 common.mjs 修复一致）。
const esmRequire = module.createRequire(import.meta.url);

// ── 脚本路径（相对于本测试文件） ──────────────────────────────────────────────
const SCRIPTS = path.join(import.meta.dirname, "..", "plugins", "zcode-worktree-guard", "scripts");
const HOOK = path.join(SCRIPTS, "guard_hook.mjs");
const WT = path.join(SCRIPTS, "wt.mjs");
const SS = path.join(SCRIPTS, "session_start.mjs");

// ═══════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════════════════════

/** 运行 guard_hook.mjs，stdin 喂 JSON */
function runHook(payload, opts = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd,
    timeout: 15000,
  });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** 运行 wt.mjs 子命令，子命令在 argv[2]，参数在 stdin JSON */
function runWt(sub, params = {}, opts = {}) {
  const r = spawnSync("node", [WT, sub], {
    input: JSON.stringify(params),
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd,
    timeout: 30000,
  });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** 从 wt.mjs 的 {"content":"..."} 输出中提取 content */
function wtContent(r) {
  try { return JSON.parse(r.stdout).content || ""; } catch { return ""; }
}

/** 运行 session_start.mjs */
function runSs(payload, opts = {}) {
  const r = spawnSync("node", [SS], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd,
    timeout: 15000,
  });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// ── 断言辅助 ──────────────────────────────────────────────────────────────────

/** 断言：exit 0 + stdout 含 hookSpecificOutput.updatedInput（可选检查 file_path 包含某子串） */
function assertRewrite(r, contains) {
  assert.equal(r.code, 0, `期望 exit 0（重写），实际 ${r.code}; stderr: ${r.stderr.slice(0, 200)}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); }
  catch { assert.fail(`stdout 不是 JSON: ${r.stdout.slice(0, 300)}`); }
  assert.ok(parsed.hookSpecificOutput?.updatedInput,
    `缺少 updatedInput: ${r.stdout.slice(0, 300)}`);
  if (contains) {
    // norm() 在 Windows 下小写化路径，hook 重写输出的 file_path 是小写。
    // 用 path.resolve + norm 做大小写/分隔符不敏感的包含比较。
    const fp = parsed.hookSpecificOutput.updatedInput.file_path
      || parsed.hookSpecificOutput.updatedInput.path || "";
    const nFp = C.norm(fp);
    const nContains = C.norm(contains);
    assert.ok(nFp.includes(nContains),
      `重写 file_path "${fp}" 不包含 "${contains}"`);
  }
  return parsed.hookSpecificOutput.updatedInput;
}

/** 断言：exit 2（拦截），可选检查 stderr 包含子串 */
function assertBlock(r, contains) {
  assert.equal(r.code, 2,
    `期望 exit 2（拦截），实际 ${r.code}; stdout: ${r.stdout.slice(0, 200)}; stderr: ${r.stderr.slice(0, 200)}`);
  if (contains) {
    assert.ok(r.stderr.toLowerCase().includes(contains.toLowerCase()),
      `stderr 缺少 "${contains}": ${r.stderr.slice(0, 400)}`);
  }
}

/** 断言：exit 0 + 空 stdout（放行，无重写） */
function assertPass(r) {
  assert.equal(r.code, 0, `期望 exit 0（放行），实际 ${r.code}; stderr: ${r.stderr}`);
  assert.equal(r.stdout, "", `期望空 stdout（放行无重写），实际: ${r.stdout.slice(0, 200)}`);
}

/** 断言：wt.mjs 输出含某关键字（成功） */
function assertWtOk(r, contains) {
  const content = wtContent(r);
  if (contains) {
    assert.ok(content.includes(contains), `wt 输出缺少 "${contains}": ${content.slice(0, 300)}`);
  }
}

/** 断言：wt.mjs 输出含 ❌（失败） */
function assertWtFail(r, contains) {
  const content = wtContent(r);
  assert.ok(content.includes("❌"), `期望失败但输出不含 ❌: ${content.slice(0, 300)}`);
  if (contains) {
    assert.ok(content.includes(contains), `wt 失败输出缺少 "${contains}": ${content.slice(0, 300)}`);
  }
}

// ── 临时仓库夹具 ──────────────────────────────────────────────────────────────

/** 创建一个带初始 commit 的临时 git 仓库，返回根目录绝对路径 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtg-test-"));
  spawnSync("git", ["init", "-q", "-b", "master"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir, encoding: "utf8" });
  // 测试仓库隔离：禁用 fsmonitor——本机系统级 core.fsmonitor=true 会让 git 在临时仓库
  // 里拉起 fsmonitor--daemon（detached 但继承 stdio 管道句柄），spawnSync 等不到管道
  // EOF 而永久挂起（实测卡死 makeRepo 的 git commit；偶发单用例失败同源）。
  spawnSync("git", ["config", "core.fsmonitor", "false"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, encoding: "utf8" });
  return dir;
}

/** 安全删除临时仓库（先强制移除所有 worktree 避免 Windows 文件锁） */
function cleanupRepo(dir) {
  try {
    const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: dir, encoding: "utf8" });
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        const wt = line.slice("worktree ".length);
        try { spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: dir, encoding: "utf8" }); } catch {}
      }
    }
  } catch {}
  // Windows 上 git 子进程刚退出时可能短暂持有 .git 下句柄，导致 rmSync EPERM。
  // 重试几次（退避等待句柄释放），仍失败则放弃——临时目录由 OS 清理，
  // 不应让测试清理的竞态污染测试结果（测试体断言已通过）。
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const end = Date.now() + 300;
      while (Date.now() < end) { /* busy-wait ~300ms 让句柄释放 */ }
    }
  }
}

/** 获取仓库的 git common dir */
function repoCommon(dir) {
  return C.gitCommonDir(dir);
}

/** 从真实 ZCode DB 获取一条 subagent→parent 继承链（用于 D 组真实继承测试） */
function getRealSubagentChain() {
  let DatabaseSync;
  try { ({ DatabaseSync } = esmRequire("node:sqlite")); } catch { return null; }
  try {
    const dbPath = C.resolveDbPath();
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
    const row = db.prepare(
      "SELECT id AS child, parent_id AS parent FROM session " +
      "WHERE id LIKE 'sess_subagent_%' AND parent_id IS NOT NULL LIMIT 1"
    ).get();
    db.close();
    return row || null;
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════════
// J. matchGlob 纯函数白盒单测
// ═══════════════════════════════════════════════════════════════════════════════

describe("J. matchGlob 纯函数", () => {
  const ROOT = "C:\\repo";
  // matchGlob 接收已 norm（小写化）的 target 和 pattern
  function mg(target, pattern) {
    return C.matchGlob(C.norm(path.join(ROOT, target)), C.norm(path.join(ROOT, pattern)));
  }

  it("J01: * 匹配同段（a.js）", () => assert.equal(mg("a.js", "*.js"), true));
  it("J02: * 不跨段（a/b.js vs *.js）", () => assert.equal(mg("a/b.js", "*.js"), false));
  it("J03: ** 跨段（a/b/c.js）", () => assert.equal(mg("a/b/c.js", "**"), true));
  it("J04: docs/**/*.md 匹配 docs/x/y.md", () => assert.equal(mg("docs/x/y.md", "docs/**/*.md"), true));
  it("J05: docs/**/*.md 匹配 docs/readme.md", () => assert.equal(mg("docs/readme.md", "docs/**/*.md"), true));
  it("J06: docs/**/*.md 不匹配 src/x.md", () => assert.equal(mg("src/x.md", "docs/**/*.md"), false));
  it("J07: ? 匹配单字符（ax.txt vs a?.txt）", () => assert.equal(mg("ax.txt", "a?.txt"), true));
  it("J08: ? 不匹配多字符（axx.txt vs a?.txt）", () => assert.equal(mg("axx.txt", "a?.txt"), false));
  it("J09: 正则元字符 . 被转义（精确匹配，非通配）", () => {
    // a.txt 中的 . 被转义为 \.，所以 a-txt 不匹配 a.txt
    assert.equal(mg("a-txt", "a.txt"), false);
    assert.equal(mg("a.txt", "a.txt"), true);
  });
  it("J10: 无通配符的精确匹配", () => assert.equal(mg("AGENTS.md", "AGENTS.md"), true));
});

// ═══════════════════════════════════════════════════════════════════════════════
// A. decideWrite 决策表（Write/Edit/Read）
// ═══════════════════════════════════════════════════════════════════════════════

describe("A. decideWrite 决策表（Write/Edit/Read）", () => {
  let repo, common, wtPath, sid;

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
    sid = "sess_test_a";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "feat" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env, cwd: repo });
    wtPath = path.join(repo, ".worktrees", "worktree-feat");
  });
  after(() => cleanupRepo(repo));

  // §7 rewrite
  it("A01: Write 主checkout → 重写到 worktree", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "x.js"), content: "x" },
    });
    assertRewrite(r, wtPath);
  });

  it("A02: Edit 主checkout → 重写（Edit 工具路径与 Write 相同）", () => {
    const r = runHook({
      tool_name: "Edit", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "x.js"), old_string: "x", new_string: "y" },
    });
    assertRewrite(r, wtPath);
  });

  // §6 inside-worktree
  it("A03: Write 已在 worktree 内 → 放行", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(wtPath, "y.js"), content: "y" },
    });
    assertPass(r);
  });

  // §1 .git 保护（硬规则，最高优先级）
  it("A04: Write .git/config → 拦截", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, ".git", "config"), content: "x" },
    });
    assertBlock(r, ".git");
  });

  it("A05: Write .git/objects/xx → 拦截", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, ".git", "objects", "ab", "cd"), content: "x" },
    });
    assertBlock(r, ".git");
  });

  // §2 outside-repo
  it("A06: Write 仓库外路径 → 放行", () => {
    const outside = path.join(os.tmpdir(), "wtg-outside-test.txt");
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: outside, content: "x" },
    });
    assertPass(r);
  });

  it("A07: Write 非 git 目录文件 → 放行", () => {
    const nonGit = path.join(os.tmpdir(), "wtg-nongit", "test.txt");
    fs.mkdirSync(path.dirname(nonGit), { recursive: true });
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: nonGit, content: "x" },
    });
    assertPass(r);
  });

  // §7/§8 cross-worktree deny（P3 修复后）
  it("A08: Write 其他 worktree 副本 → 拦截（跨副本写入保护）", () => {
    // P3 修复：decideWrite 在 §7 rewrite 前检查目标是否落在另一个已注册 worktree 内。
    // 之前 .worktrees/ 在 root 内会被错误重写，现在正确 deny。
    runWt("create", { task_name: "other" }, { env: { ZCODE_SESSION_ID: "sess_other" }, cwd: repo });
    const otherWt = path.join(repo, ".worktrees", "worktree-other");
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(otherWt, "z.js"), content: "z" },
    });
    assertBlock(r, "其他 worktree");
  });

  // §7 rewrite (Read)
  it("A09: Read 主checkout（有绑定）→ 重写", () => {
    const r = runHook({
      tool_name: "Read", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "readme.md") },
    });
    assertRewrite(r, wtPath);
  });

  // §7 rewrite (相对路径)
  it("A10: Write 相对路径 src/app.js → 重写", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: "src/app.js", content: "x" },
    });
    assertRewrite(r, wtPath);
  });

  it("A11: Write ./src/x.js → 重写", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: "./src/x.js", content: "x" },
    });
    assertRewrite(r, wtPath);
  });

  it("A12: Write 深层路径 → 重写精确 rel 拼接", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "a", "b", "c", "d.js"), content: "x" },
    });
    const result = assertRewrite(r);
    assert.equal(result.file_path, path.join(wtPath, "a", "b", "c", "d.js"));
  });

  it("A13: 大小写不一致 → norm 后正确重写", () => {
    // 用大写形式传入 file_path，norm() 小写化后应匹配
    const upperRepo = repo.toUpperCase();
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(upperRepo, "Case.js"), content: "x" },
    });
    // Windows 不区分大小写，重写应生效
    assertRewrite(r);
  });

  it("A13b: 重写保留原始大小写文件名（不小写化）", () => {
    // 回归：曾因 rel 用 norm(小写)过的路径计算，导致 AgentType.java → agenttype.java，
    // 破坏 Java 类名↔文件名契约（用户报告：Fantasia 项目编译失败）。
    // norm 只应用于 isInside 比对；rel 必须用原始大小写计算。
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: {
        file_path: path.join(repo, "scene", "src", "AgentType.java"),
        content: "x",
      },
    });
    const result = assertRewrite(r);
    assert.equal(
      path.basename(result.file_path),
      "AgentType.java",
      `重写后文件名被小写化！得到: ${result.file_path}`,
    );
    // 中间目录也要保留大小写
    assert.ok(result.file_path.includes(path.join("scene", "src", "AgentType.java")),
      `中间路径大小写未保留: ${result.file_path}`);
  });

  it("A13c: Edit 重写同样保留大小写文件名", () => {
    const r = runHook({
      tool_name: "Edit", cwd: repo, session_id: sid,
      tool_input: {
        file_path: path.join(repo, "AgentTypeAlignmentTest.java"),
        old_string: "a", new_string: "b",
      },
    });
    const result = assertRewrite(r);
    assert.equal(path.basename(result.file_path), "AgentTypeAlignmentTest.java",
      `Edit 重写后文件名被小写化: ${result.file_path}`);
  });

  it("A13d: Glob 搜索路径重写保留大小写", () => {
    const r = runHook({
      tool_name: "Glob", cwd: repo, session_id: sid,
      tool_input: { pattern: "*.java", path: path.join(repo, "Src", "Main") },
    });
    const result = assertRewrite(r);
    assert.ok(result.path.includes(path.join("Src", "Main")),
      `Glob 搜索路径被小写化: ${result.path}`);
  });

  // §2 outside-repo (prefix attack)
  it("A14: Write 路径前缀相似但实际仓库外 → 放行（防 isInside 前缀绕过）", () => {
    const fakeRepo = repo + "-evil";
    fs.mkdirSync(fakeRepo, { recursive: true });
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(fakeRepo, "x.js"), content: "x" },
    });
    assertPass(r);
  });

  it("A15: Write file_path 为空 → 放行（guard 早退）", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: "", content: "x" },
    });
    assertPass(r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A2. 默认开放（无绑定场景）—— v0.4：无绑定写主 checkout 放行（不再 fail-closed）
// ═══════════════════════════════════════════════════════════════════════════════

describe("A2. 默认开放（无绑定主副本）", () => {
  let repo, sid;

  before(() => {
    repo = makeRepo();
    sid = "sess_nobody"; // 无绑定
  });
  after(() => cleanupRepo(repo));

  it("A16: 无绑定 Write 主checkout → 放行（默认开放）", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "new.js"), content: "x" },
    });
    assertPass(r);
  });

  it("A17: 无绑定 Edit 主checkout → 放行（默认开放）", () => {
    const r = runHook({
      tool_name: "Edit", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "new.js"), old_string: "a", new_string: "b" },
    });
    assertPass(r);
  });

  it("A18: 无绑定 Read 主checkout → 放行", () => {
    const r = runHook({
      tool_name: "Read", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "readme.md") },
    });
    assertPass(r);
  });

  it("A19: 无绑定 Write 仓库外 → 放行", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(os.tmpdir(), "wtg-ext.txt"), content: "x" },
    });
    assertPass(r);
  });

  it("A20: 无绑定 Write .git → 拦截（硬规则仍生效）", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, ".git", "config"), content: "x" },
    });
    assertBlock(r, ".git");
  });

  it("A21: 无绑定 Write 其他 worktree 副本 → 拦截（跨副本保护始终生效）", () => {
    // v0.4：跨副本保护上提——即使无绑定，写到别的已注册 worktree 副本内仍 deny
    const env = { ZCODE_SESSION_ID: "sess_other_a21" };
    runWt("create", { task_name: "other-a21" }, { env, cwd: repo });
    const otherWt = path.join(repo, ".worktrees", "worktree-other-a21");
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(otherWt, "z.js"), content: "z" },
    });
    assertBlock(r, "其他 worktree");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. Glob/Grep 搜索路径重写
// ═══════════════════════════════════════════════════════════════════════════════

describe("B. Glob/Grep 搜索路径重写", () => {
  let repo, wtPath, sid;

  before(() => {
    repo = makeRepo();
    sid = "sess_test_b";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "feat" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env, cwd: repo });
    wtPath = path.join(repo, ".worktrees", "worktree-feat");
  });
  after(() => cleanupRepo(repo));

  it("B01: Glob 无 path + 有绑定 → 注入 path=worktree", () => {
    const r = runHook({
      tool_name: "Glob", cwd: repo, session_id: sid,
      tool_input: { pattern: "*.js" },
    });
    const result = assertRewrite(r);
    assert.equal(result.path, wtPath);
  });

  it("B02: Grep 无 path + 有绑定 → 注入 path=worktree", () => {
    const r = runHook({
      tool_name: "Grep", cwd: repo, session_id: sid,
      tool_input: { pattern: "foo" },
    });
    const result = assertRewrite(r);
    assert.equal(result.path, wtPath);
  });

  it("B03: Glob path 在主根下 → 重写到 worktree", () => {
    const r = runHook({
      tool_name: "Glob", cwd: repo, session_id: sid,
      tool_input: { pattern: "*.js", path: path.join(repo, "src") },
    });
    const result = assertRewrite(r);
    assert.equal(result.path, path.join(wtPath, "src"));
  });

  it("B04: Glob path 在 worktree 内 → 放行", () => {
    const r = runHook({
      tool_name: "Glob", cwd: repo, session_id: sid,
      tool_input: { pattern: "*.js", path: wtPath },
    });
    assertPass(r);
  });

  it("B05: Glob path 仓库外 → 放行", () => {
    const r = runHook({
      tool_name: "Glob", cwd: repo, session_id: sid,
      tool_input: { pattern: "*.js", path: os.tmpdir() },
    });
    assertPass(r);
  });

  it("B06: Glob 无绑定 → 放行（搜索只读，不注入）", () => {
    // 用独立 repo，确保无 state.json 兜底（B 组 before 的 enter 会写 state.json）
    const isolated = makeRepo();
    try {
      const r = runHook({
        tool_name: "Glob", cwd: isolated, session_id: "sess_nobody_b06",
        tool_input: { pattern: "*.js" },
      });
      assertPass(r);
    } finally {
      cleanupRepo(isolated);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. Bash 危险操作拦截
// ═══════════════════════════════════════════════════════════════════════════════

describe("C. Bash 危险操作拦截", () => {
  let repo, wtPath, sid;

  before(() => {
    repo = makeRepo();
    sid = "sess_test_c";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "feat" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env, cwd: repo });
    wtPath = path.join(repo, ".worktrees", "worktree-feat");
  });
  after(() => cleanupRepo(repo));

  // --- GIT_PUSH_PROTECTED_RE / GIT_PUSH_DEFAULT_RE ---

  it("C01: git push origin master → 拦截", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git push origin master" },
    });
    assertBlock(r, "push");
  });

  it("C02: git push origin main → 拦截", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git push origin main" },
    });
    assertBlock(r, "push");
  });

  it("C03: 裸 git push（在 master 分支上）→ 拦截", () => {
    // cwd = repo root → branch = master
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git push" },
    });
    assertBlock(r);
  });

  it("C04: 裸 git push（在 worktree 分支上）→ 放行", () => {
    // cwd = worktree → branch = worktree-feat（非受保护）
    const r = runHook({
      tool_name: "Bash", cwd: wtPath, session_id: sid,
      tool_input: { command: "git push" },
    });
    assertPass(r);
  });

  // --- GIT_CHECKOUT_RE ---

  it("C05: 有绑定时 git checkout master → 拦截", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git checkout master" },
    });
    assertBlock(r, "checkout");
  });

  it("C06: 有绑定时 git switch main → 拦截", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git switch main" },
    });
    assertBlock(r, "switch");
  });

  it("C07: git checkout feature（非受保护）→ 放行", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git checkout feature" },
    });
    assertPass(r);
  });

  // --- GIT_DEL_WORKTREE_RE ---

  it("C08: git branch -d worktree-xxx → 拦截", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git branch -d worktree-old" },
    });
    assertBlock(r);
  });

  it("C09: git branch -D worktree-xxx → 拦截", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git branch -D worktree-old" },
    });
    assertBlock(r);
  });

  // --- GIT_MUTATE_RE / GIT_MERGE_TARGET_RE ---

  it("C10: master 分支上 git merge feature → 拦截（受保护分支上 mutate）", () => {
    // cwd = repo → branch = master
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git merge feature" },
    });
    assertBlock(r);
  });

  it("C11: git merge worktree-xxx（任意位置）→ 拦截", () => {
    // cwd = worktree → branch = worktree-feat（非受保护），但 merge 目标是 worktree-* 分支
    const r = runHook({
      tool_name: "Bash", cwd: wtPath, session_id: sid,
      tool_input: { command: "git merge worktree-other" },
    });
    assertBlock(r, "worktree");
  });

  it("C12: worktree 内 git merge master（同步基线）→ 放行", () => {
    // SKILL 明确允许：副本内 merge master 同步基线
    const r = runHook({
      tool_name: "Bash", cwd: wtPath, session_id: sid,
      tool_input: { command: "git merge master" },
    });
    assertPass(r);
  });

  it("C13: 无危险操作的 git status → 放行", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git status" },
    });
    assertPass(r);
  });

  it("C14: 非 git 命令 → 放行", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "echo hello" },
    });
    assertPass(r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C2. 无绑定 Bash（v0.4 默认开放）——本地 git 操作放行，push 安全网仍拦
// ═══════════════════════════════════════════════════════════════════════════════

describe("C2. 无绑定 Bash（默认开放）", () => {
  let repo, sid;

  before(() => {
    repo = makeRepo();
    sid = "sess_nobody_c2"; // 无绑定
  });
  after(() => cleanupRepo(repo));

  it("C15: 无绑定 master 上 git merge feature → 放行（默认开放）", () => {
    // v0.4：mutate 检查仅 hasBinding/in_worktree 时拦截；无绑定=主副本自由工作流
    spawnSync("git", ["branch", "feature"], { cwd: repo, encoding: "utf8" });
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git merge feature" },
    });
    assertPass(r);
  });

  it("C16: 无绑定 git checkout master → 放行（默认开放）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git checkout master" },
    });
    assertPass(r);
  });

  it("C17: 无绑定 git rebase master → 放行（默认开放）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git rebase master" },
    });
    assertPass(r);
  });

  it("C18: 无绑定 git pull → 放行（默认开放）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git pull" },
    });
    assertPass(r);
  });

  it("C19: 无绑定 git push origin master → 仍拦截（push 安全网常驻）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git push origin master" },
    });
    assertBlock(r, "push");
  });

  it("C20: 无绑定 裸 git push（在 master 上）→ 仍拦截（安全网）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git push" },
    });
    assertBlock(r);
  });

  it("C21: 无绑定 git branch -d worktree-xxx → 仍拦截（删分支安全网）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git branch -d worktree-old" },
    });
    assertBlock(r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. resolveBinding 三层降级（含真实 DB 继承）
// ═══════════════════════════════════════════════════════════════════════════════

describe("D. resolveBinding 三层降级", () => {
  let repo, common;
  const realChain = getRealSubagentChain();

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
  });
  after(() => cleanupRepo(repo));

  // ① 自身直绑
  it("D01: 自身直绑 → source=self", () => {
    const sid = "sess_d01";
    C.saveBinding(common, sid, {
      worktree: "C:\\wt\\d01", branch: "worktree-d01", base: "master", source: "self",
    });
    const r = C.resolveBinding(common, sid);
    assert.ok(r);
    assert.equal(r.worktree, "C:\\wt\\d01");
    assert.equal(r.source, "self");
  });

  // ② 真实 DB 继承
  it("D02: 真实 DB 继承（subagent → parent 有绑定）→ source=inherited", (t) => {
    if (!realChain) { t.skip("跳过：DB 无可用 subagent 继承链"); return; }
    const { child, parent } = realChain;
    // 给 parent 写绑定
    C.saveBinding(common, parent, {
      worktree: "C:\\wt\\inherited", branch: "worktree-inh", base: "master", source: "self",
    });
    const r = C.resolveBinding(common, child);
    assert.ok(r, "子代理应继承到父绑定");
    assert.equal(r.worktree, "C:\\wt\\inherited");
    assert.equal(r.source, "inherited");
  });

  // ② 快照语义
  it("D03: 继承后写快照 → 第二次不查 DB（改父绑定不影响子）", (t) => {
    if (!realChain) { t.skip("跳过：DB 无可用 subagent 继承链"); return; }
    const { child, parent } = realChain;
    // D02 已快照了 child 的 binding，改 parent 的绑定
    C.saveBinding(common, parent, {
      worktree: "C:\\wt\\changed", branch: "worktree-changed", base: "master", source: "self",
    });
    const r = C.resolveBinding(common, child);
    // 子的快照不变
    assert.equal(r.worktree, "C:\\wt\\inherited");
    assert.equal(r.source, "inherited");
  });

  // ③ state.json 不再产生绑定（v0.4：默认开放，绑定只来自本会话 enter）
  it("D04: 无直绑无 DB → state.json 不再兜底 → 返回 null", () => {
    const sid = "sess_d04_top"; // 非 subagent 前缀，不查 DB
    C.saveStateByCommon(common, {
      active: true, path: "C:\\wt\\state", branch: "worktree-state", base: "master",
      entered_at: new Date().toISOString(),
    });
    const r = C.resolveBinding(common, sid);
    assert.equal(r, null, "v0.4：state.json 不应再产生绑定");
    C.clearStateByCommon(common);
  });

  // ④ 全无 → null
  it("D05: 全无绑定 → null", () => {
    C.clearStateByCommon(common);
    const sid = "sess_d05_nobody";
    const r = C.resolveBinding(common, sid);
    assert.equal(r, null);
  });

  // ② v0.4：继承链不再降级到 state.json（绑定只来自明确 enter / 父链直绑）
  it("D07: DB parent 无绑定 + 有 state.json → 返回 null（不再降级到 state）", (t) => {
    if (!realChain) { t.skip("跳过：DB 无可用 subagent 继承链"); return; }
    const { child, parent } = realChain;
    // 清掉 child 的所有绑定（含 D03 的 inherited 快照）和 parent 的绑定（含 D03 残留）
    C.clearBinding(common, child);
    C.clearBinding(common, parent);
    C.saveStateByCommon(common, {
      active: true, path: "C:\\wt\\fb", branch: "worktree-fb", base: "master",
      entered_at: new Date().toISOString(),
    });
    // resolveInherited 链：child → parent（顶层 sess_，无 binding）→ v0.4 不再查 state.json。
    const r = C.resolveBinding(common, child);
    assert.equal(r, null, "v0.4：继承链无直绑时不再降级到 state.json");
    C.clearStateByCommon(common);
  });

  // ① 优先于 ③
  it("D08: 自身直绑优先于 state.json", () => {
    const sid = "sess_d08";
    C.saveBinding(common, sid, {
      worktree: "C:\\wt\\self-d08", branch: "worktree-d08", base: "master", source: "self",
    });
    C.saveStateByCommon(common, {
      active: true, path: "C:\\wt\\state-d08", branch: "worktree-state", base: "master",
      entered_at: new Date().toISOString(),
    });
    const r = C.resolveBinding(common, sid);
    assert.equal(r.worktree, "C:\\wt\\self-d08");
    assert.equal(r.source, "self");
    C.clearStateByCommon(common);
  });

  // D10: 顶层 session 不查 DB
  it("D10: 顶层 session（sess_ 开头，非 subagent）→ 不查 DB", () => {
    const sid = "sess_d10_topLevel"; // 不以 sess_subagent_ 开头
    // 无直绑、无 state → null（不走 DB 查询）
    C.clearStateByCommon(common);
    const r = C.resolveBinding(common, sid);
    assert.equal(r, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. allowlist 临时放行 + TTL + 注入防护
// ═══════════════════════════════════════════════════════════════════════════════

describe("E. allowlist 临时放行", () => {
  let repo, common, sid;

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
    sid = "sess_nobody_e"; // 无绑定：allowlist 是唯一放行路径
  });
  after(() => cleanupRepo(repo));

  // --- add + 放行效果 ---

  it("E01: allow add 相对路径 → 后续 Write 放行", () => {
    runWt("allow", { action: "add", path: "README.md", reason: "临时改文档" }, { cwd: repo });
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "README.md"), content: "x" },
    });
    assertPass(r);
  });

  it("E02: allow add 绝对路径 → Write 放行", () => {
    const abs = path.join(repo, "abs-file.txt");
    runWt("allow", { action: "add", path: abs, reason: "绝对路径" }, { cwd: repo });
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: abs, content: "x" },
    });
    assertPass(r);
  });

  it("E03: allow add glob (docs/*.md) → Write docs/x.md 放行", () => {
    runWt("allow", { action: "add", path: "docs/*.md", reason: "glob" }, { cwd: repo });
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "docs", "guide.md"), content: "x" },
    });
    assertPass(r);
  });

  it("E04: allow list → 显示已有条目", () => {
    const r = runWt("allow", { action: "list" }, { cwd: repo });
    const content = wtContent(r);
    assert.ok(content.includes("README.md"), `list 缺少 README.md: ${content.slice(0, 300)}`);
  });

  // --- TTL 过期 ---

  it("E06: TTL 过期 → 过期条目不生效（白盒验证）", () => {
    // 直接写入一个已过期的条目
    C.addAllowlistEntry(common, {
      path: "expired.txt", reason: "已过期",
      expires_at: new Date(Date.now() - 60000).toISOString(),
      created_at: new Date().toISOString(),
    });
    assert.equal(
      C.isAllowlisted(common, path.join(repo, "expired.txt"), repo),
      false,
      "过期条目不应生效",
    );
  });

  it("E07: TTL 未过期 → 条目生效", () => {
    C.addAllowlistEntry(common, {
      path: "fresh.txt", reason: "未过期",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      created_at: new Date().toISOString(),
    });
    assert.equal(
      C.isAllowlisted(common, path.join(repo, "fresh.txt"), repo),
      true,
      "未过期条目应生效",
    );
  });

  // --- 注入防护 ---

  it("E08: allow add .git → 拒绝", () => {
    const r = runWt("allow", { action: "add", path: ".git", reason: "evil" }, { cwd: repo });
    assertWtFail(r, "拒绝");
  });

  it("E09: allow add * → 拒绝", () => {
    const r = runWt("allow", { action: "add", path: "*", reason: "evil" }, { cwd: repo });
    assertWtFail(r, "拒绝");
  });

  it("E10: allow add . → 拒绝", () => {
    const r = runWt("allow", { action: "add", path: ".", reason: "evil" }, { cwd: repo });
    assertWtFail(r, "拒绝");
  });

  it("E11: allow add 含 .git 的路径 → 拒绝", () => {
    const r = runWt("allow", { action: "add", path: "src/.git/config", reason: "evil" }, { cwd: repo });
    assertWtFail(r, "拒绝");
  });

  it("E12: allow add 后 audit.jsonl 有记录", () => {
    C.clearAllowlist(common);
    runWt("allow", { action: "add", path: "audit-test.md", reason: "审计检查" }, { cwd: repo });
    const auditFile = path.join(common, "worktree-guard", "audit.jsonl");
    assert.ok(fs.existsSync(auditFile), `audit.jsonl 不存在: ${auditFile}`);
    const content = fs.readFileSync(auditFile, "utf8");
    assert.ok(content.includes("audit-test.md"), `audit.jsonl 缺少记录: ${content.slice(0, 300)}`);
  });

  it("E05: allow clear → 清空", () => {
    runWt("allow", { action: "clear" }, { cwd: repo });
    const r = runWt("allow", { action: "list" }, { cwd: repo });
    const content = wtContent(r);
    assert.ok(content.includes("无放行路径"), `清空后应显示空: ${content.slice(0, 200)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F. whitelist 声明式白名单 + validateWhitelist
// ═══════════════════════════════════════════════════════════════════════════════

describe("F. whitelist 声明式白名单", () => {
  let repo, common, wtPath, sid;

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
    sid = "sess_test_f";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "feat" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env, cwd: repo });
    wtPath = path.join(repo, ".worktrees", "worktree-feat");
    // 写 sidecar 配置
    fs.mkdirSync(path.join(repo, ".zcode"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".zcode", "worktree-guard.json"),
      JSON.stringify({ main_write_whitelist: ["AGENTS.md", "docs/**/*.md"] }),
    );
  });
  after(() => cleanupRepo(repo));

  it("F01: 白名单精确匹配 AGENTS.md → Write 放行", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "AGENTS.md"), content: "x" },
    });
    assertPass(r);
  });

  it("F02: 白名单 glob docs/**/*.md → Write docs/a/b.md 放行", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "docs", "a", "b.md"), content: "x" },
    });
    assertPass(r);
  });

  it("F03: 非白名单路径 → 重写（不被白名单放行）", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "src", "app.js"), content: "x" },
    });
    assertRewrite(r, wtPath);
  });

  it("F04: 白名单优先于重写（有绑定仍放行白名单路径）", () => {
    // AGENTS.md 在白名单，即使有绑定也放行（不重写）
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "AGENTS.md"), content: "x" },
    });
    assertPass(r); // 不是 rewrite，是 pass
  });
});

describe("F2. validateWhitelist 危险模式检测", () => {
  it("F05: 危险裸根模式 → 标记 dangerous", () => {
    const { valid, dangerous } = C.validateWhitelist(["AGENTS.md", ".", "/", "*", "**", "./", ".\\"]);
    assert.ok(valid.includes("AGENTS.md"));
    for (const d of [".", "/", "*", "**"]) {
      assert.ok(dangerous.includes(d), `dangerous 缺少 "${d}": ${JSON.stringify(dangerous)}`);
    }
  });

  it("F06: 正常模式 → 标记 valid", () => {
    const { valid, dangerous } = C.validateWhitelist(["AGENTS.md", "docs/**/*.md", "src/*.ts"]);
    assert.equal(dangerous.length, 0);
    assert.equal(valid.length, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// G. authorize-main / revoke-main
// ═══════════════════════════════════════════════════════════════════════════════

describe("G. authorize-main / revoke-main", () => {
  let repo, common, wtPath, sid;

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
    sid = "sess_test_g";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "feat" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env, cwd: repo });
    wtPath = path.join(repo, ".worktrees", "worktree-feat");
  });
  after(() => cleanupRepo(repo));

  it("G01: authorize-main → 后续 Write 放行（不再重写）", () => {
    runWt("authorize-main", { reason: "测试全局授权" }, { cwd: repo });
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "main.js"), content: "x" },
    });
    assertPass(r); // 放行，不重写
  });

  it("G02: authorize-main → Bash 放行（handleBash 早退）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: "git push origin master" },
    });
    assertPass(r);
  });

  it("G04: authorize 期间写 .git → 仍拦截（硬规则优先于 globalAllow）", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, ".git", "config"), content: "x" },
    });
    assertBlock(r, ".git");
  });

  it("G03: revoke-main → Write 重新走正常决策（有绑定→重写）", () => {
    runWt("revoke-main", {}, { cwd: repo });
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "main.js"), content: "x" },
    });
    assertRewrite(r, wtPath);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H. wt.mjs 生命周期子命令
// ═══════════════════════════════════════════════════════════════════════════════

describe("H. wt.mjs 生命周期子命令", () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => cleanupRepo(repo));

  it("H01: create 合法 task_name → 成功，worktree 目录存在", () => {
    const r = runWt("create", { task_name: "my-feature" }, { cwd: repo });
    assertWtOk(r, "worktree 已创建");
    assert.ok(fs.existsSync(path.join(repo, ".worktrees", "worktree-my-feature")),
      "worktree 目录应存在");
  });

  it("H02: create 非法 task_name（大写）→ 失败", () => {
    const r = runWt("create", { task_name: "MyFeature" }, { cwd: repo });
    assertWtFail(r, "task_name 非法");
  });

  it("H02b: create 非法 task_name（中文）→ 失败", () => {
    const r = runWt("create", { task_name: "功能" }, { cwd: repo });
    assertWtFail(r, "task_name 非法");
  });

  it("H03: create 重复 task_name → 失败（分支已存在）", () => {
    runWt("create", { task_name: "dup" }, { cwd: repo });
    const r = runWt("create", { task_name: "dup" }, { cwd: repo });
    assertWtFail(r, "已存在");
  });

  it("H04: create 指定 base_branch → 成功", () => {
    // 先创建一个 base 分支
    spawnSync("git", ["branch", "develop"], { cwd: repo, encoding: "utf8" });
    const r = runWt("create", { task_name: "from-dev", base_branch: "develop" }, { cwd: repo });
    assertWtOk(r, "worktree 已创建");
  });

  it("H05: enter 未注册路径 → 失败", () => {
    const r = runWt("enter", { path: ".worktrees/nonexistent" }, { cwd: repo });
    assertWtFail(r);
  });

  it("H06: enter 合法 → 写 binding + state.json", () => {
    runWt("create", { task_name: "enter-test" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h06" };
    const r = runWt("enter", { path: ".worktrees/worktree-enter-test" }, { env, cwd: repo });
    assertWtOk(r, "已进入");
    const common = repoCommon(repo);
    const binding = C.loadBinding(common, "sess_h06");
    assert.ok(binding && binding.worktree, "binding 应已写入");
    const state = C.loadStateByCommon(common);
    assert.ok(state && state.active, "state.json 应已写入");
  });

  it("H07: exit action=keep → 清 binding，保留目录", () => {
    runWt("create", { task_name: "keep-test" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h07" };
    runWt("enter", { path: ".worktrees/worktree-keep-test" }, { env, cwd: repo });
    const r = runWt("exit", { action: "keep" }, { env, cwd: repo });
    assertWtOk(r, "绑定已清除");
    // 目录仍在
    assert.ok(fs.existsSync(path.join(repo, ".worktrees", "worktree-keep-test")),
      "keep 模式目录应保留");
    // binding 已清
    const common = repoCommon(repo);
    assert.equal(C.loadBinding(common, "sess_h07"), null, "binding 应已清除");
  });

  it("H08: exit action=remove 工作区脏 → 拒绝删除", () => {
    runWt("create", { task_name: "dirty-test" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h08" };
    runWt("enter", { path: ".worktrees/worktree-dirty-test" }, { env, cwd: repo });
    // 在 worktree 里写一个文件制造脏状态
    const wtDir = path.join(repo, ".worktrees", "worktree-dirty-test");
    fs.writeFileSync(path.join(wtDir, "uncommitted.txt"), "dirty");
    const r = runWt("exit", { action: "remove", confirm_remove: true }, { env, cwd: repo });
    assertWtFail(r, "未提交");
  });

  it("H09: exit action=remove 干净 + confirm → 删目录", () => {
    runWt("create", { task_name: "clean-test" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h09" };
    runWt("enter", { path: ".worktrees/worktree-clean-test" }, { env, cwd: repo });
    const r = runWt("exit", { action: "remove", confirm_remove: true }, { env, cwd: repo });
    assertWtOk(r, "已删除");
    assert.ok(!fs.existsSync(path.join(repo, ".worktrees", "worktree-clean-test")),
      "remove 模式目录应已删除");
  });

  it("H09b: exit action=remove 无 confirm → 拒绝", () => {
    runWt("create", { task_name: "noconfirm-test" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h09b" };
    runWt("enter", { path: ".worktrees/worktree-noconfirm-test" }, { env, cwd: repo });
    const r = runWt("exit", { action: "remove" }, { env, cwd: repo });
    assertWtFail(r, "confirm_remove");
  });

  it("H10: status → 显示 worktree 列表 + 有效绑定", () => {
    runWt("create", { task_name: "status-test" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h10" };
    runWt("enter", { path: ".worktrees/worktree-status-test" }, { env, cwd: repo });
    const r = runWt("status", {}, { env, cwd: repo });
    const content = wtContent(r);
    assert.ok(content.includes("已注册 worktree"), `status 缺少 worktree 列表: ${content.slice(0, 300)}`);
    assert.ok(content.includes("有效绑定"), `status 缺少有效绑定: ${content.slice(0, 300)}`);
    assert.ok(content.includes("worktree-status-test"), `status 缺少 worktree 名: ${content.slice(0, 300)}`);
  });

  it("H11: 悬空检查（exit remove 时其他 session 仍绑定）→ 拒绝", () => {
    runWt("create", { task_name: "dangling-test" }, { cwd: repo });
    // A、B 两 session 绑同一 worktree
    runWt("enter", { path: ".worktrees/worktree-dangling-test" },
      { env: { ZCODE_SESSION_ID: "sess_a" }, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-dangling-test" },
      { env: { ZCODE_SESSION_ID: "sess_b" }, cwd: repo });
    // A 尝试 remove → 拒绝（B 仍绑定）
    const r = runWt("exit", { action: "remove", confirm_remove: true },
      { env: { ZCODE_SESSION_ID: "sess_a" }, cwd: repo });
    assertWtFail(r, "其他会话");
  });

  // --- v0.4.3：exit delete_branch（合并后收尾正规路径，反馈驱动） ---

  it("H12: exit(remove, delete_branch=true) 分支已合并 → 删目录 + 删分支", () => {
    runWt("create", { task_name: "merged-feature" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h12" };
    runWt("enter", { path: ".worktrees/worktree-merged-feature" }, { env, cwd: repo });
    const wtDir = path.join(repo, ".worktrees", "worktree-merged-feature");
    // 副本内提交一个改动，再在主 checkout 合并
    fs.writeFileSync(path.join(wtDir, "feat.txt"), "x");
    spawnSync("git", ["add", "."], { cwd: wtDir, encoding: "utf8" });
    spawnSync("git", ["commit", "-q", "-m", "feat"], { cwd: wtDir, encoding: "utf8" });
    spawnSync("git", ["merge", "-q", "worktree-merged-feature"], { cwd: repo, encoding: "utf8" });
    const r = runWt("exit", { action: "remove", confirm_remove: true, delete_branch: true }, { env, cwd: repo });
    const content = wtContent(r);
    assertWtOk(r, "已删除");
    assert.ok(content.includes("分支 worktree-merged-feature 已删除"), `应提示分支已删: ${content.slice(0, 300)}`);
    assert.ok(!fs.existsSync(wtDir), "目录应已删除");
    const br = spawnSync("git", ["branch", "--list", "worktree-merged-feature"], { cwd: repo, encoding: "utf8" });
    assert.equal(br.stdout.trim(), "", "分支应已删除");
  });

  it("H13: exit(remove, delete_branch=true) 分支未合并 → 删目录，保留分支", () => {
    runWt("create", { task_name: "unmerged-feature" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h13" };
    runWt("enter", { path: ".worktrees/worktree-unmerged-feature" }, { env, cwd: repo });
    const wtDir = path.join(repo, ".worktrees", "worktree-unmerged-feature");
    // 副本内提交，但不合并到 master
    fs.writeFileSync(path.join(wtDir, "feat.txt"), "y");
    spawnSync("git", ["add", "."], { cwd: wtDir, encoding: "utf8" });
    spawnSync("git", ["commit", "-q", "-m", "feat2"], { cwd: wtDir, encoding: "utf8" });
    const r = runWt("exit", { action: "remove", confirm_remove: true, delete_branch: true }, { env, cwd: repo });
    const content = wtContent(r);
    assertWtOk(r, "已删除");
    assert.ok(content.includes("保留"), `应提示分支保留（未合并）: ${content.slice(0, 300)}`);
    assert.ok(!fs.existsSync(wtDir), "目录应已删除");
    const br = spawnSync("git", ["branch", "--list", "worktree-unmerged-feature"], { cwd: repo, encoding: "utf8" });
    assert.ok(br.stdout.includes("worktree-unmerged-feature"), "未合并分支应保留");
  });

  it("H14: exit(keep, delete_branch=true) → 提示已忽略，目录保留", () => {
    runWt("create", { task_name: "keep-ignore" }, { cwd: repo });
    const env = { ZCODE_SESSION_ID: "sess_h14" };
    runWt("enter", { path: ".worktrees/worktree-keep-ignore" }, { env, cwd: repo });
    const r = runWt("exit", { action: "keep", delete_branch: true }, { env, cwd: repo });
    const content = wtContent(r);
    assertWtOk(r, "已忽略");
    assert.ok(content.includes("delete_branch 仅在 action=remove"), `应提示已忽略: ${content.slice(0, 300)}`);
    assert.ok(fs.existsSync(path.join(repo, ".worktrees", "worktree-keep-ignore")), "keep 模式目录应保留");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// I. SessionStart hook 4 分支
// ═══════════════════════════════════════════════════════════════════════════════

describe("I. SessionStart hook 4 分支", () => {
  let repo, common;

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
  });
  after(() => cleanupRepo(repo));

  it("I04: 全新无任何状态 → 默认开放提示", () => {
    const r = runSs({ cwd: repo, session_id: "sess_i04" }, { cwd: repo });
    assert.equal(r.code, 0);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { assert.fail(`stdout 非 JSON: ${r.stdout.slice(0, 200)}`); }
    assert.ok(parsed.additionalContext, "缺少 additionalContext");
    assert.ok(parsed.additionalContext.includes("默认开放"),
      `v0.4 默认提示应含"默认开放": ${parsed.additionalContext.slice(0, 200)}`);
  });

  it("I01: session 已有直绑 → 已锁定提示", () => {
    const sid = "sess_i01";
    runWt("create", { task_name: "ss-test" }, { cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-ss-test" },
      { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    const r = runSs({ cwd: repo, session_id: sid }, { cwd: repo });
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { assert.fail(`stdout 非 JSON`); }
    assert.ok(parsed.additionalContext.includes("锁定"),
      `应含"锁定": ${parsed.additionalContext.slice(0, 200)}`);
  });

  it("I03: 无绑定但有遗留 state.json → 默认开放 + 上次会话信息提示", () => {
    const sid = "sess_i03_new"; // 新 session，无直绑
    // state.json 已被 I01 的 enter 写入（指向 worktree-ss-test）
    // 确认 state 存在
    const state = C.loadStateByCommon(common);
    assert.ok(state, "state.json 应存在");
    const r = runSs({ cwd: repo, session_id: sid }, { cwd: repo });
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { assert.fail(`stdout 非 JSON`); }
    // v0.4：state.json 不再产生绑定，走默认开放分支，附带"上次会话"信息提示
    assert.ok(parsed.additionalContext.includes("默认开放"),
      `应含"默认开放": ${parsed.additionalContext.slice(0, 200)}`);
    assert.ok(parsed.additionalContext.includes("上次会话"),
      `应含"上次会话"提示: ${parsed.additionalContext.slice(0, 200)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// K. 鲁棒性 / 边界
// ═══════════════════════════════════════════════════════════════════════════════

describe("K. 鲁棒性 / 边界", () => {
  let repo;
  before(() => { repo = makeRepo(); });
  after(() => cleanupRepo(repo));

  it("K01: stdin 非法 JSON → guard_hook 不崩溃、放行（fail-open）", () => {
    const r = spawnSync("node", [HOOK], {
      input: "this is not json {{{",
      encoding: "utf8", cwd: repo, timeout: 10000,
    });
    assert.equal(r.status, 0, `非法 JSON 应 exit 0（fail-open），实际 ${r.status}`);
  });

  it("K02: guard_hook tool_name 未知 → 放行", () => {
    const r = runHook({
      tool_name: "SomeUnknownTool", cwd: repo, session_id: "sess_k02",
      tool_input: { file_path: path.join(repo, "x.js") },
    });
    assertPass(r);
  });

  it("K03: cwd 不在 git 仓库 → 放行", () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "wtg-nogit-"));
    try {
      const r = runHook({
        tool_name: "Write", cwd: nonGit, session_id: "sess_k03",
        tool_input: { file_path: path.join(nonGit, "x.js"), content: "x" },
      });
      assertPass(r);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("K04: session_id 缺省 → 用 cli-manual 兜底不崩，默认开放放行", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo,
      // 不传 session_id
      tool_input: { file_path: path.join(repo, "x.js"), content: "x" },
    });
    // v0.4：cli-manual 无绑定 → 默认开放放行（不再 fail-closed）
    assertPass(r);
  });

  it("K05: 多 session 并发绑定不同 worktree → 互不干扰", () => {
    const env1 = { ZCODE_SESSION_ID: "sess_concurrent_1" };
    const env2 = { ZCODE_SESSION_ID: "sess_concurrent_2" };
    runWt("create", { task_name: "wt1" }, { env: env1, cwd: repo });
    runWt("create", { task_name: "wt2" }, { env: env2, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-wt1" }, { env: env1, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-wt2" }, { env: env2, cwd: repo });

    const wt1Path = path.join(repo, ".worktrees", "worktree-wt1");
    const wt2Path = path.join(repo, ".worktrees", "worktree-wt2");

    // session 1 → 重写到 wt1
    const r1 = runHook({
      tool_name: "Write", cwd: repo, session_id: "sess_concurrent_1",
      tool_input: { file_path: path.join(repo, "a.js"), content: "x" },
    });
    assertRewrite(r1, wt1Path);

    // session 2 → 重写到 wt2
    const r2 = runHook({
      tool_name: "Write", cwd: repo, session_id: "sess_concurrent_2",
      tool_input: { file_path: path.join(repo, "a.js"), content: "x" },
    });
    assertRewrite(r2, wt2Path);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// L. 代码审查修复验证（P0-P5）
// ═══════════════════════════════════════════════════════════════════════════════

describe("L. 代码审查修复验证", () => {
  let repo, common;
  beforeEach(() => { repo = makeRepo(); common = repoCommon(repo); });
  afterEach(() => cleanupRepo(repo));

  // --- P0: session_id 路径穿越防护 ---

  it("L01: 含 ../ 的 session_id → safeFileName 净化，不穿越目录", () => {
    const evilSid = "../../etc/evil";
    // saveBinding 不应写到 bindings/ 之外
    C.saveBinding(common, evilSid, {
      worktree: "C:\\wt", branch: "worktree-x", base: "master", source: "self",
    });
    // 绑定文件应落在 bindings/ 内，文件名被净化（无 ../）
    const bindingsDir = path.join(common, "worktree-guard", "bindings");
    const files = fs.existsSync(bindingsDir) ? fs.readdirSync(bindingsDir) : [];
    const evilPath = path.join(common, "etc", "evil.json");
    assert.ok(!fs.existsSync(evilPath), `路径穿越成功！evil 文件被写到: ${evilPath}`);
    // 净化后的文件应存在
    assert.ok(files.some((f) => f.endsWith(".json")), "绑定文件应在 bindings/ 内");
    // 读取时应能取回（sessionId 同样被 safeFileName 处理）
    const loaded = C.loadBinding(common, evilSid);
    assert.ok(loaded && loaded.worktree, "save/load 用同一 safeFileName 应能取回");
  });

  it("L02: 正常 session_id → 不受 safeFileName 影响", () => {
    const sid = "sess_normal_123";
    C.saveBinding(common, sid, {
      worktree: "C:\\wt", branch: "worktree-x", base: "master", source: "self",
    });
    assert.deepEqual(C.loadBinding(common, sid)?.worktree, "C:\\wt");
  });

  // --- P1: writeJson 原子化 ---

  it("L03: writeJson 写入后文件完整可读（无半写）", () => {
    // 用 saveBaseByCommon（内部走 writeJson）验证写入完整性
    C.saveBaseByCommon(common, "worktree-x", "develop");
    C.saveBaseByCommon(common, "worktree-y", "master");
    const bases = C.loadBasesByCommon(common);
    assert.equal(bases["worktree-x"], "develop");
    assert.equal(bases["worktree-y"], "master");
  });

  it("L04: writeJson 不残留临时文件", () => {
    C.saveAllowlist(common, { paths: [{ path: "x", reason: "t" }] });
    const dir = path.join(common, "worktree-guard");
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.startsWith(".tmp-"));
    assert.equal(tmpFiles.length, 0, `残留临时文件: ${tmpFiles}`);
  });

  // --- P2: allowlist 过期条目垃圾回收 ---

  it("L05: loadAllowlist 自动剔除过期条目（lazy GC）", () => {
    // 直接写入含过期和未过期条目的 allowlist
    C.saveAllowlist(common, {
      paths: [
        { path: "expired.md", expires_at: new Date(Date.now() - 60000).toISOString() },
        { path: "fresh.md", expires_at: new Date(Date.now() + 60000).toISOString() },
        { path: "nottl.md" }, // 无 TTL，永不过期
      ],
    });
    const al = C.loadAllowlist(common); // 触发 GC
    assert.equal(al.paths.length, 2, "过期条目应被 GC 剔除");
    assert.ok(al.paths.every((e) => e.path !== "expired.md"), "expired.md 不应残留");
    // 文件应已回写（GC 后）
    const reread = C.loadAllowlist(common);
    assert.equal(reread.paths.length, 2, "GC 回写后条目数一致");
  });

  it("L06: 全部未过期的 allowlist → GC 不触发无谓写", () => {
    C.saveAllowlist(common, {
      paths: [{ path: "a.md", expires_at: new Date(Date.now() + 60000).toISOString() }],
    });
    const al = C.loadAllowlist(common);
    assert.equal(al.paths.length, 1);
    // 再次 load 应仍为 1
    assert.equal(C.loadAllowlist(common).paths.length, 1);
  });

  // --- P3: decideWrite 跨副本 deny（端到端，已在 A08 覆盖，这里白盒验证逻辑） ---

  it("L07: 跨副本 deny 端到端 → 其他副本内 Write 被拦截", () => {
    const sid = "sess_l07";
    runWt("create", { task_name: "main" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-main" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    runWt("create", { task_name: "other" }, { env: { ZCODE_SESSION_ID: "sess_other" }, cwd: repo });
    const otherWt = path.join(repo, ".worktrees", "worktree-other");
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(otherWt, "x.js"), content: "x" },
    });
    assertBlock(r, "其他 worktree");
  });

  // --- P4: whitelistPatterns 过滤危险模式 ---

  it("L08: whitelistPatterns 过滤危险模式（*）→ 不放行裸根", () => {
    const cfg = { main_write_whitelist: ["*", "AGENTS.md", "docs/**/*.md"] };
    const patterns = C.whitelistPatterns(cfg);
    assert.ok(!patterns.includes("*"), "危险模式 * 应被剔除");
    assert.ok(patterns.includes("AGENTS.md"));
    assert.ok(patterns.includes("docs/**/*.md"));
  });

  it("L09: whitelistPatterns 过滤 / 和 .", () => {
    const cfg = { main_write_whitelist: ["/", ".", "**", "src/*.js"] };
    const patterns = C.whitelistPatterns(cfg);
    assert.equal(patterns.length, 1, "仅 src/*.js 合法");
    assert.ok(patterns.includes("src/*.js"));
  });

  it("L10: 危险白名单模式端到端 → 被过滤（绑定态下仍重写，防护生效）", () => {
    // v0.4：默认开放下无绑定 Write 放行，无法再用"无绑定 fail-closed"验证 * 过滤。
    // 改为绑定态：* 被过滤 → 无白名单 → Write 主 checkout 被重写到 worktree（而非被白名单放行）。
    const sid = "sess_l10";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "feat" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env, cwd: repo });
    const wtPath = path.join(repo, ".worktrees", "worktree-feat");
    fs.mkdirSync(path.join(repo, ".zcode"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".zcode", "worktree-guard.json"),
      JSON.stringify({ main_write_whitelist: ["*"] }),
    );
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "anything.js"), content: "x" },
    });
    // * 被过滤 → 无白名单 → 有绑定 → 重写（而非白名单放行）
    assertRewrite(r, wtPath);
  });

  it("L11: 正常白名单端到端 → 放行（未误杀）", () => {
    fs.mkdirSync(path.join(repo, ".zcode"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".zcode", "worktree-guard.json"),
      JSON.stringify({ main_write_whitelist: ["AGENTS.md"] }),
    );
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: "sess_l11",
      tool_input: { file_path: path.join(repo, "AGENTS.md"), content: "x" },
    });
    assertPass(r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M. v0.3 文件同步：copyFiles / symlinkDirs / junction + 清理安全
// ═══════════════════════════════════════════════════════════════════════════════

describe("M. v0.3 文件同步 + 清理安全", () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => cleanupRepo(repo));

  // --- syncConfig 路径校验 ---

  it("M01: syncConfig 正常解析 copy_files + symlink_dirs", () => {
    const cfg = { sync: { copy_files: ["package.json", ".env"], symlink_dirs: ["node_modules"] } };
    const { copyFiles, symlinkDirs } = C.syncConfig(cfg);
    assert.deepEqual(copyFiles, ["package.json", ".env"]);
    assert.deepEqual(symlinkDirs, ["node_modules"]);
  });

  it("M02: syncConfig 拒绝绝对路径和 .. 穿越", () => {
    const cfg = { sync: { copy_files: ["/etc/passwd", "../evil", "ok.txt"], symlink_dirs: ["C:\\evil", "..\\node_modules"] } };
    const { copyFiles, symlinkDirs } = C.syncConfig(cfg);
    assert.deepEqual(copyFiles, ["ok.txt"]);
    assert.deepEqual(symlinkDirs, []);
  });

  it("M03: syncConfig 无 sync 配置 → 空数组", () => {
    const { copyFiles, symlinkDirs } = C.syncConfig({});
    assert.deepEqual(copyFiles, []);
    assert.deepEqual(symlinkDirs, []);
  });

  // --- syncCopyFiles 白盒 ---

  it("M04: syncCopyFiles 正常复制文件", () => {
    fs.writeFileSync(path.join(repo, "package.json"), '{"name":"test"}');
    const wtPath = path.join(repo, ".worktrees", "wt-m04");
    fs.mkdirSync(wtPath, { recursive: true });
    const r = C.syncCopyFiles(repo, wtPath, ["package.json"]);
    assert.deepEqual(r.copied, ["package.json"]);
    assert.equal(r.failed.length, 0);
    assert.ok(fs.existsSync(path.join(wtPath, "package.json")));
    assert.equal(fs.readFileSync(path.join(wtPath, "package.json"), "utf8"), '{"name":"test"}');
  });

  it("M05: syncCopyFiles 源不存在 → 跳过", () => {
    const wtPath = path.join(repo, ".worktrees", "wt-m05");
    fs.mkdirSync(wtPath, { recursive: true });
    const r = C.syncCopyFiles(repo, wtPath, ["nonexistent.txt"]);
    assert.deepEqual(r.skipped, ["nonexistent.txt"]);
    assert.equal(r.copied.length, 0);
  });

  it("M06: syncCopyFiles 源是目录 → 跳过（copyFileSync 只复制文件）", () => {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const wtPath = path.join(repo, ".worktrees", "wt-m06");
    fs.mkdirSync(wtPath, { recursive: true });
    const r = C.syncCopyFiles(repo, wtPath, ["src"]);
    assert.equal(r.copied.length, 0);
    assert.equal(r.skipped.length, 1);
  });

  // --- syncSymlinkDirs 白盒 ---

  it("M07: syncSymlinkDirs 创建链接（Windows junction / 其他平台 dir symlink）", () => {
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "leftpad"), "x");
    const wtPath = path.join(repo, ".worktrees", "wt-m07");
    fs.mkdirSync(wtPath, { recursive: true });
    const r = C.syncSymlinkDirs(repo, wtPath, ["node_modules"]);
    if (r.failed.length === 0) {
      assert.deepEqual(r.linked, ["node_modules"]);
      assert.ok(fs.existsSync(path.join(wtPath, "node_modules", "leftpad")));
    }
    // CI/沙箱环境可能无 symlink 权限，failed 非空时容忍
  });

  it("M08: syncSymlinkDirs 源不存在 → 跳过", () => {
    const wtPath = path.join(repo, ".worktrees", "wt-m08");
    fs.mkdirSync(wtPath, { recursive: true });
    const r = C.syncSymlinkDirs(repo, wtPath, ["nonexistent"]);
    assert.deepEqual(r.skipped, ["nonexistent"]);
    assert.equal(r.linked.length, 0);
  });

  // --- 🔴 清理安全（最关键测试） ---

  it("M09: 🔴 removeSyncedLinks 用 lstat 识别 symlink，unlink 只删链接不删目标", () => {
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "important"), "主仓库数据");
    const wtPath = path.join(repo, ".worktrees", "wt-m09");
    fs.mkdirSync(wtPath, { recursive: true });
    const sl = C.syncSymlinkDirs(repo, wtPath, ["node_modules"]);
    if (sl.failed.length > 0) return; // 无 symlink 权限时跳过
    assert.ok(fs.lstatSync(path.join(wtPath, "node_modules")).isSymbolicLink());
    const rm = C.removeSyncedLinks(wtPath, ["node_modules"]);
    assert.deepEqual(rm.removed, ["node_modules"]);
    assert.equal(rm.failed.length, 0);
    // 🔴 核心断言：主仓库的 node_modules 仍完整
    assert.ok(fs.existsSync(path.join(repo, "node_modules", "important")),
      "清理后主仓库 node_modules 被误删！");
    assert.equal(fs.readFileSync(path.join(repo, "node_modules", "important"), "utf8"), "主仓库数据");
    assert.ok(!fs.existsSync(path.join(wtPath, "node_modules")));
  });

  it("M10: 🔴 removeSyncedLinks 对真目录不删（留给 git remove）", () => {
    const wtPath = path.join(repo, ".worktrees", "wt-m10");
    fs.mkdirSync(path.join(wtPath, "real-dir"), { recursive: true });
    fs.writeFileSync(path.join(wtPath, "real-dir", "file"), "x");
    const rm = C.removeSyncedLinks(wtPath, ["real-dir"]);
    assert.equal(rm.removed.length, 0, "真目录不应被 removeSyncedLinks 删除");
    assert.equal(rm.skipped.length, 1);
    assert.ok(fs.existsSync(path.join(wtPath, "real-dir", "file")));
  });

  // --- 端到端：create → exit(remove) 含 symlinkDirs 的清理安全 ---

  it("M11: 🔴 端到端 create(含symlinkDirs) → exit(remove) → 主仓库目标完整", () => {
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "pkg"), "共享依赖");
    fs.mkdirSync(path.join(repo, ".zcode"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".zcode", "worktree-guard.json"),
      JSON.stringify({ sync: { symlink_dirs: ["node_modules"] } }),
    );
    const sid = "sess_m11";
    const env = { ZCODE_SESSION_ID: sid };
    const cr = runWt("create", { task_name: "feat" }, { env, cwd: repo });
    assertWtOk(cr, "worktree 已创建");
    const wtNodeModules = path.join(repo, ".worktrees", "worktree-feat", "node_modules");
    if (!fs.existsSync(wtNodeModules)) return; // symlink 权限不足跳过
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env, cwd: repo });
    const er = runWt("exit", { action: "remove", confirm_remove: true }, { env, cwd: repo });
    assertWtOk(er, "副本目录已删除");
    // 🔴 核心安全断言：主仓库 node_modules 完整
    assert.ok(fs.existsSync(path.join(repo, "node_modules", "pkg")),
      "exit(remove) 后主仓库 node_modules 被误删！");
    assert.equal(fs.readFileSync(path.join(repo, "node_modules", "pkg"), "utf8"), "共享依赖");
  });

  it("M12: 端到端 create(含copyFiles) → 文件已复制到 worktree", () => {
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=abc");
    fs.mkdirSync(path.join(repo, ".zcode"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".zcode", "worktree-guard.json"),
      JSON.stringify({ sync: { copy_files: [".env"] } }),
    );
    const cr = runWt("create", { task_name: "feat" }, { env: { ZCODE_SESSION_ID: "sess_m12" }, cwd: repo });
    assertWtOk(cr, "worktree 已创建");
    const copied = path.join(repo, ".worktrees", "worktree-feat", ".env");
    assert.ok(fs.existsSync(copied), ".env 应已复制到 worktree");
    assert.equal(fs.readFileSync(copied, "utf8"), "SECRET=abc");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// N. 会话身份贯通（v0.4.1 回归锁）+ Read 去武器化 + MSYS 路径/分支误报
//
// 背景（v0.4.0 线上回归）：wt.mjs 经 Bash 调用拿不到 ZCODE 的 session_id（环境
// 变量不注入），enter 写到 cli-manual 名下；hook 用 payload 真实 sess_* 查询 →
// 绑定永远解析失败 → 重写失效（直写 master）+ 跨副本误拦（连 Read 都拦）。
// v0.4.1 修复：guard_hook 对调用 wt.mjs 的 Bash 命令注入 `export ZCODE_SESSION_ID=
// <id>; ` 前缀（updatedInput），身份随进程环境传递。N04 是本回归的端到端锁。
// ═══════════════════════════════════════════════════════════════════════════════

describe("N. 会话身份贯通 + Read 去武器化 + MSYS 路径", () => {
  let repo, common, sid, wtPath, otherWt;

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
    sid = "sess_n_bound";
    runWt("create", { task_name: "feat" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    wtPath = path.join(repo, ".worktrees", "worktree-feat");
    runWt("create", { task_name: "other" }, { env: { ZCODE_SESSION_ID: "sess_n_maker" }, cwd: repo });
    otherWt = path.join(repo, ".worktrees", "worktree-other");
  });
  after(() => cleanupRepo(repo));

  // --- 会话身份注入 ---

  it("N01: Bash 调用 wt.mjs → hook 注入 export ZCODE_SESSION_ID 前缀（命令逐字保留）", () => {
    const cmd = `echo '{"path":".worktrees/worktree-feat"}' | node "${WT}" enter`;
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: cmd },
    });
    assert.equal(r.code, 0, `期望 exit 0，实际 ${r.code}; stderr: ${r.stderr.slice(0, 200)}`);
    const newCmd = JSON.parse(r.stdout).hookSpecificOutput?.updatedInput?.command;
    assert.equal(newCmd, `export ZCODE_SESSION_ID=${sid}; ${cmd}`,
      `注入后命令不符合预期: ${newCmd}`);
  });

  it("N02: 命令已含 ZCODE_SESSION_ID= → 幂等，不再注入", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: `export ZCODE_SESSION_ID=sess_x; node "${WT}" status` },
    });
    assertPass(r);
  });

  it("N03: 不安全 session_id（含空格/引号）→ 不注入（防 shell 注入）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: 'bad"id; echo pwned',
      tool_input: { command: `node "${WT}" status` },
    });
    assertPass(r);
  });

  it("N04: 🔴 端到端回归锁：注入身份 enter → hook 以 payload id 解析绑定 → 透明重写", () => {
    // 1) hook 看到的真实结构：agent 在 Bash 工具里调 wt.mjs enter（写侧无会话 env）
    const cmd = `echo '{"path":".worktrees/worktree-feat"}' | node "${WT}" enter`;
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: cmd },
    });
    // 2) 从注入命令提取 export 的 id（模拟真实 shell 执行该命令时的环境）
    const newCmd = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command;
    const m = newCmd.match(/^export ZCODE_SESSION_ID=([^;]+); /);
    assert.ok(m, `注入前缀缺失: ${newCmd.slice(0, 120)}`);
    assert.equal(m[1], sid);
    // 3) wt.mjs 在该 env 下运行 enter（= 注入后命令的真实效果）
    const er = runWt("enter", { path: ".worktrees/worktree-feat" }, { env: { ZCODE_SESSION_ID: m[1] }, cwd: repo });
    assertWtOk(er, "已进入 worktree");
    // 4) hook 以 payload session_id（与 env 同值）解析绑定 → 主 checkout 写入被重写
    const wr = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(repo, "n04.js"), content: "x" },
    });
    assertRewrite(wr, wtPath);
  });

  it("N05: exit 经注入身份运行 → 只清本会话绑定，他 session 绑定不受影响", () => {
    runWt("enter", { path: ".worktrees/worktree-other" }, { env: { ZCODE_SESSION_ID: "sess_n05b" }, cwd: repo });
    const xr = runWt("exit", { action: "keep" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    assertWtOk(xr, "本会话绑定已清除");
    assert.equal(C.loadBinding(common, sid), null, "本会话绑定应已清除");
    const other = C.loadBinding(common, "sess_n05b");
    assert.ok(other && other.worktree, "其他会话绑定不应被误清");
    runWt("exit", { action: "keep" }, { env: { ZCODE_SESSION_ID: "sess_n05b" }, cwd: repo });
  });

  it("N06: 无会话 env 的 enter 落 cli-manual，status 提示该绑定对 ZCode 会话不可见", () => {
    runWt("enter", { path: ".worktrees/worktree-feat" }, { cwd: repo }); // 无 env（终端手工调用形态）
    const st = wtContent(runWt("status", {}, { cwd: repo }));
    assert.ok(st.includes("cli-manual"), `status 应列出 cli-manual 绑定: ${st.slice(0, 300)}`);
    assert.ok(st.includes("不可见"), `status 应提示 cli-manual 绑定对会话不可见: ${st.slice(0, 300)}`);
    runWt("exit", { action: "keep" }, { cwd: repo }); // 清理
  });

  // --- Read 去武器化（v0.4.1：默认开放哲学下读操作永不拦截） ---

  it("N07: 无绑定 Read 其他 worktree 副本 → 放行（v0.4.0 曾误拦）", () => {
    const r = runHook({
      tool_name: "Read", cwd: repo, session_id: "sess_n_nobody",
      tool_input: { file_path: path.join(otherWt, "z.js") },
    });
    assertPass(r);
  });

  it("N08: 无绑定 Read .git → 放行（读取排障无害；写仍拦截）", () => {
    const r = runHook({
      tool_name: "Read", cwd: repo, session_id: "sess_n_nobody",
      tool_input: { file_path: path.join(repo, ".git", "config") },
    });
    assertPass(r);
  });

  it("N09: 有绑定 Read 其他副本 → 放行且不重写（防路径错拼到自身副本下）", () => {
    // N05 已清除本组 sid 的绑定，此处自持重建（用例间不依赖执行顺序之外的隐式状态）
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    const r = runHook({
      tool_name: "Read", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(otherWt, "z.js") },
    });
    assertPass(r); // 放行 = 不产生 updatedInput（重写会把路径拼进自身副本，错位）
  });

  it("N10: Bash 命令同时含 wt.mjs 与危险 git 操作 → 拦截优先（注入不跳过保护）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: `node "${WT}" enter && git push origin master` },
    });
    assertBlock(r, "push");
  });

  // --- MSYS 路径归一化 + git 上下文误报 ---

  it("N11: extractCdTarget 归一化 Git Bash 盘符路径（/f/... 与 /cygdrive/f/...）", () => {
    if (process.platform !== "win32") return; // POSIX 上无此形态
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), "wtg-msys-"));
    const drive = sub[0].toLowerCase();
    const msys = `/${drive}${sub.slice(2).replace(/\\/g, "/")}`;
    assert.equal(C.extractCdTarget(`cd ${msys} && git status`, "F:\\cur"), sub);
    assert.equal(C.extractCdTarget(`cd /cygdrive${msys} && git status`, "F:\\cur"), sub);
  });

  it("N12: cd 到不存在目录 → 视为无有效 cd（对齐 bash 失败停留在原 cwd 的语义）", () => {
    assert.equal(C.extractCdTarget("cd /definitely/not/exists && git status", "F:\\cur"), null);
  });

  it("N13: currentBranch 区分 git 失败与真 detached HEAD（不再误报）", () => {
    assert.equal(C.currentBranch(path.join(os.tmpdir(), "wtg-no-such-n13")), "(git 调用失败)");
    const repo2 = makeRepo();
    try {
      assert.equal(C.currentBranch(repo2), "master");
      spawnSync("git", ["checkout", "-q", "--detach"], { cwd: repo2, encoding: "utf8" });
      assert.equal(C.currentBranch(repo2), "(detached HEAD)");
    } finally {
      cleanupRepo(repo2);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// O. git -C 语境解析（v0.4.2 反馈③）+ TTL 本地显示 + exit 容错 + 拦截文案
//
// 背景（外部反馈症状③）：绑定态下 `git -C <worktree> merge ...` 此前按主 checkout
// 语境求值分支（master）→ 误判为"受保护分支上 merge"而拦截，副本内的 git 闭环
// （改码 → 提交 → 编译 → 测试）走不通。v0.4.2：hook 按 `git -C` 目标求值语境；
// 同命令内 `VAR=...` 赋值可解析 `$VAR` 形态的目标（反馈实发命令即此形态）。
// ═══════════════════════════════════════════════════════════════════════════════

describe("O. git -C 语境解析 + v0.4.2 修复", () => {
  let repo, common, sid, wtPath, otherWt;

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
    sid = "sess_o_bound";
    runWt("create", { task_name: "feat" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-feat" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    wtPath = path.join(repo, ".worktrees", "worktree-feat");
    runWt("create", { task_name: "other" }, { env: { ZCODE_SESSION_ID: "sess_o_maker" }, cwd: repo });
    otherWt = path.join(repo, ".worktrees", "worktree-other");
    // 反馈者的命令形态：合并一个【无 worktree- 前缀】的分支
    spawnSync("git", ["branch", "fix-demo"], { cwd: repo, encoding: "utf8" });
  });
  after(() => cleanupRepo(repo));

  // --- 端到端：git -C 语境（反馈③复现） ---

  it("O01: 🔴 绑定态 git -C <WT> merge --ff-only <非worktree前缀分支> → 放行（反馈③）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: `git -C "${wtPath}" merge --ff-only fix-demo` },
    });
    assertPass(r);
  });

  it("O02: 绑定态 git -C <WT> merge master（同步基线）→ 放行", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: `git -C "${wtPath}" merge master` },
    });
    assertPass(r);
  });

  it("O03: 绑定态 git -C <主checkout> merge → 仍拦截（-C 指向主副本时语境正确）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: `git -C "${repo}" merge fix-demo` },
    });
    assertBlock(r, "受保护分支");
  });

  it("O04: git -C <WT> checkout master → 仍拦截（防副本被劫持到受保护分支）", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: `git -C "${wtPath}" checkout master` },
    });
    assertBlock(r, "checkout");
  });

  it("O05: 绑定态 同命令变量形式 git -C \"$WT\" merge（反馈实发形态）→ 放行", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: sid,
      tool_input: { command: `WT="${wtPath}"\ngit -C "$WT" merge --ff-only fix-demo` },
    });
    assertPass(r);
  });

  // --- extractGitCTarget 单元 ---

  it("O06: extractGitCTarget 解析形态（字面量/引号/裸词/相对/-c 前缀/链式取最后/无-C）", () => {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "wtg-ogc1-"));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "wtg-ogc2-"));
    const rel = path.join(d1, "relsub");
    fs.mkdirSync(rel, { recursive: true });
    const cur = "F:\\nonexistent-cur";
    try {
      assert.equal(C.extractGitCTarget(`git -C ${d2} status`, cur), path.resolve(d2), "裸词");
      assert.equal(C.extractGitCTarget(`git -C "${d1}" status`, cur), path.resolve(d1), "双引号");
      assert.equal(C.extractGitCTarget(`git -C '${d1}' status`, cur), path.resolve(d1), "单引号");
      assert.equal(C.extractGitCTarget(`git -C relsub status`, d1), path.resolve(rel), "相对路径基于 baseCwd");
      assert.equal(C.extractGitCTarget(`git -c a=b -C "${d1}" status`, cur), path.resolve(d1), "-c 前缀后 -C");
      assert.equal(C.extractGitCTarget(`git -C "${d1}" a; git -C "${d2}" b`, cur), path.resolve(d2), "链式取最后");
      assert.equal(C.extractGitCTarget(`git status`, cur), null, "无 -C");
      assert.equal(C.extractGitCTarget(`git -C "F:\\no\\such\\dir" status`, cur), null, "不存在 → null");
      assert.equal(C.extractGitCTarget(`git -C $NOPE status`, cur), null, "未赋值 $VAR → null");
      // cd 与 -C 组合：-C 相对路径应基于 cd 后语境（模拟 guard_hook 的两级解析）
      const cdT = C.extractCdTarget(`cd "${d1}" && git -C relsub status`, cur);
      assert.equal(C.extractGitCTarget(`cd "${d1}" && git -C relsub status`, cdT || cur), path.resolve(rel), "cd 后相对 -C");
    } finally {
      fs.rmSync(d1, { recursive: true, force: true });
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });

  // --- TTL 本地显示（反馈④） ---

  it("O07: allow 输出显示本地时间与分钟数（不再裸 UTC ISO 串）", () => {
    const r = runWt("allow", { action: "add", path: "docs/tmp-o07.md", reason: "测试" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
    const content = wtContent(r);
    assert.ok(content.includes("本地时间"), `应标注本地时间: ${content.slice(0, 300)}`);
    assert.ok(content.includes("60 分钟"), `应显示时长: ${content.slice(0, 300)}`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(content), `不应再输出裸 UTC ISO: ${content.slice(0, 300)}`);
    runWt("allow", { action: "clear" }, { env: { ZCODE_SESSION_ID: sid }, cwd: repo });
  });

  // --- exit(remove) 半成功容错（live 验证发现的 Windows 边缘） ---

  it("O08: exit(remove) 遇 is not a working tree → 视为已注销，清绑定不卡死", () => {
    const sid2 = "sess_o08";
    runWt("create", { task_name: "halfgone" }, { env: { ZCODE_SESSION_ID: sid2 }, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-halfgone" }, { env: { ZCODE_SESSION_ID: sid2 }, cwd: repo });
    // 模拟首次 remove 半成功：git 已注销（直接 spawn 强删目录+注销）
    spawnSync("git", ["worktree", "remove", "--force", path.join(repo, ".worktrees", "worktree-halfgone")],
      { cwd: repo, encoding: "utf8" });
    // 此时 exit(remove) 重试 → "is not a working tree" → 容错继续
    const r = runWt("exit", { action: "remove", confirm_remove: true }, { env: { ZCODE_SESSION_ID: sid2 }, cwd: repo });
    const content = wtContent(r);
    assert.ok(!content.includes("❌"), `不应失败: ${content.slice(0, 300)}`);
    assert.ok(content.includes("副本已不在 git 注册表"), `应提示已注销: ${content.slice(0, 300)}`);
    assert.equal(C.loadBinding(common, sid2), null, "绑定应已清除");
  });

  // --- 跨副本拦截文案（反馈③体验） ---

  it("O09: 跨副本写拦截文案包含 enter 指引", () => {
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: sid,
      tool_input: { file_path: path.join(otherWt, "z.js"), content: "z" },
    });
    assertBlock(r, "进入该副本");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P. v0.4.4（issue #1 反馈）: remove 子命令（exit-first 收尾）+ authorize-main TTL + 拦截文案重构
// ═══════════════════════════════════════════════════════════════════════════════

describe("P. v0.4.4 remove / TTL / 拦截文案", () => {
  let repo, common;
  const stateJson = () => path.join(common, "worktree-guard", "state.json");

  before(() => {
    repo = makeRepo();
    common = repoCommon(repo);
  });
  after(() => cleanupRepo(repo));

  // --- remove 子命令：exit-first 流的收尾 ---

  it("P01: exit-first 全流程——exit(keep) → merge → remove 收尾（删目录+删已合并分支）", () => {
    const sid = "sess_p01";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "p1-flow" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-p1-flow" }, { env, cwd: repo });
    const wt = path.join(repo, ".worktrees", "worktree-p1-flow");
    spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "work"], { cwd: wt, encoding: "utf8" });
    const er = runWt("exit", { action: "keep" }, { env, cwd: repo });
    assert.ok(!wtContent(er).includes("❌"), `exit 不应失败: ${wtContent(er).slice(0, 200)}`);
    // exit 后（无绑定、默认开放态）自由合并——issue 报告者的自然流
    const mg = spawnSync("git", ["merge", "-q", "worktree-p1-flow"], { cwd: repo, encoding: "utf8" });
    assert.equal(mg.status ?? 1, 0, "merge 应成功");
    const r = runWt("remove", { path: ".worktrees/worktree-p1-flow", confirm_remove: true, delete_branch: true },
      { env, cwd: repo });
    const c = wtContent(r);
    assert.ok(c.includes("副本目录已删除"), `应删目录: ${c.slice(0, 300)}`);
    assert.ok(c.includes("已删除（已合并"), `应删已合并分支: ${c.slice(0, 300)}`);
    assert.ok(!fs.existsSync(wt), "副本目录应已不存在");
    const br = spawnSync("git", ["branch", "--list", "worktree-p1-flow"], { cwd: repo, encoding: "utf8" });
    assert.equal((br.stdout || "").trim(), "", "分支应已删除");
    assert.equal(C.loadBinding(common, sid), null, "绑定应已清除");
  });

  it("P02: remove 未合并分支 → 删目录、保留分支（-d 闸门）", () => {
    const sid = "sess_p02";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "p2-unmerged" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-p2-unmerged" }, { env, cwd: repo });
    const wt = path.join(repo, ".worktrees", "worktree-p2-unmerged");
    spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "work"], { cwd: wt, encoding: "utf8" });
    runWt("exit", { action: "keep" }, { env, cwd: repo });
    const r = runWt("remove", { path: ".worktrees/worktree-p2-unmerged", confirm_remove: true, delete_branch: true },
      { env, cwd: repo });
    const c = wtContent(r);
    assert.ok(c.includes("副本目录已删除"), `应删目录: ${c.slice(0, 300)}`);
    assert.ok(c.includes("保留"), `未合并分支应保留: ${c.slice(0, 300)}`);
    const br = spawnSync("git", ["branch", "--list", "worktree-p2-unmerged"], { cwd: repo, encoding: "utf8" });
    assert.ok((br.stdout || "").includes("worktree-p2-unmerged"), "未合并分支应保留");
    // 分支残留留给 P04 形态②复用
  });

  it("P03: remove 缺 confirm_remove → 拒绝（已注册副本形态）", () => {
    runWt("create", { task_name: "p3-confirm" }, { cwd: repo });
    const r = runWt("remove", { path: ".worktrees/worktree-p3-confirm" }, { cwd: repo });
    assert.ok(wtContent(r).includes("❌"), "应失败");
    assert.ok(wtContent(r).includes("confirm_remove"), `应提示 confirm: ${wtContent(r).slice(0, 200)}`);
    // 残留形态（P02 留下的目录已删、分支未删）优先给更具体的 delete_branch 指引
    const r2 = runWt("remove", { path: ".worktrees/worktree-p2-unmerged" }, { cwd: repo });
    assert.ok(wtContent(r2).includes("delete_branch"), `残留形态应指引 delete_branch: ${wtContent(r2).slice(0, 200)}`);
  });

  it("P04: remove 形态②——目录已被手动 remove、仅剩分支 → 分支残留清理", () => {
    // P02 留下的 worktree-p2-unmerged 分支；目录先手动注销（issue 实况）
    const wt = path.join(repo, ".worktrees", "worktree-p2-unmerged");
    spawnSync("git", ["merge", "-q", "worktree-p2-unmerged"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["worktree", "remove", wt], { cwd: repo, encoding: "utf8" });
    const r = runWt("remove", { path: ".worktrees/worktree-p2-unmerged", confirm_remove: true, delete_branch: true },
      { cwd: repo });
    const c = wtContent(r);
    assert.ok(c.includes("仅做分支清理"), `应提示分支残留模式: ${c.slice(0, 300)}`);
    assert.ok(c.includes("已删除（已合并"), `应删已合并分支: ${c.slice(0, 300)}`);
    const br = spawnSync("git", ["branch", "--list", "worktree-p2-unmerged"], { cwd: repo, encoding: "utf8" });
    assert.equal((br.stdout || "").trim(), "", "分支应已删除");
  });

  it("P05: remove 形态② 不带 delete_branch → 拒绝并指引", () => {
    // 造一个仅剩分支的残留（创建→合并→手动 remove 目录）
    runWt("create", { task_name: "p5-left" }, { cwd: repo });
    spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "w"],
      { cwd: path.join(repo, ".worktrees", "worktree-p5-left"), encoding: "utf8" });
    spawnSync("git", ["merge", "-q", "worktree-p5-left"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["worktree", "remove", path.join(repo, ".worktrees", "worktree-p5-left")],
      { cwd: repo, encoding: "utf8" });
    const r = runWt("remove", { path: ".worktrees/worktree-p5-left", confirm_remove: true }, { cwd: repo });
    assert.ok(wtContent(r).includes("❌"), "应失败");
    assert.ok(wtContent(r).includes("delete_branch"), `应指引 delete_branch: ${wtContent(r).slice(0, 200)}`);
  });

  it("P06: remove 目标仍被其他会话绑定 → 拒绝", () => {
    const envA = { ZCODE_SESSION_ID: "sess_p06a" };
    runWt("create", { task_name: "p6-occ" }, { env: envA, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-p6-occ" }, { env: envA, cwd: repo });
    const r = runWt("remove", { path: ".worktrees/worktree-p6-occ", confirm_remove: true, delete_branch: true },
      { env: { ZCODE_SESSION_ID: "sess_p06b" }, cwd: repo });
    assert.ok(wtContent(r).includes("❌"), "应失败");
    assert.ok(wtContent(r).includes("其他会话绑定"), `应提示占用: ${wtContent(r).slice(0, 200)}`);
    runWt("exit", { action: "keep" }, { env: envA, cwd: repo }); // 清理
  });

  it("P07: remove 脏工作区 → 拒绝删除", () => {
    const sid = "sess_p07";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "p7-dirty" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-p7-dirty" }, { env, cwd: repo });
    fs.writeFileSync(path.join(repo, ".worktrees", "worktree-p7-dirty", "dirty.txt"), "x");
    runWt("exit", { action: "keep" }, { env, cwd: repo });
    const r = runWt("remove", { path: ".worktrees/worktree-p7-dirty", confirm_remove: true }, { env, cwd: repo });
    assert.ok(wtContent(r).includes("❌"), "应失败");
    assert.ok(wtContent(r).includes("未提交改动"), `应提示脏区: ${wtContent(r).slice(0, 200)}`);
  });

  it("P08: remove 自身绑定态 → 兼作退出（清绑定）", () => {
    const sid = "sess_p08";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "p8-self" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-p8-self" }, { env, cwd: repo });
    const r = runWt("remove", { path: ".worktrees/worktree-p8-self", confirm_remove: true, delete_branch: true },
      { env, cwd: repo });
    const c = wtContent(r);
    assert.ok(!c.includes("❌"), `不应失败: ${c.slice(0, 300)}`);
    assert.ok(c.includes("本会话绑定已清除"), `应清自绑定: ${c.slice(0, 300)}`);
    assert.equal(C.loadBinding(common, sid), null, "绑定文件应已清除");
  });

  it("P09: remove 非注册路径且无分支残留 → 拒绝", () => {
    const r = runWt("remove", { path: ".worktrees/worktree-nonexistent", confirm_remove: true }, { cwd: repo });
    assert.ok(wtContent(r).includes("❌"), "应失败");
    assert.ok(wtContent(r).includes("不是本仓库已注册"), `应提示未注册: ${wtContent(r).slice(0, 200)}`);
  });

  // --- authorize-main TTL ---

  it("P10: authorize-main 默认写入 15 分钟 TTL，生效中", () => {
    const r = runWt("authorize-main", { reason: "TTL 测试" }, { cwd: repo });
    const c = wtContent(r);
    assert.ok(c.includes("有效期至"), `应显示有效期: ${c.slice(0, 200)}`);
    assert.ok(c.includes("约 15 分钟"), `默认 15 分钟: ${c.slice(0, 200)}`);
    const s = JSON.parse(fs.readFileSync(stateJson(), "utf8"));
    const exp = new Date(s.allow_expires_at).getTime();
    assert.ok(exp > Date.now() && exp < Date.now() + 16 * 60000, "expires_at 应在 ~15 分钟后");
    assert.equal(C.loadGlobalAllow(common), true, "授权应生效");
  });

  it("P11: TTL 过期 → loadGlobalAllow 判负，hook 恢复拦截", () => {
    const s = JSON.parse(fs.readFileSync(stateJson(), "utf8"));
    s.allow_expires_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(stateJson(), JSON.stringify(s));
    assert.equal(C.loadGlobalAllow(common), false, "过期授权应失效");
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: "sess_p11",
      tool_input: { command: "git push origin master" },
    });
    assertBlock(r, "push");
  });

  it("P12: ttl_minutes 可调；非法值回落默认 15", () => {
    const r5 = runWt("authorize-main", { reason: "x", ttl_minutes: 5 }, { cwd: repo });
    assert.ok(wtContent(r5).includes("约 5 分钟"), `应显示 5 分钟: ${wtContent(r5).slice(0, 200)}`);
    const rBad = runWt("authorize-main", { reason: "x", ttl_minutes: "abc" }, { cwd: repo });
    assert.ok(wtContent(rBad).includes("约 15 分钟"), `非法值应回落 15: ${wtContent(rBad).slice(0, 200)}`);
  });

  it("P13: 旧版数据（allow_main_writes 无 expires_at）→ 视为已过期（收紧）", () => {
    const s = JSON.parse(fs.readFileSync(stateJson(), "utf8"));
    delete s.allow_expires_at;
    fs.writeFileSync(stateJson(), JSON.stringify(s));
    assert.equal(C.loadGlobalAllow(common), false, "无 TTL 的旧授权应视为过期");
  });

  it("P14: revoke-main 清除全部授权字段（含 expires_at）", () => {
    runWt("authorize-main", { reason: "x" }, { cwd: repo });
    runWt("revoke-main", {}, { cwd: repo });
    const s = JSON.parse(fs.readFileSync(stateJson(), "utf8"));
    assert.ok(!("allow_main_writes" in s) && !("allow_expires_at" in s), "授权字段应全清");
  });

  // --- 拦截文案重构（反馈③④）---

  it("P15: push 拦截文案——解法前置、含可复制 authorize 命令与拆分执行提示", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: "sess_p15",
      tool_input: { command: "git push origin master" },
    });
    assertBlock(r, "push");
    const err = r.stderr;
    assert.ok(err.includes("→ 解法"), `应有解法段: ${err.slice(0, 300)}`);
    assert.ok(err.includes("authorize-main"), `应含 authorize 命令: ${err.slice(0, 300)}`);
    assert.ok(err.includes("拆开分步执行"), `应有组合命令提示: ${err.slice(0, 300)}`);
    assert.ok(err.indexOf("🔴 worktree-guard 拦截") < err.indexOf("→ 解法"), "拦截原因应在解法之前");
  });

  it("P16: git branch -d 拦截文案——含 exit(delete_branch) 与 remove 两条收尾指引", () => {
    const r = runHook({
      tool_name: "Bash", cwd: repo, session_id: "sess_p16",
      tool_input: { command: "git branch -d worktree-p16" },
    });
    assertBlock(r);
    const err = r.stderr;
    assert.ok(err.includes("delete_branch"), `应含 exit(delete_branch): ${err.slice(0, 300)}`);
    // 收紧："<worktree路径>" 占位符只出现在 remove 解法命令行里（footer 只列子命令名）
    assert.ok(err.includes("\"path\":\"<worktree路径>\""), `应含 remove 命令行: ${err.slice(0, 400)}`);
  });

  it("P17: 跨副本写拦截文案——enter 指引 + 可复制 enter 命令", () => {
    // 造一个已注册的其他副本
    runWt("create", { task_name: "p17-other" }, { cwd: repo });
    const r = runHook({
      tool_name: "Write", cwd: repo, session_id: "sess_p17",
      tool_input: { file_path: path.join(repo, ".worktrees", "worktree-p17-other", "z.js"), content: "z" },
    });
    assertBlock(r, "进入该副本");
    assert.ok(r.stderr.includes("enter"), `解法应含 enter 命令: ${r.stderr.slice(0, 300)}`);
  });

  // --- v0.4.4 审查修复回归 ---

  it("P18: exit(keep) 回执的 remove 示例是合法 JSON（Windows 反斜杠路径回归锁）", () => {
    const sid = "sess_p18";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "p18-receipt" }, { env, cwd: repo });
    runWt("enter", { path: ".worktrees/worktree-p18-receipt" }, { env, cwd: repo });
    const er = runWt("exit", { action: "keep" }, { env, cwd: repo });
    const c = wtContent(er);
    const m = c.match(/\{"path":[^\n]*?"delete_branch":true\}/);
    assert.ok(m, `回执应含 remove JSON 示例: ${c.slice(-300)}`);
    let parsed;
    try { parsed = JSON.parse(m[0]); }
    catch (e) { assert.fail(`回执示例不是合法 JSON（照抄即"缺少 path 参数"）: ${m[0]} (${e.message})`); }
    assert.equal(parsed.confirm_remove, true);
    assert.equal(parsed.delete_branch, true);
    assert.ok(parsed.path && !parsed.path.includes("\\"), `示例路径应为正斜杠相对路径: ${parsed.path}`);
  });

  it("P19: remove 路径安全——主 checkout 本身与仓库外路径均拒绝", () => {
    // path="." → 解析为主 checkout → 非注册副本、无同名分支 → 拒绝
    const rRoot = runWt("remove", { path: ".", confirm_remove: true, delete_branch: true }, { cwd: repo });
    assert.ok(wtContent(rRoot).includes("❌"), `主 checkout 应拒绝: ${wtContent(rRoot).slice(0, 200)}`);
    // 仓库外绝对路径 → 分支残留形态的仓库内约束 → 拒绝
    const outside = path.join(os.tmpdir(), "wtg-outside-" + Date.now(), "worktree-fake");
    const rOut = runWt("remove", { path: outside, confirm_remove: true, delete_branch: true }, { cwd: repo });
    assert.ok(wtContent(rOut).includes("不在本仓库内"), `仓库外应拒绝: ${wtContent(rOut).slice(0, 200)}`);
  });

  it("P20: remove 形态② 未合并分支 → -d 拒删、分支保留", () => {
    const sid = "sess_p20";
    const env = { ZCODE_SESSION_ID: sid };
    runWt("create", { task_name: "p20-left" }, { env, cwd: repo });
    const wt = path.join(repo, ".worktrees", "worktree-p20-left");
    spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "w"], { cwd: wt, encoding: "utf8" });
    runWt("exit", { action: "keep" }, { env, cwd: repo });
    spawnSync("git", ["worktree", "remove", wt], { cwd: repo, encoding: "utf8" });
    const r = runWt("remove", { path: ".worktrees/worktree-p20-left", confirm_remove: true, delete_branch: true },
      { cwd: repo });
    const c = wtContent(r);
    assert.ok(c.includes("仅做分支清理"), `应提示分支残留模式: ${c.slice(0, 300)}`);
    assert.ok(c.includes("保留"), `未合并分支应保留: ${c.slice(0, 300)}`);
    const br = spawnSync("git", ["branch", "--list", "worktree-p20-left"], { cwd: repo, encoding: "utf8" });
    assert.ok((br.stdout || "").includes("worktree-p20-left"), "未合并分支应保留");
    // 清理：测试进程直删（不经 hook）
    spawnSync("git", ["branch", "-D", "worktree-p20-left"], { cwd: repo, encoding: "utf8" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Q. v0.4.5（issues #3-#7）: 链接全量扫描 + exit 目标闸门 + 死绑定回收/prune
//     + 文件锁指引 + status 收尾盘点
// ═══════════════════════════════════════════════════════════════════════════════

describe("Q. v0.4.5 issues #3-#7", () => {
  const isWin = process.platform === "win32";
  const bindFile = (common, sid) => path.join(common, "worktree-guard", "bindings", `${sid}.json`);

  /** 构造仅含 prune/死会话判定所需列的 ZCode 会话 DB，返回可作 ZCODE_STORAGE_DIR 的根目录 */
  function makeSessionDb(entries) {
    let DatabaseSync;
    try { ({ DatabaseSync } = esmRequire("node:sqlite")); } catch { return null; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtg-db-"));
    const dbDir = path.join(dir, "cli", "db");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "db.sqlite"));
    db.exec("CREATE TABLE session (id text primary key, parent_id text, time_updated integer)");
    const ins = db.prepare("INSERT INTO session (id, parent_id, time_updated) VALUES (?, ?, ?)");
    for (const e of entries) ins.run(e.id, e.parent_id ?? null, e.timeUpdated ?? Date.now());
    db.close();
    return dir;
  }

  /** 在 target 处创建指向 shared 的目录链接（Windows junction / 其他平台 dir symlink），失败返回 false */
  function makeDirLink(shared, target) {
    try {
      fs.symlinkSync(shared, target, isWin ? "junction" : "dir");
      return true;
    } catch {
      return false; // 沙箱/CI 无 symlink 权限
    }
  }

  // --- #3：链接保护升级（全量扫描） ---

  it("Q01: 🔴 未声明 junction 也在 remove 前被全量摘除——链接目标内容完整（issue #3）", () => {
    const repo = makeRepo();
    try {
      // 共享目标目录（仓库外）+ 副本内手工建链接（不写入 config symlink_dirs）
      const shared = fs.mkdtempSync(path.join(os.tmpdir(), "wtg-shared-"));
      fs.writeFileSync(path.join(shared, "keep.txt"), "共享数据");
      // gitignore 语义：git status 不把链接算作未提交改动（真实场景 node_modules 均被忽略）
      fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
      fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\nnode_modules/\n");
      const env = { ZCODE_SESSION_ID: "sess_q01" };
      runWt("create", { task_name: "q01" }, { env, cwd: repo });
      const wt = path.join(repo, ".worktrees", "worktree-q01");
      if (!makeDirLink(shared, path.join(wt, "node_modules"))) return; // 无链接权限跳过
      runWt("enter", { path: ".worktrees/worktree-q01" }, { env, cwd: repo });
      const r = runWt("exit", { action: "remove", confirm_remove: true }, { env, cwd: repo });
      const c = wtContent(r);
      assert.ok(!c.includes("❌"), `不应失败: ${c.slice(0, 300)}`);
      assert.ok(c.includes("已安全摘除链接（全量扫描）"), `应提示全量摘除: ${c.slice(0, 300)}`);
      assert.ok(c.includes("node_modules"), `摘除清单应含链接名: ${c.slice(0, 300)}`);
      assert.ok(!fs.existsSync(wt), "副本目录应已删除");
      // 🔴 核心安全断言：链接目标（副本外共享目录）内容完整
      assert.equal(fs.readFileSync(path.join(shared, "keep.txt"), "utf8"), "共享数据",
        "未声明链接的目标被穿透删除！");
      fs.rmSync(shared, { recursive: true, force: true });
    } finally {
      cleanupRepo(repo);
    }
  });

  it("Q02: linkScanMode 默认 all，sync.link_scan='declared' 回退", () => {
    assert.equal(C.linkScanMode({}), "all");
    assert.equal(C.linkScanMode({ sync: {} }), "all");
    assert.equal(C.linkScanMode({ sync: { link_scan: "declared" } }), "declared");
    assert.equal(C.linkScanMode({ sync: { link_scan: "bogus" } }), "all");
  });

  it("Q03: scanAndRemoveAllLinks——嵌套链接摘除、真目录/文件/根 .git 不动、嵌套 .git 链接也摘除、目标完整", () => {
    const repo = makeRepo();
    try {
      const wt = path.join(repo, ".worktrees", "wt-q03");
      fs.mkdirSync(path.join(wt, "real-dir", "sub"), { recursive: true });
      fs.writeFileSync(path.join(wt, "real-dir", "sub", "f.txt"), "x");
      fs.writeFileSync(path.join(wt, "plain.txt"), "x");
      fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../.git/worktrees/wt-q03"); // worktree 的 .git 是文件
      const shared = fs.mkdtempSync(path.join(os.tmpdir(), "wtg-shared-"));
      fs.writeFileSync(path.join(shared, "keep.txt"), "target-data");
      if (!makeDirLink(shared, path.join(wt, "node_modules"))) return;
      if (!makeDirLink(shared, path.join(wt, "real-dir", "sub", "link"))) return;
      // 嵌套 .git symlink（vendored 仓库罕见形态）——审查修复后同样摘除（只跳过副本根的 .git）
      if (!makeDirLink(shared, path.join(wt, "real-dir", ".git"))) return;
      const r = C.scanAndRemoveAllLinks(wt);
      assert.ok(r.removed.includes("node_modules"), `应摘除顶层链接: ${JSON.stringify(r.removed)}`);
      assert.ok(r.removed.includes("real-dir/sub/link"), `应摘除嵌套链接: ${JSON.stringify(r.removed)}`);
      assert.ok(r.removed.includes("real-dir/.git"), `嵌套 .git 链接也应摘除: ${JSON.stringify(r.removed)}`);
      assert.equal(r.failed.length, 0, `不应有失败: ${JSON.stringify(r.failed)}`);
      assert.ok(fs.existsSync(path.join(wt, "real-dir", "sub", "f.txt")), "真目录内容不应被动");
      assert.ok(fs.existsSync(path.join(wt, "plain.txt")), "普通文件不应被动");
      assert.ok(fs.existsSync(path.join(wt, ".git")), "副本根的 .git 文件不应被动");
      assert.equal(fs.readFileSync(path.join(shared, "keep.txt"), "utf8"), "target-data",
        "链接目标被穿透删除！");
      fs.rmSync(shared, { recursive: true, force: true });
    } finally {
      cleanupRepo(repo);
    }
  });

  // --- #4：exit 目标解析闸门 ---

  it("Q04: exit 显式 path 与绑定一致 → 正常退出", () => {
    const repo = makeRepo();
    try {
      const env = { ZCODE_SESSION_ID: "sess_q04" };
      runWt("create", { task_name: "q04" }, { env, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q04" }, { env, cwd: repo });
      const r = runWt("exit", { action: "keep", path: ".worktrees/worktree-q04" }, { env, cwd: repo });
      const c = wtContent(r);
      assert.ok(!c.includes("❌"), `不应失败: ${c.slice(0, 300)}`);
      assert.ok(c.includes("绑定已清除"), `应正常退出: ${c.slice(0, 300)}`);
    } finally {
      cleanupRepo(repo);
    }
  });

  it("Q05: exit 显式 path 与绑定不一致 → 拒绝（绝不静默改目标）", () => {
    const repo = makeRepo();
    try {
      const env = { ZCODE_SESSION_ID: "sess_q05" };
      runWt("create", { task_name: "q05a" }, { env, cwd: repo });
      runWt("create", { task_name: "q05b" }, { env, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q05a" }, { env, cwd: repo });
      const r = runWt("exit", { action: "keep", path: ".worktrees/worktree-q05b" }, { env, cwd: repo });
      assertWtFail(r, "不一致");
      // 两目录都未被误动
      assert.ok(fs.existsSync(path.join(repo, ".worktrees", "worktree-q05b")), "目标目录不应被动");
    } finally {
      cleanupRepo(repo);
    }
  });

  it("Q06: 🔴 exit 无绑定 + remove 无 path → 拒绝从 state.json 猜测目标（issue #4 核心）", () => {
    const repo = makeRepo();
    try {
      const common = repoCommon(repo);
      const envA = { ZCODE_SESSION_ID: "sess_q06a" };
      runWt("create", { task_name: "q06" }, { env: envA, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q06" }, { env: envA, cwd: repo });
      // 模拟绑定已消失但 state.json 留存（如死会话被清理）
      fs.unlinkSync(bindFile(common, "sess_q06a"));
      const wt = path.join(repo, ".worktrees", "worktree-q06");
      const r = runWt("exit", { action: "remove", confirm_remove: true },
        { env: { ZCODE_SESSION_ID: "sess_q06b" }, cwd: repo });
      assertWtFail(r, "不再从 state.json 猜测删除目标");
      assert.ok(wtContent(r).includes("remove 子命令"), `应指引 remove 子命令: ${wtContent(r).slice(0, 300)}`);
      assert.ok(fs.existsSync(wt), "state 指向的副本不应被误删");
    } finally {
      cleanupRepo(repo);
    }
  });

  it("Q07: exit 无绑定 + keep + state 留存 → 仍按 state 汇报（回退保留，无害）", () => {
    const repo = makeRepo();
    try {
      const common = repoCommon(repo);
      const envA = { ZCODE_SESSION_ID: "sess_q07a" };
      runWt("create", { task_name: "q07" }, { env: envA, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q07" }, { env: envA, cwd: repo });
      fs.unlinkSync(bindFile(common, "sess_q07a"));
      const r = runWt("exit", { action: "keep" }, { env: { ZCODE_SESSION_ID: "sess_q07b" }, cwd: repo });
      const c = wtContent(r);
      assert.ok(!c.includes("❌"), `不应失败: ${c.slice(0, 300)}`);
      assert.ok(c.includes("worktree-q07"), `应按 state 汇报: ${c.slice(0, 300)}`);
    } finally {
      cleanupRepo(repo);
    }
  });

  it("Q08: exit 无绑定 + 显式 path（已注册）+ remove → 收尾成功", () => {
    const repo = makeRepo();
    try {
      runWt("create", { task_name: "q08" }, { cwd: repo }); // 全程无 enter：无绑定、无 state
      const r = runWt("exit", { action: "remove", confirm_remove: true, delete_branch: true, path: ".worktrees/worktree-q08" },
        { env: { ZCODE_SESSION_ID: "sess_q08" }, cwd: repo });
      const c = wtContent(r);
      assert.ok(!c.includes("❌"), `不应失败: ${c.slice(0, 300)}`);
      assert.ok(c.includes("副本目录已删除"), `应删目录: ${c.slice(0, 300)}`);
      assert.ok(!fs.existsSync(path.join(repo, ".worktrees", "worktree-q08")), "目录应已删除");
    } finally {
      cleanupRepo(repo);
    }
  });

  // --- #5：死绑定豁免 / 标注 / prune ---

  it("Q09: 🔴 stale 绑定（副本已被手动 remove）不再阻断清理，绑定文件被回收（issue #5③）", () => {
    const repo = makeRepo();
    try {
      const common = repoCommon(repo);
      const envGhost = { ZCODE_SESSION_ID: "sess_q09ghost" };
      runWt("create", { task_name: "q09" }, { env: envGhost, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q09" }, { env: envGhost, cwd: repo });
      // 副本被外部强制移除（目录 + 注册表消失），ghost 绑定残留
      spawnSync("git", ["worktree", "remove", "--force", path.join(repo, ".worktrees", "worktree-q09")],
        { cwd: repo, encoding: "utf8" });
      // 形态②分支残留 + 死绑定 → 应放行而非"仍被其他会话绑定"拒绝
      const r = runWt("remove", { path: ".worktrees/worktree-q09", confirm_remove: true, delete_branch: true },
        { env: { ZCODE_SESSION_ID: "sess_q09b" }, cwd: repo });
      const c = wtContent(r);
      assert.ok(!c.includes("❌"), `死绑定不应阻断: ${c.slice(0, 300)}`);
      assert.ok(c.includes("已忽略并回收死绑定"), `应注明忽略死绑定: ${c.slice(0, 300)}`);
      assert.ok(!fs.existsSync(bindFile(common, "sess_q09ghost")), "死绑定文件应被回收");
      const br = spawnSync("git", ["branch", "--list", "worktree-q09"], { cwd: repo, encoding: "utf8" });
      assert.equal((br.stdout || "").trim(), "", "已合并分支应已删除");
    } finally {
      cleanupRepo(repo);
    }
  });

  it("Q10: 🔴 死会话绑定（DB 静默超阈）不再阻断 remove（issue #5①）", () => {
    const repo = makeRepo();
    const storage = makeSessionDb([{ id: "sess_q10ghost", timeUpdated: Date.now() - 48 * 3600000 }]);
    try {
      if (!storage) return; // node:sqlite 不可用则跳过
      const envGhost = { ZCODE_SESSION_ID: "sess_q10ghost" };
      runWt("create", { task_name: "q10" }, { env: envGhost, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q10" }, { env: envGhost, cwd: repo });
      const r = runWt("remove", { path: ".worktrees/worktree-q10", confirm_remove: true, delete_branch: true },
        { env: { ZCODE_SESSION_ID: "sess_q10b", ZCODE_STORAGE_DIR: storage }, cwd: repo });
      const c = wtContent(r);
      assert.ok(!c.includes("❌"), `死会话绑定不应阻断: ${c.slice(0, 300)}`);
      assert.ok(c.includes("已忽略并回收死绑定"), `应注明忽略: ${c.slice(0, 300)}`);
      assert.ok(c.includes("会话已静默"), `死因应是会话静默: ${c.slice(0, 300)}`);
      assert.ok(!fs.existsSync(path.join(repo, ".worktrees", "worktree-q10")), "目录应已删除");
    } finally {
      cleanupRepo(repo);
      if (storage) fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it("Q11: prune——dry_run 仅盘点；实删清死绑定、保留活跃/未知", () => {
    const repo = makeRepo();
    const storage = makeSessionDb([
      { id: "sess_q11dead", timeUpdated: Date.now() - 48 * 3600000 },
      { id: "sess_q11alive", timeUpdated: Date.now() },
    ]);
    try {
      if (!storage) return;
      const common = repoCommon(repo);
      const env = { ZCODE_STORAGE_DIR: storage };
      runWt("create", { task_name: "q11dead" }, { env: { ZCODE_SESSION_ID: "sess_q11dead" }, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q11dead" }, { env: { ZCODE_SESSION_ID: "sess_q11dead" }, cwd: repo });
      runWt("create", { task_name: "q11alive" }, { env: { ZCODE_SESSION_ID: "sess_q11alive" }, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q11alive" }, { env: { ZCODE_SESSION_ID: "sess_q11alive" }, cwd: repo });
      runWt("create", { task_name: "q11unknown" }, { env: { ZCODE_SESSION_ID: "sess_q11unknown" }, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q11unknown" }, { env: { ZCODE_SESSION_ID: "sess_q11unknown" }, cwd: repo });
      // stale 形态：q11unknown 副本被强制移除，绑定残留（DB 无记录，但目标已消失 → 死）
      spawnSync("git", ["worktree", "remove", "--force", path.join(repo, ".worktrees", "worktree-q11unknown")],
        { cwd: repo, encoding: "utf8" });

      const dry = runWt("prune", { dry_run: true }, { env, cwd: repo });
      const dc = wtContent(dry);
      assert.ok(dc.includes("仅盘点未删除"), `dry_run 应仅盘点: ${dc.slice(0, 300)}`);
      assert.ok(dc.includes("sess_q11dead") && dc.includes("sess_q11unknown"), `应列出死绑定: ${dc.slice(0, 400)}`);
      for (const sid of ["sess_q11dead", "sess_q11alive", "sess_q11unknown"]) {
        assert.ok(fs.existsSync(bindFile(common, sid)), `dry_run 不应删除 ${sid}`);
      }

      const pr = runWt("prune", {}, { env, cwd: repo });
      const pc = wtContent(pr);
      assert.ok(pc.includes("已清理 2 条死绑定"), `应清理 2 条: ${pc.slice(0, 400)}`);
      assert.ok(!fs.existsSync(bindFile(common, "sess_q11dead")), "死会话绑定应被清理");
      assert.ok(!fs.existsSync(bindFile(common, "sess_q11unknown")), "stale 绑定应被清理");
      assert.ok(fs.existsSync(bindFile(common, "sess_q11alive")), "活跃会话绑定应保留");
    } finally {
      cleanupRepo(repo);
      if (storage) fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  // --- #7：status 收尾盘点 + stale 标注 ---

  it("Q12: status 收尾盘点——已合并可清理/孤儿目录/无副本分支（issue #7）", () => {
    const repo = makeRepo();
    try {
      runWt("create", { task_name: "q12a" }, { cwd: repo }); // 无新提交 → 已合并、干净
      runWt("create", { task_name: "q12b" }, { cwd: repo });
      spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "w"],
        { cwd: path.join(repo, ".worktrees", "worktree-q12b"), encoding: "utf8" }); // 未合并
      runWt("create", { task_name: "q12c" }, { cwd: repo });
      spawnSync("git", ["worktree", "remove", "--force", path.join(repo, ".worktrees", "worktree-q12c")],
        { cwd: repo, encoding: "utf8" }); // 分支残留
      fs.mkdirSync(path.join(repo, ".worktrees", "orphan-dir"), { recursive: true }); // 孤儿目录
      const r = runWt("status", {}, { cwd: repo });
      const c = wtContent(r);
      assert.ok(c.includes("收尾盘点"), `应有盘点节: ${c.slice(0, 200)}`);
      assert.ok(c.includes("已合并进 master、工作区干净"), `应标注可清理: ${c.slice(0, 600)}`);
      assert.ok(c.includes("worktree-q12a"), `应含 q12a: ${c.slice(0, 600)}`);
      assert.ok(!c.includes("[worktree-q12b] ✅"), `未合并副本不应标可清理: ${c.slice(0, 600)}`);
      assert.ok(c.includes("孤儿目录") && c.includes("orphan-dir"), `应列出孤儿目录: ${c.slice(0, 600)}`);
      assert.ok(c.includes("worktree-q12c") && c.includes("无对应副本"), `应列出无副本分支: ${c.slice(0, 600)}`);
    } finally {
      cleanupRepo(repo);
    }
  });

  it("Q13: status 对 stale 绑定打标注（issue #5②）", () => {
    const repo = makeRepo();
    try {
      const envGhost = { ZCODE_SESSION_ID: "sess_q13ghost" };
      runWt("create", { task_name: "q13" }, { env: envGhost, cwd: repo });
      runWt("enter", { path: ".worktrees/worktree-q13" }, { env: envGhost, cwd: repo });
      spawnSync("git", ["worktree", "remove", "--force", path.join(repo, ".worktrees", "worktree-q13")],
        { cwd: repo, encoding: "utf8" });
      const r = runWt("status", {}, { env: { ZCODE_SESSION_ID: "sess_q13other" }, cwd: repo });
      const c = wtContent(r);
      assert.ok(c.includes("stale"), `应打 stale 标注: ${c.slice(0, 400)}`);
      assert.ok(c.includes("prune 可清理"), `应指引 prune: ${c.slice(0, 400)}`);
    } finally {
      cleanupRepo(repo);
    }
  });

  // --- #6：文件锁失败识别（处置指引的判定函数） ---

  it("Q14: isLockError 识别文件锁类失败输出（issue #6）", () => {
    assert.ok(C.isLockError("fatal: unable to unlink 'x': Device or resource busy"));
    assert.ok(C.isLockError("error: could not delete 'x': EPERM: operation not permitted"));
    assert.ok(C.isLockError("rm: cannot remove 'x': The process cannot access the file because it is being used by another process."));
    assert.ok(C.isLockError("error: Access is denied."));
    assert.ok(C.isLockError("无法删除: 另一个程序正在使用此文件"));
    assert.ok(!C.isLockError("fatal: invalid reference: foo"));
    assert.ok(!C.isLockError(""));
    assert.ok(!C.isLockError(undefined));
  });

  // --- 审查修复回归（v0.4.5 自查） ---

  it("Q15: status 盘点对损坏副本降级标注——脏检查失败不拖垮整个 status", () => {
    const repo = makeRepo();
    try {
      runWt("create", { task_name: "q15" }, { cwd: repo });
      // 损坏副本：.git 文件指向不存在的 gitdir（悬空指针——注意不能直接删文件：
      // 副本在主仓库内，删掉后 git -C 会向上遍历找到主 .git，静默对主 checkout 求值；
      // 且该文件带 Git for Windows 特殊属性，直接 write 会 EPERM，须 unlink 后重建）
      const q15Git = path.join(repo, ".worktrees", "worktree-q15", ".git");
      fs.unlinkSync(q15Git);
      fs.writeFileSync(q15Git, "gitdir: ../.git/worktrees/worktree-q15-gone");
      const r = runWt("status", {}, { cwd: repo });
      const c = wtContent(r);
      assert.ok(!c.includes("❌"), `status 不应失败: ${c.slice(0, 300)}`);
      assert.ok(c.includes("脏检查失败"), `应降级标注而非崩溃: ${c.slice(0, 600)}`);
    } finally {
      cleanupRepo(repo);
    }
  });
});

