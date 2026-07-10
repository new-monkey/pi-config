/**
 * Jenkins CLI Extension
 *
 * Provides tools to interact with Jenkins from Pi:
 *   - Trigger jobs with parameters
 *   - Check job/build status
 *   - View console output
 *   - List jobs by view/folder
 *
 * Configure via settings.json:
 *   "jenkins": {
 *     "url": "https://jenkins.corp.com",
 *     "apiKey": "$JENKINS_API_KEY",
 *     "username": "your-user"
 *   }
 *
 * Or via env vars:
 *   JENKINS_URL
 *   JENKINS_API_KEY or JENKINS_TOKEN
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface JenkinsConfig {
  url: string;
  apiKey?: string;
  username?: string;
}

function loadConfig(): JenkinsConfig | null {
  const url = process.env.JENKINS_URL;
  const apiKey = process.env.JENKINS_API_KEY || process.env.JENKINS_TOKEN;
  if (!url) return null;
  return { url, apiKey, username: process.env.JENKINS_USER };
}

function authHeader(config: JenkinsConfig): Record<string, string> {
  if (config.apiKey) {
    return { Authorization: `Bearer ${config.apiKey}` };
  }
  if (config.username && config.apiKey) {
    const encoded = Buffer.from(`${config.username}:${config.apiKey}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

async function jenkinsFetch(config: JenkinsConfig, path: string, options?: RequestInit): Promise<Response> {
  const url = `${config.url.replace(/\/$/, "")}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      ...authHeader(config),
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
}

export default function jenkinsExtension(api: ExtensionAPI) {
  const config = loadConfig();
  if (!config) {
    // Don't register tools if no Jenkins URL configured
    return;
  }

  // ── List Jobs ──────────────────────────────────────────────────────────

  api.registerTool({
    name: "jenkins_list_jobs",
    label: "Jenkins: List Jobs",
    description: "List Jenkins jobs, optionally filtered by view or folder path.",
    parameters: Type.Object({
      view: Type.Optional(
        Type.String({ description: "View name or folder path (e.g., 'my-folder' or 'api-team/deploy')" })
      ),
      depth: Type.Optional(
        Type.Number({ description: "How deep to recurse into folders (default: 1)", default: 1 })
      ),
    }),
    async execute(_id, params) {
      const view = params.view || "";
      const depth = params.depth ?? 1;
      const path = view ? `/view/${encodeURIComponent(view)}/api/json?tree=jobs[name,url,color,lastBuild[number,timestamp,result]]&depth=${depth}` :
        `/api/json?tree=jobs[name,url,color,lastBuild[number,timestamp,result]]&depth=${depth}`;

      const res = await jenkinsFetch(config, path);
      if (!res.ok) return { content: [{ type: "text", text: `Jenkins API error: ${res.status} ${res.statusText}` }], details: {} };

      const data = await res.json();
      const jobs = data.jobs || [];

      if (jobs.length === 0) return { content: [{ type: "text", text: "No jobs found." }], details: {} };

      const lines = jobs.map((j: { name: string; color?: string; url?: string; lastBuild?: { number: number; result: string | null; timestamp: number } }) => {
        const status = j.color === "blue" ? "✅" : j.color === "red" ? "❌" : j.color === "yellow" ? "⚠️" : j.color === "notbuilt" ? "⏸️" : "⚪";
        const build = j.lastBuild ? `#${j.lastBuild.number} (${j.lastBuild.result || "running"})` : "never built";
        return `${status} ${j.name} — ${build}`;
      });

      return { content: [{ type: "text", text: `Jenkins Jobs:\n${lines.join("\n")}` }], details: { count: jobs.length } };
    },
  });

  // ── Build Job ──────────────────────────────────────────────────────────

  api.registerTool({
    name: "jenkins_build",
    label: "Jenkins: Trigger Build",
    description: "Trigger a Jenkins job build, optionally with parameters.",
    parameters: Type.Object({
      job: Type.String({ description: "Job name (e.g., 'my-service/deploy')" }),
      parameters: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: "Build parameters as key-value pairs" })
      ),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for build to complete (default: false)", default: false })
      ),
    }),
    async execute(_id, params) {
      const jobPath = `/job/${params.job.split("/").map(p => encodeURIComponent(p)).join("/job/")}`;

      let buildUrl: string;
      if (params.parameters && Object.keys(params.parameters).length > 0) {
        buildUrl = `${jobPath}/buildWithParameters`;
      } else {
        buildUrl = `${jobPath}/build`;
      }

      const body = params.parameters ? new URLSearchParams(params.parameters).toString() : undefined;
      const res = await jenkinsFetch(config, buildUrl, {
        method: "POST",
        body,
        headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
      });

      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: "text", text: `Build trigger failed: ${res.status}\n${text.slice(0, 500)}` }], details: {} };
      }

      // Jenkins returns 201 with Location header pointing to the queue item
      const location = res.headers.get("Location");
      if (!location) return { content: [{ type: "text", text: `Build triggered for ${params.job}.` }], details: {} };

      return { content: [{ type: "text", text: `Build triggered for ${params.job}.\nQueue URL: ${location}` }], details: { queueUrl: location } };
    },
  });

  // ── Build Status ───────────────────────────────────────────────────────

  api.registerTool({
    name: "jenkins_build_status",
    label: "Jenkins: Build Status",
    description: "Check the status of recent builds for a job.",
    parameters: Type.Object({
      job: Type.String({ description: "Job name (e.g., 'my-service/deploy')" }),
      count: Type.Optional(
        Type.Number({ description: "Number of recent builds to show (default: 5)", default: 5 })
      ),
    }),
    async execute(_id, params) {
      const jobPath = `/job/${params.job.split("/").map(p => encodeURIComponent(p)).join("/job/")}`;
      const res = await jenkinsFetch(config, `${jobPath}/api/json?tree=builds[number,result,timestamp,url,estimatedDuration,duration]{0,${params.count || 5}}`);

      if (!res.ok) return { content: [{ type: "text", text: `Jenkins API error: ${res.status}` }], details: {} };

      const data = await res.json();
      const builds = data.builds || [];

      if (builds.length === 0) return { content: [{ type: "text", text: `No builds found for ${params.job}.` }], details: {} };

      const lines = builds.map((b: { number: number; result: string | null; timestamp: number; duration?: number; estimatedDuration?: number }) => {
        const status = b.result === "SUCCESS" ? "✅" : b.result === "FAILURE" ? "❌" : b.result === "UNSTABLE" ? "⚠️" : b.result === null ? "🔄" : "❓";
        const time = new Date(b.timestamp).toLocaleString();
        const duration = b.duration ? ` (${Math.round(b.duration / 1000)}s)` : "";
        return `${status} #${b.number} — ${b.result || "running"} — ${time}${duration}`;
      });

      return { content: [{ type: "text", text: `Builds for ${params.job}:\n${lines.join("\n")}` }], details: { count: builds.length } };
    },
  });

  // ── Console Output ─────────────────────────────────────────────────────

  api.registerTool({
    name: "jenkins_console",
    label: "Jenkins: Console Output",
    description: "Get the console log output from a specific build.",
    parameters: Type.Object({
      job: Type.String({ description: "Job name" }),
      build: Type.Optional(
        Type.Union(
          [Type.Number({ description: "Build number" }), Type.String({ description: "'lastBuild', 'lastSuccessfulBuild', 'lastFailedBuild'" })],
          { description: "Build number or alias (default: 'lastBuild')", default: "lastBuild" }
        )
      ),
      tail: Type.Optional(
        Type.Number({ description: "Only show last N lines (default: all)", default: 100 })
      ),
    }),
    async execute(_id, params) {
      const jobPath = `/job/${params.job.split("/").map(p => encodeURIComponent(p)).join("/job/")}`;
      const buildNum = params.build ?? "lastBuild";
      const res = await jenkinsFetch(config, `${jobPath}/${buildNum}/consoleText`);

      if (!res.ok) return { content: [{ type: "text", text: `Jenkins API error: ${res.status}` }], details: {} };

      let text = await res.text();
      const lines = text.split("\n");
      const tail = params.tail ?? 100;

      if (lines.length > tail) {
        text = `... (${lines.length - tail} lines hidden) ...\n` + lines.slice(-tail).join("\n");
      }

      return { content: [{ type: "text", text: text.slice(0, 10000) }], details: { totalLines: lines.length, shown: Math.min(lines.length, tail) } };
    },
  });

  // ── Trigger with Wait ──────────────────────────────────────────────────

  api.registerTool({
    name: "jenkins_build_and_wait",
    label: "Jenkins: Build and Wait",
    description: "Trigger a build and poll until it completes, returning the result.",
    parameters: Type.Object({
      job: Type.String({ description: "Job name" }),
      parameters: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Build parameters" })),
      timeout: Type.Optional(Type.Number({ description: "Max wait time in seconds (default: 300)", default: 300 })),
    }),
    async execute(_id, params) {
      const jobPath = `/job/${params.job.split("/").map(p => encodeURIComponent(p)).join("/job/")}`;

      // Trigger
      const body = params.parameters ? new URLSearchParams(params.parameters).toString() : undefined;
      const triggerRes = await jenkinsFetch(config, `${jobPath}/buildWithParameters`, {
        method: "POST",
        body,
        headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
      });

      if (!triggerRes.ok) {
        return { content: [{ type: "text", text: `Build trigger failed: ${triggerRes.status}` }], details: {} };
      }

      const location = triggerRes.headers.get("Location");
      if (!location) return { content: [{ type: "text", text: "Build triggered but no queue URL returned." }], details: {} };

      // Wait for build to appear and complete
      const start = Date.now();
      const timeout = (params.timeout ?? 300) * 1000;
      let buildNumber: number | null = null;

      // Poll queue for build number
      while (Date.now() - start < timeout) {
        const queueRes = await jenkinsFetch(config, `${jobPath}/lastBuild/api/json?tree=number,result,displayName`);
        if (queueRes.ok) {
          const lastBuild = await queueRes.json();
          buildNumber = lastBuild.number;
          break;
        }
        await new Promise(r => setTimeout(r, 3000));
      }

      if (!buildNumber) {
        return { content: [{ type: "text", text: `Build queued but did not start within ${params.timeout ?? 300}s. Queue URL: ${location}` }], details: {} };
      }

      // Poll until complete
      while (Date.now() - start < timeout) {
        const statusRes = await jenkinsFetch(config, `${jobPath}/${buildNumber}/api/json?tree=result,building,duration,timestamp`);
        if (statusRes.ok) {
          const build = await statusRes.json();
          if (!build.building) {
            const statusEmoji = build.result === "SUCCESS" ? "✅" : build.result === "FAILURE" ? "❌" : "⚠️";
            const duration = build.duration ? ` (${Math.round(build.duration / 1000)}s)` : "";
            return {
              content: [{ type: "text", text: `${statusEmoji} Build #${buildNumber} ${build.result}${duration}` }],
              details: { buildNumber, result: build.result, duration: build.duration },
            };
          }
        }
        await new Promise(r => setTimeout(r, 5000));
      }

      return { content: [{ type: "text", text: `Build #${buildNumber} still running after timeout.` }], details: { buildNumber, timedOut: true } };
    },
  });
}
