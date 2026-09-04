# omp-skill-kit — OMP extension contract audit

Single-version contract audit for the installed local Oh My Pi runtime.

- Binary command: `omp --version` -> `omp/18.1.6`
- Binary path: `where omp` -> `C:\Users\stigm\.local\bin\omp.exe`
- Pinned package source: `node_modules/@oh-my-pi/pi-coding-agent/package.json` -> version `18.1.6`
- Source root: `node_modules/@oh-my-pi/pi-coding-agent/src/`

Both binary and package source are synchronized to exact version **18.1.6**.

---

## 1. Extension Hook Surface & Handlers

Only public, officially supported extension events are used: `session_start`, `before_agent_start`, `tool_result`, and `session_stop`. No private internal APIs or unverified lifecycle hooks are registered.

### `session_start`
- **Definition**: `extensibility/shared-events.ts:28-30`
  ```ts
  export interface SessionStartEvent {
    type: "session_start";
  }
  ```
- **Registration**: `extensibility/extensions/types.ts:1237`
  ```ts
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  ```
- **Dispatch**: `extensibility/extensions/runner.ts:1349-1410` (`emit<TEvent>(event: TEvent)`)
  Executes registered handlers sequentially via `#runHandlerWithTimeout` (`:1378-1384`).
- **Timeout & Exception Isolation**: `extensibility/extensions/runner.ts:1262-1347` (`#runHandlerWithTimeout`).
  - Synchronous throws or unhandled rejections are caught (`:1298-1300`, `:1314-1316`).
  - Errors are routed to logger and `#errorListeners` via `this.emitError()` (`:1338-1343`), returning `undefined`.
  - Errors do **not** escape to tear down or block the session loop.
  - Per-handler default timeout: `30_000` ms (`runner.ts:86`).

### `before_agent_start`
- **Definition**: `extensibility/extensions/types.ts:756-761`
  ```ts
  export interface BeforeAgentStartEvent {
    type: "before_agent_start";
    prompt: string;
    images?: ImageContent[];
    systemPrompt: string[];
  }
  ```
- **Result Type**: `extensibility/extensions/types.ts:1141-1145`
  ```ts
  export interface BeforeAgentStartEventResult {
    message?: CustomMessagePayload;
    systemPrompt?: string[];
  }
  ```
- **Registration**: `extensibility/extensions/types.ts:1263`
  ```ts
  on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
  ```
- **Dispatch & Chaining**: `extensibility/extensions/runner.ts:1715-1766` (`emitBeforeAgentStart`).
  - Iterates handlers (`:1729-1755`), passing current prompt, images, and accumulated `systemPrompt` (`:1730-1734`).
  - When a handler returns `systemPrompt` (`:1749-1753`), `currentSystemPrompt` is updated and passed to subsequent handlers.
  - Handlers returning no changes leave `systemPrompt` intact.
- **Fail-Open Isolation**: `#runHandlerWithTimeout` (`:1736-1742`) catches timeouts and errors without throwing. `omp-skill-kit` additionally wraps ranking with internal fail-open logic (750 ms limit, fallback `{ names: [], unavailable: true }`).

### `tool_result` and `session_stop`
- **Tool result contract**: `extensibility/extensions/types.ts:939-945` defines `tool_result` with `toolCallId`, normalized `input`, result `content`, and `isError`; the public registration is `types.ts:1248`.
- **Dispatch**: `extensibility/extensions/runner.ts:1391-1394` dispatches registered `tool_result` handlers after tool execution. This is the supported observation point for confirming that a selected skill's `SKILL.md` was actually read.
- **Session stop contract**: `extensibility/shared-events.ts:97-107` defines `session_stop` with `messages`, `turn_id`, `session_id`, `stop_hook_active`, and an abort `signal`; the public registration is `extensions/types.ts:1225`.
- **Stop result semantics**: `extensibility/shared-events.ts:393-403` allows only continuation-related fields. The plugin returns no stop decision; it records usage/verdict and remains fail-open.
- **Identity**: `extensions/runner.ts:641-643` exposes `runner.sessionId` from `sessionManager.getSessionId()`; the `session_stop.session_id` field is used to join the pending route.

