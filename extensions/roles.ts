/**
 * Role Manager Extension
 *
 * Config-driven role switching for different workflows.
 * Roles defined in ~/.pi/agent/roles.json (global) or .pi/roles.json (project).
 *
 * Each role configures: thinking level, tools (allow/deny), and instructions.
 * Model is NOT switched — uses whatever defaultModel is set in settings.json.
 *
 * Usage:
 *   /role           → interactive selector
 *   /role dev       → switch directly
 *   /role list      → list all roles
 *   Ctrl+Shift+R    → cycle through roles
 *   pi --role dev   → start in a role
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolsConfig {
  /** Only these tools are enabled. Omit or use ["*"] to allow all. */
  enabled?: string[];
  /** These tools are explicitly disabled. Takes precedence over enabled. */
  disabled?: string[];
}

type InstructionMode = "append" | "replace" | "prefix";

interface Role {
  /** Human-readable description */
  description?: string;
  /** Parent role to inherit from */
  extends?: string;
  /** Thinking level */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Tool configuration */
  tools?: ToolsConfig;
  /** Instructions appended (or replace/prefix) to system prompt */
  instructions?: string;
  /** How instructions are applied to the system prompt */
  instructionMode?: InstructionMode;
  /** Custom system prompt to fully replace the default */
  systemPrompt?: string;
}

interface RolesConfig {
  [name: string]: Role;
}

interface Snapshot {
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools: string[];
}

// ─── Config Loading ──────────────────────────────────────────────────────────

function resolveRole(name: string, roles: RolesConfig, visited: Set<string> = new Set()): Role | undefined {
  const raw = roles[name];
  if (!raw) return undefined;
  if (visited.has(name)) {
    console.error(`Circular role inheritance detected: ${name}`);
    return undefined;
  }
  if (!raw.extends) return raw;

  visited.add(name);
  const parent = resolveRole(raw.extends, roles, visited);
  if (!parent) return raw;

  return {
    ...parent,
    ...raw,
    tools: {
      ...(parent.tools ?? {}),
      ...(raw.tools ?? {}),
      enabled: raw.tools?.enabled ?? parent.tools?.enabled,
      disabled: [...new Set([...(parent.tools?.disabled ?? []), ...(raw.tools?.disabled ?? [])])],
    },
  };
}

