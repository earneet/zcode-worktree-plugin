# Feature Request: PreToolUse / SessionStart hook stdin 增加 `parent_session_id`

## 请求

在 PreToolUse 和 SessionStart hook 的 stdin JSON 中增加 `parent_session_id` 字段，用于标识当前 session 的父 session（子代理场景下为发起 Agent/Task 调用的主 session）。

## 背景

ZCode 支持子代理（Agent/Task 工具派生），子代理有独立的 `session_id`（`sess_subagent_*`）。ZCode 的 SQLite session 表已存储 `parent_session_id` 列，但该信息**未暴露到 hook stdin**。

插件（如 zcode-worktree-guard）需要知道当前 session 的 parent，用于实现**子代理继承父 session 的 worktree 绑定**——子代理和父代理应共享同一个 worktree 副本，而非各自创建。

## 现状（基于 ZCode bundle 源码确认）

对 `zcode.cjs`（v24.x bundle）的探索确认，hook stdin 构造器 `createClaudeCompatibleHookStdin`（约 L2942）构造的 JSON **不包含任何 parent 字段**：

**PreToolUse hook stdin 完整字段**（事件源 L2460）：
```
session_id, cwd, agent_type, hook_event_name, permission_mode,
transcript_path, tool_name, tool_input, tool_use_id,
traceId, turnId, riskLevel, sideEffectScope, timestamp, toolCallId
```

**SessionStart hook stdin 完整字段**（事件源 L3094）：
```
session_id, cwd, agent_type, hook_event_name, permission_mode,
model, source, timestamp, traceId, turnId
```

两者均无 `parent_session_id` / `parentSessionId` / `parent_id`。

`parentSessionId` 在 bundle 中仅出现在：
- SQLite session 表 Zod schema（L43, L57）
- DB 行映射 `parent_session_id` 列（L1019）
- OpenTelemetry span 属性（L2958 等）
- 子 session spawn 上下文（L3062 等）

**即 parent 信息存在于 DB 和遥测中，但从未进入 hook stdin。**

## 当前 workaround 及其风险

zcode-worktree-guard 当前通过**直读 SQLite session 表**获取 parent：

```js
const row = db.prepare("SELECT parent_id FROM session WHERE id = ?").get(sessionId);
```

这带来 **DB schema 耦合风险**：ZCode 升级若修改 session 表结构（列名、类型、表名），插件继承机制会静默失效。

## 请求的具体变更

在 `createClaudeCompatibleHookStdin`（L2942）构造的 JSON 中，从事件对象透传 `parent_session_id`：

```js
// 建议在 L2942 附近：
let t = {
  ...e,
  agent_type: e.agentName,
  hook_event_name: e.hookEventName,
  permission_mode: e.mode,
  session_id: e.sessionId,
  parent_session_id: e.parentSessionId ?? null,  // ← 新增
};
```

同时在 PreToolUse（L2460）和 SessionStart（L3094）的事件对象构造处，从 session 上下文填充 `parentSessionId`（该信息在 session 行中已有）。

## 兼容性

- **向后兼容**：`parent_session_id` 是新增字段，现有不读取该字段的插件不受影响
- **值为 null**：顶层会话的 parent 为 null（明确语义，而非"字段缺失"）
- **snake_case**：与现有 `session_id`、`hook_event_name` 等字段保持命名一致

## 收益

1. 插件不再需要直读宿主 SQLite DB，消除 schema 耦合
2. 子代理继承机制更健壮（ZCode 升级不会破坏）
3. 符合最小权限原则（插件不应访问宿主内部 DB）
4. 与 opencode 的 `client.session.get(id).parentID` API 对齐（跨工具一致性）

## 参考

- 探索证据：`zcode.cjs` L2942（stdin builder）、L2460（PreToolUse event）、L3094（SessionStart event）
- 消费方：zcode-worktree-guard `common.mjs` `resolveBinding()` / `queryParentId()`
- 对比项目：opencode-worktree-isolation 通过 `client.session.get()` API 获取 parentID（不耦合 DB）
