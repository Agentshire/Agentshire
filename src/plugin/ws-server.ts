import { WebSocketServer, WebSocket } from "ws";
import type { AgentEvent } from "../contracts/events.js";
import { sanitizeTownSessionId } from "./town-session.js";
import { getActivityLogForAgent, type ActivityLogEntry } from "./subagent-tracker.js";
import type { CustomAssetManager } from "./custom-asset-manager.js";
import { loadChatHistory, loadNewMessages, getCurrentSessionId, invalidateSessionCache, loadCitizenHistory, loadCitizenNewMessages, loadSubagentFinalMessage, loadChatItemHistory, loadCitizenItemHistory } from "./session-history.js";
import { ChatSessionWatcher } from "./chat-session-watcher.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "./paths.js";

export interface TownWsServerOptions {
  port: number;
  customAssetManager?: CustomAssetManager;
  onAction?: (payload: {
    action: Record<string, unknown>;
    townSessionId: string;
  }) => void;
  onChat?: (payload: { message: string; townSessionId: string }) => void;
  onMultimodal?: (payload: {
    parts: Array<{ kind: string; text?: string; data?: string; mimeType?: string; fileName?: string }>;
    townSessionId: string;
    agentId?: string;
    npcId?: string;
  }) => void;
  onImplicitChat?: (payload: {
    id: string;
    system: string;
    user: string;
    maxTokens: number;
    temperature: number;
    stop: string[];
  }) => Promise<{ text: string; usage?: { input: number; output: number } }>;
  onCitizenChat?: (payload: { npcId: string; message: string; townSessionId: string }) => void;
  onTopicStart?: (payload: { npcIds: string[]; townSessionId: string }) => void;
  onTopicMessage?: (payload: { npcIds: string[]; message: string; townSessionId: string }) => void;
  onTopicEnd?: (payload: { townSessionId: string }) => void;
}

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const clientSessions = new Map<WebSocket, string>();
const clientChatWatchers = new Map<WebSocket, ChatSessionWatcher>();
const clientChatBindings = new Map<WebSocket, { townSessionId: string; agentId: string }>();
const clientChatRetryTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
const coldStartBindings = new Set<WebSocket>();
let activeTownSessionId: string | undefined;
let customAssetMgr: CustomAssetManager | undefined;

/** Mutable holder for WS callbacks — allows hot-updating after eager startup. */
let liveCallbacks: Omit<TownWsServerOptions, "port" | "customAssetManager"> = {};

function getPublishedConfigPath(): string {
  const pluginDir = join(fileURLToPath(import.meta.url), "..", "..", "..");
  return join(pluginDir, "town-data", "citizen-config.json");
}

export function findCitizenNpcId(agentId: string): string | null {
  return findCitizenNpcIdByAgentId(agentId);
}

function findCitizenNpcIdByAgentId(agentId: string): string | null {
  try {
    const configPath = getPublishedConfigPath();
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const characters: any[] = config.characters ?? [];
    const citizen = characters.find(
      (entry: any) => entry?.role === "citizen" && entry?.agentEnabled && entry?.agentId === agentId,
    );
    return typeof citizen?.id === "string" && citizen.id ? citizen.id : null;
  } catch {
    return null;
  }
}

export function getActiveTownSessionId(): string | undefined {
  return activeTownSessionId;
}

interface WorkSnapshotAgent {
  id: string;
  displayName: string;
  task: string;
  status: "pending" | "working" | "completed" | "failed";
}

interface WorkSnapshot {
  phase: "working";
  stewardPersona?: string;
  agents: WorkSnapshotAgent[];
}

const workSnapshots = new Map<string, WorkSnapshot>();

function sessionLogPrefix(townSessionId: string): string {
  return `[agentshire][session:${townSessionId}]`;
}

function cloneWorkSnapshot(snapshot: WorkSnapshot): WorkSnapshot {
  return {
    phase: snapshot.phase,
    stewardPersona: snapshot.stewardPersona,
    agents: snapshot.agents.map((agent) => ({ ...agent })),
  };
}

function normalizeDoneStatus(status: string): WorkSnapshotAgent["status"] {
  if (status === "completed") return "completed";
  return "failed";
}

function getWorkSnapshot(townSessionId: string): WorkSnapshot | null {
  return workSnapshots.get(townSessionId) ?? null;
}

function setWorkSnapshot(townSessionId: string, snapshot: WorkSnapshot | null): void {
  if (!snapshot) {
    workSnapshots.delete(townSessionId);
    return;
  }
  workSnapshots.set(townSessionId, snapshot);
}

