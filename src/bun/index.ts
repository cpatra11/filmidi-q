import { BrowserWindow, Updater, Utils } from "electrobun/bun";
import Electrobun from "electrobun/bun";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { runAgentLoop, resolveToolResult } from "./lib/aiAgent";
import { requestNativeMediaThroughSidecar, pingSwiftSidecar } from "./lib/swiftSidecar";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log(
        "Vite dev server not running. Run 'bun run dev:hmr' for HMR support.",
      );
    }
  }
  return "views://mainview/index.html";
}

const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
  title: "Filmidi",
  url,
  frame: {
    width: 1400,
    height: 900,
    x: 100,
    y: 100,
  },
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 12, y: 12 },
});

// ─── IPC Transport ──────────────────────────────────────────────

const transport = mainWindow.webview.createTransport();
let isMaximized = false;

// ─── MCP pending request tracking
interface PendingRequest {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const mcpPendingRequests = new Map<string, PendingRequest>();

// Secure in-memory storage for sensitive credentials
const secureStore = new Map<string, string>();
const CREDENTIALS_FILE = join(homedir(), "Library", "Application Support", "com.filmidi.editor", "credentials.json");

function loadCredentials() {
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      const data = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8"));
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "string") secureStore.set(key, value);
      }
    }
  } catch {}
}

