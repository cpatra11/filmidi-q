import { useEditorStore, commands } from "@videoflow/react-video-editor";
import { useAppStore } from "@/store/useAppStore";
import { useHelpStore } from "@/store/useHelpStore";
import { useMediaPanelStore } from "@/store/useMediaPanelStore";
import { useProjectSaveStore, type ProjectData } from "@/store/useProjectSaveStore";
import { useProjectStore } from "@/store/useProjectStore";
import { useSaveAsStore } from "@/store/useSaveAsStore";
import { useAgentStore } from "@/store/useAgentStore";
import { useGenerationStore } from "@/store/useGenerationStore";
import { dbChooseProjectLocation, dbWriteProjectFile } from "./dbIPC";
import { serializeFilmidiPackage } from "./exportHelpers";
import { getMediaDuration } from "./mediaDuration";
import { findAvailableTrack, normalizeTrackForKind } from "@/lib/timelineMove";
import { extractMovAudio } from "@/lib/movAudio";

const { addLayerCommand } = commands;

function getDisplayName(urlOrFile: string | File | undefined): string {
  if (!urlOrFile) return "Clip";
  if (typeof urlOrFile === "string") {
    const parts = urlOrFile.split("/");
    const last = parts[parts.length - 1];
    return decodeURIComponent(last).replace(/\.[^.]+$/, "") || "Clip";
  }
  return urlOrFile.name.replace(/\.[^.]+$/, "") || "Clip";
}

function setLayerTrack(commit: any, layerId: string, track: number) {
  commit((draft: any) => {
    const layer = draft.layers?.find((x: any) => x.id === layerId);
    if (layer) layer.track = normalizeTrackForKind(track, layer.type === "audio" ? "audio" : "video");
  }, { label: "Set track" });
}

async function getCurrentProjectData(projectId: string | null): Promise<ProjectData> {
  const saveStore = useProjectSaveStore.getState();
  const saved = projectId ? await saveStore.loadProject(projectId) : null;
  const mediaStore = useMediaPanelStore.getState();
  const generationStore = useGenerationStore.getState();
  return {
    timeline: useEditorStore.getState().video,
    mediaManifest: {
      assets: mediaStore.assets,
      folders: mediaStore.folders,
    },
    generationLog: generationStore.history,
    chatHistory: useAgentStore.getState().sessions,
  };
}

export async function saveCurrentProject(): Promise<void> {
  const projectStore = useProjectStore.getState();
  const saveStore = useProjectSaveStore.getState();
  const projectId = projectStore.currentProjectId;
  if (!projectId) return;
  const data = await getCurrentProjectData(projectId);
  await saveStore.saveProject(data);
  const current = projectStore.projects.find((p) => p.id === projectId);
  if (current?.filePath) {
    const slash = Math.max(current.filePath.lastIndexOf("/"), current.filePath.lastIndexOf("\\"));
    const directory = slash >= 0 ? current.filePath.slice(0, slash) : ".";
    const fileName = slash >= 0 ? current.filePath.slice(slash + 1) : current.filePath;
    await dbWriteProjectFile(directory, fileName, await serializeFilmidiPackage());
  }
}

export async function saveProjectAsCopy(): Promise<void> {
  const projectStore = useProjectStore.getState();
  const currentId = projectStore.currentProjectId;
  if (!currentId) return;

  const current = projectStore.projects.find((p) => p.id === currentId);
  const baseName = current?.name ?? "Untitled Project";
  useSaveAsStore.getState().open(`${baseName} Copy`);
}

export async function saveProjectAsCopyWithName(name: string, location?: string): Promise<{ id: string; name: string; filePath: string } | null> {
  const projectStore = useProjectStore.getState();
  const currentId = projectStore.currentProjectId;
  if (!currentId) return null;

  const current = projectStore.projects.find((p) => p.id === currentId);
  const nextName = name.trim() || `${current?.name ?? "Untitled Project"} Copy`;
  const folder = location || await dbChooseProjectLocation();
  if (!folder) return null;
  const fileName = `${nextName.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "Untitled Project"}.filmidi`;
  const data = await getCurrentProjectData(currentId);
  const filePath = await dbWriteProjectFile(folder, fileName, await serializeFilmidiPackage());
  const id = projectStore.addProject(nextName, {
    width: current?.width ?? useEditorStore.getState().video.width ?? 1920,
    height: current?.height ?? useEditorStore.getState().video.height ?? 1080,
    fps: current?.fps ?? useEditorStore.getState().video.fps ?? 30,
    filePath,
  }, { select: false });
  await useProjectSaveStore.getState().importProject(id, data);
  projectStore.openProject(id);
  useAppStore.getState().setProjectName(nextName);
  return { id, name: nextName, filePath };
}

