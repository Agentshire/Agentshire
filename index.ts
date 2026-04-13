import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { agentTownPlugin } from "./src/plugin/channel.js";
import { setTownRuntime } from "./src/plugin/runtime.js";
import { initStateDir } from "./src/plugin/paths.js";
import { hookToAgentEvent } from "./src/plugin/hook-translator.js";
import { broadcastAgentEvent, clearEventBuffer, getActiveTownSessionId, findCitizenNpcId, retryChatWatchersForBinding } from "./src/plugin/ws-server.js";
import { extractTownSessionId } from "./src/plugin/town-session.js";
import { createTownTools } from "./src/plugin/tools.js";
import { onSubagentSpawned, onSubagentEnded, getLabelForSession, stopAll as stopAllWatchers } from "./src/plugin/subagent-tracker.js";
import { onAgentStarted, onAgentCompleted, clearPlan, isCurrentBatchDone, hasActivePlan, cleanupStaleSessionPlans } from "./src/plugin/plan-manager.js";
import type { CustomAssetManager } from "./src/plugin/custom-asset-manager.js";
import { pushNewChatMessages, pushSubagentCompletion } from "./src/plugin/ws-server.js";
import { handleEditorRequest, ensureEditorDirs, MIME_TYPES } from "./src/plugin/editor-serve.js";
import { createServer, type Server } from "node:http";
import { dirname as _dirname, join as _join } from "node:path";
import { fileURLToPath as _fu } from "node:url";
import { existsSync as _exists, readFileSync as _read, statSync as _stat } from "node:fs";

const NUDGE_DELAY_MS = 10_000;
let pendingNudgeTimer: ReturnType<typeof setTimeout> | null = null;
let httpServer: Server | null = null;

function cancelNudge(): void {
  if (pendingNudgeTimer) {
    clearTimeout(pendingNudgeTimer);
    pendingNudgeTimer = null;
  }
}

function scheduleNudge(townSessionId: string): void {
  cancelNudge();
  pendingNudgeTimer = setTimeout(async () => {
    pendingNudgeTimer = null;
    console.log('[agentshire] nudge: steward did not resume after batch completion, sending nudge message');
    try {
      const { sendNudgeMessage } = await import("./src/plugin/channel.js");
      const { sanitizeTownSessionId } = await import("./src/plugin/town-session.js");
      await sendNudgeMessage(
        sanitizeTownSessionId(townSessionId),
        '[系统通知] 当前批次的居民已全部完成任务。请调用 next_step() 查看下一步指令。',
      );
    } catch (err) {
      console.error('[agentshire] nudge: failed to send nudge message:', err);
    }
  }, NUDGE_DELAY_MS);
}

export { agentTownPlugin } from "./src/plugin/channel.js";
export { setTownRuntime } from "./src/plugin/runtime.js";
export { loadTownSoul, listTownSouls } from "./src/town-souls.js";
export type { TownSoul } from "./src/town-souls.js";

const TOWN_AGENT_ID = "town-steward";

const pendingSpawnTasks = new Map<string, string>();

function notifyGroupDiscussion(hookName: string, agentId: string, payload: Record<string, unknown>): void {
  import("./src/plugin/group-discussion.js").then(({ hasActiveDiscussion, onCitizenResponse, onCitizenTurnEnd }) => {
    if (!hasActiveDiscussion()) return;
    if (hookName === "llm_output") {
      const texts: string[] = (payload as any).assistantTexts ?? [];
      const text = texts.length > 0 ? texts[texts.length - 1] : String((payload as any).output ?? "");
      if (text) onCitizenResponse(agentId, text);
    } else if (hookName === "agent_end") {
      onCitizenTurnEnd(agentId);
    }
  }).catch(() => {});
}

function resolveSessionId(ctx: unknown, payload: Record<string, unknown>): string | undefined {
  const c = (ctx ?? {}) as Record<string, unknown>;
  return (
    extractTownSessionId(c.sessionId) ??
    extractTownSessionId(c.sessionKey) ??
    extractTownSessionId(c.requesterSessionKey) ??
    extractTownSessionId(payload.sessionId) ??
    getActiveTownSessionId()
  ) ?? undefined;
}