function updateWorkSnapshot(townSessionId: string, event: AgentEvent): void {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        const existing = getWorkSnapshot(townSessionId);
        if (!existing?.agents.some(a => a.status === "working")) {
          setWorkSnapshot(townSessionId, null);
        }
      } else if (event.subtype === "done") {
        setWorkSnapshot(townSessionId, null);
      }
      return;

    case "sub_agent":
      if (event.subtype === "started") {
        const snapshot = getWorkSnapshot(townSessionId)
          ? cloneWorkSnapshot(getWorkSnapshot(townSessionId)!)
          : { phase: "working" as const, agents: [] };
        const existingIdx = snapshot.agents.findIndex((agent) => agent.id === event.agentId);
        const nextAgent: WorkSnapshotAgent = {
          id: event.agentId,
          displayName: event.displayName ?? event.agentId,
          task: event.task,
          status: "working",
        };
        if (existingIdx >= 0) snapshot.agents[existingIdx] = nextAgent;
        else snapshot.agents.push(nextAgent);
        setWorkSnapshot(townSessionId, snapshot);
        return;
      }

      if (event.subtype === "done" && getWorkSnapshot(townSessionId)) {
        const snapshot = cloneWorkSnapshot(getWorkSnapshot(townSessionId)!);
        const agent = snapshot.agents.find((item) => item.id === event.agentId);
        if (!agent) return;
        agent.status = normalizeDoneStatus(event.status);
        setWorkSnapshot(townSessionId, snapshot);
      }
      return;

    default:
      return;
  }
}

function getClientSessionId(ws: WebSocket): string {
  return clientSessions.get(ws) ?? "default";
}

function sendWorkSnapshot(ws: WebSocket, townSessionId: string): void {
  const snapshot = getWorkSnapshot(townSessionId);
  if (ws.readyState !== WebSocket.OPEN) return;

  let enrichedSnapshot: any = snapshot ?? null;
  if (snapshot?.agents.length) {
    enrichedSnapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) => ({
        ...agent,
        activityLog: getActivityLogForAgent(agent.id),
      })),
    };
  }

  ws.send(
    JSON.stringify({
      type: "work_snapshot",
      townSessionId,
      snapshot: enrichedSnapshot,
    }),
  );
  if (snapshot?.agents.length) {
    console.log(
      `[agentshire] Sent work snapshot (${snapshot.agents.length} agents) for ${townSessionId}`,
    );
  }
}

