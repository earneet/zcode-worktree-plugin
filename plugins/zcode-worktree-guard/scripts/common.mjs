// zcode-worktree-guard 共享工具：git 封装、路径归一化、状态读写、配置加载、cd 解析。
// wt.mjs 与 guard_hook.mjs 共用本模块。纯 Node 标准库，零依赖。
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// 常量

export const STATE_DIR_NAME = "worktree-guard";
export const BRANCH_PREFIX_DEFAULT = "worktree-";
export const DEFAULT_PARENT = ".worktrees";
export const DEFAULT_PROTECTED = ["master", "main"];
export const TASK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

// ---------------------------------------------------------------------------
// 路径归一化（Windows 大小写不敏感）。process.platform === "win32" 时 normcase 为 toLowerCase。

export function norm(p) {
  // path.resolve 把相对路径基于 cwd 解析为绝对路径，并规范化 . 和 ..
  const abs = path.resolve(String(p));
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function isInside(targetAbs, baseAbs) {
  // 两侧均已 norm 归一（小写化）。用 path.sep 做前缀边界。
  return targetAbs === baseAbs || targetAbs.startsWith(baseAbs + path.sep);
}

// ---------------------------------------------------------------------------
// git 封装

export function runGit(args, cwd, opts = {}) {
  // 返回 { code, stdout }。找不到 git / 超时抛 Error（由调用方兜底）。
  const timeout = (opts.timeout ?? 60) * 1000;
  try {
    const out = execFileSync("git", ["-C", String(cwd), ...args], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { code: 0, stdout: out.trim() };
  } catch (e) {
    // execFileSync 在非零退出时抛错；把 stderr/stdout 和 code 都带上
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
  // git common dir 的绝对路径。找不到时返回 null。
  try {
    const { code, stdout } = runGit(["rev-parse", "--git-common-dir"], cwd, { timeout: 10 });
    if (code !== 0 || !stdout) return null;
    return path.resolve(String(cwd), stdout);
  } catch {
    return null;
  }
}

export function findGitContext(targetPath, cwd) {
  // 从目标文件路径向上查找它所属的 git 仓库，返回 { common, root } 或 { common: null, root: null }。
  // ZCode 会话 cwd 是启动目录（可能非 git），但 agent 写的文件可在任意仓库内。
  if (!targetPath) return { common: null, root: null };
  const absTarget = path.isAbsolute(targetPath) ? targetPath : path.join(String(cwd), targetPath);
  // 从目标所在目录（文件取父目录）向上找 .git
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
  if (c3 === 0 && superTree) return false; // submodule
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
  // 追加到 .git/info/exclude（本地排除，不进版本库）。
  const common = gitCommonDir(mainRoot);
  if (!common) return false;
  const exclude = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const existing = fs.existsSync(exclude)
    ? fs.readFileSync(exclude, "utf8")
    : "";
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
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

export function branchPrefix(cfg) {
  return cfg.branch_prefix || BRANCH_PREFIX_DEFAULT;
}

export function worktreeParent(cfg) {
  return (cfg.worktree_parent || DEFAULT_PARENT).trim().replace(/^\/+|\/+$/g, "");
}

export function protectedBranches(cfg) {
  const extra = cfg.protected_branches;
  const set = new Set(DEFAULT_PROTECTED);
  if (Array.isArray(extra)) {
    for (const b of extra) if (b && b.trim()) set.add(b.trim().toLowerCase());
  }
  return set;
}

// ---------------------------------------------------------------------------
// 状态文件读写（git common dir 下 worktree-guard/）

function stateDirOf(common) {
  return path.join(common, STATE_DIR_NAME);
}
function stateFile(common) {
  return path.join(stateDirOf(common), "state.json");
}
function overrideFile(common) {
  return path.join(stateDirOf(common), "override.json");
}
function basesFile(common) {
  return path.join(stateDirOf(common), "bases.json");
}

function readJson(f) {
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
}

export function loadStateByCommon(common) {
  const s = readJson(stateFile(common));
  return s && s.active ? s : null;
}

export function saveStateByCommon(common, state) {
  writeJson(stateFile(common), state);
}

export function clearStateByCommon(common) {
  if (fs.existsSync(stateFile(common))) fs.unlinkSync(stateFile(common));
}

export function loadOverrideByCommon(common) {
  return readJson(overrideFile(common));
}

export function saveOverrideByCommon(common, override) {
  writeJson(overrideFile(common), override);
}

export function clearOverrideByCommon(common) {
  if (fs.existsSync(overrideFile(common))) fs.unlinkSync(overrideFile(common));
}

export function loadBasesByCommon(common) {
  return readJson(basesFile(common)) || {};
}

export function saveBaseByCommon(common, branch, base) {
  const bases = loadBasesByCommon(common);
  bases[branch] = base;
  writeJson(basesFile(common), bases);
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Bash 命令解析：提取 cd 目标（弥补 hook 看不到命令内部 cd 的限制）

const CD_RE = /(?:^|[;&|]\s*|\band\b\s+)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|`$()]+))/m;

export function extractCdTarget(command, cwd) {
  // 取最后一个 cd 目标（命令可能多段 cd，以最后所在目录为准）。
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
