# React Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Lever's vanilla HTML/CSS/JS frontend to Vite + React + TypeScript with CSS Modules and Zustand, preserving all existing functionality.

**Architecture:** Scaffold a fresh Vite + React + TS project in `ui/`. Break the monolithic `index.html` into focused React components. The Rust/Tauri backend stays completely untouched. Zustand stores manage app state; a typed IPC layer wraps Tauri's `invoke`/`listen`. xterm.js is installed from npm instead of vendored.

**Tech Stack:** Vite, React 18, TypeScript, CSS Modules, Zustand, @xterm/xterm, @tauri-apps/api v2

---

### Task 1: Scaffold Vite + React + TypeScript project

**Files:**
- Create: `ui/package.json`
- Create: `ui/tsconfig.json`
- Create: `ui/tsconfig.node.json`
- Create: `ui/vite.config.ts`
- Create: `ui/index.html`
- Create: `ui/src/main.tsx`
- Create: `ui/src/vite-env.d.ts`

- [ ] **Step 1: Back up the old UI and scaffold project**

Rename the old UI files so they're preserved during migration:

```bash
cd /Users/onil/Repos/Personal/lever
mv ui/index.html ui/index.old.html
mv ui/vendor ui/vendor.old
```

- [ ] **Step 2: Create package.json**

Create `ui/package.json`:

```json
{
  "name": "lever-ui",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

Create `ui/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create vite.config.ts**

Create `ui/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
```

- [ ] **Step 5: Create index.html**

Create `ui/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lever</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create entry point and env types**

Create `ui/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./global.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

Create `ui/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

Create a placeholder `ui/src/App.tsx`:

```tsx
export default function App() {
  return <div>Lever</div>;
}
```

Create an empty `ui/src/global.css`:

```css
/* placeholder */
```

- [ ] **Step 7: Install dependencies and verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui
npm install
npm run build
```

Expected: Build succeeds, `ui/dist/` directory created with bundled output.

- [ ] **Step 8: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/package.json ui/package-lock.json ui/tsconfig.json ui/tsconfig.node.json ui/vite.config.ts ui/index.html ui/src/
git commit -m "scaffold: Vite + React + TypeScript project in ui/"
```

---

### Task 2: Global CSS and TypeScript types

**Files:**
- Create: `ui/src/global.css`
- Create: `ui/src/types/index.ts`

- [ ] **Step 1: Create global.css with CSS variables and resets**

Migrate the CSS variables and base styles from `ui/index.old.html` (lines 9-37) into `ui/src/global.css`:

```css
:root {
  --bg: #0c0e14;
  --sidebar-bg: #111420;
  --surface: #181c2a;
  --surface-hover: #1e2336;
  --border: #232839;
  --text: #e2e5f0;
  --text-dim: #6c7294;
  --text-muted: #3d4463;
  --green: #34d399;
  --green-dim: rgba(52, 211, 153, 0.12);
  --red: #f87171;
  --red-dim: rgba(248, 113, 113, 0.12);
  --yellow: #fbbf24;
  --blue: #60a5fa;
  --blue-dim: rgba(96, 165, 250, 0.12);
  --terminal-bg: #0a0c12;
  --font-mono: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui,
    sans-serif;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

#root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

::-webkit-scrollbar {
  width: 4px;
}
::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 4px;
}
```

- [ ] **Step 2: Create TypeScript types**

Create `ui/src/types/index.ts` — these mirror the Rust structs from `src-tauri/src/main.rs`:

```ts
// Mirrors Rust ServiceDef (main.rs:21-36)
export interface ServiceDef {
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  cwd: string;
  service_type: string;
  stop_command: string[];
}

// Mirrors Rust ServiceGroup (main.rs:42-50)
export interface ServiceGroup {
  id: string;
  label: string;
  services: ServiceDef[];
  repo_path: string;
}

// Mirrors Rust AppConfig (main.rs:52-56)
export interface AppConfig {
  groups: ServiceGroup[];
}

// Mirrors Rust ServiceStatus (main.rs:150-154)
export interface ServiceStatus {
  id: string;
  status: "running" | "stopped";
}

// Mirrors Rust PollResult (main.rs:156-160)
export interface PollResult {
  statuses: ServiceStatus[];
  logs: Record<string, string[]>;
}

// Mirrors Rust PtyInfo (main.rs:162-165)
export interface PtyInfo {
  id: string;
}

// Mirrors Rust PtyDataEvent (main.rs:136-140)
export interface PtyDataEvent {
  id: string;
  data: string;
}

// Mirrors Rust GitBranchInfo (main.rs:585-589)
export interface GitBranchInfo {
  name: string;
  is_current: boolean;
  is_remote: boolean;
}

// Mirrors Rust GitCommitInfo (main.rs:591-598)
export interface GitCommitInfo {
  hash: string;
  short_hash: string;
  summary: string;
  author: string;
  time_ago: string;
}

// Mirrors Rust GitFileStatus (main.rs:600-605)
export interface GitFileStatus {
  path: string;
  status: "modified" | "new" | "deleted" | "renamed" | "typechange";
  staged: boolean;
}

// Mirrors Rust GitRepoInfo (main.rs:607-614)
export interface GitRepoInfo {
  current_branch: string;
  branches: GitBranchInfo[];
  is_dirty: boolean;
  changed_files: GitFileStatus[];
  recent_commits: GitCommitInfo[];
}

// Mirrors Rust GitPrInfo (main.rs:616-625)
export interface GitPrInfo {
  number: number;
  title: string;
  author: string;
  branch: string;
  state: string;
  url: string;
  is_draft: boolean;
  updated: string;
}

// UI-only types
export interface TerminalTab {
  id: string;
  label: string;
  ptyId: string | null;
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/global.css ui/src/types/
git commit -m "feat: add global CSS variables and TypeScript type definitions"
```

---

### Task 3: Tauri IPC layer

**Files:**
- Create: `ui/src/lib/tauri.ts`

- [ ] **Step 1: Create typed IPC wrapper**

Create `ui/src/lib/tauri.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppConfig,
  PollResult,
  PtyInfo,
  GitRepoInfo,
  GitPrInfo,
} from "../types";

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),

  saveConfig: (config: AppConfig) => invoke("save_config", { config }),

  startService: (id: string) => invoke("start_service", { id }),

  stopService: (id: string) => invoke("stop_service", { id }),

  poll: () => invoke<PollResult>("poll"),

  createPty: (cols: number, rows: number) =>
    invoke<PtyInfo>("create_pty", { cols, rows }),

  writePty: (id: string, data: string) =>
    invoke("write_pty", { id, data }),

  resizePty: (id: string, cols: number, rows: number) =>
    invoke("resize_pty", { id, cols, rows }),

  closePty: (id: string) => invoke("close_pty", { id }),

  gitInfo: (path: string) => invoke<GitRepoInfo>("git_info", { path }),

  gitCheckout: (path: string, branch: string, isRemote: boolean) =>
    invoke("git_checkout", { path, branch, isRemote }),

  gitFetch: (path: string) => invoke("git_fetch", { path }),

  gitPull: (path: string) => invoke<string>("git_pull", { path }),

  gitPrList: (path: string) => invoke<GitPrInfo[]>("git_pr_list", { path }),
};

export function tauriListen<T>(
  event: string,
  callback: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => callback(e.payload));
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/lib/
git commit -m "feat: add typed Tauri IPC wrapper"
```

---

### Task 4: Zustand stores

**Files:**
- Create: `ui/src/stores/configStore.ts`
- Create: `ui/src/stores/serviceStore.ts`
- Create: `ui/src/stores/terminalStore.ts`
- Create: `ui/src/stores/gitStore.ts`

- [ ] **Step 1: Create configStore**

Create `ui/src/stores/configStore.ts`:

```ts
import { create } from "zustand";
import type { AppConfig, ServiceDef, ServiceGroup } from "../types";
import { api } from "../lib/tauri";

interface ConfigState {
  groups: ServiceGroup[];
  loaded: boolean;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;
  setGroups: (groups: ServiceGroup[]) => void;
  addGroup: (group: ServiceGroup) => void;
  removeGroup: (groupId: string) => void;
  updateGroup: (groupId: string, updates: Partial<ServiceGroup>) => void;
  addService: (groupId: string, service: ServiceDef) => void;
  updateService: (groupId: string, index: number, service: ServiceDef) => void;
  moveService: (
    fromGroupId: string,
    index: number,
    toGroupId: string,
    service: ServiceDef
  ) => void;
  removeService: (groupId: string, index: number) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  groups: [],
  loaded: false,

