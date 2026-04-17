import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { stateDir } from "./paths.js";

const AGENT_ID = "town-steward";
const CHANNEL_ID = "agentshire";
const TEMPLATE_DIR = "town-workspace";

function getPluginDir(): string {
  return join(fileURLToPath(import.meta.url), "../../..");
}

function ensureTownWorkspace(): string {
  const agentDir = join(stateDir(), `workspace-${AGENT_ID}`);
  const templateDir = join(getPluginDir(), TEMPLATE_DIR);
  if (!existsSync(templateDir)) {
    console.warn(
      `[agentshire] Template workspace not found at ${templateDir}`,
    );
    return agentDir;
  }

  mkdirSync(agentDir, { recursive: true });

  const pluginDir = getPluginDir();
  const SDK_DEFAULT_MARKERS = [
    "# SOUL.md - Who You Are",
    "# IDENTITY.md - Who Am I?",
  ];
  for (const file of readdirSync(templateDir)) {
    const src = join(templateDir, file);
    const dst = join(agentDir, file);
    if (!existsSync(dst)) {
      copyFileSync(src, dst);
    } else {
      const existing = readFileSync(dst, "utf-8");
      if (SDK_DEFAULT_MARKERS.some((m) => existing.startsWith(m))) {
        copyFileSync(src, dst);
      }
    }
  }

  const defaultsPath = join(agentDir, "town-defaults.json");
  if (existsSync(defaultsPath)) {
    try {
      const data = JSON.parse(readFileSync(defaultsPath, "utf-8"));
      const resolve = (p: string) => p && !p.startsWith("/") ? join(pluginDir, p) : p;
      if (data.steward) data.steward.personaFile = resolve(data.steward.personaFile ?? "");
      if (Array.isArray(data.citizens)) {
        data.citizens = data.citizens.map((c: any) => ({ ...c, personaFile: resolve(c.personaFile ?? "") }));
      }
      writeFileSync(defaultsPath, JSON.stringify(data, null, 2), "utf-8");
    } catch {}
  }

  console.log(`[agentshire] Initialized workspace at ${agentDir}`);
  return agentDir;
}

export async function ensureTownAgentConfig(): Promise<void> {
  try {
    const configPath = join(stateDir(), "openclaw.json");
    if (!existsSync(configPath)) return;

    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);

    const agents: any[] = cfg.agents?.list ?? [];
    const hasAgent = agents.some((a: any) => a.id === AGENT_ID);

    const bindings: any[] = cfg.bindings ?? [];
    const hasBinding = bindings.some(
      (b: any) => b.match?.channel === CHANNEL_ID && b.agentId === AGENT_ID,
    );

    let dirty = false;
    const workspaceDir = ensureTownWorkspace();

    if (!hasAgent) {
      cfg.agents = cfg.agents ?? {};
      cfg.agents.list = cfg.agents.list ?? [];
      cfg.agents.list.push({
        id: AGENT_ID,
        name: "shire",
        workspace: workspaceDir,
        identity: { name: "shire", emoji: "🏘️" },
      });
      dirty = true;
    }

    if (!hasBinding) {
      cfg.bindings = cfg.bindings ?? [];
      cfg.bindings.push({
        type: "route",
        agentId: AGENT_ID,
        comment: "Route agentshire channel to dedicated steward agent",
        match: { channel: CHANNEL_ID },
      });
      dirty = true;
    }

    // Ensure channels.agentshire exists so Gateway calls startAccount()
    const channels = cfg.channels ?? {};
    if (!channels[CHANNEL_ID]) {
      cfg.channels = { ...channels, [CHANNEL_ID]: { enabled: true } };
      dirty = true;
    } else if (channels[CHANNEL_ID].enabled === false) {
      // Respect explicit disable — don't override
    }

    const DEFAULT_TIMEOUT = 600;
    const subagents = cfg.agents?.defaults?.subagents ?? {};
    if (!subagents.runTimeoutSeconds || subagents.runTimeoutSeconds < DEFAULT_TIMEOUT) {
      cfg.agents = cfg.agents ?? {};
      cfg.agents.defaults = cfg.agents.defaults ?? {};
      cfg.agents.defaults.subagents = {
        ...subagents,
        runTimeoutSeconds: Math.max(subagents.runTimeoutSeconds ?? 0, DEFAULT_TIMEOUT),
      };
      dirty = true;
    }

    // Warn if user has a manual tools.allow list — it overrides plugin-registered tools
    if (cfg.tools?.allow && Array.isArray(cfg.tools.allow)) {
      console.warn(
        `[agentshire] ⚠️  Detected manual "tools.allow" in openclaw.json. ` +
        `This overrides the 11 tools registered by the plugin (create_project, create_plan, etc.). ` +
        `If the agent reports "no tools available", remove the "tools" section from openclaw.json.`,
      );
    }

    if (!dirty) return;

    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    console.log(
      `[agentshire] Auto-configured ${AGENT_ID} agent + binding in openclaw.json`,
    );
  } catch (err) {
    console.error("[agentshire] Failed to auto-configure agent:", err);
  }
}
