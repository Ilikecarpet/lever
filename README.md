<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Lever icon" />
</p>

<h1 align="center">Lever</h1>

<p align="center">
  A desktop app for managing development services, terminals, and Git worktrees — all in one place.
</p>

<p align="center">
  <a href="https://github.com/Ilikecarpet/lever/releases/latest"><img src="https://img.shields.io/github/v/release/Ilikecarpet/lever?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-blue?style=flat-square" alt="Platform" />
  <a href="https://v2.tauri.app"><img src="https://img.shields.io/badge/built%20with-Tauri%202-orange?style=flat-square" alt="Tauri 2" /></a>
</p>

---

Lever replaces the mess of terminal tabs, manually started services, and scattered dev scripts with a single interface. Define your services once, organize them into groups, and start everything with a click. Switch between Git worktrees without losing context. Split terminals like tmux — but with a GUI.

## Features

**Service Management**
- Define services with commands, args, working directories, and optional stop commands
- Organize services into logical groups (e.g. "Backend", "Frontend", "Infrastructure")
- Start/stop services individually or monitor real-time logs
- Automatic log capture to `~/.lever/projects/<id>/logs/`
- Listening ports collected in the status bar and clickable — no hunting for which port a dev server landed on

**Terminal Workspaces**
- Integrated terminal powered by xterm.js
- Split panes vertically and horizontally
- Multiple workspaces per project with quick switching
- Auto-respawn shell on `exit`

**Agent Usage**
- Live context meter in the status bar for the Claude Code session in the focused pane
- Breakdown of what fills the window — cached, newly written, fresh input, reply
- Running session totals: turns, input/output tokens, cache reads and writes, subagent output
- Read from Claude Code's own session files; nothing is attached to the process
- Optional statusLine bridge for the exact context window (200k vs 1M), which is
  otherwise not recorded anywhere on disk — off by default, and it chains to any
  statusLine command you already use
- With the bridge on, the plan's 5-hour and 7-day usage as Claude Code reports it,
  with the time to each reset — account-wide, so it is one figure however many
  sessions are open
- Working/idle read from Claude Code's own record rather than guessed from terminal output
- A pulse on the worktree and workspace when an agent finishes, so the one waiting on
  you stands out across several running at once

**Git Worktrees**
- Create and manage Git worktrees directly from the sidebar
- Each worktree gets its own isolated set of service groups
- Branch autocomplete when creating new worktrees
- Live Git status — current branch, staged/unstaged changes, dirty state

**Project Launcher**
- Start page with project cards showing service counts and last-opened time
- Create projects from any folder with automatic Git detection
- Import/export project configs as JSON
- Clone and rename projects via right-click context menu

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+T` | New workspace |
| `Cmd+D` | Split pane vertically |
| `Cmd+Shift+D` | Split pane horizontally |
| `Cmd+W` | Close pane |
| `Cmd+[` / `Cmd+]` | Focus previous / next pane |
| `Cmd+1` – `Cmd+9` | Switch to workspace by index |
| `Cmd+B` | Toggle the sidebar |
| `Cmd+G` | Toggle the docked git panel |
| `Cmd+Shift+[` / `Cmd+Shift+]` | Cycle worktree context (main repo → worktrees) |

All shortcuts are scoped to the active worktree context.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | [Tauri 2](https://v2.tauri.app) (Rust) |
| Frontend | React 18, TypeScript, Vite |
| State management | Zustand |
| Terminal | xterm.js |
| PTY | portable-pty |
| Git operations | git2 |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Rust](https://rustup.rs) (stable)
- Tauri 2 CLI — `cargo install tauri-cli --version "^2"`

### Development

```bash
# Install frontend dependencies
npm install --prefix ui

# Run in dev mode (starts both Vite and the Tauri window)
cargo tauri dev
```

The frontend dev server runs at `http://localhost:1420` with hot reload. Rust changes trigger an automatic recompile.

### Build

```bash
cargo tauri build
```

Produces a bundled `.app` (macOS) or `.exe` (Windows) in `src-tauri/target/release/bundle/`.

## Installation

Download the latest `.dmg` from [Releases](https://github.com/Ilikecarpet/lever/releases), open it, and drag Lever to Applications.

> **Note:** The app is not code-signed. macOS may flag it as damaged on first launch. Fix with:
> ```
> xattr -cr /Applications/Lever.app
> ```

After that first install, Lever updates itself: it checks the releases feed hourly and offers the new version under Settings → Updates, which downloads, replaces the bundle, and restarts. The quarantine step above is only needed for the manual `.dmg`, never for an update Lever installs on its own.

## Project Structure

```
lever/
├── src-tauri/          Rust backend — PTY management, Git ops, service lifecycle
│   ├── src/main.rs     Tauri command handlers
│   └── Cargo.toml
├── ui/                 React frontend
│   ├── src/
│   │   ├── components/ UI components (Sidebar, MainPanel, StartPage, Modals)
│   │   ├── stores/     Zustand stores (config, services, worktrees, workspaces, git, theme)
│   │   ├── hooks/      PTY management, keyboard shortcuts, Tauri events
│   │   ├── lib/        IPC wrappers, pane tree logic
│   │   └── types/      TypeScript interfaces
│   └── package.json
└── .github/workflows/  CI/CD release pipeline
```

## Service Configuration

Services are defined in JSON groups within each project:

```json
{
  "groups": [
    {
      "id": "backend",
      "label": "Backend",
      "services": [
        {
          "id": "api",
          "label": "API Server",
          "command": "PORT=5001 npm run dev",
          "cwd": "/path/to/api",
          "service_type": "service"
        },
        {
          "id": "db",
          "label": "Database",
          "command": "docker compose up",
          "cwd": "/path/to/project",
          "service_type": "service"
        }
      ]
    }
  ]
}
```

`command` is a whole shell command line, run by zsh as typed — environment
prefixes, quotes, pipes and redirection all work. (Older configs that split the
line into `command` plus an `args` array still run; saving the service in the
inspector rewrites them to the single field.)

Each worktree can override these groups with its own service definitions, so feature branches can run different configurations without affecting the main workspace.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
