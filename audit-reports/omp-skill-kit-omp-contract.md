# omp-skill-kit — OMP extension contract audit

Grounding for every OMP extension point `omp-skill-kit` v0.1.0 uses.
Verified against the installed OMP `17.3.7` and the latest `18.1.4`
(`@oh-my-pi/pi-coding-agent`, npm). Line ranges cite `file:lines` and were
read from the installed source, not inferred.

Source roots:
- 17.3.7: `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/`
- 18.1.4: npm tarball `package/src/`

## 1. `before_agent_start` — per-turn names-only routing hook

| Claim | 17.3.7 | 18.1.4 |
|---|---|---|
| Handler delivery: one call per registered handler per user prompt, before the agent loop | `extensibility/extensions/runner.ts:1688-1738` (`emitBeforeAgentStart`), handler lookup `extensions/runner.ts:1698-1701` | `extensibility/extensions/runner.ts:1715-1765`, lookup at `:1725-1728` |
| Event carries `prompt`, `images`, current `systemPrompt: string[]` chain | `extensibility/extensions/runner.ts:1703-1707` | `extensibility/extensions/runner.ts:1730-1734` |
| Handler result `systemPrompt` **replaces** the prompt for this turn only; multiple returns are chained | `extensibility/extensions/runner.ts:1722-1726` (`currentSystemPrompt = result.systemPrompt; systemPromptModified = true`) and `:1716-1720` (chains into next handler's `event.systemPrompt`) | `:1749-1753`, `:1743-1747` |
| `message` (CustomMessagePayload) is a separate channel, NOT merged into systemPrompt | `:1708-1713` (`messages.push(result.message)`) | `:1735-1740` |
| Combined result returned only when something changed; else `undefined` | `:1728-1736` | `:1755-1763` |
| Handler timeout/throw is contained: `#runHandlerWithTimeout` catches, logs, returns `undefined` unless `onFailure` supplied (emit path passes none) | `runner.ts:1238-1310` (timeout `:1294-1307`, throw `:1308-1316`) | same structure (`runner.ts:1265-1337`) |
| Per-handler budget default 30 000 ms | `runner.ts:85` (`EXTENSION_HANDLER_TIMEOUT_MS = 30_000`) | `runner.ts:86` |

Event type: `BeforeAgentStartEvent` = `{ type: "before_agent_start"; prompt; images?; systemPrompt: string[] }`
at `extensions/types.ts:715-719` (17.3.7) / `:755-763` (18.1.4).
Result type: `BeforeAgentStartEventResult` = `{ message?: CustomMessagePayload; systemPrompt?: string[] }`
at `extensions/types.ts:1100-1104` (17.3.7) / `:1141-1145` (18.1.4).
`on("before_agent_start", handler)` registration: `types.ts:1222` (17.3.7) / `:1263` (18.1.4).

**Conclusion**: returning `{ systemPrompt: [...event.systemPrompt, routingBlock] }` inserts a
names-only hint exactly for the current turn, is chained after other extensions, and never
becomes a session message. A slow/crashing handler fails open (no hint), never blocks OMP.

## 2. Session id

| Claim | 17.3.7 | 18.1.4 |
|---|---|---|
| `ctx.sessionManager.getSessionId()` returns this session's stable id | `runner.ts:640-643` (`get sessionId(): string { return this.sessionManager.getSessionId(); }`) | `runner.ts:641-644` |
| `ExtensionContext.sessionManager` is read-only | `extensions/types.ts:462` | `:462` |

## 3. `loadCapability("skills", { cwd })` — active deduplicated catalog

| Claim | 17.3.7 | 18.1.4 |
|---|---|---|
| Public export from discovery | `discovery/index.ts:61` (in re-export block starting `:58`) | `discovery/index.ts:61` |
| `loadCapability(capabilityId, options)` builds `LoadContext {cwd, home, repoRoot}` from `options.cwd` | `capability/index.ts:256-273` | `capability/index.ts:256-273` |
| Filters disabled providers + `options.providers` | `capability/index.ts:240-253` (`filterProviders`) | `:237-250` |
| Deduplication by `key` (skill name), priority order wins; shadowed duplicates marked `_shadowed` and excluded from `items` | `capability/index.ts:187-219` (keySeen/`_shadowed` logic), validation `:221-232` | `:184-216`, `:218-229` |
| Result `{ items, all, warnings, providers }`; `items` = deduped priority-ordered survivors | `capability/types.ts:124-132` | `capability/types.ts:124-132` |
| `LoadOptions.cwd?: string` — per-turn custom cwd supported | `capability/types.ts:66` | `capability/types.ts:66` |

`loadCapability("skills", {cwd: ctx.cwd})` returns the active OMP skill catalog:
user/project/plugin/managed providers, deduplicated by OMP priority. We read only `items`.

## 4. Skill type and metadata

`capability/skill.ts:44-59` (identical in 17.3.7 and 18.1.4):

```ts
export interface Skill {
    name: string;            // unique key
    path: string;            // absolute path
    content: string;         // markdown body
    frontmatter?: SkillFrontmatter;
    containRoot?: string;    // plugin-root containment for skill://
    level: "user" | "project";
    _source: SourceMeta;     // provider id/name/path/level
}
```

Frontmatter (`skill.ts:14-38`): `name?`, `description?`, `globs?`, `alwaysApply?`,
`hide?` (omit from rendered skill listing; manual access only),
`disableModelInvocation?` (Agent Skills equivalent, excluded from system-prompt listing).

`SourceMeta` = `{ provider, providerName, path, level: "user"|"project"|"native" }`
at `capability/types.ts:96-106`.

**Conclusion**: catalog snapshot uses exactly `name`, `description` (from frontmatter),
`_source.provider` and `_source.path`; `hide`/`disableModelInvocation` and empty/missing
description exclude a skill from automatic routing per OMP contract.

## 5. Command registration

`ExtensionAPI.registerCommand(name, {description?, getArgumentCompletions?, handler})`
at `extensions/types.ts:1322-1330` (17.3.7) / `:1321-1329` (18.1.4).
Namespace convention `omp-skill-kit:*` matches `omp-guard-kit` (existing plugin in this
account's marketplace ecosystem).

## 6. UI status

`ExtensionUIContext.setStatus(key, text | undefined)` — footer/status text
at `extensions/types.ts:283` (both versions).

## 7. Timers and session shutdown

| Claim | 17.3.7 | 18.1.4 |
|---|---|---|
| `ctx.setInterval` / `ctx.setTimeout` — contained throws, `unref`'d, cleared on `session_shutdown` | `extensions/types.ts:489-497` | `:489-497` |
| `clearTimer(timer)` | `types.ts:496-497` | same |
| `session_stop` fires with `{type, messages, turn_id, ...}`, handlers run with per-event budget | `extensibility/shared-events.ts:97-100`; runner dispatch `runner.ts:1331-1341` | `extensibility/extensions/types.ts:1266`; runner dispatch same shape |
| Detached background work: `ExtensionRunner` returns control to OMP; long installer runs as separate process, not a handler | `runner.ts:1688-1738` (handlers awaited per turn only) | `:1715-1765` |

The installer is intentionally NOT a `session_start`-held operation: `session_start`
(`shared-events.ts:28-30`; registration `types.ts:1196` 17.3.7 / `:1237` 18.1.4) fires the
detached installer and returns immediately; no OMP path waits on it.

## 8. Extension loading

`loadExtensions(paths, cwd, eventBus?)` at `extensions/loader.ts:439-460` and
`discoverAndLoadExtensions(configuredPaths, cwd, eventBus?)` at `:736+` (17.3.7).
`package.json: omp.extensions: ["./dist/extension.js"]`; the host loads real files through
`loadExtensionFromFactory`/`loadExtensions`, so loader E2E must use the real loader, not a
direct import.

## Verified matrix

- Installed: **17.3.7** (read at `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent`)
- Latest at pin-time: **18.1.4** (npm tarball, `package/src/`)
- `engines.omp: ">=17.3.7"` covers both.

All extension points used by `omp-skill-kit` are present with identical semantics in both
versions. No private/internal API is imported; the bundle externals only `@oh-my-pi/pi-coding-agent`
types for compile-time host API shape.