export function openProjectHome(): void {
  useProjectStore.getState().openProject(null);
}

export async function importMediaFromPicker(): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "video/*,audio/*,image/*";

  const files = await new Promise<File[] | null>((resolve) => {
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve(null);
    input.click();
  });

  if (!files || files.length === 0) return;
  await importMediaFiles(files);
}

export async function importMediaFiles(files: File[] | FileList): Promise<void> {
  const mediaStore = useMediaPanelStore.getState();
  const editor = useEditorStore.getState();
  const fileArr = Array.from(files);
  const fps = editor.video.fps || 30;
  const startTime = editor.currentFrame / fps;

  for (const file of fileArr) {
    const type = file.type.startsWith("video/") ? "video" as const : file.type.startsWith("audio/") ? "audio" as const : "image" as const;
    const duration = await getMediaDuration(file, type);
    const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const url = URL.createObjectURL(file);
    const audioUrl = type === "video" ? await extractMovAudio(file) : null;
    mediaStore.addAsset({
      id,
      name: file.name,
      type,
      url,
      duration,
      isGenerated: false,
      folderId: mediaStore.currentFolderId,
      createdAt: Date.now(),
    });
    if (type === "video") {
      const { generateLinkId, setLayerLinkId } = await import("@/lib/linkUtils");
      const { commands: cmds } = await import("@videoflow/react-video-editor");
      const setSettingCommand = cmds.setSettingCommand;
      const linkId = generateLinkId();
      const clipName = getDisplayName(file);
      const audioTrack = findAvailableTrack(useEditorStore.getState().video.layers ?? [], "audio", startTime, duration);
      const videoTrack = findAvailableTrack(useEditorStore.getState().video.layers ?? [], "video", startTime, duration);
      const audioLayerId = await addLayerCommand(editor.commit, { type: "audio", source: audioUrl ?? url, sourceDuration: duration, startTime });
      setLayerTrack(editor.commit, audioLayerId, audioTrack);
      await cmds.setSettingCommand(editor.commit, audioLayerId, "name", `${clipName} Audio`);
      await cmds.setPropertyCommand(editor.commit, audioLayerId, "mute", false);
      await cmds.setPropertyCommand(editor.commit, audioLayerId, "volume", 1);
      await setLayerLinkId(editor.commit, audioLayerId, linkId, setSettingCommand);
      const layerId = await addLayerCommand(editor.commit, { type, source: url, sourceDuration: duration, startTime });
      setLayerTrack(editor.commit, layerId, videoTrack);
      await cmds.setSettingCommand(editor.commit, layerId, "name", clipName);
      await setLayerLinkId(editor.commit, layerId, linkId, setSettingCommand);
      // Keep the source video audible as a fallback for MOV audio codecs that
      // the standalone audio renderer cannot decode.
      await cmds.setPropertyCommand(editor.commit, layerId, "mute", false);
    } else {
      const track = findAvailableTrack(useEditorStore.getState().video.layers ?? [], type === "audio" ? "audio" : "video", startTime, duration);
      const layerId = await addLayerCommand(editor.commit, { type, source: url, sourceDuration: duration, startTime });
      if (layerId) setLayerTrack(editor.commit, layerId, track);
    }
  }

  mediaStore.showToast(`Imported ${fileArr.length} file${fileArr.length > 1 ? "s" : ""}`);
  const s = useEditorStore.getState();
  s.bridge?.seek(s.currentFrame);
}

export function openHelp(): void {
  useHelpStore.getState().open();
}

export function showMcpInstructions(): void {
  alert([
    "Filmidi Editor — MCP Server",
    "",
    "Endpoint: http://127.0.0.1:19790/mcp",
    "",
    "To connect from Claude Desktop:",
    "1. Open Claude Desktop Settings",
    "2. Add an MCP server with URL http://127.0.0.1:19790/mcp",
    "3. Start Filmidi Editor first",
  ].join("\n"));
}

export function sendFeedback(): void {
  const message = window.prompt("Feedback", "");
  if (!message || !message.trim()) return;
  console.log("[feedback]", message.trim());
  alert("Feedback captured locally. Share the console output with the maintainer.");
}
