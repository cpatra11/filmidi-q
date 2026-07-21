import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

type ProcessResult = { code: number | null; stdout: string; stderr: string };

function commandPath(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("which", [name]);
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? output.trim() || null : null));
  });
}

function run(command: string, args: string[], timeoutMs = 120_000): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function gstreamerAvailable(): Promise<boolean> {
  const [launch, discoverer] = await Promise.all([
    commandPath("gst-launch-1.0"),
    commandPath("gst-discoverer-1.0"),
  ]);
  return Boolean(launch && discoverer);
}

/** Normalize a browser-imported media file through GStreamer when installed. */
export async function normalizeWithGStreamer(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!(await gstreamerAvailable())) return null;
  const base64Data = typeof payload.base64Data === "string" ? payload.base64Data : "";
  if (!base64Data) throw new Error("gstreamer-normalize requires base64Data");

  const workDir = mkdtempSync(join(tmpdir(), "filmidi-gst-"));
  const inputPath = join(workDir, "input");
  const outputPath = join(workDir, "normalized.mp4");
  try {
    writeFileSync(inputPath, Buffer.from(base64Data, "base64"));
    const discoverer = await commandPath("gst-discoverer-1.0");
    if (!discoverer) return null;
    const probe = await run(discoverer, [inputPath], 30_000);
    if (probe.code !== 0) throw new Error(`GStreamer could not inspect media: ${probe.stderr.trim()}`);

    // Use standard plugins first, then the libav encoders commonly shipped
    // with desktop GStreamer distributions.
    const pipelines = [
      ["x264enc", "voaacenc"],
      ["avenc_h264", "avenc_aac"],
    ];
    let lastError = "GStreamer normalization failed";
    for (const [videoEncoder, audioEncoder] of pipelines) {
      const result = await run("gst-launch-1.0", [
        "-e", "filesrc", `location=${inputPath}`,
        "!", "decodebin", "name=decode",
        "decode.", "!", "queue", "!", "videoconvert", "!", videoEncoder,
        "tune=zerolatency", "speed-preset=veryfast", "!", "h264parse", "!", "mp4mux", "name=mux", "faststart=true", "!", "filesink", `location=${outputPath}`,
        "decode.", "!", "queue", "!", "audioconvert", "!", "audioresample", "!", audioEncoder,
        "!", "aacparse", "!", "mux.",
      ], 300_000);
      if (result.code === 0) {
        const bytes = readFileSync(outputPath);
        return {
          backend: "gstreamer",
          dataUrl: `data:video/mp4;base64,${bytes.toString("base64")}`,
          mimeType: "video/mp4",
          probe: probe.stdout.slice(0, 12_000),
        };
      }
      lastError = result.stderr.trim().slice(-2_000) || lastError;
    }
    throw new Error(lastError);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

