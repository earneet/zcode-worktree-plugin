// zcode-worktree-guard 共享工具：git 封装、路径归一化、状态读写、绑定解析、决策表。
// wt.mjs 与 guard_hook.mjs 共用本模块。纯 Node 标准库，零依赖。
// v0.2：会话级绑定（bindings/ 每session一文件）+ DB parent 继承。
// v0.4：默认主副本开放——绑定只来自本会话 enter（或 subagent 继承父链 enter），
//       state.json 不再作为绑定真值（仅保留 globalAllow / 审计 / 状态显示）。
// v0.4.1：会话身份贯通——ZCode 只把 session_id 放进 hook 的 stdin payload，从不注入
//       Bash 子进程环境，wt.mjs 自身拿不到真实会话 id（v0.4.0 回归根因）。由
//       guard_hook 在 PreToolUse 对调用 wt.mjs 的 Bash 命令注入会话环境变量解决。
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import module from "node:module";

// ESM 没有 require，用 createRequire 创建一个（用于加载 node:sqlite 同步 API）。
// 直接 require("node:sqlite") 在 .mjs 模块内会抛 ReferenceError，导致 DB 继承静默失效。
const esmRequire = module.createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 常量

export const STATE_DIR_NAME = "worktree-guard";
export const BRANCH_PREFIX_DEFAULT = "worktree-";
export const DEFAULT_PARENT = ".worktrees";
export const DEFAULT_PROTECTED = ["master", "main"];
export const TASK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
export const SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// 会话身份（v0.4.1）
// ZCode 的 session_id 只出现在 hook 的 stdin payload（guard_hook / session_start），
// Bash 工具子进程环境里没有任何会话变量（已实测穷举）。因此 wt.mjs（agent 经
// Bash 调用）自身永远拿不到真实会话 id——v0.4.0 "绑定永远解析失败"的根因。
// 贯通方式：guard_hook 用 updatedInput 给调用 wt.mjs 的 Bash 命令注入
// `export ZCODE_SESSION_ID=<id>; ` 前缀，身份随进程环境确定性传递。

export const SESSION_ENV = "ZCODE_SESSION_ID";
export const MANUAL_SESSION_ID = "cli-manual";
// id 会被拼进 shell 命令（export 前缀），只放行无元字符/引号的形态，防注入。
export const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export function sessionIdFromEnv() {
  return process.env[SESSION_ENV] || process.env.CLAUDE_SESSION_ID || null;
}

export function resolveSessionId(ctx) {
  // hook 侧统一入口：payload session_id（真实来源）优先 → env → cli-manual。
  return (ctx && ctx.session_id) || sessionIdFromEnv() || MANUAL_SESSION_ID;
}

// ---------------------------------------------------------------------------
// hook stdin 读取与解析（三个脚本共用；BOM 兼容 + 容错空/坏 JSON）

export function readStdinJson(timeoutMs = 100) {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), timeoutMs);
  });
}