function isStewardDirect(ctx: any): boolean {
  if (!ctx?.agentId) return true;
  if (ctx.agentId !== TOWN_AGENT_ID) return false;
  const sk = ctx.sessionKey as string | undefined;
  if (sk && sk.includes(":subagent:")) return false;
  return true;
}

function dispatchSteward(hookName: string, payload: Record<string, unknown>, ctx?: unknown): void {
  const result = hookToAgentEvent(hookName, payload);
  if (!result) return;
  const sid = resolveSessionId(ctx, payload);
  console.log(`[agentshire][session:${sid ?? "unscoped"}] hook → ${hookName}`);
  const events = Array.isArray(result) ? result : [result];
  for (const event of events) {
    broadcastAgentEvent(event, sid);
  }
}

function dispatchCitizen(hookName: string, payload: Record<string, unknown>, ctx?: unknown): void {
  const sk = (ctx as any)?.sessionKey as string | undefined;
  if (!sk) return;
  const agentIdMatch = sk.match(/^agent:([^:]+):/);
  if (!agentIdMatch) return;
  const agentId = agentIdMatch[1];
  const npcId = findCitizenNpcId(agentId);
  if (!npcId) return;
  const result = hookToAgentEvent(hookName, payload);
  if (!result) return;
  const sid = resolveSessionId(ctx, payload);
  const events = Array.isArray(result) ? result : [result];
  for (const event of events) {
    (event as any).npcId = npcId;
    broadcastAgentEvent(event, sid);
  }

  notifyGroupDiscussion(hookName, agentId, payload);
}

function extractAgentIdForChatBinding(ctx: any): string | undefined {
  if (ctx?.agentId === TOWN_AGENT_ID || !ctx?.agentId) return "steward";
  const sk = ctx?.sessionKey as string | undefined;
  if (!sk) return undefined;
  const m = sk.match(/^agent:([^:]+):/);
  return m?.[1];
}