  loadConfig: async () => {
    try {
      const config = await api.getConfig();
      set({ groups: config.groups, loaded: true });
    } catch {
      set({ groups: [], loaded: true });
    }
  },

  saveConfig: async () => {
    const config: AppConfig = { groups: get().groups };
    await api.saveConfig(config);
  },

  setGroups: (groups) => set({ groups }),

  addGroup: (group) => {
    set((s) => ({ groups: [...s.groups, group] }));
    get().saveConfig();
  },

  removeGroup: (groupId) => {
    set((s) => ({ groups: s.groups.filter((g) => g.id !== groupId) }));
    get().saveConfig();
  },

  updateGroup: (groupId, updates) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId ? { ...g, ...updates } : g
      ),
    }));
    get().saveConfig();
  },

  addService: (groupId, service) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId ? { ...g, services: [...g.services, service] } : g
      ),
    }));
    get().saveConfig();
  },

  updateService: (groupId, index, service) => {
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        const services = [...g.services];
        services[index] = service;
        return { ...g, services };
      }),
    }));
    get().saveConfig();
  },

  moveService: (fromGroupId, index, toGroupId, service) => {
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id === fromGroupId) {
          const services = [...g.services];
          services.splice(index, 1);
          return { ...g, services };
        }
        if (g.id === toGroupId) {
          return { ...g, services: [...g.services, service] };
        }
        return g;
      }),
    }));
    get().saveConfig();
  },

  removeService: (groupId, index) => {
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        const services = [...g.services];
        services.splice(index, 1);
        return { ...g, services };
      }),
    }));
    get().saveConfig();
  },
}));
```

- [ ] **Step 2: Create serviceStore**

Create `ui/src/stores/serviceStore.ts`:

```ts
import { create } from "zustand";
import { api } from "../lib/tauri";

interface ServiceState {
  statuses: Record<string, "running" | "stopped">;
  logs: Record<string, string[]>;
  activeLogSvcId: string | null;
  poll: () => Promise<void>;
  startService: (id: string) => Promise<void>;
  stopService: (id: string) => Promise<void>;
  appendLog: (svcId: string, line: string) => void;
  clearLog: (svcId: string) => void;
  setActiveLog: (svcId: string | null) => void;
}

const MAX_LOG_LINES = 3000;

export const useServiceStore = create<ServiceState>((set, get) => ({
  statuses: {},
  logs: {},
  activeLogSvcId: null,

  poll: async () => {
    try {
      const result = await api.poll();
      const newStatuses: Record<string, "running" | "stopped"> = {};
      for (const s of result.statuses) {
        newStatuses[s.id] = s.status;
      }
      set({ statuses: newStatuses });

      // Append polled logs
      for (const [id, lines] of Object.entries(result.logs)) {
        for (const line of lines) {
          get().appendLog(id, line);
        }
      }
    } catch {
      // poll failed, ignore
    }
  },

  startService: async (id) => {
    try {
      await api.startService(id);
    } catch (e) {
      get().appendLog(id, "[error] " + e);
    }
  },

  stopService: async (id) => {
    try {
      await api.stopService(id);
    } catch (e) {
      get().appendLog(id, "[error] " + e);
    }
  },

  appendLog: (svcId, line) => {
    set((s) => {
      const existing = s.logs[svcId] || [];
      const updated = [...existing, line];
      while (updated.length > MAX_LOG_LINES) updated.shift();
      return { logs: { ...s.logs, [svcId]: updated } };
    });
  },

  clearLog: (svcId) => {
    set((s) => ({ logs: { ...s.logs, [svcId]: [] } }));
  },

  setActiveLog: (svcId) => set({ activeLogSvcId: svcId }),
}));
```

- [ ] **Step 3: Create terminalStore**

Create `ui/src/stores/terminalStore.ts`:

```ts
import { create } from "zustand";
import type { TerminalTab } from "../types";

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  counter: number;
  addTab: () => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  setPtyId: (tabId: string, ptyId: string) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  counter: 0,

  addTab: () => {
    const next = get().counter + 1;
    const tabId = `tab-${next}`;
    const tab: TerminalTab = { id: tabId, label: "Terminal", ptyId: null };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tabId,
      counter: next,
    }));
    return tabId;
  },

  closeTab: (id) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id
          ? tabs.length > 0
            ? tabs[tabs.length - 1].id
            : null
          : s.activeTabId;
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  setPtyId: (tabId, ptyId) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ptyId } : t)),
    }));
  },
}));
```

- [ ] **Step 4: Create gitStore**

Create `ui/src/stores/gitStore.ts`:

```ts
import { create } from "zustand";
import type { GitRepoInfo, GitPrInfo } from "../types";
import { api } from "../lib/tauri";

interface GitState {
  gitInfo: Record<string, GitRepoInfo>;
  prCache: Record<string, GitPrInfo[]>;
  activeGitGroupId: string | null;
  statusMessage: string;
  refreshGitInfo: (groupId: string, repoPath: string) => Promise<void>;
  refreshAllGit: (
    groups: { id: string; repo_path: string }[]
  ) => Promise<void>;
  loadPrs: (groupId: string, repoPath: string) => Promise<void>;
  checkout: (
    groupId: string,
    repoPath: string,
    branch: string,
    isRemote: boolean
  ) => Promise<void>;
  fetch: (groupId: string, repoPath: string) => Promise<void>;
  pull: (groupId: string, repoPath: string) => Promise<void>;
  setActiveGitGroup: (groupId: string | null) => void;
  setStatusMessage: (msg: string) => void;
}

export const useGitStore = create<GitState>((set, get) => ({
  gitInfo: {},
  prCache: {},
  activeGitGroupId: null,
  statusMessage: "",

  refreshGitInfo: async (groupId, repoPath) => {
    if (!repoPath) return;
    try {
      const info = await api.gitInfo(repoPath);
      set((s) => ({ gitInfo: { ...s.gitInfo, [groupId]: info } }));
    } catch {
      // ignore
    }
  },

  refreshAllGit: async (groups) => {
    for (const g of groups) {
      if (g.repo_path) {
        get().refreshGitInfo(g.id, g.repo_path);
      }
    }
  },

  loadPrs: async (groupId, repoPath) => {
    if (!repoPath) return;
    try {
      const prs = await api.gitPrList(repoPath);
      set((s) => ({ prCache: { ...s.prCache, [groupId]: prs } }));
    } catch {
      // ignore
    }
  },

  checkout: async (groupId, repoPath, branch, isRemote) => {
    try {
      await api.gitCheckout(repoPath, branch, isRemote);
      await get().refreshGitInfo(groupId, repoPath);
    } catch (e) {
      set({ statusMessage: "Checkout failed: " + e });
      setTimeout(() => set({ statusMessage: "" }), 4000);
      await get().refreshGitInfo(groupId, repoPath);
    }
  },

  fetch: async (groupId, repoPath) => {
    set({ statusMessage: "Fetching..." });
    try {
      await api.gitFetch(repoPath);
      set({ statusMessage: "Fetch complete" });
      await get().refreshGitInfo(groupId, repoPath);
      get().loadPrs(groupId, repoPath);
    } catch (e) {
      set({ statusMessage: "Fetch failed: " + e });
    }
    setTimeout(() => set({ statusMessage: "" }), 3000);
  },

  pull: async (groupId, repoPath) => {
    set({ statusMessage: "Pulling..." });
    try {
      await api.gitPull(repoPath);
      set({ statusMessage: "Pull complete" });
      await get().refreshGitInfo(groupId, repoPath);
    } catch (e) {
      set({ statusMessage: "Pull failed: " + e });
    }
    setTimeout(() => set({ statusMessage: "" }), 3000);
  },

  setActiveGitGroup: (groupId) => set({ activeGitGroupId: groupId }),

  setStatusMessage: (msg) => set({ statusMessage: msg }),
}));
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/stores/
git commit -m "feat: add Zustand stores for config, services, terminals, and git"
```

---

### Task 5: React hooks

**Files:**
- Create: `ui/src/hooks/useTauriEvent.ts`
- Create: `ui/src/hooks/usePty.ts`

- [ ] **Step 1: Create useTauriEvent hook**

Create `ui/src/hooks/useTauriEvent.ts`:

```ts
import { useEffect } from "react";
import { tauriListen } from "../lib/tauri";