function handleCustomAssetMessage(ws: WebSocket, msg: any): boolean {
  if (!customAssetMgr) return false;
  const send = (data: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  switch (msg.type) {
    case "custom_asset_list": {
      const assets = customAssetMgr.listAssets(msg.kind);
      send({ type: "custom_asset_catalog", assets });
      return true;
    }
    case "custom_asset_upload": {
      const result = customAssetMgr.saveAsset({
        kind: msg.kind ?? "model",
        name: msg.name ?? "未命名",
        data: msg.data,
        cells: msg.cells,
        scale: msg.scale,
        assetType: msg.assetType,
        fixRotationX: msg.fixRotationX,
        fixRotationY: msg.fixRotationY,
        fixRotationZ: msg.fixRotationZ,
        thumbnail: msg.thumbnail,
      });
      if ("error" in result) {
        send({ type: "custom_asset_error", message: result.error });
      } else {
        send({ type: "custom_asset_saved", asset: result });
      }
      return true;
    }
    case "custom_asset_update": {
      const result = customAssetMgr.updateAsset(msg.id, {
        name: msg.name,
        cells: msg.cells,
        scale: msg.scale,
        assetType: msg.assetType,
        fixRotationX: msg.fixRotationX,
        fixRotationY: msg.fixRotationY,
        fixRotationZ: msg.fixRotationZ,
        thumbnail: msg.thumbnail,
      });
      if ("error" in result) {
        send({ type: "custom_asset_error", message: result.error });
      } else {
        send({ type: "custom_asset_saved", asset: result });
      }
      return true;
    }
    case "custom_asset_delete": {
      const result = customAssetMgr.deleteAsset(msg.id);
      if (result.success) {
        send({ type: "custom_asset_deleted", id: msg.id });
      } else {
        send({ type: "custom_asset_error", message: result.error ?? "删除失败" });
      }
      return true;
    }
    default:
      return false;
  }
}

function resolveChatTranscriptPath(townSessionId: string, agentId: string): string | null {
  try {
    if (agentId === "steward") {
      const storeDir = join(stateDir(), "agents", "town-steward", "sessions");
      const indexPath = join(storeDir, "sessions.json");
      if (!existsSync(indexPath)) return null;
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      const newKey = `agent:town-steward:town:default:${townSessionId}`;
      const legacyKey = `town:default:${townSessionId}`;
      const entry = (index[newKey] ?? index[legacyKey]) as any;
      if (!entry?.sessionId) return null;
      const fp = join(storeDir, `${entry.sessionId}.jsonl`);
      return existsSync(fp) ? fp : null;
    }
    const storeDir = join(stateDir(), "agents", agentId, "sessions");
    const indexPath = join(storeDir, "sessions.json");
    if (!existsSync(indexPath)) return null;
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    const exactKey = `agent:${agentId}:${townSessionId}`;
    const exactEntry = index[exactKey] as any;
    if (exactEntry?.sessionId) {
      const fp = join(storeDir, `${exactEntry.sessionId}.jsonl`);
      if (existsSync(fp)) return fp;
    }
    return null;
  } catch {
    return null;
  }
}

function clearChatWatcherRetry(ws: WebSocket): void {
  const timer = clientChatRetryTimers.get(ws);
  if (timer) {
    clearTimeout(timer);
    clientChatRetryTimers.delete(ws);
  }
}

function scheduleChatWatcherRetry(ws: WebSocket): void {
  clearChatWatcherRetry(ws);
  const binding = clientChatBindings.get(ws);
  if (!binding) return;
  const timer = setTimeout(() => {
    clientChatRetryTimers.delete(ws);
    const current = clientChatBindings.get(ws);
    if (!current || clientChatWatchers.has(ws)) return;
    tryStartChatWatcher(ws, current.townSessionId, current.agentId);
  }, 400);
  clientChatRetryTimers.set(ws, timer);
}

function tryStartChatWatcher(ws: WebSocket, townSessionId: string, agentId: string): boolean {
  const transcriptPath = resolveChatTranscriptPath(townSessionId, agentId);
  if (!transcriptPath) {
    console.log(`${sessionLogPrefix(townSessionId)} Chat watcher: no transcript yet for ${agentId}`);
    coldStartBindings.add(ws);
    scheduleChatWatcherRetry(ws);
    return false;
  }
  clearChatWatcherRetry(ws);
  const isColdStart = coldStartBindings.has(ws);
  coldStartBindings.delete(ws);
  const existing = clientChatWatchers.get(ws);
  if (existing) existing.stop();
  const watcher = new ChatSessionWatcher(transcriptPath, agentId, (items) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "chat_delta", agentId, items }));
    }
  });
  clientChatWatchers.set(ws, watcher);
  watcher.start(isColdStart);
  console.log(`${sessionLogPrefix(townSessionId)} Chat watcher started for ${agentId} (coldStart=${isColdStart})`);
  return true;
}

export function retryChatWatchersForBinding(townSessionId: string, agentId: string): void {
  for (const [ws, binding] of clientChatBindings) {
    if (binding.townSessionId !== townSessionId || binding.agentId !== agentId) continue;
    const existing = clientChatWatchers.get(ws);
    if (existing) continue;
    tryStartChatWatcher(ws, townSessionId, agentId);
  }
}

