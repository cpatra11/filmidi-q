export type NativeMediaBackend = "swift-sidecar" | "bun-fallback";

export type NativeMediaTask =
  | "transcribe-audio"
  | "detect-beats"
  | "extract-audio"
  | "export-video"
  | "sample-frames"
  | "gstreamer-normalize";

export interface NativeMediaRequest {
  task: NativeMediaTask;
  payload: Record<string, unknown>;
}

export interface NativeMediaResponse {
  ok?: boolean;
  error?: string;
  backend?: NativeMediaBackend;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __filmidiSwiftSidecar?: {
      request: (request: NativeMediaRequest) => Promise<NativeMediaResponse | unknown> | NativeMediaResponse | unknown;
    };
  }
}

let lastKnownBackend: NativeMediaBackend = "bun-fallback";

function isDesktopMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Mac/i.test(platform) || /Mac OS X/i.test(ua);
}

export function hasSwiftSidecarBridge(): boolean {
  return isDesktopMac() && typeof window !== "undefined" && typeof window.__filmidiSwiftSidecar?.request === "function";
}

export function getNativeMediaBackend(): NativeMediaBackend {
  if (lastKnownBackend === "swift-sidecar") return "swift-sidecar";
  return hasSwiftSidecarBridge() ? "swift-sidecar" : "bun-fallback";
}

export function canUseSwiftSidecar(): boolean {
  return getNativeMediaBackend() === "swift-sidecar";
}

export async function requestNativeMedia<T = unknown>(
  task: NativeMediaTask,
  payload: Record<string, unknown>,
): Promise<T | null> {
  // GStreamer is a Bun-hosted backend; do not route this task to the
  // optional Swift sidecar even when that sidecar is available.
  if (task !== "gstreamer-normalize" && hasSwiftSidecarBridge()) {
    try {
      const response = await window.__filmidiSwiftSidecar!.request({ task, payload });
      if (response == null) return null;
      if (typeof response === "object") {
        const typed = response as NativeMediaResponse;
        if (typed.backend) lastKnownBackend = typed.backend;
        if ("error" in typed && typed.error) return null;
        if ("result" in typed) {
          return typed.result as T;
        }
      }
      return response as T;
    } catch (error) {
      console.warn(`[native-media] ${task} failed on direct Swift bridge, falling back`, error);
    }
  }

  const bridge = (window as any).__electrobunBunBridge;
  if (!bridge) return null;

  try {
    const requestId = crypto.randomUUID();
    const response = await new Promise<NativeMediaResponse | null>((resolve, reject) => {
      const eb = (window as any).__electrobun;
      const prevHandler = eb?.receiveMessageFromBun;
      let cleanedUp = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (eb) eb.receiveMessageFromBun = prevHandler;
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Native media request timed out"));
      }, 120_000);

      if (eb) {
        eb.receiveMessageFromBun = (msg: unknown) => {
          const data = typeof msg === "string"
            ? (() => {
                try {
                  return JSON.parse(msg);
                } catch {
                  return null;
                }
              })()
            : msg;
          if (data?.type !== "native-media-response" || data.requestId !== requestId) {
            if (prevHandler) prevHandler(msg);
            return;
          }
          clearTimeout(timeout);
          cleanup();
          resolve(data as NativeMediaResponse);
        };
      }

      bridge.postMessage(JSON.stringify({
        type: "native-media-request",
        requestId,
        task,
        payload,
      }));
    });

    if (!response) return null;
    if (response.backend) lastKnownBackend = response.backend;
    if (response.error) {
      return null;
    }
    // Bun forwards the complete Swift response inside `result`, while the
    // direct sidecar bridge exposes the task payload directly. Accept both
    // shapes so extracted audio/data URLs are not silently dropped.
    const nested = response.result as any;
    return ((nested?.result !== undefined ? nested.result : nested) as T | null) ?? null;
  } catch (error) {
    console.warn(`[native-media] ${task} failed via Bun bridge, falling back`, error);
    return null;
  }
}