---

## 2. Extension Context & UI Capabilities

### `ExtensionContext.hasUI`
- **Definition**: `extensibility/extensions/types.ts:467` (`hasUI: boolean;`).
- **Implementation**: `extensibility/extensions/runner.ts:881-883`
  ```ts
  hasUI(): boolean {
    return this.#uiContext !== noOpUIContext;
  }
  ```
- **Context Binding**: `extensibility/extensions/runner.ts:1176` (`hasUI: this.hasUI(),`).
- **Semantics**: `true` in interactive TUI sessions; `false` in non-interactive print (`-p`), JSON-RPC, or headless batch runs.

### `ui.notify`
- **Definition**: `extensibility/extensions/types.ts:279`
  ```ts
  notify(message: string, type?: "info" | "warning" | "error"): void;
  ```
- **Semantics**: Displays a banner notification in interactive mode; no-op when `hasUI === false`.

### `ui.setStatus`
- **Definition**: `extensibility/extensions/types.ts:285`
  ```ts
  setStatus(key: string, text: string | undefined): void;
  ```
- **Semantics**: Sets or clears key-addressed status text in the TUI footer/status bar. Passing `undefined` clears the status entry.

---

## 3. Managed Timers & Lifecycle Cleanup

### `ctx.setInterval` & `ctx.clearTimer`
- **Interface**: `extensibility/extensions/types.ts:501-509`
  ```ts
  setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer;
  setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer;
  clearTimer(timer: Timer): void;
  ```
- **Runner Implementation**: `extensibility/extensions/runner.ts:1192-1194`
  ```ts
  setInterval: (callback, ms, ...args) => this.#managedTimers.setInterval(callback, ms, ...args),
  setTimeout: (callback, ms, ...args) => this.#managedTimers.setTimeout(callback, ms, ...args),
  clearTimer: timer => this.#managedTimers.clear(timer),
  ```
- **ManagedTimers Class**: `extensibility/extensions/managed-timers.ts:22-83`
  - `setInterval`: `managed-timers.ts:28-32` creates an unref'd timer and tracks it in `#timers`.
  - Isolation (`:66-82`): Callbacks execute inside an isolated wrapper (`#run`). Synchronous throws or rejected promises are swallowed and reported to `onError` without escaping to process-level `uncaughtException`.
  - `clearTimer`: `managed-timers.ts:51-55` removes the handle and invokes `clearInterval`/`clearTimeout`.

### Automatic Cleanup on Session Teardown
- **Runner Teardown Call**: `extensibility/extensions/runner.ts:397` inside `emitSessionShutdownEvent`:
  ```ts
  extensionRunner.disposeFileFallbacks();
  extensionRunner.clearManagedTimers();
  ```
- **Clear All**: `extensibility/extensions/managed-timers.ts:58-64`
  ```ts
  clearAll(): void {
    for (const timer of this.#timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.#timers.clear();
  }
  ```
  Guarantees that background polling intervals scheduled by extensions are unconditionally cleared when the session closes, preventing memory leaks and orphaned operations.

---

## 4. Capability Loading & Catalog Discovery

- **Export**: `discovery/index.ts:61` re-exports `loadCapability`.
- **Implementation**: `capability/index.ts:256-273` (`loadCapability(capabilityId, options)`).
- **Skill Discovery**: Scans user, project, plugin, and managed skill directories, applying priority deduplication and returning surviving active items in `items`.

---

## 5. Summary of Invariants

1. **Version Parity**: Host binary `omp 18.1.6` matches `node_modules/@oh-my-pi/pi-coding-agent` version `18.1.6` exactly.
2. **Hook Integrity**: Only public `session_start`, `before_agent_start`, `tool_result`, and `session_stop` events are used. No private hooks.
3. **Fail-Open Routing**: Extension failures or timeouts (750 ms) never propagate to or block user turns.
4. **Isolated Timers**: Progress observers use `ctx.setInterval`, protected against `uncaughtException` and auto-cleared on teardown.
5. **Names-Only Hints**: Only candidate skill names are ever injected into `systemPrompt`. Bodies, descriptions, and file paths remain strictly excluded.