export function startTownWsServer(opts: TownWsServerOptions): void {
  if (wss) return;
  customAssetMgr = opts.customAssetManager;

  // Store initial callbacks in the mutable holder so they can be hot-updated later.
  const { port: _port, customAssetManager: _cam, ...callbacks } = opts;
  Object.assign(liveCallbacks, callbacks);

  wss = new WebSocketServer({ port: opts.port });
  console.log(`[agentshire] WebSocket server listening on ws://localhost:${opts.port}`);

  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[agentshire] ❌ WebSocket port ${opts.port} is already in use.`);
      console.error(`[agentshire]    Fix: stop the process using this port, or change wsPort in openclaw.json:`);
      console.error(`[agentshire]    { "plugins": { "entries": { "agentshire": { "config": { "wsPort": ${opts.port + 1} } } } } }`);
    } else {
      console.error("[agentshire] WebSocket server error:", err);
    }
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[agentshire] Town frontend connected (${clients.size} total)`);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));

        if (msg.type === "town_session_init" && typeof msg.townSessionId === "string") {
          const townSessionId = sanitizeTownSessionId(msg.townSessionId);
          clientSessions.set(ws, townSessionId);
          activeTownSessionId = townSessionId;
          console.log(`${sessionLogPrefix(townSessionId)} WS bound to frontend connection`);
          if (ws.readyState === WebSocket.OPEN) {
            let modelName: string | undefined;
            try {
              const { getTownRuntime } = require("./runtime.js") as typeof import("./runtime.js");
              const rt = getTownRuntime();
              const cfg = typeof (rt.config as any)?.loadConfig === "function" ? (rt.config as any).loadConfig() : rt.config;
              modelName = cfg?.agents?.defaults?.model?.primary;
            } catch {}
            ws.send(JSON.stringify({ type: "town_session_bound", townSessionId, ...(modelName ? { model: modelName } : {}) }));
          }
          sendWorkSnapshot(ws, townSessionId);
        } else if (msg.type === "chat_agent_bind" && typeof msg.agentId === "string") {
          const townSessionId = getClientSessionId(ws);
          const agentId = msg.agentId;
          console.log(`${sessionLogPrefix(townSessionId)} WS ← chat_agent_bind agentId=${agentId}`);

          const oldWatcher = clientChatWatchers.get(ws);
          if (oldWatcher) { oldWatcher.stop(); clientChatWatchers.delete(ws); }
          clearChatWatcherRetry(ws);

          clientChatBindings.set(ws, { townSessionId, agentId });

          tryStartChatWatcher(ws, townSessionId, agentId);
        } else if (msg.type === "chat") {
          const townSessionId = getClientSessionId(ws);
          console.log(
            `${sessionLogPrefix(townSessionId)} WS ← chat ${JSON.stringify(msg).slice(0, 200)}`,
          );
          // DirectorBridge sends { type:'chat', body:[{kind:'text',text:'...'}] }
          // InputBar may also send { type:'chat', message:'...' }
          if (Array.isArray(msg.body)) {
            const textParts = msg.body
              .filter((p: any) => p.kind === "text" && p.text)
              .map((p: any) => p.text)
              .join(" ");
            if (textParts) liveCallbacks.onChat?.({ message: textParts, townSessionId });
          } else if (typeof msg.message === "string") {
            liveCallbacks.onChat?.({ message: msg.message, townSessionId });
          }
        } else if (msg.type === "multimodal" && Array.isArray(msg.parts)) {
          const townSessionId = getClientSessionId(ws);
          console.log(
            `${sessionLogPrefix(townSessionId)} WS ← multimodal parts=${msg.parts.length}`,
          );
          liveCallbacks.onMultimodal?.({
            parts: msg.parts,
            townSessionId,
            ...(typeof msg.agentId === "string" ? { agentId: msg.agentId } : {}),
            ...(typeof msg.npcId === "string" ? { npcId: msg.npcId } : {}),
          });
        } else if (handleCustomAssetMessage(ws, msg)) {
          // handled by custom asset manager
        } else if (msg.type === "citizen_chat" && typeof msg.npcId === "string" && typeof msg.message === "string") {
          const townSessionId = getClientSessionId(ws);
          const _debug = process.env.AGENTSHIRE_DEBUG === "1";
          console.log(
            `${sessionLogPrefix(townSessionId)} WS ← citizen_chat npc=${msg.npcId} len=${String(msg.message).length}${_debug ? ` "${String(msg.message).slice(0, 80)}"` : ""}`,
          );
          liveCallbacks.onCitizenChat?.({ npcId: msg.npcId, message: msg.message, townSessionId });
        } else if (msg.type === "topic_start" && Array.isArray(msg.npcIds)) {
          const townSessionId = getClientSessionId(ws);
          console.log(`${sessionLogPrefix(townSessionId)} WS ← topic_start npcIds=[${msg.npcIds.join(",")}]`);
          liveCallbacks.onTopicStart?.({ npcIds: msg.npcIds, townSessionId });
        } else if (msg.type === "topic_message" && Array.isArray(msg.npcIds) && typeof msg.message === "string") {
          const townSessionId = getClientSessionId(ws);
          console.log(`${sessionLogPrefix(townSessionId)} WS ← topic_message npcIds=[${msg.npcIds.join(",")}] len=${msg.message.length}`);
          liveCallbacks.onTopicMessage?.({ npcIds: msg.npcIds, message: msg.message, townSessionId });
        } else if (msg.type === "topic_end") {
          const townSessionId = getClientSessionId(ws);
          console.log(`${sessionLogPrefix(townSessionId)} WS ← topic_end`);
          liveCallbacks.onTopicEnd?.({ townSessionId });
        } else if (msg.type === "implicit_chat_request" && typeof msg.id === "string" && liveCallbacks.onImplicitChat) {
          const townSessionId = getClientSessionId(ws);
          liveCallbacks.onImplicitChat({
            id: msg.id,
            system: String(msg.system ?? ""),
            user: String(msg.user ?? ""),
            maxTokens: Number(msg.maxTokens ?? 200),
            temperature: Number(msg.temperature ?? 0.85),
            stop: Array.isArray(msg.stop) ? msg.stop.map(String) : [],
          }).then((result) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "implicit_chat_response", id: msg.id, text: result.text, usage: result.usage }));
            }
          }).catch((err) => {
            console.warn(`${sessionLogPrefix(townSessionId)} implicit_chat error:`, (err as Error).message);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "implicit_chat_response", id: msg.id, text: "", error: (err as Error).message }));
            }
          });
        } else if (msg.type === "chat_history_request") {
          const townSessionId = getClientSessionId(ws);
          const limit = typeof msg.limit === "number" ? msg.limit : 50;
          const cursor = typeof msg.cursor === "string" ? msg.cursor : undefined;
          const agentId = typeof msg.agentId === "string" ? msg.agentId : undefined;
          const format = typeof msg.format === "string" ? msg.format : "messages";
          console.log(`${sessionLogPrefix(townSessionId)} WS ← chat_history_request agentId=${agentId ?? "steward"} limit=${limit} format=${format} cursor=${cursor ?? "latest"}`);

          if (format === "items") {
            const result = (agentId && agentId !== "steward")
              ? loadCitizenItemHistory(agentId, limit)
              : loadChatItemHistory(limit, cursor);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "chat_history",
                agentId: agentId ?? "steward",
                format: "items",
                items: result.items,
                hasMore: result.hasMore,
                cursor: result.cursor,
              }));
            }
          } else {
            const result = (agentId && agentId !== "steward")
              ? loadCitizenHistory(agentId, limit)
              : loadChatHistory(limit, cursor);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "chat_history",
                agentId: agentId ?? "steward",
                messages: result.messages,
                hasMore: result.hasMore,
                cursor: result.cursor,
              }));
            }
          }
        } else if (msg.type === "command" && typeof msg.command === "string") {
          const townSessionId = getClientSessionId(ws);
          const slashText = `/${msg.command}${msg.args ? " " + msg.args : ""}`;
          console.log(`${sessionLogPrefix(townSessionId)} WS ← command "${slashText}"`);
          liveCallbacks.onChat?.({ message: slashText, townSessionId });
        } else if (msg.type === "abort") {
          const townSessionId = getClientSessionId(ws);
          console.log(`${sessionLogPrefix(townSessionId)} WS ← abort`);
          liveCallbacks.onAction?.({
            action: { type: "abort_requested" },
            townSessionId,
          });
        } else {
          const townSessionId = getClientSessionId(ws);
          console.log(
            `${sessionLogPrefix(townSessionId)} WS ← action type=${String(msg?.type ?? "unknown")}`,
          );
          liveCallbacks.onAction?.({ action: msg, townSessionId });
        }
      } catch (err) {
        console.error("[agentshire] WS message parse error:", err);
      }
    });

    ws.on("close", () => {
      const watcher = clientChatWatchers.get(ws);
      if (watcher) { watcher.stop(); clientChatWatchers.delete(ws); }
      clearChatWatcherRetry(ws);
      coldStartBindings.delete(ws);
      clientChatBindings.delete(ws);
      clientSessions.delete(ws);
      clients.delete(ws);
      console.log(`[agentshire] Town frontend disconnected (${clients.size} remaining)`);
    });
  });
}