export function useTauriEvent<T>(
  event: string,
  callback: (payload: T) => void
) {
  useEffect(() => {
    const unlisten = tauriListen<T>(event, callback);
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
}
```

- [ ] **Step 2: Create usePty hook**

Create `ui/src/hooks/usePty.ts`:

```ts
import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "../lib/tauri";
import { tauriListen } from "../lib/tauri";
import { useTerminalStore } from "../stores/terminalStore";
import type { PtyDataEvent } from "../types";

const THEME = {
  background: "#0a0c12",
  foreground: "#e2e5f0",
  cursor: "#60a5fa",
  selectionBackground: "rgba(96,165,250,0.3)",
  black: "#1a1d27",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#a78bfa",
  cyan: "#22d3ee",
  white: "#e2e5f0",
  brightBlack: "#6c7294",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

export function usePty(tabId: string, containerRef: React.RefObject<HTMLDivElement | null>) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const setPtyId = useTerminalStore((s) => s.setPtyId);

  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const fit = useCallback(() => {
    fitRef.current?.fit();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'JetBrains Mono', 'Fira Code', monospace",
      theme: THEME,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    let unlistenFn: (() => void) | null = null;

    // Create PTY and wire up
    api
      .createPty(term.cols, term.rows)
      .then((info) => {
        ptyIdRef.current = info.id;
        setPtyId(tabId, info.id);

        // Send keystrokes to PTY
        term.onData((data) => {
          api.writePty(info.id, data).catch(() => {});
        });

        // Handle resize
        term.onResize(({ cols, rows }) => {
          api.resizePty(info.id, cols, rows).catch(() => {});
        });

        // Listen for PTY output
        tauriListen<PtyDataEvent>("pty-data", (payload) => {
          if (payload.id === info.id) {
            term.write(payload.data);
          }
        }).then((unlisten) => {
          unlistenFn = unlisten;
        });

        term.focus();
      })
      .catch((e) => {
        term.write(`\r\nFailed to create terminal: ${e}\r\n`);
      });

    // ResizeObserver for container
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => fitAddon.fit(), 50);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (unlistenFn) unlistenFn();
      if (ptyIdRef.current) {
        api.closePty(ptyIdRef.current).catch(() => {});
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  return { focus, fit };
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/hooks/
git commit -m "feat: add useTauriEvent and usePty hooks"
```

---

### Task 6: StatusBar component

**Files:**
- Create: `ui/src/components/StatusBar/StatusBar.tsx`
- Create: `ui/src/components/StatusBar/StatusBar.module.css`

- [ ] **Step 1: Create StatusBar CSS module**

Create `ui/src/components/StatusBar/StatusBar.module.css`:

```css
.statusbar {
  height: 22px;
  background: var(--sidebar-bg);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 10px;
  color: var(--text-muted);
  gap: 14px;
}

.info {
  flex: 1;
}
```

- [ ] **Step 2: Create StatusBar component**

Create `ui/src/components/StatusBar/StatusBar.tsx`:

```tsx
import { useConfigStore } from "../../stores/configStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useGitStore } from "../../stores/gitStore";
import styles from "./StatusBar.module.css";

export default function StatusBar() {
  const groups = useConfigStore((s) => s.groups);
  const statuses = useServiceStore((s) => s.statuses);
  const statusMessage = useGitStore((s) => s.statusMessage);

  const allServices = groups.flatMap((g) => g.services);
  const running = allServices.filter(
    (s) => (statuses[s.id] || "stopped") === "running"
  ).length;

  return (
    <div className={styles.statusbar}>
      <span>
        {running}/{allServices.length} running
      </span>
      <span className={styles.info}>{statusMessage}</span>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/StatusBar/
git commit -m "feat: add StatusBar component"
```

---

### Task 7: ServiceItem component

**Files:**
- Create: `ui/src/components/Sidebar/ServiceItem.tsx`
- Create: `ui/src/components/Sidebar/ServiceItem.module.css`

- [ ] **Step 1: Create ServiceItem CSS module**

Create `ui/src/components/Sidebar/ServiceItem.module.css`:

```css
.svcItem {
  padding: 6px 14px 6px 22px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: background 0.1s;
  font-size: 12px;
}
.svcItem:hover {
  background: var(--surface-hover);
}

.svcDot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.svcDot.running {
  background: var(--green);
  box-shadow: 0 0 5px rgba(52, 211, 153, 0.4);
}

.svcName {
  flex: 1;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.svcBadge {
  font-size: 8px;
  padding: 1px 4px;
  border-radius: 2px;
  font-weight: 700;
  text-transform: uppercase;
  background: var(--blue-dim);
  color: var(--blue);
}

.hoverActions {
  display: flex;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.1s;
}
.svcItem:hover .hoverActions {
  opacity: 1;
}

.svcBtn {
  background: none;
  border: none;
  cursor: pointer;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
}
.svcBtn.play {
  color: var(--green);
}
.svcBtn.play:hover {
  background: var(--green-dim);
}
.svcBtn.kill {
  color: var(--red);
}
.svcBtn.kill:hover {
  background: var(--red-dim);
}
.svcBtn:disabled {
  opacity: 0.15;
  cursor: default;
}
```

- [ ] **Step 2: Create ServiceItem component**

Create `ui/src/components/Sidebar/ServiceItem.tsx`:

```tsx
import { useServiceStore } from "../../stores/serviceStore";
import type { ServiceDef } from "../../types";
import styles from "./ServiceItem.module.css";

interface Props {
  service: ServiceDef;
}

export default function ServiceItem({ service }: Props) {
  const status = useServiceStore(
    (s) => s.statuses[service.id] || "stopped"
  );
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);
  const setActiveLog = useServiceStore((s) => s.setActiveLog);

  const isRunning = status === "running";

  return (
    <div className={styles.svcItem} onClick={() => setActiveLog(service.id)}>
      <div
        className={`${styles.svcDot} ${isRunning ? styles.running : ""}`}
      />
      <span className={styles.svcName}>{service.label}</span>
      {service.service_type === "task" && (
        <span className={styles.svcBadge}>Task</span>
      )}
      <div className={styles.hoverActions}>
        <button
          className={`${styles.svcBtn} ${styles.play}`}
          onClick={(e) => {
            e.stopPropagation();
            startService(service.id);
          }}
          disabled={isRunning}
        >
          &#9654;
        </button>
        <button
          className={`${styles.svcBtn} ${styles.kill}`}
          onClick={(e) => {
            e.stopPropagation();
            stopService(service.id);
          }}
          disabled={!isRunning}
        >
          &#9724;
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/Sidebar/ServiceItem.tsx ui/src/components/Sidebar/ServiceItem.module.css
git commit -m "feat: add ServiceItem component"
```

---

### Task 8: GroupItem component

**Files:**
- Create: `ui/src/components/Sidebar/GroupItem.tsx`
- Create: `ui/src/components/Sidebar/GroupItem.module.css`

- [ ] **Step 1: Create GroupItem CSS module**

Create `ui/src/components/Sidebar/GroupItem.module.css`:

```css
.group {
  margin-bottom: 2px;
}

.groupHeader {
  padding: 8px 14px 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}
.groupHeader:hover {
  background: var(--surface-hover);
}

.chevron {
  font-size: 9px;
  color: var(--text-muted);
  transition: transform 0.15s;
  display: inline-block;
  margin-right: 4px;
}
.chevron.collapsed {
  transform: rotate(-90deg);
}

.groupLabel {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 4px;
}

.groupCount {
  font-size: 10px;
  color: var(--text-muted);
  font-weight: 500;
}

.groupActions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.groupHeader:hover .groupActions {
  opacity: 1;
}

.groupBtn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 3px;
  font-weight: 600;
}
.groupBtn.start {
  color: var(--green);
}
.groupBtn.start:hover {
  background: var(--green-dim);
}
.groupBtn.stop {
  color: var(--red);
}
.groupBtn.stop:hover {
  background: var(--red-dim);
}

.services {
  padding: 2px 0;
  overflow: hidden;
  transition: max-height 0.2s ease;
}

.gitBranch {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 14px 6px 26px;
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.gitBranch:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.gitBranchIcon {
  font-size: 12px;
  opacity: 0.7;
}

.gitBranchName {
  font-family: var(--font-mono);
  font-size: 11px;
}

.gitDirty {
  color: var(--yellow);
  font-size: 9px;
  margin-left: 2px;
}
```

- [ ] **Step 2: Create GroupItem component**

Create `ui/src/components/Sidebar/GroupItem.tsx`:

```tsx
import { useState } from "react";
import { useServiceStore } from "../../stores/serviceStore";
import { useGitStore } from "../../stores/gitStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { ServiceGroup } from "../../types";
import ServiceItem from "./ServiceItem";
import styles from "./GroupItem.module.css";

interface Props {
  group: ServiceGroup;
}

export default function GroupItem({ group }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const statuses = useServiceStore((s) => s.statuses);
  const startService = useServiceStore((s) => s.startService);
  const stopService = useServiceStore((s) => s.stopService);
  const gitInfo = useGitStore((s) => s.gitInfo[group.id]);
  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);
  const loadPrs = useGitStore((s) => s.loadPrs);
  const refreshGitInfo = useGitStore((s) => s.refreshGitInfo);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);

  const runningCount = group.services.filter(
    (s) => (statuses[s.id] || "stopped") === "running"
  ).length;

  const handleStartAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const svc of group.services) {
      if (svc.service_type === "task") continue;
      if ((statuses[svc.id] || "stopped") === "running") continue;
      await startService(svc.id);
    }
  };

  const handleStopAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const svc of [...group.services].reverse()) {
      if ((statuses[svc.id] || "stopped") === "running") {
        await stopService(svc.id);
      }
    }
  };

  const handleOpenGitPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveTab(null);
    setActiveGitGroup(group.id);
    loadPrs(group.id, group.repo_path);
    refreshGitInfo(group.id, group.repo_path);
  };

  return (
    <div className={styles.group}>
      <div
        className={styles.groupHeader}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={styles.groupLabel}>
          <span
            className={`${styles.chevron} ${collapsed ? styles.collapsed : ""}`}
          >
            &#9660;
          </span>
          {group.label}
          <span className={styles.groupCount}>
            {runningCount}/{group.services.length}
          </span>
        </span>
        <div className={styles.groupActions}>
          <button
            className={`${styles.groupBtn} ${styles.start}`}
            onClick={handleStartAll}
            title="Start all"
          >
            &#9654;
          </button>
          <button
            className={`${styles.groupBtn} ${styles.stop}`}
            onClick={handleStopAll}
            title="Stop all"
          >
            &#9724;
          </button>
        </div>
      </div>
      {group.repo_path && (
        <div className={styles.gitBranch} onClick={handleOpenGitPanel}>
          <span className={styles.gitBranchIcon}>&#9579;</span>
          <span className={styles.gitBranchName}>
            {gitInfo?.current_branch || "..."}
          </span>
          {gitInfo?.is_dirty && <span className={styles.gitDirty}>&#9679;</span>}
        </div>
      )}
      {!collapsed && (
        <div className={styles.services}>
          {group.services.map((svc) => (
            <ServiceItem key={svc.id} service={svc} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/Sidebar/GroupItem.tsx ui/src/components/Sidebar/GroupItem.module.css
git commit -m "feat: add GroupItem component with git branch indicator"
```

---

### Task 9: Sidebar component

**Files:**
- Create: `ui/src/components/Sidebar/Sidebar.tsx`
- Create: `ui/src/components/Sidebar/Sidebar.module.css`

- [ ] **Step 1: Create Sidebar CSS module**

Create `ui/src/components/Sidebar/Sidebar.module.css`:

```css
.sidebar {
  width: 250px;
  min-width: 250px;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebarTop {
  padding: 14px 14px 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
}

.sidebarTop h1 {
  font-size: 13px;
  font-weight: 700;
}

.iconBtn {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 15px;
  padding: 4px 6px;
  border-radius: 4px;
  line-height: 1;
}
.iconBtn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.sidebarScroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

.addGroupBtn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.addGroupBtn:hover {
  color: var(--text-dim);
  background: var(--surface-hover);
}

.inlineInputWrapper {
  padding: 6px 14px;
}

.inlineInput {
  width: 100%;
  background: var(--terminal-bg);
  border: 1px solid var(--blue);
  border-radius: 4px;
  color: var(--text);
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
  font-family: inherit;
}
```

- [ ] **Step 2: Create Sidebar component**

Create `ui/src/components/Sidebar/Sidebar.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import GroupItem from "./GroupItem";
import styles from "./Sidebar.module.css";

interface Props {
  onOpenSettings: () => void;
}

export default function Sidebar({ onOpenSettings }: Props) {
  const groups = useConfigStore((s) => s.groups);
  const addGroup = useConfigStore((s) => s.addGroup);
  const [addingGroup, setAddingGroup] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingGroup && inputRef.current) {
      inputRef.current.focus();
    }
  }, [addingGroup]);

  const handleAddGroup = () => {
    setAddingGroup(true);
  };

  const handleAddGroupSubmit = (value: string) => {
    setAddingGroup(false);
    const name = value.trim();
    if (!name) return;
    const gid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (groups.find((g) => g.id === gid)) return;
    addGroup({ id: gid, label: name, services: [], repo_path: "" });
  };

  return (
    <div className={styles.sidebar}>
      <div className={styles.sidebarTop}>
        <h1>Lever</h1>
        <button
          className={styles.iconBtn}
          onClick={onOpenSettings}
          title="Settings"
        >
          &#9881;
        </button>
      </div>
      <div className={styles.sidebarScroll}>
        {groups.map((group) => (
          <GroupItem key={group.id} group={group} />
        ))}
        {addingGroup ? (
          <div className={styles.inlineInputWrapper}>
            <input
              ref={inputRef}
              className={styles.inlineInput}
              placeholder="Group name..."
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  handleAddGroupSubmit(e.currentTarget.value);
                if (e.key === "Escape") setAddingGroup(false);
              }}
              onBlur={(e) => handleAddGroupSubmit(e.currentTarget.value)}
            />
          </div>
        ) : (
          <button className={styles.addGroupBtn} onClick={handleAddGroup}>
            + Add Group
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/Sidebar/Sidebar.tsx ui/src/components/Sidebar/Sidebar.module.css
git commit -m "feat: add Sidebar component with inline group creation"
```

---

### Task 10: TabBar component

**Files:**
- Create: `ui/src/components/MainPanel/TabBar.tsx`
- Create: `ui/src/components/MainPanel/TabBar.module.css`

- [ ] **Step 1: Create TabBar CSS module**

Create `ui/src/components/MainPanel/TabBar.module.css`:

```css
.tabBar {
  display: flex;
  background: var(--sidebar-bg);
  border-bottom: 1px solid var(--border);
  min-height: 32px;
  overflow-x: auto;
  align-items: stretch;
}
.tabBar::-webkit-scrollbar {
  height: 0;
}

.tab {
  padding: 0 14px;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  flex-shrink: 0;
  font-weight: 500;
}
.tab:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.03);
}
.tab.active {
  color: var(--text);
  border-bottom-color: var(--blue);
  background: var(--bg);
}

.tdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
}

.tclose {
  font-size: 14px;
  opacity: 0;
  color: var(--text-dim);
  padding: 0 2px;
  cursor: pointer;
}
.tab:hover .tclose {
  opacity: 0.5;
}
.tclose:hover {
  opacity: 1 !important;
}

.tabNew {
  padding: 0 10px;
  height: 32px;
  display: flex;
  align-items: center;
  font-size: 16px;
  color: var(--text-muted);
  cursor: pointer;
}
.tabNew:hover {
  color: var(--text);
}
```

- [ ] **Step 2: Create TabBar component**

Create `ui/src/components/MainPanel/TabBar.tsx`:

```tsx
import { useTerminalStore } from "../../stores/terminalStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import styles from "./TabBar.module.css";

export default function TabBar() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const addTab = useTerminalStore((s) => s.addTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActiveGitGroup = useGitStore((s) => s.setActiveGitGroup);
  const setActiveLog = useServiceStore((s) => s.setActiveLog);

  const handleTabClick = (tabId: string) => {
    setActiveGitGroup(null);
    setActiveLog(null);
    setActiveTab(tabId);
  };

  const handleNewTab = () => {
    setActiveGitGroup(null);
    setActiveLog(null);
    addTab();
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeTab(tabId);
  };

  return (
    <div className={styles.tabBar}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.tab} ${activeTabId === tab.id ? styles.active : ""}`}
          onClick={() => handleTabClick(tab.id)}
        >
          <span className={styles.tdot} />
          <span>{tab.label}</span>
          <span
            className={styles.tclose}
            onClick={(e) => handleCloseTab(e, tab.id)}
          >
            &times;
          </span>
        </div>
      ))}
      <div className={styles.tabNew} onClick={handleNewTab} title="New terminal">
        +
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/MainPanel/TabBar.tsx ui/src/components/MainPanel/TabBar.module.css
git commit -m "feat: add TabBar component"
```

---

### Task 11: TerminalView component

**Files:**
- Create: `ui/src/components/MainPanel/TerminalView.tsx`
- Create: `ui/src/components/MainPanel/TerminalView.module.css`

- [ ] **Step 1: Create TerminalView CSS module**

Create `ui/src/components/MainPanel/TerminalView.module.css`:

```css
.termPanel {
  position: absolute;
  inset: 0;
  display: none;
}

.termPanel.active {
  display: flex;
  flex-direction: column;
}

.termContainer {
  flex: 1;
}
```

- [ ] **Step 2: Create TerminalView component**

Create `ui/src/components/MainPanel/TerminalView.tsx`:

```tsx
import { useRef, useEffect } from "react";
import { usePty } from "../../hooks/usePty";
import { useTerminalStore } from "../../stores/terminalStore";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalView.module.css";

interface Props {
  tabId: string;
}

export default function TerminalView({ tabId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isActive = activeTabId === tabId;
  const { focus, fit } = usePty(tabId, containerRef);

  useEffect(() => {
    if (isActive) {
      fit();
      focus();
    }
  }, [isActive, fit, focus]);

  return (
    <div className={`${styles.termPanel} ${isActive ? styles.active : ""}`}>
      <div ref={containerRef} className={styles.termContainer} />
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/MainPanel/TerminalView.tsx ui/src/components/MainPanel/TerminalView.module.css
git commit -m "feat: add TerminalView component with xterm.js integration"
```

---

### Task 12: LogOverlay component

**Files:**
- Create: `ui/src/components/MainPanel/LogOverlay.tsx`
- Create: `ui/src/components/MainPanel/LogOverlay.module.css`

- [ ] **Step 1: Create LogOverlay CSS module**

Create `ui/src/components/MainPanel/LogOverlay.module.css`:

```css
.logOverlay {
  position: absolute;
  inset: 0;
  display: none;
  flex-direction: column;
  background: rgba(10, 12, 18, 0.95);
  backdrop-filter: blur(4px);
  z-index: 10;
  animation: logSlideIn 0.15s ease;
}

.logOverlay.open {
  display: flex;
}

@keyframes logSlideIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.logHeader {
  padding: 8px 16px;
  font-size: 11px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.logActions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.clearBtn {
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.clearBtn:hover {
  background: var(--surface-hover);
}

.closeBtn {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 3px;
  line-height: 1;
}
.closeBtn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.logOutput {
  flex: 1;
  padding: 12px 16px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-dim);
  -webkit-user-select: text;
  user-select: text;
}

.stderr {
  color: var(--yellow);
}
```

- [ ] **Step 2: Create LogOverlay component**

Create `ui/src/components/MainPanel/LogOverlay.tsx`:

```tsx
import { useRef, useEffect } from "react";
import { useServiceStore } from "../../stores/serviceStore";
import { useConfigStore } from "../../stores/configStore";
import styles from "./LogOverlay.module.css";

export default function LogOverlay() {
  const activeLogSvcId = useServiceStore((s) => s.activeLogSvcId);
  const logs = useServiceStore((s) =>
    activeLogSvcId ? s.logs[activeLogSvcId] || [] : []
  );
  const clearLog = useServiceStore((s) => s.clearLog);
  const setActiveLog = useServiceStore((s) => s.setActiveLog);
  const groups = useConfigStore((s) => s.groups);
  const outputRef = useRef<HTMLDivElement>(null);

  const svc = groups
    .flatMap((g) => g.services)
    .find((s) => s.id === activeLogSvcId);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [logs]);

  if (!activeLogSvcId) return null;

  return (
    <div className={`${styles.logOverlay} ${styles.open}`}>
      <div className={styles.logHeader}>
        <span>{(svc?.label || activeLogSvcId) + " output"}</span>
        <div className={styles.logActions}>
          <button
            className={styles.clearBtn}
            onClick={() => clearLog(activeLogSvcId)}
          >
            Clear
          </button>
          <button
            className={styles.closeBtn}
            onClick={() => setActiveLog(null)}
          >
            &times;
          </button>
        </div>
      </div>
      <div ref={outputRef} className={styles.logOutput}>
        {logs.map((line, i) => (
          <span
            key={i}
            className={line.startsWith("[stderr]") ? styles.stderr : undefined}
          >
            {line + "\n"}
          </span>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/MainPanel/LogOverlay.tsx ui/src/components/MainPanel/LogOverlay.module.css
git commit -m "feat: add LogOverlay component for service log viewing"
```

---

### Task 13: GitPanel component

**Files:**
- Create: `ui/src/components/MainPanel/GitPanel.tsx`
- Create: `ui/src/components/MainPanel/GitPanel.module.css`

- [ ] **Step 1: Create GitPanel CSS module**

Create `ui/src/components/MainPanel/GitPanel.module.css`:

```css
.gitPanel {
  position: absolute;
  inset: 0;
  display: none;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}
.gitPanel.active {
  display: flex;
}

.header {
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
}
.header h3 {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.actions {
  display: flex;
  gap: 6px;
}

.btn {
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.btn:hover {
  background: var(--surface-hover);
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}
.body::-webkit-scrollbar {
  width: 6px;
}
.body::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}

.section {
  border-bottom: 1px solid var(--border);
}
.sectionHeader {
  padding: 10px 16px;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}
.sectionHeader:hover {
  background: var(--surface-hover);
}
.sectionCount {
  font-size: 10px;
  font-weight: 500;
  background: var(--surface);
  padding: 1px 6px;
  border-radius: 8px;
}
.sectionBody {
  padding: 0 0 6px;
}

.branchSearch {
  width: calc(100% - 32px);
  margin: 0 16px 6px;
  padding: 6px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}
.branchSearch:focus {
  border-color: var(--blue);
}

.branchItem {
  padding: 5px 16px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  color: var(--text-dim);
}
.branchItem:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.branchItem.current {
  color: var(--green);
  font-weight: 600;
}
.check {
  font-size: 10px;
  width: 14px;
  flex-shrink: 0;
}
.branchName {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.remoteTag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(139, 92, 246, 0.12);
  color: #a78bfa;
  font-family: inherit;
  font-weight: 600;
}

.prItem {
  padding: 8px 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.prItem:hover {
  background: var(--surface-hover);
}
.prRow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.prNumber {
  font-size: 11px;
  color: var(--blue);
  font-weight: 600;
}
.prTitle {
  font-size: 12px;
  color: var(--text);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prDraft {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--surface);
  color: var(--text-muted);
  font-weight: 600;
}
.prMeta {
  font-size: 10px;
  color: var(--text-muted);
  display: flex;
  gap: 8px;
}

.commitItem {
  padding: 5px 16px;
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
}
.commitItem:hover {
  background: var(--surface-hover);
}
.commitHash {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--blue);
  flex-shrink: 0;
}
.commitMsg {
  color: var(--text-dim);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.commitTime {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.fileItem {
  padding: 4px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-dim);
}
.fileItem:hover {
  background: var(--surface-hover);
}
.fileBadge {
  font-size: 9px;
  font-weight: 700;
  width: 14px;
  text-align: center;
  font-family: var(--font-sans);
}
.fileBadge.modified {
  color: var(--yellow);
}
.fileBadge.new {
  color: var(--green);
}
.fileBadge.deleted {
  color: var(--red);
}
.fileBadge.staged {
  color: var(--blue);
}

.loading {
  padding: 20px 16px;
  color: var(--text-muted);
  font-size: 12px;
}
.empty {
  padding: 12px 16px;
  color: var(--text-muted);
  font-size: 11px;
  font-style: italic;
}
.showMore {
  padding: 6px 16px;
  font-size: 11px;
  color: var(--blue);
  cursor: pointer;
  background: none;
  border: none;
  font-family: inherit;
  font-weight: 600;
  width: 100%;
  text-align: left;
}
.showMore:hover {
  background: var(--surface-hover);
}

.statusClean {
  color: var(--green);
  font-size: 10px;
}
.statusDirty {
  color: var(--yellow);
  font-size: 10px;
}
```

- [ ] **Step 2: Create GitPanel component**

Create `ui/src/components/MainPanel/GitPanel.tsx`:

```tsx
import { useState, useMemo } from "react";
import { useGitStore } from "../../stores/gitStore";
import { useConfigStore } from "../../stores/configStore";
import type { GitBranchInfo, GitPrInfo } from "../../types";
import styles from "./GitPanel.module.css";

export default function GitPanel() {
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const gitInfo = useGitStore((s) =>
    activeGitGroupId ? s.gitInfo[activeGitGroupId] : undefined
  );
  const prCache = useGitStore((s) =>
    activeGitGroupId ? s.prCache[activeGitGroupId] : undefined
  );
  const fetchGit = useGitStore((s) => s.fetch);
  const pullGit = useGitStore((s) => s.pull);
  const checkoutGit = useGitStore((s) => s.checkout);
  const groups = useConfigStore((s) => s.groups);
  const group = groups.find((g) => g.id === activeGitGroupId);

  if (!activeGitGroupId || !group) return null;

  if (!gitInfo) {
    return (
      <div className={`${styles.gitPanel} ${styles.active}`}>
        <div className={styles.loading}>Loading git info...</div>
      </div>
    );
  }

  const handleCheckout = (branch: string, isRemote: boolean) => {
    checkoutGit(activeGitGroupId, group.repo_path, branch, isRemote);
  };

  return (
    <div className={`${styles.gitPanel} ${styles.active}`}>
      <div className={styles.header}>
        <h3>
          <span>&#9579;</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {gitInfo.current_branch}
          </span>
          {gitInfo.is_dirty ? (
            <span className={styles.statusDirty}>&#9679; modified</span>
          ) : (
            <span className={styles.statusClean}>clean</span>
          )}
        </h3>
        <div className={styles.actions}>
          <button
            className={styles.btn}
            onClick={() => fetchGit(activeGitGroupId, group.repo_path)}
          >
            Fetch
          </button>
          <button
            className={styles.btn}
            onClick={() => pullGit(activeGitGroupId, group.repo_path)}
          >
            Pull
          </button>
        </div>
      </div>
      <div className={styles.body}>
        {gitInfo.changed_files.length > 0 && (
          <ChangesSection files={gitInfo.changed_files} />
        )}
        <BranchSection
          title="Local branches"
          branches={gitInfo.branches.filter((b) => !b.is_remote)}
          onCheckout={handleCheckout}
        />
        <BranchSection
          title="Remote branches"
          branches={gitInfo.branches.filter((b) => b.is_remote)}
          onCheckout={handleCheckout}
        />
        <PrSection
          prs={prCache}
          gitInfo={gitInfo}
          onCheckout={handleCheckout}
        />
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            Recent commits{" "}
            <span className={styles.sectionCount}>
              {gitInfo.recent_commits.length}
            </span>
          </div>
          <div className={styles.sectionBody}>
            {gitInfo.recent_commits.map((c) => (
              <div key={c.hash} className={styles.commitItem}>
                <span className={styles.commitHash}>{c.short_hash}</span>
                <span className={styles.commitMsg}>{c.summary}</span>
                <span className={styles.commitTime}>{c.time_ago}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChangesSection({
  files,
}: {
  files: { path: string; status: string; staged: boolean }[];
}) {
  const [limit, setLimit] = useState(10);
  const visible = files.slice(0, limit);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        Changes{" "}
        <span className={styles.sectionCount}>{files.length}</span>
      </div>
      <div className={styles.sectionBody}>
        {visible.map((f) => {
          const badge =
            f.status === "new"
              ? "A"
              : f.status === "deleted"
                ? "D"
                : f.status === "renamed"
                  ? "R"
                  : "M";
          const cls = f.staged ? "staged" : f.status;
          return (
            <div key={f.path} className={styles.fileItem}>
              <span className={`${styles.fileBadge} ${styles[cls] || ""}`}>
                {badge}
              </span>
              <span
                style={{
                  flex: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {f.path}
              </span>
              {f.staged && (
                <span style={{ fontSize: 9, color: "var(--blue)" }}>
                  staged
                </span>
              )}
            </div>
          );
        })}
        {limit < files.length && (
          <button
            className={styles.showMore}
            onClick={() => setLimit((l) => l + 10)}
          >
            Show more ({files.length - limit} remaining)
          </button>
        )}
      </div>
    </div>
  );
}

function BranchSection({
  title,
  branches,
  onCheckout,
}: {
  title: string;
  branches: GitBranchInfo[];
  onCheckout: (branch: string, isRemote: boolean) => void;
}) {
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(15);

  const filtered = useMemo(
    () =>
      branches.filter(
        (b) => !filter || b.name.toLowerCase().includes(filter.toLowerCase())
      ),
    [branches, filter]
  );
  const visible = filtered.slice(0, limit);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        {title}{" "}
        <span className={styles.sectionCount}>{branches.length}</span>
      </div>
      <div className={styles.sectionBody}>
        <input
          className={styles.branchSearch}
          placeholder={`Filter ${title.toLowerCase()}...`}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setLimit(15);
          }}
        />
        {filtered.length === 0 ? (
          <div className={styles.empty}>No matching branches</div>
        ) : (
          <>
            {visible.map((b) => (
              <div
                key={b.name}
                className={`${styles.branchItem} ${b.is_current ? styles.current : ""}`}
                onClick={() => !b.is_current && onCheckout(b.name, b.is_remote)}
              >
                <span className={styles.check}>
                  {b.is_current ? "\u2713" : ""}
                </span>
                <span className={styles.branchName}>{b.name}</span>
                {b.is_remote && (
                  <span className={styles.remoteTag}>remote</span>
                )}
              </div>
            ))}
            {limit < filtered.length && (
              <button
                className={styles.showMore}
                onClick={() => setLimit((l) => l + 15)}
              >
                Show more ({filtered.length - limit} remaining)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PrSection({
  prs,
  gitInfo,
  onCheckout,
}: {
  prs: GitPrInfo[] | undefined;
  gitInfo: { branches: GitBranchInfo[] };
  onCheckout: (branch: string, isRemote: boolean) => void;
}) {
  const handlePrClick = (pr: GitPrInfo) => {
    const localMatch = gitInfo.branches.find(
      (b) => !b.is_remote && b.name === pr.branch
    );
    const remoteMatch = gitInfo.branches.find(
      (b) => b.is_remote && b.name.endsWith("/" + pr.branch)
    );
    if (localMatch) onCheckout(pr.branch, false);
    else if (remoteMatch) onCheckout(remoteMatch.name, true);
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        Pull Requests{" "}
        <span className={styles.sectionCount}>
          {prs ? prs.length : "..."}
        </span>
      </div>
      <div className={styles.sectionBody}>
        {!prs ? (
          <div className={styles.loading}>Loading...</div>
        ) : prs.length === 0 ? (
          <div className={styles.empty}>No open pull requests</div>
        ) : (
          prs.map((pr) => (
            <div
              key={pr.number}
              className={styles.prItem}
              onClick={() => handlePrClick(pr)}
            >
              <div className={styles.prRow}>
                <span className={styles.prNumber}>#{pr.number}</span>
                <span className={styles.prTitle}>{pr.title}</span>
                {pr.is_draft && (
                  <span className={styles.prDraft}>Draft</span>
                )}
              </div>
              <div className={styles.prMeta}>
                <span>{pr.author}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {pr.branch}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/MainPanel/GitPanel.tsx ui/src/components/MainPanel/GitPanel.module.css
git commit -m "feat: add GitPanel component with branches, PRs, commits, and changes"
```

---

### Task 14: MainPanel component

**Files:**
- Create: `ui/src/components/MainPanel/MainPanel.tsx`
- Create: `ui/src/components/MainPanel/MainPanel.module.css`

- [ ] **Step 1: Create MainPanel CSS module**

Create `ui/src/components/MainPanel/MainPanel.module.css`:

```css
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.termArea {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--terminal-bg);
}

.emptyState {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
  background: var(--terminal-bg);
}
```

- [ ] **Step 2: Create MainPanel component**

Create `ui/src/components/MainPanel/MainPanel.tsx`:

```tsx
import { useTerminalStore } from "../../stores/terminalStore";
import { useGitStore } from "../../stores/gitStore";
import { useServiceStore } from "../../stores/serviceStore";
import TabBar from "./TabBar";
import TerminalView from "./TerminalView";
import LogOverlay from "./LogOverlay";
import GitPanel from "./GitPanel";
import styles from "./MainPanel.module.css";

export default function MainPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const activeGitGroupId = useGitStore((s) => s.activeGitGroupId);
  const activeLogSvcId = useServiceStore((s) => s.activeLogSvcId);

  const showEmpty = tabs.length === 0 && !activeGitGroupId;

  return (
    <div className={styles.main}>
      <TabBar />
      <div className={styles.termArea}>
        {showEmpty && (
          <div className={styles.emptyState}>Press + to open a terminal</div>
        )}
        {tabs.map((tab) => (
          <TerminalView key={tab.id} tabId={tab.id} />
        ))}
        {activeGitGroupId && !activeTabId && <GitPanel />}
        {activeLogSvcId && <LogOverlay />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/MainPanel/MainPanel.tsx ui/src/components/MainPanel/MainPanel.module.css
git commit -m "feat: add MainPanel component composing tabs, terminals, git, and logs"
```

---

### Task 15: ConfigModal component (settings + service form)

**Files:**
- Create: `ui/src/components/Modals/ConfigModal.tsx`
- Create: `ui/src/components/Modals/ConfigModal.module.css`

- [ ] **Step 1: Create ConfigModal CSS module**

Create `ui/src/components/Modals/ConfigModal.module.css`:

```css
.overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  z-index: 100;
  align-items: center;
  justify-content: center;
}
.overlay.open {
  display: flex;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: 520px;
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modalHeader {
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
}
.modalHeader h2 {
  font-size: 14px;
  font-weight: 600;
}
.headerActions {
  display: flex;
  gap: 6px;
}

.modalBody {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.btn:hover {
  background: var(--surface-hover);
}
.btnPrimary {
  background: var(--blue-dim);
  border-color: rgba(96, 165, 250, 0.3);
  color: var(--blue);
}
.btnDanger {
  color: var(--red);
}
.btnSm {
  padding: 3px 8px;
  font-size: 11px;
}

.groupHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 4px;
}
.groupLabel {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.groupActions {
  display: flex;
  gap: 4px;
}

.repoRow {
  padding: 2px 10px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.repoLabel {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}
.repoInput {
  flex: 1;
  padding: 4px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 11px;
  font-family: var(--font-mono);
  outline: none;
}

.si {
  padding: 8px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-radius: 6px;
}
.si:hover {
  background: var(--surface-hover);
}
.siInfo {
  flex: 1;
}
.siLabel {
  font-size: 13px;
  font-weight: 500;
}
.siMeta {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
}
.siActions {
  display: flex;
  gap: 4px;
}

.svcBadge {
  font-size: 8px;
  padding: 1px 4px;
  border-radius: 2px;
  font-weight: 700;
  text-transform: uppercase;
  background: var(--blue-dim);
  color: var(--blue);
  margin-left: 6px;
}

.emptyGroup {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

/* Form modal */
.formOverlay {
  z-index: 200;
}
.formModal {
  width: 460px;
  padding: 20px;
}

.fg {
  margin-bottom: 12px;
}
.fg label {
  display: block;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-dim);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.fg input,
.fg select {
  width: 100%;
  padding: 7px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}
.fg input:focus,
.fg select:focus {
  border-color: var(--blue);
}
.hint {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 2px;
}

.formActions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

.inlineInput {
  width: 100%;
  background: var(--terminal-bg);
  border: 1px solid var(--blue);
  border-radius: 4px;
  color: var(--text);
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
  font-family: inherit;
}
```

- [ ] **Step 2: Create ConfigModal component**

Create `ui/src/components/Modals/ConfigModal.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import type { ServiceDef } from "../../types";
import styles from "./ConfigModal.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface FormState {
  open: boolean;
  groupId: string;
  index: number; // -1 for new
  label: string;
  command: string;
  args: string;
  cwd: string;
  serviceType: string;
  stopCommand: string;
  description: string;
}

const EMPTY_FORM: FormState = {
  open: false,
  groupId: "",
  index: -1,
  label: "",
  command: "",
  args: "",
  cwd: "",
  serviceType: "service",
  stopCommand: "",
  description: "",
};

export default function ConfigModal({ open, onClose }: Props) {
  const groups = useConfigStore((s) => s.groups);
  const updateGroup = useConfigStore((s) => s.updateGroup);
  const removeGroup = useConfigStore((s) => s.removeGroup);
  const addGroup = useConfigStore((s) => s.addGroup);
  const addService = useConfigStore((s) => s.addService);
  const updateService = useConfigStore((s) => s.updateService);
  const moveService = useConfigStore((s) => s.moveService);
  const removeService = useConfigStore((s) => s.removeService);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && renameRef.current) renameRef.current.focus();
  }, [renaming]);

  const openForm = (groupId?: string, index?: number) => {
    if (groupId !== undefined && index !== undefined && index >= 0) {
      const g = groups.find((g) => g.id === groupId);
      const svc = g?.services[index];
      if (svc) {
        setForm({
          open: true,
          groupId,
          index,
          label: svc.label,
          command: svc.command,
          args: svc.args.join(" "),
          cwd: svc.cwd,
          serviceType: svc.service_type,
          stopCommand: svc.stop_command.join(" "),
          description: svc.description,
        });
        return;
      }
    }
    setForm({ ...EMPTY_FORM, open: true, groupId: groups[0]?.id || "" });
  };

  const saveForm = () => {
    if (!form.label.trim() || !form.command.trim()) return;

    let gid = form.groupId;
    if (gid === "__new__") {
      const name = prompt("New group name:");
      if (!name) return;
      gid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      addGroup({ id: gid, label: name, services: [], repo_path: "" });
    }

    const allIds = groups.flatMap((g) => g.services.map((s) => s.id));
    let svcId: string;
    if (form.index >= 0) {
      const g = groups.find((g) => g.id === form.groupId);
      svcId = g?.services[form.index]?.id || form.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    } else {
      let base = form.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      svcId = base;
      let n = 1;
      while (allIds.includes(svcId)) svcId = base + "-" + ++n;
    }

    const svc: ServiceDef = {
      id: svcId,
      label: form.label.trim(),
      command: form.command.trim(),
      description: form.description.trim(),
      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
      cwd: form.cwd.trim(),
      service_type: form.serviceType,
      stop_command: form.stopCommand.trim()
        ? form.stopCommand.trim().split(/\s+/)
        : [],
    };

    if (form.index >= 0 && form.groupId) {
      if (form.groupId === gid) {
        updateService(gid, form.index, svc);
      } else {
        moveService(form.groupId, form.index, gid, svc);
      }
    } else {
      addService(gid, svc);
    }

    setForm(EMPTY_FORM);
  };

  const handleDeleteGroup = (gid: string, svcCount: number) => {
    if (svcCount > 0 && confirmDelete !== gid) {
      setConfirmDelete(gid);
      setTimeout(() => setConfirmDelete(null), 2000);
      return;
    }
    removeGroup(gid);
    setConfirmDelete(null);
  };

  const handleRename = (gid: string, value: string) => {
    setRenaming(null);
    const name = value.trim();
    if (name) updateGroup(gid, { label: name });
  };

  return (
    <>
      {/* Settings modal */}
      <div
        className={`${styles.overlay} ${open ? styles.open : ""}`}
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className={styles.modal}>
          <div className={styles.modalHeader}>
            <h2>Manage Services</h2>
            <div className={styles.headerActions}>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => openForm()}
              >
                + Add
              </button>
              <button className={styles.btn} onClick={onClose}>
                Done
              </button>
            </div>
          </div>
          <div className={styles.modalBody}>
            {groups.map((group) => (
              <div key={group.id}>
                <div className={styles.groupHeader}>
                  {renaming === group.id ? (
                    <input
                      ref={renameRef}
                      className={styles.inlineInput}
                      defaultValue={group.label}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          handleRename(group.id, e.currentTarget.value);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={(e) =>
                        handleRename(group.id, e.currentTarget.value)
                      }
                    />
                  ) : (
                    <span className={styles.groupLabel}>{group.label}</span>
                  )}
                  <div className={styles.groupActions}>
                    <button
                      className={`${styles.btn} ${styles.btnSm}`}
                      onClick={() => setRenaming(group.id)}
                    >
                      Rename
                    </button>
                    <button
                      className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
                      onClick={() =>
                        handleDeleteGroup(group.id, group.services.length)
                      }
                    >
                      {confirmDelete === group.id ? "Confirm?" : "Delete"}
                    </button>
                  </div>
                </div>
                <div className={styles.repoRow}>
                  <span className={styles.repoLabel}>Repo:</span>
                  <input
                    className={styles.repoInput}
                    defaultValue={group.repo_path || ""}
                    placeholder="/path/to/repo"
                    onBlur={(e) =>
                      updateGroup(group.id, {
                        repo_path: e.target.value.trim(),
                      })
                    }
                  />
                </div>
                {group.services.map((svc, i) => (
                  <div key={svc.id} className={styles.si}>
                    <div className={styles.siInfo}>
                      <div className={styles.siLabel}>
                        {svc.label}
                        <span className={styles.svcBadge}>
                          {svc.service_type}
                        </span>
                      </div>
                      <div className={styles.siMeta}>
                        {svc.command} {svc.args.join(" ")}
                      </div>
                    </div>
                    <div className={styles.siActions}>
                      <button
                        className={`${styles.btn} ${styles.btnSm}`}
                        onClick={() => openForm(group.id, i)}
                      >
                        Edit
                      </button>
                      <button
                        className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
                        onClick={() => removeService(group.id, i)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                {group.services.length === 0 && (
                  <div className={styles.emptyGroup}>
                    No services in this group
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Service form modal */}
      <div
        className={`${styles.overlay} ${styles.formOverlay} ${form.open ? styles.open : ""}`}
        onClick={(e) =>
          e.target === e.currentTarget && setForm(EMPTY_FORM)
        }
      >
        <div className={`${styles.modal} ${styles.formModal}`}>
          <h2 style={{ fontSize: 14, marginBottom: 14 }}>
            {form.index >= 0 ? "Edit Service" : "Add Service"}
          </h2>
          <div className={styles.fg}>
            <label>Group</label>
            <select
              value={form.groupId}
              onChange={(e) => setForm({ ...form, groupId: e.target.value })}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
              <option value="__new__">+ New Group...</option>
            </select>
          </div>
          <div className={styles.fg}>
            <label>Name</label>
            <input
              placeholder="e.g. Docker Compose"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </div>
          <div className={styles.fg}>
            <label>Command</label>
            <input
              placeholder="e.g. docker"
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
            />
          </div>
          <div className={styles.fg}>
            <label>Arguments</label>
            <input
              placeholder="e.g. compose up"
              value={form.args}
              onChange={(e) => setForm({ ...form, args: e.target.value })}
            />
          </div>
          <div className={styles.fg}>
            <label>Working Directory</label>
            <input
              placeholder="/path/to/project"
              value={form.cwd}
              onChange={(e) => setForm({ ...form, cwd: e.target.value })}
            />
          </div>
          <div className={styles.fg}>
            <label>Type</label>
            <select
              value={form.serviceType}
              onChange={(e) =>
                setForm({ ...form, serviceType: e.target.value })
              }
            >
              <option value="service">Service</option>
              <option value="task">Task</option>
            </select>
          </div>
          <div className={styles.fg}>
            <label>Stop Command</label>
            <input
              placeholder="e.g. docker compose stop"
              value={form.stopCommand}
              onChange={(e) =>
                setForm({ ...form, stopCommand: e.target.value })
              }
            />
            <div className={styles.hint}>Optional — runs before killing</div>
          </div>
          <div className={styles.fg}>
            <label>Description</label>
            <input
              placeholder="Optional"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </div>
          <div className={styles.formActions}>
            <button
              className={styles.btn}
              onClick={() => setForm(EMPTY_FORM)}
            >
              Cancel
            </button>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={saveForm}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/components/Modals/
git commit -m "feat: add ConfigModal with service CRUD and group management"
```

---

### Task 16: App component (root layout + initialization)

**Files:**
- Modify: `ui/src/App.tsx`
- Create: `ui/src/App.module.css`

- [ ] **Step 1: Create App CSS module**

Create `ui/src/App.module.css`:

```css
.layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}
```

- [ ] **Step 2: Write the App component**

Replace `ui/src/App.tsx`:

```tsx
import { useState, useEffect, useRef } from "react";
import { useConfigStore } from "./stores/configStore";
import { useServiceStore } from "./stores/serviceStore";
import { useTerminalStore } from "./stores/terminalStore";
import { useGitStore } from "./stores/gitStore";
import { useTauriEvent } from "./hooks/useTauriEvent";
import type { PtyDataEvent } from "./types";
import Sidebar from "./components/Sidebar/Sidebar";
import MainPanel from "./components/MainPanel/MainPanel";
import StatusBar from "./components/StatusBar/StatusBar";
import ConfigModal from "./components/Modals/ConfigModal";
import styles from "./App.module.css";

export default function App() {
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const groups = useConfigStore((s) => s.groups);
  const loaded = useConfigStore((s) => s.loaded);
  const poll = useServiceStore((s) => s.poll);
  const addTab = useTerminalStore((s) => s.addTab);
  const refreshAllGit = useGitStore((s) => s.refreshAllGit);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialized = useRef(false);

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // After config loads, open first terminal tab and start polling
  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;
    addTab();

    // Service poll loop (300ms like original)
    const pollInterval = setInterval(poll, 300);

    // Git poll loop (5s like original)
    const gitInterval = setInterval(() => {
      const currentGroups = useConfigStore.getState().groups;
      refreshAllGit(currentGroups);
    }, 5000);

    // Initial git refresh
    refreshAllGit(groups);

    return () => {
      clearInterval(pollInterval);
      clearInterval(gitInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  return (
    <>
      <div className={styles.layout}>
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
        <MainPanel />
      </div>
      <StatusBar />
      <ConfigModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add ui/src/App.tsx ui/src/App.module.css
git commit -m "feat: add App root component with init, polling, and layout"
```

---

### Task 17: Update Tauri config and .gitignore

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `.gitignore`

- [ ] **Step 1: Update tauri.conf.json to point to Vite build output**

Change `frontendDist` from `"../ui"` to `"../ui/dist"`, and add build commands:

In `src-tauri/tauri.conf.json`, change:

```json
{
  "productName": "Lever",
  "version": "1.0.0",
  "identifier": "com.lever.app",
  "build": {
    "frontendDist": "../ui/dist",
    "beforeDevCommand": "cd ../ui && npm run dev",
    "beforeBuildCommand": "cd ../ui && npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "Lever",
        "width": 900,
        "height": 700,
        "minWidth": 600,
        "minHeight": 400,
        "titleBarStyle": "Visible",
        "decorations": true,
        "resizable": true
      }
    ],
    "security": {
      "csp": null
    }
  }
}
```

- [ ] **Step 2: Update .gitignore**

Add `node_modules` and Vite build output:

```
# Build artifacts
src-tauri/target/

# Node
ui/node_modules/
ui/dist/

# macOS
.DS_Store

# Editor
.idea/
.vscode/
*.swp
*.swo
```

- [ ] **Step 3: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add src-tauri/tauri.conf.json .gitignore
git commit -m "chore: update Tauri config for Vite and update .gitignore"
```

---

### Task 18: Clean up old files and verify

**Files:**
- Delete: `ui/index.old.html`
- Delete: `ui/vendor.old/`

- [ ] **Step 1: Run the full Vite build to verify everything compiles**

```bash
cd /Users/onil/Repos/Personal/lever/ui && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 2: Remove old UI files**

```bash
cd /Users/onil/Repos/Personal/lever
rm ui/index.old.html
rm -rf ui/vendor.old/
```

- [ ] **Step 3: Run a Tauri build to verify the full stack compiles**

```bash
cd /Users/onil/Repos/Personal/lever/src-tauri && cargo build
```

Expected: Rust compilation succeeds (the Tauri backend is unchanged).

- [ ] **Step 4: Commit**

```bash
cd /Users/onil/Repos/Personal/lever
git add -A
git commit -m "chore: remove old vanilla UI files, migration complete"
```

---

### Task 19: Smoke test the app

- [ ] **Step 1: Launch the app in dev mode**

```bash
cd /Users/onil/Repos/Personal/lever/src-tauri && cargo tauri dev
```

- [ ] **Step 2: Verify core functionality**

Manual checks:
1. App window opens at 900x700 with dark theme
2. Sidebar shows service groups from config
3. Click "+" to open a terminal tab — shell prompt appears
4. Type in the terminal and verify keystrokes work
5. Start/stop a service from the sidebar
6. Click a service to view its log overlay
7. Click a git branch badge to open the git panel
8. Open settings (gear icon) — manage services modal appears
9. Status bar shows running service count
10. Add a new group via the sidebar "+ Add Group" button

- [ ] **Step 3: Fix any visual or functional discrepancies**

Compare the React UI against the original vanilla UI. Fix any CSS differences, missing interactions, or broken features.
