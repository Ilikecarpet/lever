# Lever UI — React Migration Design

## Overview

Migrate Lever's frontend from a monolithic vanilla HTML/CSS/JS file (`ui/index.html`, 1527 lines) to a Vite + React + TypeScript application with CSS Modules and Zustand for state management. The Rust/Tauri backend remains unchanged.

## Tech Stack

- **Framework**: React 18+ with TypeScript
- **Build tool**: Vite
- **Styling**: CSS Modules + global CSS variables
- **State management**: Zustand
- **Terminal**: `@xterm/xterm` + `@xterm/addon-fit` (npm packages, replacing vendored files)
- **Tauri**: `@tauri-apps/api` v2

## Approach

Scaffold a fresh Vite + React + TS project in the `ui/` directory. Rebuild the UI as React components, migrating existing logic and styles from `index.html`. The Rust backend stays untouched — only the frontend layer changes.

## Component Architecture

```
App
├── Sidebar
│   ├── GroupList
│   │   └── GroupItem
│   │       ├── GroupHeader (name, git branch badge, start/stop all)
│   │       ├── ServiceItem (name, status indicator, start/stop, view log)
│   │       └── GitBranchBadge
│   └── SidebarFooter (add group, settings)
├── MainPanel
│   ├── TabBar
│   │   └── Tab (terminal tab, closeable)
│   ├── TerminalView (xterm.js instance per tab)
│   ├── LogOverlay (service log viewer)
│   └── GitPanel (branch list, commits, PRs, status)
├── Modals
│   ├── ConfigModal (edit group/service definitions)
│   └── ConfirmModal (destructive action confirmation)
└── StatusBar (connection status, running service count)
```

## File Structure

```
ui/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── App.module.css
│   ├── global.css                  (CSS variables, resets)
│   ├── components/
│   │   ├── Sidebar/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── Sidebar.module.css
│   │   │   ├── GroupItem.tsx
│   │   │   ├── GroupItem.module.css
│   │   │   ├── ServiceItem.tsx
│   │   │   └── ServiceItem.module.css
│   │   ├── MainPanel/
│   │   │   ├── MainPanel.tsx
│   │   │   ├── MainPanel.module.css
│   │   │   ├── TabBar.tsx
│   │   │   ├── TabBar.module.css
│   │   │   ├── TerminalView.tsx
│   │   │   ├── TerminalView.module.css
│   │   │   ├── LogOverlay.tsx
│   │   │   ├── LogOverlay.module.css
│   │   │   ├── GitPanel.tsx
│   │   │   └── GitPanel.module.css
│   │   ├── Modals/
│   │   │   ├── ConfigModal.tsx
│   │   │   ├── ConfigModal.module.css
│   │   │   ├── ConfirmModal.tsx
│   │   │   └── ConfirmModal.module.css
│   │   └── StatusBar/
│   │       ├── StatusBar.tsx
│   │       └── StatusBar.module.css
│   ├── stores/
│   │   ├── configStore.ts
│   │   ├── serviceStore.ts
│   │   ├── terminalStore.ts
│   │   └── gitStore.ts
│   ├── hooks/
│   │   ├── useTauriEvent.ts
│   │   └── usePty.ts
│   ├── lib/
│   │   └── tauri.ts
│   └── types/
│       └── index.ts
```

## State Management (Zustand)

### `configStore`
- `groups: ServiceGroup[]` — loaded from backend on init
- `loadConfig()` — calls `invoke('get_config')`
- `saveConfig(config)` — calls `invoke('save_config')`
- `addGroup()`, `updateGroup()`, `removeGroup()`
- `addService()`, `updateService()`, `removeService()`

### `serviceStore`
- `statuses: Record<string, 'running' | 'stopped'>` — per service
- `poll()` — calls `invoke('poll')`, updates statuses
- `startService(groupId, serviceId)` / `stopService(...)`
- `startGroup(groupId)` / `stopGroup(groupId)`
- Polling interval on mount (~2s, matching current behavior)

### `terminalStore`
- `tabs: Tab[]` — `{ id, title, ptyId }`
- `activeTabId: string`
- `addTab()` / `closeTab(id)` / `setActiveTab(id)`
- xterm.js Terminal instances managed in `usePty` hook (not in store — DOM refs don't belong in Zustand)

### `gitStore`
- `gitInfo: Record<string, GitInfo>` — per group
- `refreshGitInfo(groupId)` — calls `invoke('git_info')`
- `checkout(groupId, branch)` / `fetch(groupId)` / `pull(groupId)`
- `getPrList(groupId)`

## Data Flow

```
User action → Component → Store action → invoke() → Rust backend
                                                         ↓
Component ← Store update ← Zustand set() ←──────── Response

Backend event (pty-data, log) → useTauriEvent hook → Component update
```

## Tauri IPC Layer (`lib/tauri.ts`)

Typed wrapper around `@tauri-apps/api`:

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export const api = {
  getConfig: () => invoke<AppConfig>('get_config'),
  saveConfig: (config: AppConfig) => invoke('save_config', { config }),
  startService: (groupId: string, serviceId: string, cwd: string, cmd: string, args: string[]) =>
    invoke('start_service', { groupId, serviceId, cwd, cmd, args }),
  stopService: (serviceId: string, stopCmd?: string) =>
    invoke('stop_service', { serviceId, stopCmd }),
  poll: () => invoke<Record<string, string>>('poll'),
  createPty: (id: string, cwd: string) => invoke('create_pty', { id, cwd }),
  writePty: (id: string, data: string) => invoke('write_pty', { id, data }),
  resizePty: (id: string, cols: number, rows: number) => invoke('resize_pty', { id, cols, rows }),
  closePty: (id: string) => invoke('close_pty', { id }),
  gitInfo: (repoPath: string) => invoke<GitInfo>('git_info', { repoPath }),
  gitCheckout: (repoPath: string, branch: string) => invoke('git_checkout', { repoPath, branch }),
  gitFetch: (repoPath: string) => invoke('git_fetch', { repoPath }),
  gitPull: (repoPath: string) => invoke('git_pull', { repoPath }),
  gitPrList: (repoPath: string) => invoke<PrInfo[]>('git_pr_list', { repoPath }),
};
```

## Key Hooks

### `useTauriEvent(event, callback)`
Subscribe/unsubscribe to backend events with React lifecycle cleanup.

### `usePty(ptyId, containerRef)`
Manages xterm Terminal lifecycle:
- Creates Terminal + FitAddon on mount
- Listens for `pty-data` events filtered by pty ID
- Sends keystrokes via `api.writePty()`
- Handles resize via `api.resizePty()`
- Cleans up terminal + listener on unmount

## Tauri Config Changes

- `tauri.conf.json`: `frontendDist` changes from `../ui` to `../ui/dist`
- Add `beforeBuildCommand` and `beforeDevCommand` for Vite

## Styling

- Global CSS variables defined in `global.css` (migrated from existing `<style>` block)
- Per-component styles in `.module.css` files
- Existing dark theme preserved: `#0c0e14` bg, `#111420` sidebar, green/red/yellow/blue accents

## Backend

No changes to the Rust backend. All 14 Tauri commands and event emissions remain identical.