function registerHooks(api: OpenClawPluginApi): void {
  const stewardHooks = [
    "before_agent_start", "llm_input", "llm_output",
    "before_tool_call", "after_tool_call", "agent_end",
  ] as const;

  for (const hookName of stewardHooks) {
    api.on(hookName, (event: any, ctx: any) => {
      if (!isStewardDirect(ctx)) {
        if (hookName === 'before_agent_start') {
          const sid = resolveSessionId(ctx, event as any);
          const agentId = extractAgentIdForChatBinding(ctx);
          if (sid && agentId) {
            retryChatWatchersForBinding(sid, agentId);
          }
        }
        dispatchCitizen(hookName, event as any, ctx);
        return;
      }
      if (hookName === 'before_agent_start' || hookName === 'before_tool_call' || hookName === 'llm_input') {
        if (pendingNudgeTimer) {
          console.log('[agentshire] nudge cancelled: steward resumed on its own');
          cancelNudge();
        }
      }
      if (hookName === 'before_agent_start') {
        const sid = resolveSessionId(ctx, event as any);
        const agentId = extractAgentIdForChatBinding(ctx);
        if (sid && agentId) {
          retryChatWatchersForBinding(sid, agentId);
        }
      }
      dispatchSteward(hookName, event as any, ctx);
      if (hookName === 'agent_end') {
        const sid = resolveSessionId(ctx, event as any);
        if (sid) {
          setTimeout(() => pushNewChatMessages(sid), 500);
        }
      }
      if (hookName === 'before_tool_call') {
        const toolName = String((event as any)?.toolName ?? (event as any)?.name ?? '');
        if (toolName === 'sessions_spawn') {
          const params = (event as any)?.params ?? (event as any)?.input ?? {};
          const label = String(params.label ?? '');
          const task = String(params.task ?? '');
          if (label && task) {
            pendingSpawnTasks.set(label, task);
          }
        }
      }
    });
  }

  api.on("subagent_spawned", (event: any, ctx: any) => {
    const sid = resolveSessionId(ctx, event as any);
    const label = String(event.label ?? event.displayName ?? "");
    const cachedTask = label ? pendingSpawnTasks.get(label) : undefined;
    if (cachedTask) {
      event.task = cachedTask;
      pendingSpawnTasks.delete(label);
    }
    dispatchSteward("subagent_spawned", event as any, ctx);
    onSubagentSpawned(event as Record<string, unknown>, sid, (fallbackLabel, fallbackSid) => {
      console.log(`[agentshire] fallback: marking "${fallbackLabel}" as completed`);
      onAgentCompleted(fallbackLabel, true);

      if (fallbackSid) {
        setTimeout(() => pushSubagentCompletion(
          String((event as any).childSessionKey ?? ""), fallbackSid), 800);
      }

      if (hasActivePlan() && isCurrentBatchDone()) {
        if (fallbackSid) {
          console.log('[agentshire] fallback: batch complete, scheduling nudge');
          scheduleNudge(fallbackSid);
        }
      }
    });
    if (label) onAgentStarted(label);
  });

  api.on("subagent_ended", (event: any, ctx: any) => {
    const trackedLabel = getLabelForSession(event as Record<string, unknown>);
    dispatchSteward("subagent_ended", event as any, ctx);
    onSubagentEnded(event as Record<string, unknown>);
    const label = trackedLabel ?? String(event.label ?? event.displayName ?? "");
    const success = String(event.outcome ?? "ok") !== "error";
    if (label) {
      console.log(`[agentshire] subagent_ended: label="${label}" success=${success}`);
      onAgentCompleted(label, success);
    }

    const childKey = String(event.targetSessionKey ?? "");
    if (childKey) {
      const sid = resolveSessionId(ctx, event as any);
      if (sid) {
        setTimeout(() => pushSubagentCompletion(childKey, sid), 800);
      }
    }

    if (hasActivePlan() && isCurrentBatchDone()) {
      const sid = resolveSessionId(ctx, event as any);
      if (sid) {
        console.log('[agentshire] batch complete detected, scheduling nudge in', NUDGE_DELAY_MS, 'ms');
        scheduleNudge(sid);
      }
    }
  });

  api.on("session_start", (event: any, ctx: any) => {
    if (!isStewardDirect(ctx)) return;
    const sid = resolveSessionId(ctx, event as any);
    if (sid) clearEventBuffer(sid);
    if (sid) {
      cleanupStaleSessionPlans(sid);
      setTimeout(() => pushNewChatMessages(sid), 200);
    }
    dispatchSteward("before_agent_start", {
      ...(event as any),
      sessionId: (ctx as any)?.sessionId ?? (event as any).sessionId ?? `oc-${Date.now()}`,
      model: (event as any).model ?? "default",
    }, ctx);
  });

  api.on("session_end", (event: any, ctx: any) => {
    if (!isStewardDirect(ctx)) return;
    dispatchSteward("session_end", event as any, ctx);
    clearPlan();
    cancelNudge();
  });

  api.on("message_sending", (event: any, ctx: any) => {
    if (!isStewardDirect(ctx)) return;
    dispatchSteward("message_sending", event as any, ctx);
  });
}

