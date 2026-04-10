import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppConfig,
  PollResult,
  PtyInfo,
  GitRepoInfo,
} from "../types";

// ---------------------------------------------------------------------------
// Config commands
// ---------------------------------------------------------------------------

export function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export function saveConfig(config: AppConfig): Promise<void> {
  return invoke<void>("save_config", { config });
}

// ---------------------------------------------------------------------------
// Service commands
// ---------------------------------------------------------------------------

export function startService(id: string): Promise<void> {
  return invoke<void>("start_service", { id });
}

export function stopService(id: string): Promise<void> {
  return invoke<void>("stop_service", { id });
}

export function poll(): Promise<PollResult> {
  return invoke<PollResult>("poll");
}

// ---------------------------------------------------------------------------
// PTY commands
// ---------------------------------------------------------------------------

export function createPty(cols: number, rows: number): Promise<PtyInfo> {
  return invoke<PtyInfo>("create_pty", { cols, rows });
}

export function writePty(id: string, data: string): Promise<void> {
  return invoke<void>("write_pty", { id, data });
}

export function resizePty(
  id: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke<void>("resize_pty", { id, cols, rows });
}

export function closePty(id: string): Promise<void> {
  return invoke<void>("close_pty", { id });
}

// ---------------------------------------------------------------------------
// Git commands
// ---------------------------------------------------------------------------

export function gitInfo(path: string): Promise<GitRepoInfo> {
  return invoke<GitRepoInfo>("git_info", { path });
}

export function gitFetch(path: string): Promise<void> {
  return invoke<void>("git_fetch", { path });
}

export function gitPull(path: string): Promise<string> {
  return invoke<string>("git_pull", { path });
}

// ---------------------------------------------------------------------------
// Event listener helper
// ---------------------------------------------------------------------------

export function tauriListen<T>(
  event: string,
  callback: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => callback(e.payload));
}