/**
 * Hot-update WS callbacks after the server has already started.
 * Only provided callbacks are merged; omitted ones keep their current value.
 * This allows `gateway.startAccount()` to inject the full set of callbacks
 * even when the WS server was started eagerly during `register()`.
 */
export function updateTownWsCallbacks(
  callbacks: Partial<Omit<TownWsServerOptions, "port" | "customAssetManager">>,
): void {
  Object.assign(liveCallbacks, callbacks);
  console.log(
    `[agentshire] WS callbacks updated: ${Object.keys(callbacks).join(", ")}`,
  );
}

export function stopTownWsServer(): void {
  if (!wss) return;
  for (const watcher of clientChatWatchers.values()) watcher.stop();
  clientChatWatchers.clear();
  for (const timer of clientChatRetryTimers.values()) clearTimeout(timer);
  clientChatRetryTimers.clear();
  clientChatBindings.clear();
  for (const ws of clients) ws.close();
  clients.clear();
  clientSessions.clear();
  workSnapshots.clear();
  citizenMessageCounts.clear();
  lastPushHash = "";
  wss.close();
  wss = null;
  console.log("[agentshire] WebSocket server stopped");
}

/**
 * Broadcast an AgentEvent to all connected town frontends.
 * Wraps in `{ type: 'agent_event', event }` for the frontend WS protocol.
 */