export default {
  id: "agentshire",
  name: "Agentshire",
  description: "OpenClaw plugin for building a living 3D town with social NPCs, a map editor, and a character workshop.",
  register(api: any) {
    setTownRuntime(api.runtime);
    initStateDir(api.runtime.config);
    api.registerChannel(agentTownPlugin);
    registerHooks(api);
    api.registerTool(createTownTools());

    import("./src/plugin/auto-config.js")
      .then((m) => m.ensureTownAgentConfig())
      .catch((err) => console.error("[agentshire] auto-config failed:", err));

    api.on("subagent_spawning", async (event: any) => {
      try {
        const soulId = event.soul || event.persona || event.label;
        if (soulId) {
          const { loadTownSoul } = await import("./src/town-souls.js");
          const { join } = await import("node:path");
          const { fileURLToPath } = await import("node:url");
          const pluginDir = join(fileURLToPath(import.meta.url), "..");
          const townSoul = loadTownSoul(soulId, pluginDir);
          if (townSoul.soul) return { prependSystemContext: townSoul.soul };
        }
      } catch (err) {
        console.error("[agentshire] Failed to load citizen soul:", err);
      }
    });

    // Start HTTP frontend server eagerly during plugin init
    // (registerService.start() may not be called in all OpenClaw versions)
    if (!httpServer) {
      const townPort = ((api.pluginConfig as Record<string, unknown> | undefined)?.townPort as number) ?? 55210;
      try {
        const pluginDir = _dirname(_fu(import.meta.url));
        const distDir = _join(pluginDir, "town-frontend", "dist");
        if (!_exists(distDir)) {
          console.log(`[agentshire] Town frontend not built yet. Run: cd ${_join(pluginDir, "town-frontend")} && npm run build`);
        } else {
          ensureEditorDirs(pluginDir);
          const server = createServer(async (req, res) => {
            let urlPath = new URL(req.url ?? "/", `http://localhost:${townPort}`).pathname;
            if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

            // Editor routes: ext-assets, citizen-workshop, custom-assets
            if (await handleEditorRequest(req, res, pluginDir)) return;

            // Steward workspace: projects & tasks
            const stewardPrefix = "/steward-workspace/";
            if (urlPath.startsWith(stewardPrefix)) {
              const { stateDir } = await import("./src/plugin/paths.js");
              const relPath = decodeURIComponent(urlPath.slice(stewardPrefix.length));
              const wsFile = join(stateDir(), "workspace-town-steward", relPath);
              if (existsSync(wsFile) && statSync(wsFile).isFile()) {
                const ext = wsFile.substring(wsFile.lastIndexOf("."));
                res.writeHead(200, {
                  "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
                  "Access-Control-Allow-Origin": "*",
                });
                res.end(_read(wsFile));
                return;
              }
            }

            // Fallback: serve from dist/
            const filePath = _join(distDir, decodeURIComponent(urlPath));
            if (_exists(filePath) && _stat(filePath).isFile()) {
              const ext = filePath.substring(filePath.lastIndexOf("."));
              res.writeHead(200, {
                "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(_read(filePath));
              return;
            }

            // SPA fallback for HTML pages
            const htmlFile = urlPath.endsWith(".html") ? _join(distDir, urlPath) : null;
            if (htmlFile && _exists(htmlFile)) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(_read(htmlFile));
              return;
            }
            const indexPath = _join(distDir, "index.html");
            if (_exists(indexPath)) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(_read(indexPath));
            } else {
              res.writeHead(404);
              res.end("Not Found");
            }
          });
          httpServer = server;
          server.listen(townPort, () => console.log(`[agentshire] HTTP server listening on port ${townPort}`));
          server.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
              console.error(`[agentshire] ❌ HTTP port ${townPort} is already in use.`);
              console.error(`[agentshire]    Fix: stop the process using this port, or change townPort in openclaw.json`);
            } else {
              console.error("[agentshire] Frontend server error:", err);
            }
          });
        }
      } catch (err) {
        console.error("[agentshire] Failed to start town frontend server:", err);
      }
    }

    // Register process-level cleanup for graceful shutdown
    const cleanup = () => {
      stopAllWatchers();
      if (httpServer) {
        httpServer.close();
        httpServer = null;
      }
      cancelNudge();
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  },

  deregister() {
    stopAllWatchers();
    if (httpServer) {
      httpServer.close(() => console.log("[agentshire] HTTP server closed."));
      httpServer = null;
    }
    cancelNudge();
    console.log("[agentshire] Plugin deregistered, resources cleaned up.");
  },
};