function loadRoles(cwd: string): RolesConfig {
  const globalPath = join(getAgentDir(), "roles.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "roles.json");

  let globalRoles: RolesConfig = {};
  let projectRoles: RolesConfig = {};

  if (existsSync(globalPath)) {
    try {
      globalRoles = JSON.parse(readFileSync(globalPath, "utf-8"));
    } catch (err) {
      console.error(`Failed to load roles from ${globalPath}: ${err}`);
    }
  }

  if (existsSync(projectPath)) {
    try {
      projectRoles = JSON.parse(readFileSync(projectPath, "utf-8"));
    } catch (err) {
      console.error(`Failed to load roles from ${projectPath}: ${err}`);
    }
  }

  return { ...globalRoles, ...projectRoles };
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function rolesExtension(api: ExtensionAPI) {
  let roles: RolesConfig = {};
  let activeRoleName: string | undefined;
  let activeRole: Role | undefined;
  let snapshot: Snapshot | undefined;

  // Register --role CLI flag
  api.registerFlag("role", {
    description: "Role to activate on startup",
    type: "string",
  });

  // ── Apply role ──────────────────────────────────────────────────────────

  async function applyRole(name: string, role: Role, ctx: ExtensionContext): Promise<void> {
    // Resolve inheritance
    const resolved = resolveRole(name, roles);
    if (!resolved) {
      ctx.ui.notify(`Role "${name}" not found`, "error");
      return;
    }
    role = resolved;

    // Snapshot before first role activation
    if (activeRoleName === undefined) {
      snapshot = {
        thinking: api.getThinkingLevel(),
        tools: api.getActiveTools(),
      };
    }

    // Apply thinking
    if (role.thinking) api.setThinkingLevel(role.thinking);

    // Apply tools
    if (role.tools) {
      const allToolNames = api.getAllTools().map((t: { name: string }) => t.name);

      if (role.tools.enabled && role.tools.enabled.length > 0 && !role.tools.enabled.includes("*")) {
        const target = allToolNames.filter(
          (t: string) => role.tools!.enabled!.includes(t) && !(role.tools!.disabled ?? []).includes(t)
        );
        api.setActiveTools(target);
      } else if (role.tools.disabled && role.tools.disabled.length > 0) {
        const target = allToolNames.filter((t: string) => !role.tools!.disabled!.includes(t));
        api.setActiveTools(target);
      }
    }

    activeRoleName = name;
    activeRole = role;
    updateStatus(ctx);
  }

  // ── Clear role ──────────────────────────────────────────────────────────

  async function clearRole(ctx: ExtensionContext): Promise<void> {
    activeRoleName = undefined;
    activeRole = undefined;
    if (snapshot) {
      api.setThinkingLevel(snapshot.thinking);
      api.setActiveTools(snapshot.tools);
    }
    updateStatus(ctx);
    ctx.ui.notify("Role cleared, defaults restored", "info");
  }

  // ── Status line ─────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext) {
    if (activeRoleName) {
      ctx.ui.setStatus("role", ctx.ui.theme.fg("accent", `role:${activeRoleName}`));
    } else {
      ctx.ui.setStatus("role", undefined);
    }
  }

  // ── Role description builder ────────────────────────────────────────────

  function describeRole(name: string, role: Role): string {
    const parts: string[] = [];
    if (role.thinking) parts.push(`thinking:${role.thinking}`);
    if (role.tools?.enabled && !role.tools.enabled.includes("*")) parts.push(`tools:${role.tools.enabled.join(",")}`);
    if (role.tools?.disabled?.length) parts.push(`no:${role.tools.disabled.join(",")}`);
    if (role.description) parts.push(role.description.slice(0, 50));
    if (role.extends) parts.push(`extends:${role.extends}`);
    return parts.join(" │ ");
  }

  // ── Selector UI ─────────────────────────────────────────────────────────

  async function showSelector(ctx: ExtensionContext): Promise<void> {
    const names = Object.keys(roles);
    if (names.length === 0) {
      ctx.ui.notify("No roles defined. Add roles to roles.json", "warning");
      return;
    }

    const items: SelectItem[] = names.map((n) => ({
      value: n,
      label: n === activeRoleName ? `${n} (active)` : n,
      description: describeRole(n, roles[n]),
    }));

    items.push({ value: "(clear)", label: "(clear role)", description: "Restore defaults" });

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Select Role"))));
      const list = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("warning", s),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
      };
    });

    if (!result) return;
    if (result === "(clear)") { await clearRole(ctx); return; }
    const role = roles[result];
    if (role) {
      await applyRole(result, role, ctx);
      ctx.ui.notify(`Role "${result}" activated`, "info");
    }
  }

  // ── /role command ───────────────────────────────────────────────────────

  api.registerCommand("role", {
    description: "Switch role: /role <name>, /role list, /role (no args shows selector)",
    getArgumentCompletions: (prefix: string) => {
      const names = Object.keys(roles);
      const matches = names.filter((n) => n.startsWith(prefix));
      return matches.length > 0 ? matches.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args?.trim();

      if (!trimmed) {
        await showSelector(ctx);
        return;
      }

      if (trimmed === "list") {
        const names = Object.keys(roles);
        if (names.length === 0) {
          ctx.ui.notify("No roles defined.", "info");
          return;
        }
        for (const n of names) {
          const r = roles[n];
          ctx.ui.notify(`${n}${n === activeRoleName ? " (active)" : ""} — ${describeRole(n, r)}`, "info");
        }
        return;
      }

      if (trimmed === "clear") {
        await clearRole(ctx);
        return;
      }

      const role = roles[trimmed];
      if (!role) {
        ctx.ui.notify(`Unknown role "${trimmed}". Use /role list`, "error");
        return;
      }

      await applyRole(trimmed, role, ctx);
      ctx.ui.notify(`Role "${trimmed}" activated`, "info");
    },
  });

  // ── Keyboard shortcut ───────────────────────────────────────────────────

  api.registerShortcut(Key.ctrlShift("r"), {
    description: "Cycle roles",
    handler: async (ctx) => {
      const names = Object.keys(roles);
      if (names.length === 0) return;
      const cycle = ["(clear)", ...names];
      const idx = activeRoleName ? cycle.indexOf(activeRoleName) : 0;
      const next = cycle[(idx + 1) % cycle.length];

      if (next === "(clear)") {
        await clearRole(ctx);
      } else {
        const role = roles[next];
        if (role) await applyRole(next, role, ctx);
        ctx.ui.notify(`Role "${next}" activated`, "info");
      }
    },
  });

  // ── Inject role instructions ────────────────────────────────────────────

  api.on("before_agent_start", async (event) => {
    if (!activeRole) return;

    if (activeRole.systemPrompt) {
      return { systemPrompt: activeRole.systemPrompt };
    }

    if (activeRole.instructions) {
      const mode = activeRole.instructionMode ?? "append";
      switch (mode) {
        case "replace":
          return { systemPrompt: activeRole.instructions };
        case "prefix":
          return { systemPrompt: `${activeRole.instructions}\n\n${event.systemPrompt}` };
        case "append":
        default:
          return { systemPrompt: `${event.systemPrompt}\n\n${activeRole.instructions}` };
      }
    }
  });

  // ── Startup ─────────────────────────────────────────────────────────────

  api.on("session_start", async (_event, ctx) => {
    roles = loadRoles(ctx.cwd);
    snapshot = {
      thinking: api.getThinkingLevel(),
      tools: api.getActiveTools(),
    };

    const flag = api.getFlag("role");
    if (typeof flag === "string" && flag) {
      const role = roles[flag];
      if (role) {
        await applyRole(flag, role, ctx);
        ctx.ui.notify(`Role "${flag}" activated (--role flag)`, "info");
      } else {
        ctx.ui.notify(`Unknown role "${flag}" from --role flag`, "warning");
      }
    } else {
      const entries = ctx.sessionManager.getEntries();
      const last = [...entries].reverse().find(
        (e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "role-state"
      ) as { data?: { name: string } } | undefined;
      if (last?.data?.name && roles[last.data.name]) {
        activeRoleName = last.data.name;
        activeRole = roles[last.data.name];
        updateStatus(ctx);
      }
    }
  });

  // ── Persist role state ──────────────────────────────────────────────────

  api.on("turn_start", async () => {
    if (activeRoleName) {
      api.appendEntry("role-state", { name: activeRoleName });
    }
  });
}
