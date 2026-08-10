// zcode-worktree-guard 共享工具：git 封装、路径归一化、状态读写、绑定解析、决策表。
// wt.mjs 与 guard_hook.mjs 共用本模块。纯 Node 标准库，零依赖。
// v0.2：会话级绑定（bindings/ 每session一文件）+ DB parent 继承 + state.json 兜底。
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// 常量

export const STATE_DIR_NAME = "worktree-guard";
export const BRANCH_PREFIX_DEFAULT = "worktree-";
export const DEFAULT_PARENT = ".worktrees";
export const DEFAULT_PROTECTED = ["master", "main"];
export const TASK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
export const SCHEMA_VERSION = 2;

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
  return code === 0 && stdout ? stdout : "(detached HEAD)";
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

export function dirtySummary(p) {
  const { stdout } = runGit(["status", "--porcelain"], p, { check: true });
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
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
  // v0.2 白名单：声明式放行，这些路径写主目录不重写不拦截
  const wl = cfg.main_write_whitelist;
  return Array.isArray(wl) ? wl.filter((p) => typeof p === "string" && p.trim()) : [];
}

// ---------------------------------------------------------------------------
// 内部工具

function stateDirOf(common) { return path.join(common, STATE_DIR_NAME); }
function stateFile(common) { return path.join(stateDirOf(common), "state.json"); }
function basesFile(common) { return path.join(stateDirOf(common), "bases.json"); }
function metaFile(common) { return path.join(stateDirOf(common), "meta.json"); }
function bindingsDir(common) { return path.join(stateDirOf(common), "bindings"); }
function auditFile(common) { return path.join(stateDirOf(common), "audit.jsonl"); }
function bindingFile(common, sessionId) { return path.join(bindingsDir(common), `${sessionId}.json`); }

function readJson(f) {
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
}
function safeFileName(s) { return s.replace(/[^a-zA-Z0-9._-]/g, "-"); }

export function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// v0.1 兜底层：state.json（仓库级单活动，跨 session 共享）
// 保留作为 resolveBinding 的最终降级真值源。

export function loadStateByCommon(common) {
  const s = readJson(stateFile(common));
  return s && s.active ? s : null;
}
export function saveStateByCommon(common, state) { writeJson(stateFile(common), state); }
export function clearStateByCommon(common) {
  if (fs.existsSync(stateFile(common))) fs.unlinkSync(stateFile(common));
}

// 全局授权（authorize-main）：写入 state.json 的 allow_main_writes 字段（原 override.json 废弃）
export function loadGlobalAllow(common) {
  const s = readJson(stateFile(common));
  return !!(s && s.allow_main_writes);
}
export function setGlobalAllow(common, reason) {
  const s = readJson(stateFile(common)) || {};
  s.allow_main_writes = true;
  s.allow_reason = reason || "用户授权";
  s.allow_at = nowIso();
  writeJson(stateFile(common), s);
}
export function clearGlobalAllow(common) {
  const s = readJson(stateFile(common));
  if (s) { delete s.allow_main_writes; delete s.allow_reason; delete s.allow_at; writeJson(stateFile(common), s); }
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
  return readJson(allowlistFileRepo(common)) || { paths: [] };
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
    ({ DatabaseSync } = require("node:sqlite"));
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
// v0.2 绑定解析（核心）：三层降级
//   ① bindings/<session_id>.json（自身直绑，最高优先）
//   ② DB parent 链继承（查 parent_id，快照到自身）
//   ③ state.json（v0.1 兜底，仓库级单活动）
//   ④ 无绑定 → 返回 null（hook 层 fail-closed block 写）

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

  // ③ state.json 兜底（v0.1 仓库级单活动）
  const state = loadStateByCommon(common);
  if (state) {
    return {
      worktree: state.path,
      branch: state.branch,
      base: state.base,
      source: "fallback-state",
    };
  }

  // ④ 无绑定
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
  // 父是顶层会话，查它的直绑没有 → 尝试 state.json 兜底
  const state = loadStateByCommon(common);
  if (state) {
    return { worktree: state.path, branch: state.branch, base: state.base };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bash 命令解析：提取 cd 目标（v0.1 保留）

const CD_RE = /(?:^|[;&|]\s*|\band\b\s+)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|`$()]+))/m;

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
  if (!path.isAbsolute(target)) target = path.join(String(cwd), target);
  return path.resolve(target);
}

// ---------------------------------------------------------------------------
// v0.2 危险配置校验：白名单不允许裸根/全匹配（防误配卸保护）

export function validateWhitelist(patterns) {
  // 返回 {valid: bool, dangerous: [patterns]}。危险的裸根模式拒绝。
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