export function parseHookPayload(raw) {
  try { return raw.trim() ? JSON.parse(raw.replace(/^\ufeff/, "")) : {}; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// 路径归一化（Windows 大小写不敏感）

export function norm(p) {
  const abs = path.resolve(String(p));
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function isInside(targetAbs, baseAbs) {
  return targetAbs === baseAbs || targetAbs.startsWith(baseAbs + path.sep);
}

// ---------------------------------------------------------------------------
// git 封装（v0.1 保留不变）

export function runGit(args, cwd, opts = {}) {
  const timeout = (opts.timeout ?? 60) * 1000;
  try {
    const out = execFileSync("git", ["-C", String(cwd), ...args], {
      encoding: "utf8", timeout,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, stdout: out.trim() };
  } catch (e) {
    const code = e.status ?? -1;
    const stdout = (e.stdout || "").toString().trim();
    const stderr = (e.stderr || "").toString().trim();
    if (opts.check && code !== 0) {
      throw new Error(`git ${args.join(" ")} 失败: ${stderr || stdout}`);
    }
    return { code, stdout: code === 0 ? stdout : (stderr || stdout) };
  }
}

export function gitCommonDir(cwd) {
  try {
    const { code, stdout } = runGit(["rev-parse", "--git-common-dir"], cwd, { timeout: 10 });
    if (code !== 0 || !stdout) return null;
    return path.resolve(String(cwd), stdout);
  } catch {
    return null;
  }
}

export function findGitContext(targetPath, cwd) {
  if (!targetPath) return { common: null, root: null };
  const absTarget = path.isAbsolute(targetPath) ? targetPath : path.join(String(cwd), targetPath);
  let start = absTarget;
  try {
    const st = fs.statSync(start);
    if (!st.isDirectory()) start = path.dirname(start);
  } catch {
    start = path.dirname(start);
  }
  let p = path.resolve(start);
  const visited = new Set();
  while (p && !visited.has(p)) {
    visited.add(p);
    if (fs.existsSync(path.join(p, ".git"))) {
      const common = gitCommonDir(p);
      if (common) return { common, root: path.dirname(common) };
      return { common: null, root: null };
    }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return { common: null, root: null };
}

export function findGitContextForCwd(cwd) {
  return findGitContext(String(cwd), String(cwd));
}

export function currentBranch(cwd) {
  const { code, stdout } = runGit(["branch", "--show-current"], cwd, { timeout: 10 });
  if (code !== 0) return "(git 调用失败)";
  // code=0 且空输出 = 真 detached HEAD；git 失败（路径无效/git 缺失）不再误报成 detached
  return stdout || "(detached HEAD)";
}

export function inLinkedWorktree(cwd) {
  const { code: c1, stdout: gitDir } = runGit(["rev-parse", "--git-dir"], cwd, { timeout: 10 });
  if (c1 !== 0) return false;
  const { code: c2, stdout: common } = runGit(["rev-parse", "--git-common-dir"], cwd, { timeout: 10 });
  if (c2 !== 0) return false;
  const absDir = norm(path.resolve(String(cwd), gitDir));
  const absCommon = norm(path.resolve(String(cwd), common));
  if (absDir === absCommon) return false;
  const { code: c3, stdout: superTree } = runGit(
    ["rev-parse", "--show-superproject-working-tree"], cwd, { timeout: 10 }
  );
  if (c3 === 0 && superTree) return false;
  return true;
}

export function registeredWorktrees(root) {
  const { stdout } = runGit(["worktree", "list", "--porcelain"], root, { check: true });
  const result = [];
  let cur = {};
  for (const line of stdout.split(/\r?\n/).concat([""])) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: "" };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "" && cur.path) {
      result.push(cur);
      cur = {};
    }
  }
  return result;
}

export function dirtySummary(p, ignorePaths = []) {
  const { stdout } = runGit(["status", "--porcelain"], p, { check: true });
  let lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  // v0.3：过滤掉 symlink_dirs 等应忽略的路径（它们是链接，不是真正的未提交改动）
  if (ignorePaths.length) {
    const normIgnores = ignorePaths.map((d) => norm(d));
    lines = lines.filter((line) => {
      const fp = line.slice(3).trim().replace(/\/+$/, "").replace(/^"|"$/g, "");
      const nfp = norm(fp);
      return !normIgnores.some((d) => nfp === d || nfp.startsWith(d + path.sep));
    });
  }
  return { count: lines.length, sample: lines.slice(0, 10) };
}

export function aheadSummary(p, base) {
  const { code, stdout } = runGit(["log", "--oneline", `${base}..HEAD`], p);
  if (code !== 0) return { count: 0, sample: [] };
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  return { count: lines.length, sample: lines.slice(0, 10) };
}

export function ensureLocalExclude(mainRoot, relPath) {
  const common = gitCommonDir(mainRoot);
  if (!common) return false;
  const exclude = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (existing.includes(relPath)) return false;
  fs.appendFileSync(exclude, `\n# worktree-guard 本地排除\n${relPath}\n`, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// 配置（sidecar <repo>/.zcode/worktree-guard.json）

export function loadConfig(repoRoot) {
  if (!repoRoot) return {};
  const f = path.join(repoRoot, ".zcode", "worktree-guard.json");
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; }
}

export function branchPrefix(cfg) { return cfg.branch_prefix || BRANCH_PREFIX_DEFAULT; }
export function worktreeParent(cfg) {
  return (cfg.worktree_parent || DEFAULT_PARENT).trim().replace(/^\/+|\/+$/g, "");
}
export function protectedBranches(cfg) {
  const set = new Set(DEFAULT_PROTECTED);
  const extra = cfg.protected_branches;
  if (Array.isArray(extra)) for (const b of extra) if (b && b.trim()) set.add(b.trim().toLowerCase());
  return set;
}
export function whitelistPatterns(cfg) {
  // v0.2 白名单：声明式放行，这些路径写主目录不重写不拦截。
  // 危险裸根模式（*、/、.、** 等）会被 validateWhitelist 剔除，防误配卸保护。
  const wl = cfg.main_write_whitelist;
  if (!Array.isArray(wl)) return [];
  const raw = wl.filter((p) => typeof p === "string" && p.trim());
  return validateWhitelist(raw).valid;
}

// v0.3 文件同步配置：worktree 创建后复制文件 / 链接目录（复用 node_modules 等）
function isSafeRelPath(p) {
  // 仅接受相对路径，拒绝绝对路径和 .. 穿越（防误删/注入）
  if (!p || typeof p !== "string") return false;
  const t = p.trim();
  if (!t) return false;
  if (path.isAbsolute(t)) return false;
  if (t.includes("..")) return false;
  return true;
}

export function syncConfig(cfg) {
  const sync = cfg.sync || {};
  const copyFiles = Array.isArray(sync.copy_files)
    ? sync.copy_files.filter(isSafeRelPath)
    : [];
  const symlinkDirs = Array.isArray(sync.symlink_dirs)
    ? sync.symlink_dirs.filter(isSafeRelPath)
    : [];
  return { copyFiles, symlinkDirs };
}

// ---------------------------------------------------------------------------
// 内部工具

function stateDirOf(common) { return path.join(common, STATE_DIR_NAME); }
function stateFile(common) { return path.join(stateDirOf(common), "state.json"); }
function basesFile(common) { return path.join(stateDirOf(common), "bases.json"); }
function metaFile(common) { return path.join(stateDirOf(common), "meta.json"); }
function bindingsDir(common) { return path.join(stateDirOf(common), "bindings"); }
function auditFile(common) { return path.join(stateDirOf(common), "audit.jsonl"); }
function bindingFile(common, sessionId) { return path.join(bindingsDir(common), `${safeFileName(sessionId)}.json`); }

function readJson(f) {
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
function writeJson(f, data) {
  // 原子写入：先写临时文件再 rename，避免并发进程读到半写的 JSON。
  // POSIX rename 原子；Windows rename 也基本原子（同卷下覆盖替换）。
  const dir = path.dirname(f);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmp, f);
  } catch {
    // rename 失败（罕见）→ 清理临时文件，回退到直接写（非原子但仍可用）
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
  }
}
function safeFileName(s) { return s.replace(/[^a-zA-Z0-9._-]/g, "-"); }

export function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// state.json（仓库级单活动，跨 session 共享）
// v0.4 起不再作为绑定真值（默认开放语义下绑定只来自本会话明确 enter）。
// 仍保留：enter/exit 写入它作为"最近一次活动 worktree"的记录，供 status 显示与
// globalAllow（authorize-main）承载；resolveBinding 不再读它。

export function loadStateByCommon(common) {
  const s = readJson(stateFile(common));
  return s && s.active ? s : null;
}
export function saveStateByCommon(common, state) { writeJson(stateFile(common), state); }
export function clearStateByCommon(common) {
  if (fs.existsSync(stateFile(common))) fs.unlinkSync(stateFile(common));
}

// 全局授权（authorize-main）：写入 state.json 的 allow_main_writes 字段（原 override.json 废弃）
// v0.4.4 TTL（外部反馈：revoke 靠自觉，忘了授权就无限期裸奔）：授权自带过期时间，
// 到期 loadGlobalAllow 自动判负。旧版本写入的（无 allow_expires_at）按已过期处理（收紧方向）。
export const AUTH_DEFAULT_TTL_MIN = 15;

function globalAllowExpired(s) {
  if (!s.allow_expires_at) return true; // 无 TTL 视为过期（安全侧）
  return new Date(s.allow_expires_at).getTime() <= Date.now();
}

export function loadGlobalAllow(common) {
  const s = readJson(stateFile(common));
  return !!(s && s.allow_main_writes && !globalAllowExpired(s));
}

// 未过期的到期时刻（ISO），无有效授权返回 null——供 status/输出显示。
export function globalAllowExpiry(common) {
  const s = readJson(stateFile(common));
  if (!s || !s.allow_main_writes || globalAllowExpired(s)) return null;
  return s.allow_expires_at || null;
}

export function setGlobalAllow(common, reason, ttlMinutes = AUTH_DEFAULT_TTL_MIN) {
  const s = readJson(stateFile(common)) || {};
  s.allow_main_writes = true;
  s.allow_reason = reason || "用户授权";
  s.allow_at = nowIso();
  s.allow_expires_at = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  writeJson(stateFile(common), s);
}
export function clearGlobalAllow(common) {
  const s = readJson(stateFile(common));
  if (s) { delete s.allow_main_writes; delete s.allow_reason; delete s.allow_at; delete s.allow_expires_at; writeJson(stateFile(common), s); }
}

// ---------------------------------------------------------------------------
// v0.2 会话级绑定：bindings/<session_id>.json（每 session 一文件，无并发争用）

export function loadBinding(common, sessionId) {
  return readJson(bindingFile(common, sessionId));
}

export function saveBinding(common, sessionId, binding) {
  // source: "self"（自身 enter）| "inherited"（从父继承快照）
  writeJson(bindingFile(common, sessionId), { ...binding, resolved_at: nowIso() });
}

export function clearBinding(common, sessionId) {
  const f = bindingFile(common, sessionId);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function listBindings(common) {
  // 列出所有 session 绑定，返回 [{sessionId, ...binding}]
  const dir = bindingsDir(common);
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const data = readJson(path.join(dir, f));
    if (data) result.push({ sessionId: f.replace(/\.json$/, ""), ...data });
  }
  return result;
}

export function findBindingsForWorktree(common, worktreePath) {
  // 查找所有指向该 worktree 的 session 绑定（用于悬空检查）
  const nWt = norm(worktreePath);
  return listBindings(common)
    .filter((b) => b.worktree && norm(b.worktree) === nWt)
    .map((b) => b.sessionId);
}

// ---------------------------------------------------------------------------
// v0.2 临时放行：allowlist.json（仓库级单文件，不按 session 分）
// 理由：wt.mjs（agent 通过 Bash 调用）和 hook（ZCode spawn）的 session_id 来源不一致，
// 按 session 分文件会导致 wt.mjs 写的和 hook 读的 key 对不上。逃生口语义属于"这个仓库
// 临时放行某些路径"，不需要 session 隔离。allowlist 记调用者 session_id 仅作审计。

function allowlistFileRepo(common) { return path.join(stateDirOf(common), "allowlist.json"); }

export function loadAllowlist(common) {
  const al = readJson(allowlistFileRepo(common)) || { paths: [] };
  if (!al.paths) al.paths = [];
  // lazy GC：剔除已过期条目，避免 allowlist.json 无限增长。
  // 仅当确实有过期条目时才回写（避免无谓 IO）。
  const now = Date.now();
  const fresh = al.paths.filter((e) => !e.expires_at || new Date(e.expires_at).getTime() >= now);
  if (fresh.length !== al.paths.length) {
    al.paths = fresh;
    saveAllowlist(common, al);
  }
  return al;
}

export function saveAllowlist(common, data) {
  writeJson(allowlistFileRepo(common), data);
}

export function clearAllowlist(common) {
  const f = allowlistFileRepo(common);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function addAllowlistEntry(common, entry) {
  const al = loadAllowlist(common);
  if (!al.paths) al.paths = [];
  al.paths.push(entry);
  saveAllowlist(common, al);
}

export function isAllowlisted(common, targetPath, root) {
  const al = loadAllowlist(common);
  if (!al.paths || al.paths.length === 0) return false;
  const now = Date.now();
  const nTarget = norm(targetPath);
  const nRoot = norm(root);
  for (const entry of al.paths) {
    if (entry.expires_at && new Date(entry.expires_at).getTime() < now) continue;
    const ep = entry.path;
    if (path.isAbsolute(ep)) {
      if (matchGlob(nTarget, norm(ep))) return true;
    } else {
      const absPattern = norm(path.join(nRoot, ep));
      if (matchGlob(nTarget, absPattern)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// v0.2 bases（worktree 元数据，与 session 无关）

export function loadBasesByCommon(common) { return readJson(basesFile(common)) || {}; }
export function saveBaseByCommon(common, branch, base) {
  const bases = loadBasesByCommon(common);
  bases[branch] = base;
  writeJson(basesFile(common), bases);
}

// ---------------------------------------------------------------------------
// v0.2 meta（schema 版本，迁移检测）

export function ensureMeta(common) {
  const mf = metaFile(common);
  const existing = readJson(mf);
  if (!existing || existing.schema_version !== SCHEMA_VERSION) {
    writeJson(mf, { schema_version: SCHEMA_VERSION, updated_at: nowIso() });
  }
}

// ---------------------------------------------------------------------------
// v0.2 审计日志（worktree_allow 调用记录）

export function appendAudit(common, entry) {
  const f = auditFile(common);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ ...entry, ts: nowIso() }) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// v0.2 glob 匹配（手写简单实现，支持 * 和 **，避免加依赖）

export function matchGlob(target, pattern) {
  // 将 glob pattern 转为正则。支持：** 跨目录，* 单段，? 单字符。
  // target 和 pattern 都已 norm（小写化）。
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** 匹配任意（含分隔符）
        re += ".*";
        i += 2;
        if (pattern[i] === path.sep || pattern[i] === "/") i++; // 吃掉后面的分隔符
      } else {
        // * 匹配除分隔符外任意字符
        re += `[^${path.sep}\\\\/]*`;
        i++;
      }
    } else if (c === "?") {
      re += `[^${path.sep}\\\\/]`;
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  try {
    return new RegExp(`^${re}$`).test(target);
  } catch {
    return false;
  }
}

export function matchWhitelist(targetPath, root, patterns) {
  // 检查 targetPath 是否命中白名单 patterns（相对 root 的 glob）
  if (!patterns || patterns.length === 0) return false;
  const nTarget = norm(targetPath);
  const nRoot = norm(root);
  for (const p of patterns) {
    const absPattern = path.isAbsolute(p) ? norm(p) : norm(path.join(nRoot, p));
    if (matchGlob(nTarget, absPattern)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// v0.2 DB 查询（node:sqlite 只读，查 session.parent_id）
// Node 24 已稳定，无需实验标志。失败时返回 null（调用方降级）。

let _dbPathCache = null;
export function resolveDbPath() {
  if (_dbPathCache) return _dbPathCache;
  const storage = process.env.ZCODE_STORAGE_DIR;
  if (storage) {
    _dbPathCache = path.join(storage, "cli", "db", "db.sqlite");
    return _dbPathCache;
  }
  const home = os.homedir();
  const normal = path.join(home, ".zcode", "cli", "db", "db.sqlite");
  const beta = path.join(home, ".zcode-beta", "cli", "db", "db.sqlite");
  if (fs.existsSync(normal)) { _dbPathCache = normal; return normal; }
  if (fs.existsSync(beta)) { _dbPathCache = beta; return beta; }
  _dbPathCache = normal;
  return normal;
}

export function queryParentId(sessionId) {
  // 返回 parent_id 字符串，或 null（顶层会话/查询失败）。任何异常返回 null（降级）。
  let DatabaseSync;
  try {
    // 用 esmRequire（createRequire）而非裸 require——ESM 模块内裸 require 不可用。
    ({ DatabaseSync } = esmRequire("node:sqlite"));
  } catch {
    return null; // node:sqlite 不可用（Node < 22.5）
  }
  let db;
  try {
    db = new DatabaseSync(resolveDbPath(), { readOnly: true, timeout: 2000 });
  } catch {
    return null; // DB 打不开（锁/路径/权限）
  }
  try {
    const row = db.prepare("SELECT parent_id FROM session WHERE id = ?").get(sessionId);
    return row ? (row.parent_id || null) : null;
  } catch {
    return null; // schema 变更/查询错误
  } finally {
    try { db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 绑定解析（核心）：默认主副本开放——绑定只来自本会话 enter（或 subagent 继承父链 enter）。
//   ① bindings/<session_id>.json（自身直绑，最高优先）
//   ② DB parent 链继承（仅 sess_subagent_*，查 parent_id，快照到自身）
//   ③ 无绑定 → 返回 null（hook 层放行主副本写入，不拦截）
// v0.4 起 state.json 不再作为绑定真值（默认开放语义下绑定必须由本会话明确 enter 产生），
// 避免上个会话的 enter 跨会话残留、把新会话自动锁进副本。

export function resolveBinding(common, sessionId) {
  // ① 自身直绑
  const selfBinding = loadBinding(common, sessionId);
  if (selfBinding && selfBinding.worktree) {
    return { ...selfBinding, source: selfBinding.source || "self" };
  }

  // ② DB parent 链继承（仅对子代理 session_id 尝试）
  if (sessionId && sessionId.startsWith("sess_subagent_")) {
    const inherited = resolveInherited(common, sessionId);
    if (inherited) {
      // 快照到自身 binding 文件（此后父改变不影响本 session）
      saveBinding(common, sessionId, { ...inherited, source: "inherited" });
      return { ...inherited, source: "inherited" };
    }
  }

  // ③ 无绑定 → null（hook 层放行主副本写入）
  return null;
}

function resolveInherited(common, sessionId, depth = 0) {
  // 沿 parent 链向上找祖先的绑定。深度限制 10 防环。
  if (depth > 10) return null;
  const parentId = queryParentId(sessionId);
  if (!parentId) return null; // 顶层会话或 DB 失败
  // 父自身可能有直绑
  const parentBinding = loadBinding(common, parentId);
  if (parentBinding && parentBinding.worktree) return parentBinding;
  // 父也可能是子代理，继续向上
  if (parentId.startsWith("sess_subagent_")) {
    return resolveInherited(common, parentId, depth + 1);
  }
  // 父是顶层会话且无直绑 → 不再降级到 state.json（v0.4：绑定只来自明确 enter）
  return null;
}

// ---------------------------------------------------------------------------
// Bash 命令解析：提取 cd 目标（v0.1 保留）

const CD_RE = /(?:^|[;&|]\s*|\band\b\s+)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|`$()]+))/m;

// Git Bash/MSYS 风格盘符路径 → Windows 路径。
// `/f/foo` 与 `/cygdrive/f/foo` 在真实 Git Bash 里是 F:\foo，但 path.resolve 会把
// `/f/foo` 解析成 `<当前盘>:\f\foo` 垃圾路径（曾致 currentBranch 误报 detached HEAD
// 且 Bash 防护整段被跳过）。仅匹配单字母盘符，不影响多字母 POSIX 路径。
function msysToWinPath(p) {
  if (process.platform !== "win32") return p;
  const m = p.match(/^\/cygdrive\/([a-z])\/(.*)$/i) || p.match(/^\/([a-z])\/(.*)$/i);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}

// 同一条命令内的简单 shell 变量解析：收集 `NAME=值` 赋值，替换 $NAME / "${NAME}"。
// 背景：ZCode Bash 每次调用都是全新 shell，跨调用变量不保留；agent 常在同一命令内
// `WT="F:/..."` 赋值后用 `git -C "$WT" ...`。hook 不解 shell，但解析这一最常见形态
// 可让 cd/-C 语境提取拿到真实路径（反馈 v0.4.2 症状③的实发命令即此形态）。
// 只做替换、不执行任何东西；替换后路径不存在时由调用方的存在性检查兜底。
const SHELL_ASSIGN_RE = /(?:^|[\s;&|(\n])([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|)`()]+))/g;

function collectShellVars(command) {
  const vars = new Map();
  let m;
  const re = new RegExp(SHELL_ASSIGN_RE.source, "g");
  while ((m = re.exec(command)) !== null) {
    vars.set(m[1], m[2] ?? m[3] ?? m[4] ?? "");
  }
  return vars;
}

function resolveShellVars(str, vars) {
  if (!vars.size || !str.includes("$")) return str;
  return str.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (all, braced, plain) => {
      const name = braced || plain;
      return vars.has(name) ? vars.get(name) : all;
    });
}

function resolveCommandPath(rawTarget, command, baseDir) {
  // 公共路径解析：同命令变量替换 → MSYS 归一化 → 相对路径基于 baseDir → 存在性检查。
  const vars = collectShellVars(command);
  let target = msysToWinPath(resolveShellVars(rawTarget, vars));
  if (!path.isAbsolute(target)) target = path.join(String(baseDir), target);
  target = path.resolve(target);
  return fs.existsSync(target) ? target : null;
}

export function extractCdTarget(command, cwd) {
  const re = new RegExp(CD_RE.source, "gm");
  let last = null;
  let m;
  while ((m = re.exec(command)) !== null) {
    last = m[1] || m[2] || m[3];
  }
  if (!last) return null;
  let target = last;
  if (target.startsWith("~")) target = target.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "~");
  // 语义对齐真实 bash：cd 到不存在的目录会失败并停留在原 cwd，后续命令仍在原目录
  // 执行。解析出不存在的目标应视为"无有效 cd"，而不是拿垃圾路径当工作目录。
  return resolveCommandPath(target, command, cwd);
}

// git -C <path> 目标提取（v0.4.2）：取最后一次出现的 `git -C <path>`。
// 背景：git 语境（分支/是否在副本内）此前只看 cd/会话 cwd，忽略 `git -C` 目标——
// 绑定态下 `git -C <worktree> merge ...` 会在主 checkout 语境误判为"受保护分支上
// merge"而误拦（反馈症状③）。-C 是最特异的 git 语境指示，优先于 cd。
// 裸词捕获允许 $VAR/${VAR}（交由 resolveShellVars 解析），排除 ( 防 $(cmd) 命令替换。
const GIT_C_RE = /(?:^|[;&|(\n]\s*)git\s+[^;&|]*?-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|`()]+))/g;

export function extractGitCTarget(command, baseCwd) {
  let last = null;
  let m;
  const re = new RegExp(GIT_C_RE.source, "g");
  while ((m = re.exec(command)) !== null) {
    last = m[1] || m[2] || m[3];
  }
  if (!last) return null;
  // 目标不存在（含无法解析的 $VAR 动态路径）→ null，语境回退到 cd/cwd
  return resolveCommandPath(last, command, baseCwd);
}

// ---------------------------------------------------------------------------
// v0.2 危险配置校验：白名单不允许裸根/全匹配（防误配卸保护）

export function validateWhitelist(patterns) {
  // 返回 {valid: string[], dangerous: string[]}。危险裸根模式（*、/、.、** 等）归入 dangerous。
  const dangerous = [];
  const valid = [];
  for (const p of patterns) {
    const trimmed = p.trim();
    if (["", ".", "/", "*", "**", "./", ".\\"].includes(trimmed) ||
        trimmed.replace(/[/\\]/g, "") === "*") {
      dangerous.push(trimmed);
    } else {
      valid.push(trimmed);
    }
  }
  return { valid, dangerous };
}

// ---------------------------------------------------------------------------
// v0.3 文件同步：worktree 创建后复制文件 / 链接目录，清理时安全删除链接
// 设计参考 opencode-worktree-isolation，但清理安全加强：
// opencode 清理完全依赖 git worktree remove --force，无 symlink 防护（高危），
// 本实现在 git remove 前先用 lstat+unlink 安全移除 junction/symlink。

// 创建阶段：复制文件（copy_files）。逐文件 copyFileSync，收集失败不静默吞。
export function syncCopyFiles(root, wtPath, copyFiles) {
  const copied = [], skipped = [], failed = [];
  for (const f of copyFiles) {
    const src = path.join(root, f);
    const dst = path.join(wtPath, f);
    if (!fs.existsSync(src)) { skipped.push(f); continue; }
    try {
      const st = fs.lstatSync(src);   // lstat 不跟随：源本身必须是文件
      if (!st.isFile()) { skipped.push(`${f} (非文件)`); continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(f);
    } catch (e) {
      failed.push(`${f}: ${e.message}`);
    }
  }
  return { copied, skipped, failed };
}

// 创建阶段：链接目录（symlink_dirs）。Windows 用 junction（无需管理员权限），失败回退 dir symlink。
export function syncSymlinkDirs(root, wtPath, symlinkDirs) {
  const linked = [], skipped = [], failed = [];
  const isWin = process.platform === "win32";
  for (const d of symlinkDirs) {
    const src = path.join(root, d);
    const dst = path.join(wtPath, d);
    if (!fs.existsSync(src)) { skipped.push(d); continue; }
    try {
      const st = fs.lstatSync(src);   // lstat：源本身必须是目录
      if (!st.isDirectory()) { skipped.push(`${d} (非目录)`); continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const type = isWin ? "junction" : "dir";
      try {
        fs.symlinkSync(src, dst, type);
      } catch {
        // junction 失败（罕见）→ 回退普通 dir symlink（需管理员/开发者模式）
        fs.symlinkSync(src, dst, "dir");
      }
      linked.push(d);
    } catch (e) {
      failed.push(`${d}: ${e.message}`);
    }
  }
  return { linked, skipped, failed };
}

// 🔴 清理阶段：安全删除 worktree 内的 symlink/junction（必须在 git worktree remove 前）
// 关键安全点：
//   1. 必须 lstatSync（非 statSync）—— statSync 跟随 symlink 会误判为目录
//   2. 必须 unlinkSync（非 rmSync）—— unlinkSync 只删链接本身，不跟随不递归
//   3. 只删 isSymbolicLink() 的条目——用户自建的真目录留给 git remove
// 如果跳过此步直接 git worktree remove，递归删除可能跟随 junction 误删主仓库内容。
export function removeSyncedLinks(wtPath, symlinkDirs) {
  const removed = [], skipped = [], failed = [];
  for (const d of symlinkDirs) {
    const linkPath = path.join(wtPath, d);
    if (!fs.existsSync(linkPath)) { skipped.push(d); continue; }
    try {
      const st = fs.lstatSync(linkPath);   // 🔴 lstat 不跟随
      if (st.isSymbolicLink()) {
        fs.unlinkSync(linkPath);            // 🔴 unlink 只删链接，不递归
        removed.push(d);
      } else {
        skipped.push(`${d} (非链接，可能是真目录)`);
      }
    } catch (e) {
      failed.push(`${d}: ${e.message}`);
    }
  }
  return { removed, skipped, failed };
}