export function broadcastAgentEvent(event: AgentEvent, townSessionId?: string): void {
  if (townSessionId) {
    updateWorkSnapshot(townSessionId, event);
    console.log(
      `${sessionLogPrefix(townSessionId)} WS → agent_event type=${event.type}${"subtype" in event ? `/${String((event as { subtype: string }).subtype)}` : ""}`,
    );
  }

  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: "agent_event", event });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && (!townSessionId || getClientSessionId(ws) === townSessionId)) {
      ws.send(payload);
    }
  }
}


export function getConnectedClientCount(): number {
  return clients.size;
}

let lastPushHash = "";

export function pushNewChatMessages(townSessionId: string): void {
  invalidateSessionCache();
  const messages = loadNewMessages();
  if (messages.length === 0) return;

  const latest = messages.slice(-10);
  const hash = latest.map(m => `${m.role}:${m.timestamp}:${m.text.slice(0, 50)}`).join("|");
  if (hash === lastPushHash) return;
  lastPushHash = hash;
  console.log(`${sessionLogPrefix(townSessionId)} WS → chat_new_messages agentId=steward count=${latest.length}`);

  const payload = JSON.stringify({
    type: "chat_new_messages",
    agentId: "steward",
    messages: latest,
  });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && getClientSessionId(ws) === townSessionId) {
      ws.send(payload);
    }
  }
}

const citizenMessageCounts = new Map<string, number>();

export function pushCitizenMessages(agentId: string, townSessionId: string): void {
  const messages = loadCitizenNewMessages(agentId);
  if (messages.length === 0) return;
  const countKey = `${townSessionId}:${agentId}`;
  const prevCount = citizenMessageCounts.get(countKey) ?? 0;
  if (messages.length === prevCount) return;

  const nextMessages =
    messages.length > prevCount
      ? messages.slice(prevCount)
      : messages.slice(-5);
  citizenMessageCounts.set(countKey, messages.length);

  const npcId = findCitizenNpcIdByAgentId(agentId) ?? undefined;
  console.log(
    `${sessionLogPrefix(townSessionId)} WS → chat_new_messages agentId=${agentId} npcId=${npcId ?? "unknown"} count=${nextMessages.length}`,
  );

  const payload = JSON.stringify({
    type: "chat_new_messages",
    agentId,
    ...(npcId ? { npcId } : {}),
    messages: nextMessages,
  });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && getClientSessionId(ws) === townSessionId) {
      ws.send(payload);
    }
  }
}

export function pushSubagentCompletion(childSessionKey: string, townSessionId: string): void {
  try {
    const msg = loadSubagentFinalMessage(childSessionKey);
    if (!msg || !msg.text) return;

    console.log(`${sessionLogPrefix(townSessionId)} WS → chat_new_messages (subagent completion) text="${msg.text.slice(0, 60)}"`);

    invalidateSessionCache();
    const allMessages = loadNewMessages();
    allMessages.push(msg);
    allMessages.sort((a, b) => a.timestamp - b.timestamp);
    const latest = allMessages.slice(-10);
    const hash = latest.map(m => `${m.role}:${m.timestamp}:${m.text.slice(0, 50)}`).join("|");
    lastPushHash = hash;

    const payload = JSON.stringify({
      type: "chat_new_messages",
      agentId: "steward",
      messages: latest,
    });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN && getClientSessionId(ws) === townSessionId) {
        ws.send(payload);
      }
    }
  } catch (err) {
    console.warn(`[agentshire] pushSubagentCompletion error:`, (err as Error).message);
  }
}

export function clearEventBuffer(townSessionId?: string): void {
  if (townSessionId) {
    workSnapshots.delete(townSessionId);
    return;
  }
  workSnapshots.clear();
}
