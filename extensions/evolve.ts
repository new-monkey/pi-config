/**
 * Self-Evolution Extension
 *
 * Gives Pi a long-term memory about its own config changes.
 * Lessons persist globally across sessions in ~/.pi/agent/evolve/.
 *
 * Files:
 *   ~/.pi/agent/evolve/lessons.json   — stored lessons
 *   ~/.pi/agent/evolve/history.jsonl  — audit log
 *
 * Usage:
 *   /teach <lesson>       — explicitly teach Pi for future sessions
 *   /teach list           — see all stored lessons
 *   /teach forget <id>    — remove a specific lesson
 *   /evolve stats         — show evolution statistics
 *
 * The LLM can also call the evolve_learn tool to record lessons.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Lesson {
  id: string;
  timestamp: number;
  source: "user" | "llm";
  context: string;
  lesson: string;
  tags: string[];
  hitCount: number;
}

interface Config {
  maxLessons: number;
  injectLessons: boolean;
}

const DEFAULT_CONFIG: Config = { maxLessons: 25, injectLessons: true };

// ─── File helpers ────────────────────────────────────────────────────────────

let evolveDir: string;

function ensureDirs() {
  evolveDir = join(getAgentDir(), "evolve");
  if (!existsSync(evolveDir)) mkdirSync(evolveDir, { recursive: true });
}

function lessonsPath(): string {
  return join(evolveDir, "lessons.json");
}

function loadLessons(): Lesson[] {
  ensureDirs();
  try {
    if (!existsSync(lessonsPath())) return [];
    return JSON.parse(readFileSync(lessonsPath(), "utf-8"));
  } catch {
    return [];
  }
}

function saveLessons(lessons: Lesson[]) {
  ensureDirs();
  writeFileSync(lessonsPath(), JSON.stringify(lessons, null, 2) + "\n");
}

function appendHistory(entry: Record<string, unknown>) {
  ensureDirs();
  appendFileSync(
    join(evolveDir, "history.jsonl"),
    JSON.stringify({ ...entry, ts: Date.now() }) + "\n"
  );
}

function autoTags(text: string): string[] {
  const tags = new Set<string>();
  const lower = text.toLowerCase();
  if (/\b(extension|ext)\b/.test(lower)) tags.add("extension");
  if (/\b(role)\b/.test(lower)) tags.add("role");
  if (/\b(prompt|template)\b/.test(lower)) tags.add("prompt");
  if (/\b(skill)\b/.test(lower)) tags.add("skill");
  if (/\b(setting|config)\b/.test(lower)) tags.add("config");
  if (/\b(tool|command)\b/.test(lower)) tags.add("tool");
  if (/\b(workflow|method|pattern)\b/.test(lower)) tags.add("workflow");
  if (/\b(codebase|project|repo)\b/.test(lower)) tags.add("codebase");
  if (/\b(test|tdd)\b/.test(lower)) tags.add("testing");
  if (/\b(deploy|ops|ci)\b/.test(lower)) tags.add("deploy");
  return Array.from(tags);
}

// ─── The Extension ───────────────────────────────────────────────────────────

export default function evolveExtension(api: ExtensionAPI) {
  ensureDirs();

  let lessons: Lesson[] = loadLessons();
  let config: Config = { ...DEFAULT_CONFIG };

  // ── Teach ─────────────────────────────────────────────────────────────────

  function teach(
    lessonText: string,
    context: string,
    source: "user" | "llm",
    tags?: string[]
  ): Lesson {
    const lesson: Lesson = {
      id: randomUUID().slice(0, 8),
      timestamp: Date.now(),
      source,
      context: context.slice(0, 200),
      lesson: lessonText,
      tags: tags ?? autoTags(lessonText + " " + context),
      hitCount: 0,
    };

    lessons.push(lesson);

    // Evict least-used, preferring to keep user-taught
    while (lessons.length > config.maxLessons) {
      lessons.sort((a, b) => {
        if (a.source === "user" && b.source !== "user") return 1;
        if (a.source !== "user" && b.source === "user") return -1;
        return a.hitCount - b.hitCount;
      });
      const removed = lessons.shift()!;
      appendHistory({ type: "evict", id: removed.id, lesson: removed.lesson });
    }

    saveLessons(lessons);
    appendHistory({ type: "teach", id: lesson.id, source, lesson: lessonText });
    return lesson;
  }

  // ── /teach command ────────────────────────────────────────────────────────

  api.registerCommand("teach", {
    description: "Teach Pi a lesson: /teach <lesson>, /teach list, /teach forget <id>",
    handler: async (args, ctx) => {
      const t = args?.trim() ?? "";

      if (!t) {
        ctx.ui.notify("Usage: /teach <lesson> | /teach list | /teach forget <id>", "info");
        return;
      }

      if (t === "list") {
        if (lessons.length === 0) {
          ctx.ui.notify("No lessons stored yet.", "info");
          return;
        }
        const lines = lessons
          .map(
            (l) =>
              `  [${l.id}] ${l.lesson.slice(0, 80)} (hits:${l.hitCount}, ${l.source})`
          )
          .join("\n");
        ctx.ui.notify(`Lessons (${lessons.length}/${config.maxLessons}):\n${lines}`, "info");
        return;
      }

      if (t.startsWith("forget ")) {
        const id = t.slice(7).trim();
        const before = lessons.length;
        lessons = lessons.filter((l) => l.id !== id);
        if (lessons.length < before) {
          saveLessons(lessons);
          ctx.ui.notify(`Forgot lesson "${id}".`, "info");
        } else {
          ctx.ui.notify(`No lesson with id "${id}".`, "error");
        }
        return;
      }

      const lesson = teach(t, "/teach by user", "user");
      ctx.ui.notify(`Learned: "${t.slice(0, 60)}..." (id: ${lesson.id})`, "info");
    },
  });

  // ── /evolve command ──────────────────────────────────────────────────────

  api.registerCommand("evolve", {
    description: "Evolution status: /evolve stats",
    handler: async (args, ctx) => {
      if ((args?.trim() ?? "") !== "stats") {
        ctx.ui.notify(
          "Commands:\n" +
            "  /teach <lesson>        — teach Pi for future sessions\n" +
            "  /teach list            — list stored lessons\n" +
            "  /teach forget <id>     — remove a lesson\n" +
            "  /evolve stats          — show evolution statistics",
          "info"
        );
        return;
      }

      let historyLines = 0;
      try {
        if (existsSync(join(evolveDir, "history.jsonl"))) {
          historyLines = readFileSync(join(evolveDir, "history.jsonl"), "utf-8")
            .split("\n")
            .filter(Boolean).length;
        }
      } catch { /* ignore */ }

      ctx.ui.notify(
        "Evolution stats:\n" +
          `  Lessons: ${lessons.length}/${config.maxLessons}\n` +
          `  History entries: ${historyLines}\n` +
          `  Inject lessons: ${config.injectLessons}\n` +
          `  User-taught: ${lessons.filter((l) => l.source === "user").length}\n` +
          `  LLM-taught: ${lessons.filter((l) => l.source === "llm").length}\n` +
          `  Tags: ${Array.from(new Set(lessons.flatMap((l) => l.tags))).join(", ") || "(none)"}`,
        "info"
      );
    },
  });

  // ── LLM tool: evolve_learn ────────────────────────────────────────────────

  api.registerTool({
    name: "evolve_learn",
    label: "Learn a Lesson",
    description:
      "Record a lesson or learning for future sessions. Call this when you discover " +
      "something about the codebase, workflow, or user preferences to remember.",
    promptSnippet: "Record lessons and patterns for long-term memory",
    promptGuidelines: [
      "Use evolve_learn when you discover a project pattern, convention, or user preference to remember.",
      "Use evolve_learn when the user teaches you something about how they work.",
      "Use evolve_learn when you learn a quirk or rule about the codebase not in any config file.",
    ],
    parameters: Type.Object({
      lesson: Type.String({ description: "The lesson to remember", minLength: 1 }),
      context: Type.Optional(
        Type.String({ description: "Optional context about where learned" })
      ),
      tags: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Tags: extension, role, prompt, skill, config, tool, workflow, codebase, testing, deploy",
          })
        )
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate) {
      const lesson = teach(
        params.lesson,
        params.context ?? "LLM evolve_learn tool",
        "llm",
        params.tags
      );
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Lesson recorded (id: ${lesson.id}, tags: ${lesson.tags.join(", ") || "none"})`,
          },
        ],
      });
      return {
        content: [
          {
            type: "text",
            text: `Learned: "${params.lesson.slice(0, 80)}..." (id: ${lesson.id})`,
          },
        ],
        details: { lessonId: lesson.id, tags: lesson.tags },
      };
    },
  });

  // ── Inject lessons into system prompt ─────────────────────────────────────

  api.on("before_agent_start", async (event) => {
    if (!config.injectLessons || lessons.length === 0) return;

    // Bump hit count
    for (const l of lessons) l.hitCount++;
    saveLessons(lessons);

    const text = lessons
      .slice(0, config.maxLessons)
      .map((l) => `- ${l.lesson}`)
      .join("\n");

    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `<lessons_learned>\n` +
        `These lessons were learned in previous sessions. Internalize them:\n` +
        `${text}\n` +
        `</lessons_learned>`,
    };
  });

  // ── Startup ───────────────────────────────────────────────────────────────

  api.on("session_start", async (_event, ctx) => {
    lessons = loadLessons();
    if (lessons.length > 0) {
      ctx.ui.setStatus("evolve", ctx.ui.theme.fg("dim", `🧠 ${lessons.length}`));
    }
  });
}