function saveCredentials() {
  try {
    const dir = dirname(CREDENTIALS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: Record<string, string> = {};
    secureStore.forEach((value, key) => { data[key] = value; });
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[credentials] Failed to save:", err);
  }
}

// Load existing credentials on startup
loadCredentials();

// ─── SQLite Database ─────────────────────────────────────────────
import { Database } from "bun:sqlite";

const DB_DIR = join(homedir(), "Library", "Application Support", "com.filmidi.editor");
mkdirSync(DB_DIR, { recursive: true });
const db = new Database(join(DB_DIR, "projects.db"));
db.run("PRAGMA journal_mode=WAL");
db.run(`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  width INTEGER DEFAULT 1920,
  height INTEGER DEFAULT 1080,
  fps REAL DEFAULT 30,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL,
  thumbnail TEXT,
  file_path TEXT
  )`);
try { db.run("ALTER TABLE projects ADD COLUMN file_path TEXT"); } catch {}

const TRANSCRIPT_LOG_DIR = join(import.meta.dir, "../../log");
const TRANSCRIPT_LOG_FILE = join(TRANSCRIPT_LOG_DIR, "transcript log.txt");

function writeTranscriptLog(level: "debug" | "info" | "warn" | "error", scope: string, message: string, details?: unknown) {
  try {
    mkdirSync(TRANSCRIPT_LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const detailText = details === undefined ? "" : ` ${typeof details === "string" ? details : (() => {
      try { return JSON.stringify(details); } catch { return String(details); }
    })()}`;
    appendFileSync(
      TRANSCRIPT_LOG_FILE,
      `[${timestamp}] [${level}] [${scope}] ${message}${detailText}\n`,
    );
  } catch (err) {
    console.error("[transcript-log] failed to write", err);
  }
}

function sqlValue(value: unknown): string | number | bigint | boolean | Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sqlParams(values: unknown[]): Array<string | number | bigint | boolean | Uint8Array | null> {
  return values.map((value) => sqlValue(value));
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
db.run(`CREATE TABLE IF NOT EXISTS project_data (
  id TEXT PRIMARY KEY,
  timeline TEXT,
  media_manifest TEXT,
  generation_log TEXT,
  chat_history TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  session_data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);

function projectRowToEntry(row: any): any {
  return {
    id: row.id,
    name: row.name,
    width: row.width,
    height: row.height,
    fps: row.fps,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    thumbnailUrl: row.thumbnail ?? undefined,
    filePath: row.file_path ?? undefined,
  };
}

// ─── Agent cancellation support ──────────────────────────────────
let currentAgentController: AbortController | null = null;

transport.registerHandler((msg: any) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "toggleMaximize":
      if (isMaximized) {
        mainWindow.unmaximize();
        isMaximized = false;
      } else {
        mainWindow.maximize();
        isMaximized = true;
      }
      break;

    case "mcp-tool-result": {
      const pending = mcpPendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        mcpPendingRequests.delete(msg.requestId);
        if (msg.isError) {
          pending.reject(new Error(msg.result));
        } else {
          pending.resolve(msg.result);
        }
      }
      break;
    }

    case "openExternal": {
      if (typeof msg.url === "string" && msg.url.startsWith("https://")) {
        Electrobun.Utils.openExternal(msg.url);
      }
      break;
    }

    case "set-api-key": {
      if (typeof msg.key === "string") {
        if (msg.key.length > 0) {
          secureStore.set("qwen_api_key", msg.key);
        } else {
          secureStore.delete("qwen_api_key");
        }
        saveCredentials();
        transport.send({ type: "api-key-saved" });
      }
      break;
    }

    case "get-api-key": {
      // Check memory first, then try loading from file
      let key: string | null = secureStore.get("qwen_api_key") ?? null;
      if (!key) {
        loadCredentials();
        key = secureStore.get("qwen_api_key") ?? null;
      }
      transport.send({ type: "api-key-value", key });
      break;
    }

    case "sign-in": {
      if (typeof msg.authUrl === "string" && msg.authUrl.startsWith("https://")) {
        Electrobun.Utils.openExternal(msg.authUrl);
        transport.send({ type: "sign-in-browser-opened" });
      }
      break;
    }

    // ─── SQLite project persistence ───────────────────────────
    case "db-list-projects": {
      const rows = db.query("SELECT * FROM projects ORDER BY last_opened_at DESC").all();
      transport.send({ type: "db-list-projects-result", projects: rows.map(projectRowToEntry) });
      break;
    }
    case "db-save-project": {
      const { id, name, width, height, fps } = msg;
      if (!id) { transport.send({ type: "db-save-project-result", ok: false, error: "Missing id" }); break; }
      const now = Date.now();
      db.run(`INSERT OR REPLACE INTO projects (id, name, width, height, fps, created_at, last_opened_at, file_path)
        VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM projects WHERE id = ?), ?), ?, COALESCE(?, (SELECT file_path FROM projects WHERE id = ?)))`,
        sqlParams([id, name ?? "Untitled", width ?? 1920, height ?? 1080, fps ?? 30, id, now, now, msg.filePath, id]));
      transport.send({ type: "db-save-project-result", ok: true });
      break;
    }
    case "db-delete-project": {
      if (!msg.id) break;
      db.run("DELETE FROM projects WHERE id = ?", [msg.id]);
      db.run("DELETE FROM project_data WHERE id = ?", [msg.id]);
      transport.send({ type: "db-delete-project-result", ok: true });
      break;
    }
    case "db-update-project-name": {
      if (!msg.id || !msg.name) break;
      db.run("UPDATE projects SET name = ? WHERE id = ?", [msg.name, msg.id]);
      transport.send({ type: "db-update-project-name-result", ok: true });
      break;
    }
    case "db-save-project-data": {
      const { projectId, timeline, mediaManifest, generationLog, chatHistory, thumbnail } = msg;
      if (!projectId) { transport.send({ type: "db-save-project-data-result", ok: false }); break; }
      db.run(`INSERT OR REPLACE INTO project_data (id, timeline, media_manifest, generation_log, chat_history)
        VALUES (?, ?, ?, ?, ?)`,
        sqlParams([projectId,
         timeline != null ? JSON.stringify(timeline) : null,
         mediaManifest != null ? JSON.stringify(mediaManifest) : null,
         generationLog != null ? JSON.stringify(generationLog) : null,
         chatHistory != null ? JSON.stringify(chatHistory) : null]));
      if (thumbnail) db.run("UPDATE projects SET thumbnail = ? WHERE id = ?", sqlParams([thumbnail, projectId]));
      transport.send({ type: "db-save-project-data-result", ok: true });
      break;
    }
    case "db-load-project-data": {
      if (!msg.id) { transport.send({ type: "db-load-project-data-result", data: null }); break; }
      const row = db.query("SELECT * FROM project_data WHERE id = ?").get(msg.id) as any;
      if (row) {
        transport.send({ type: "db-load-project-data-result", data: {
          timeline: row.timeline ? JSON.parse(row.timeline) : null,
          mediaManifest: row.media_manifest ? JSON.parse(row.media_manifest) : null,
          generationLog: row.generation_log ? JSON.parse(row.generation_log) : null,
          chatHistory: row.chat_history ? JSON.parse(row.chat_history) : null,
        }});
      } else {
        transport.send({ type: "db-load-project-data-result", data: null });
      }
      break;
    }
    case "db-delete-project-data": {
      if (!msg.id) break;
      db.run("DELETE FROM project_data WHERE id = ?", [msg.id]);
      transport.send({ type: "db-delete-project-data-result", ok: true });
      break;
    }
    case "db-project-storage-info": {
      transport.send({
        type: "db-project-storage-info-result",
        path: join(DB_DIR, "projects.db"),
        kind: "SQLite project database",
      });
      break;
    }
    case "project-choose-location": {
      void Utils.openFileDialog({
          startingFolder: typeof msg.startingFolder === "string" && msg.startingFolder ? msg.startingFolder : "~/Documents",
          allowedFileTypes: "*",
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        }).then((paths) => {
        transport.send({ type: "project-choose-location-result", path: paths[0] ?? null });
        }).catch((error) => {
        transport.send({ type: "project-choose-location-result", path: null, error: String(error) });
        });
      break;
    }
    case "project-write-file": {
      try {
        const directory = String(msg.directory ?? "");
        const fileName = String(msg.fileName ?? "");
        const contents = String(msg.contents ?? "");
        if (!directory || !fileName) throw new Error("Project location and file name are required");
        mkdirSync(directory, { recursive: true });
        const filePath = join(directory, fileName);
        writeFileSync(filePath, contents, "utf8");
        transport.send({ type: "project-write-file-result", ok: true, path: filePath });
      } catch (error) {
        transport.send({ type: "project-write-file-result", ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      break;
    }

    // ─── Chat sessions ────────────────────────────────────────
    case "db-save-chat-sessions": {
      const { sessions } = msg;
      // Upsert all sessions
      const upsert = db.prepare(`INSERT OR REPLACE INTO chat_sessions (id, session_data, created_at, updated_at)
        VALUES (?, ?, ?, ?)`);
      const now = Date.now();
      const validSessions = ((sessions as any[]) ?? []).filter((s: any) => s && s.id);
      for (const s of validSessions) {
        upsert.run(...sqlParams([s.id, JSON.stringify(s), s.createdAt ?? now, now]));
      }
      // Delete sessions not in the list
      if (validSessions.length > 0) {
        const ids = validSessions.map((s: any) => s.id);
        db.run(`DELETE FROM chat_sessions WHERE id NOT IN (${ids.map(() => "?").join(",")})`, sqlParams(ids));
      }
      transport.send({ type: "db-save-chat-sessions-result", ok: true });
      break;
    }
    case "db-load-chat-sessions": {
      const rows = db.query("SELECT session_data FROM chat_sessions ORDER BY updated_at DESC LIMIT 20").all() as any[];
      const sessions = rows.map((r: any) => JSON.parse(r.session_data));
      transport.send({ type: "db-load-chat-sessions-result", sessions });
      break;
    }
    case "db-delete-chat-sessions": {
      db.run("DELETE FROM chat_sessions");
      transport.send({ type: "db-delete-chat-sessions-result", ok: true });
      break;
    }

    case "tool-result": {
      // Resolve pending tool execution from agent loop
      resolveToolResult(msg.toolResultId, msg.result, msg.isError);
      break;
    }

    case "native-media-request": {
      (async () => {
        try {
          const { task, payload, requestId } = msg;
          const { backend, result } = await requestNativeMediaThroughSidecar(task, payload ?? {});
          transport.send({
            type: "native-media-response",
            requestId,
            backend,
            ok: backend === "swift-sidecar" ? !(result?.error) : false,
            result,
            error: result?.error ?? null,
          });
        } catch (error) {
          transport.send({
            type: "native-media-response",
            requestId: msg.requestId,
            backend: "bun-fallback",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      break;
    }

    case "upload-audio-for-asr": {
      // Upload audio blob to a public URL for ASR.
      // Tries the local backend first, then public mirrors, then a local file fallback.
      (async () => {
        try {
          const { base64Data, mimeType, requestId } = msg;
          if (!base64Data || !requestId) {
            transport.send({ type: "upload-audio-result", requestId, error: "Missing base64Data or requestId" });
            return;
          }

          const buffer = Buffer.from(base64Data, "base64");
          const ext = mimeType?.includes("video") ? ".mp4" : mimeType?.includes("wav") ? ".wav" : ".mp3";
          const fileName = `filmidi-audio-${Date.now()}${ext}`;

          // 1. Try backend upload first.
          try {
            const formData = new FormData();
            formData.append("file", new Blob([buffer], { type: mimeType || "audio/wav" }), fileName);
            const resp = await fetchWithTimeout("http://localhost:3000/api/v1/uploads", {
              method: "POST",
              body: formData,
            }, 12_000);
            if (resp.ok) {
              const data = await resp.json() as any;
              if (typeof data?.url === "string" && data.url) {
                transport.send({ type: "upload-audio-result", requestId, url: data.url });
                return;
              }
            }
          } catch (_) {}

          // 2. Try catbox.moe (free, no auth, no expiry)
          try {
            const formData = new FormData();
            formData.append("reqtype", "fileupload");
            formData.append("fileToUpload", new Blob([buffer], { type: mimeType || "audio/wav" }), fileName);
            const resp = await fetchWithTimeout("https://catbox.moe/user/api.php", {
              method: "POST",
              body: formData,
            }, 12_000);
            if (resp.ok) {
              const url = (await resp.text()).trim();
              if (url && url.startsWith("https://")) {
                transport.send({ type: "upload-audio-result", requestId, url });
                return;
              }
            }
          } catch (_) {}

          // 3. Try tempfile.org
          try {
            const formData = new FormData();
            formData.append("files", new Blob([buffer], { type: mimeType || "audio/wav" }), fileName);
            formData.append("expiryHours", "1");
            const resp = await fetchWithTimeout("https://tempfile.org/api/upload/local", {
              method: "POST",
              body: formData,
            }, 12_000);
            if (resp.ok) {
              const data = await resp.json() as any;
              if (data?.success && data?.files?.[0]?.id) {
                const fileId = data.files[0].id;
                transport.send({ type: "upload-audio-result", requestId, url: `https://tempfile.org/${fileId}/download` });
                return;
              }
            }
          } catch (_) {}

          // 4. Try backend upload (UploadThing)
          try {
            const formData = new FormData();
            formData.append("file", new Blob([buffer], { type: mimeType || "audio/wav" }), fileName);
            const resp = await fetchWithTimeout("http://localhost:3000/api/v1/uploads", {
              method: "POST",
              body: formData,
            }, 12_000);
            if (resp.ok) {
              const data = await resp.json() as any;
              if (data?.url) {
                transport.send({ type: "upload-audio-result", requestId, url: data.url });
                return;
              }
            }
          } catch (_) {}

          // 5. Last resort: local file for debugging.
          const tempDir = join(homedir(), "Library", "Caches", "com.filmidi.editor", "audio");
          mkdirSync(tempDir, { recursive: true });
          const filePath = join(tempDir, fileName);
          writeFileSync(filePath, buffer);
          transport.send({ type: "upload-audio-result", requestId, url: `file://${filePath}` });
        } catch (err: any) {
          transport.send({ type: "upload-audio-result", requestId: msg.requestId, error: err?.message ?? String(err) });
        }
      })();
      break;
    }

    case "transcribe-audio": {
      // Run transcription entirely in Bun (avoids browser CORS issues)
      (async () => {
        try {
          const { audioUrl, apiKey, requestId } = msg;
          const effectiveApiKey = apiKey || secureStore.get("qwen_api_key");
          if (!audioUrl || !requestId) {
            writeTranscriptLog("error", "transcribe-audio", "Missing required fields", {
              hasAudioUrl: !!audioUrl,
              hasApiKey: !!effectiveApiKey,
              hasRequestId: !!requestId,
            });
            transport.send({ type: "transcription-result", requestId, error: "Missing audioUrl or requestId" });
            return;
          }

          if (!effectiveApiKey) {
            writeTranscriptLog("error", "transcribe-audio", "Missing API key", {
              requestId,
              hasApiKey: !!apiKey,
              hasStoredKey: !!secureStore.get("qwen_api_key"),
            });
            transport.send({ type: "transcription-result", requestId, error: "No Qwen API key configured. Add one in Settings > Agent." });
            return;
          }

          writeTranscriptLog("info", "transcribe-audio", "start", {
            requestId,
            audioUrl: audioUrl.slice(0, 120),
            hasApiKey: true,
          });

          const ASR_ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription";
          const POLL_ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/tasks";

          // Submit transcription task
          const submitResp = await fetch(ASR_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${effectiveApiKey}`,
              "X-DashScope-Async": "enable",
            },
            body: JSON.stringify({
              model: "qwen3-asr-flash-filetrans",
              input: { file_url: audioUrl },
              parameters: { channel_id: [0], enable_words: true },
            }),
          });

          if (!submitResp.ok) {
            const err = await submitResp.text();
            writeTranscriptLog("error", "transcribe-audio", "submit failed", {
              requestId,
              status: submitResp.status,
              error: err,
            });
            transport.send({ type: "transcription-result", requestId, error: `ASR submit failed (${submitResp.status}): ${err}` });
            return;
          }

          const submitData = await submitResp.json();
          const taskId = submitData?.output?.task_id;
          if (!taskId) {
            writeTranscriptLog("error", "transcribe-audio", "missing task_id", {
              requestId,
              submitData,
            });
            transport.send({ type: "transcription-result", requestId, error: "No task_id in ASR response" });
            return;
          }

          writeTranscriptLog("info", "transcribe-audio", "submitted", { requestId, taskId });

          // Poll for completion
          for (let attempt = 0; attempt < 150; attempt++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const pollResp = await fetch(`${POLL_ENDPOINT}/${taskId}`, {
                headers: { Authorization: `Bearer ${effectiveApiKey}` },
              });
              if (!pollResp.ok) {
                writeTranscriptLog("warn", "transcribe-audio", "poll http error", {
                  requestId,
                  taskId,
                  attempt: attempt + 1,
                  status: pollResp.status,
                });
                continue;
              }

              const pollData = await pollResp.json();
              const status = pollData?.output?.task_status;
              writeTranscriptLog("debug", "transcribe-audio", "poll", {
                requestId,
                taskId,
                attempt: attempt + 1,
                status,
              });

              if (status === "SUCCEEDED") {
                // Try multiple result URL paths (different models use different formats)
                const resultUrl =
                  pollData?.output?.results?.[0]?.transcription_url ||
                  pollData?.output?.result?.transcription_url ||
                  pollData?.output?.transcription_url ||
                  (typeof pollData?.output?.results?.[0]?.url === "string" ? pollData.output.results[0].url : null);
                if (!resultUrl) {
                  // Send back raw poll data for debugging
                  writeTranscriptLog("error", "transcribe-audio", "succeeded but no result URL", {
                    requestId,
                    taskId,
                    pollOutput: pollData.output,
                  });
                  transport.send({ type: "transcription-result", requestId, error: `No transcription URL. Poll data: ${JSON.stringify(pollData.output)}` });
                  return;
                }
                const resultResp = await fetch(resultUrl);
                const resultData = await resultResp.text();
                writeTranscriptLog("info", "transcribe-audio", "result received", {
                  requestId,
                  taskId,
                  bytes: resultData.length,
                });
                writeTranscriptLog("debug", "transcribe-audio", "result preview", resultData.slice(0, 500));
                transport.send({ type: "transcription-result", requestId, result: resultData });
                return;
              }

              if (status === "FAILED") {
                writeTranscriptLog("error", "transcribe-audio", "task failed", {
                  requestId,
                  taskId,
                  output: pollData.output,
                });
                transport.send({ type: "transcription-result", requestId, error: `ASR task failed: ${JSON.stringify(pollData.output)}` });
                return;
              }
            } catch (_) {
              // Poll error — retry
              writeTranscriptLog("warn", "transcribe-audio", "poll threw, retrying", {
                requestId,
                taskId,
                attempt: attempt + 1,
              });
            }
          }

          writeTranscriptLog("error", "transcribe-audio", "timed out", { requestId, taskId });
          transport.send({ type: "transcription-result", requestId, error: "ASR task timed out" });
        } catch (err: any) {
          writeTranscriptLog("error", "transcribe-audio", "unexpected error", err?.message ?? err);
          transport.send({ type: "transcription-result", requestId: msg.requestId, error: err?.message ?? String(err) });
        }
      })();
      break;
    }
    case "transcript-log": {
      const payload = msg.payload as { level?: "debug" | "info" | "warn" | "error"; scope?: string; message?: string; details?: unknown; timestamp?: string } | undefined;
      if (payload?.scope && payload?.message) {
        writeTranscriptLog(payload.level ?? "info", payload.scope, payload.message, payload.details);
      }
      break;
    }

    case "agent-message": {
      // Cancel any previous agent run
      if (currentAgentController) {
        currentAgentController.abort();
        currentAgentController = null;
      }
      const controller = new AbortController();
      currentAgentController = controller;
      const apiKey = secureStore.get("qwen_api_key");
      if (!apiKey) {
        transport.send({
          type: "agent-error",
          requestId: msg.requestId,
          error: "No API key configured. Set it in Settings > Agent.",
        });
        break;
      }
      runAgentLoop({
        requestId: msg.requestId,
        sessionMessages: msg.sessionMessages,
        userMessage: msg.userMessage,
        context: msg.context,
        toolDefs: msg.toolDefs,
        system: msg.system,
        modelId: msg.modelId,
        apiKey,
        send: (m: any) => transport.send(m),
      }, controller.signal);
      break;
    }

    case "cancel-agent": {
      if (currentAgentController) {
        currentAgentController.abort();
        currentAgentController = null;
      }
      break;
    }

    case "stream-chat-init": {
      const { requestId, model, messages, tools, system, apiKey } = msg;
      if (!requestId || !apiKey) break;

      (async () => {
        try {
          const controller = new AbortController();
          const fetchTimeout = setTimeout(() => controller.abort(), 20000);

          const body: Record<string, unknown> = {
            model,
            max_tokens: msg.maxTokens ?? 8192,
            stream: true,
            messages,
          };
          if (system) body.system = system;
          if (tools?.length) {
            body.tools = tools;
            const toolArr = body.tools as any[];
            toolArr[toolArr.length - 1].cache_control = { type: "ephemeral" };
          }

          const res = await fetch("https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          clearTimeout(fetchTimeout);

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            transport.send({ type: "stream-chat-result", requestId, events: [{ type: "error", message: `API ${res.status}: ${text}` }] });
            return;
          }

          const reader = res.body?.getReader();
          if (!reader) throw new Error("No response body");

          const decoder = new TextDecoder();
          let buffer = "";
          // Track current block: text or tool_use (thinking blocks are skipped)
          let currentBlock: { type: "text" | "tool_use"; id?: string; name?: string; input?: string } | null = null;
          const events: Record<string, unknown>[] = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              // DashScope sends `data:{...}` with no space — accept both forms
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data) continue;

              let parsed: Record<string, unknown>;
              try { parsed = JSON.parse(data); } catch { continue; }

              const eventType = parsed.type as string;

              if (eventType === "content_block_start") {
                const block = parsed.content_block as Record<string, unknown>;
                if (block.type === "tool_use") {
                  currentBlock = { type: "tool_use", id: block.id as string, name: block.name as string, input: "" };
                } else if (block.type === "text") {
                  currentBlock = { type: "text" };
                } else {
                  // thinking or unknown — skip
                  currentBlock = null;
                }
                continue;
              }

              if (eventType === "content_block_delta") {
                const delta = parsed.delta as Record<string, unknown>;
                if (delta.type === "text_delta" && currentBlock?.type === "text") {
                  const text = delta.text as string;
                  if (text) events.push({ type: "text_delta", text });
                } else if (delta.type === "input_json_delta" && currentBlock?.type === "tool_use") {
                  currentBlock.input = (currentBlock.input ?? "") + (delta.partial_json as string);
                }
                continue;
              }

              if (eventType === "content_block_stop") {
                if (currentBlock?.type === "tool_use" && currentBlock.id && currentBlock.name) {
                  let input: Record<string, unknown> = {};
                  try { input = JSON.parse(currentBlock.input ?? "{}"); } catch {}
                  events.push({ type: "tool_use", id: currentBlock.id, name: currentBlock.name, input });
                }
                currentBlock = null;
                continue;
              }

              if (eventType === "message_delta") {
                const delta = parsed.delta as Record<string, unknown> | undefined;
                const usage = parsed.usage as Record<string, unknown> | undefined;
                events.push({
                  type: "stop",
                  stopReason: (delta?.stop_reason as string) ?? null,
                  usage: { input_tokens: (usage?.input_tokens as number) ?? 0, output_tokens: (usage?.output_tokens as number) ?? 0 },
                });
                continue;
              }
            }
          }

          transport.send({ type: "stream-chat-result", requestId, events });
        } catch (err: any) {
          console.error("[stream-chat] Bun fetch error:", err?.message ?? err);
          try {
            transport.send({ type: "stream-chat-result", requestId, events: [{ type: "error", message: err?.message ?? String(err) }] });
          } catch (sendErr) {
            console.error("[stream-chat] Failed to send error event:", sendErr);
          }
        }
      })();
      break;
    }
  }
});

if (process.platform === "darwin") {
  void pingSwiftSidecar().then((ready) => {
    console.log("[swift-sidecar] status", ready ? "available" : "fallback");
  });
}

// ─── MCP Tool Call Bridge ───────────────────────────────────────

function callToolOnRenderer(toolName: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      mcpPendingRequests.delete(requestId);
      reject(new Error(`MCP tool call timed out: ${toolName}`));
    }, 120_000);

    mcpPendingRequests.set(requestId, { resolve, reject, timer });
    transport.send({ type: "mcp-tool-call", requestId, toolName, args });
  });
}

// Start MCP after the renderer bridge exists. The server uses node:http rather
// than Bun.serve so a transport failure cannot take down the editor process.
void import("./mcp/startMcpServer")
  .then(({ startMcpServer }) => startMcpServer(callToolOnRenderer))
  .then(() => console.log("[MCP] Server startup completed"))
  .catch((err) => console.error("[MCP] Failed to start server:", err));

// ─── Native Menu Bar ───

const isMac = process.platform === "darwin";

const menuTemplate: any[] = [
  // ── App menu (macOS only) ──
  ...(isMac
    ? [
        {
          submenu: [
            { label: "About Filmidi", action: "about" },
            { type: "separator" as const },
      {
        label: "Settings",
        accelerator: "cmd+,",
        action: "open-settings",
      },
            { type: "separator" as const },
            { label: "Hide Filmidi", role: "hide" },
            { label: "Hide Others", role: "hideOthers" },
            { label: "Show All", role: "showAll" },
            { type: "separator" as const },
            { label: "Quit Filmidi", role: "quit" },
          ],
        },
      ]
    : []),

  // ── File ──
  {
    label: "File",
    submenu: [
      { label: "New Project", accelerator: "cmd+n", action: "new-project" },
      { label: "Open Project", accelerator: "cmd+o", action: "open-project" },
      { type: "separator" },
      { label: "Save Project", accelerator: "cmd+s", action: "save-project" },
      {
        label: "Save As",
        accelerator: "cmd+shift+s",
        action: "save-as",
      },
      { type: "separator" },
      { label: "Import Media", accelerator: "cmd+i", action: "import-media" },
      { label: "Export", accelerator: "cmd+shift+e", action: "export" },
      ...(!isMac
        ? [
            { type: "separator" as const },
            { label: "Settings", accelerator: "ctrl+,", action: "open-settings" },
            { type: "separator" as const },
            { label: "Exit", role: "quit" },
          ]
        : []),
    ],
  },

  // ── Edit ──
  {
    label: "Edit",
    submenu: [
      { label: "Undo", accelerator: "cmd+z", action: "undo" },
      { label: "Redo", accelerator: "cmd+shift+z", action: "redo" },
      { type: "separator" },
      { label: "Cut", accelerator: "cmd+x", action: "cut" },
      { label: "Copy", accelerator: "cmd+c", action: "copy" },
      { label: "Paste", accelerator: "cmd+v", action: "paste" },
      { label: "Delete", accelerator: "delete", action: "delete" },
      { label: "Select All", accelerator: "cmd+a", action: "select-all" },
      { type: "separator" },
      {
        label: "Split at Playhead",
        accelerator: "cmd+k",
        action: "split-at-playhead",
      },
      { label: "Trim Start", action: "trim-start" },
      { label: "Trim End", action: "trim-end" },
    ],
  },

  // ── View ──
  {
    label: "View",
    submenu: [
      {
        label: "Media Panel",
        accelerator: "cmd+shift+0",
        action: "toggle-media-panel",
      },
      {
        label: "Inspector",
        accelerator: "cmd+shift+alt+0",
        action: "toggle-inspector",
      },
      {
        label: "Agent Panel",
        accelerator: "cmd+shift+alt+a",
        action: "toggle-agent-panel",
      },
      { type: "separator" },
      { label: "Zoom In", accelerator: "cmd+=", action: "zoom-in" },
      { label: "Zoom Out", accelerator: "cmd+-", action: "zoom-out" },
      { label: "Zoom to Fit", accelerator: "cmd+0", action: "zoom-fit" },
      { label: "Zoom to 100%", accelerator: "cmd+1", action: "zoom-100" },
      { type: "separator" },
      { label: "Toggle Full Screen", role: "toggleFullScreen" },
    ],
  },

  // ── Window ──
  {
    label: "Window",
    submenu: [
      { label: "Minimize", role: "minimize" },
      { label: "Zoom", role: "zoom" },
      ...(isMac
        ? [
            { type: "separator" as const },
            { label: "Bring All to Front", role: "bringAllToFront" },
          ]
        : []),
    ],
  },

  // ── Help ──
  {
    label: "Help",
    submenu: [
      {
        label: "Keyboard Shortcuts",
        accelerator: "cmd+/",
        action: "open-help",
      },
      { label: "MCP Instructions", action: "open-mcp" },
      { type: "separator" },
      { label: "Send Feedback", action: "send-feedback" },
    ],
  },
];

Electrobun.ApplicationMenu.setApplicationMenu(menuTemplate);

// ─── Forward menu clicks to the webview ───

Electrobun.ApplicationMenu.on("application-menu-clicked", (e) => {
  const action = (e as any)?.data?.action ?? (e as any)?.action;
  if (!action) return;

  // Forward to webview via RPC
  transport.send({ type: "menu-action", action });
});

console.log("Filmidi Editor started!");
