# Worktree Feature Design

## Overview

Add git worktree support to Lever. Users can create worktrees at the project level, which clones all service groups with paths rewritten to the worktree directory. Each worktree gets its own isolated set of workspaces. Switching between worktrees in the sidebar swaps the workspace bar to show only that context's workspaces.

## Key Decisions

- **Real git worktrees** — `git worktree add` on disk, not a virtual abstraction
- **Project-level action** — worktrees apply to the whole project, not individual groups
- **`repo_path` moves to project** — groups no longer own `repo_path`; the project has a single repo. Groups only define `cwd` for their services.
- **All groups cloned** — creating a worktree clones every group with `cwd` paths rewritten
- **Full workspace isolation** — each worktree (including main) has its own independent set of workspaces
- **Worktree groups as separate sidebar sections** — not nested inside parent groups; separated by a section divider with branch name and worktree path, left border accent on worktree groups

## Data Model Changes

### Project metadata gains `repo_path`

```typescript
interface ProjectMeta {
  id: string;
  name: string;
  repo_path: string | null;  // The project's git repository path
  created_at: number;
  last_opened: number;
}
```

### ServiceGroup loses `repo_path`

```typescript
interface ServiceGroup {
  id: string;
  label: string;
  services: ServiceDef[];
  // repo_path: removed
}
```

### New WorktreeDef type

```typescript
interface WorktreeDef {
  id: string;
  branch: string;
  path: string;                    // Absolute disk path to git worktree
  groups: ServiceGroup[];          // Cloned groups with rewritten cwd paths
}
```

### AppConfig gains worktrees array

```typescript
interface AppConfig {
  groups: ServiceGroup[];
  worktrees: WorktreeDef[];
}
```

### Workspace gains worktreeId

```typescript
interface Workspace {
  id: string;
  label: string;
  root: PaneNode;
  activePaneId: string;
  worktreeId: string | null;       // null = main/project-level
}
```

## Sidebar Layout

### Before (current)

```
┌─────────────────────────┐
│ My Project            ▼ │
├─────────────────────────┤
│ ▼ Backend          2/3  │
│   ● API Server          │
│   ● Worker              │
│   ○ Migrations    Task  │
├─────────────────────────┤
│ ▼ Frontend         1/2  │
│   ● Dev Server          │
│   ○ Storybook           │
├─────────────────────────┤
│ + Add Group             │
└─────────────────────────┘
```

### After (with a worktree)

```
┌─────────────────────────────────────────┐
│ My Project                            ▼ │
├─────────────────────────────────────────┤
│ ● main · ~/projects/myapp              │
├─────────────────────────────────────────┤
│ ▼ Backend                          2/3  │
│   ● API Server                          │
│   ● Worker                              │
│   ○ Migrations                    Task  │
├─────────────────────────────────────────┤
│ ▼ Frontend                         1/2  │
│   ● Dev Server                          │
│   ○ Storybook                           │
├─────────────────────────────────────────┤
│ ⑂ feature/auth · ~/projects/myapp-wt/… │
├─────────────────────────────────────────┤
│ ┃ ▼ Backend                        0/3  │
│ ┃   ○ API Server                        │
│ ┃   ○ Worker                            │
│ ┃   ○ Migrations                  Task  │
├─────────────────────────────────────────┤
│ ┃ ▼ Frontend                       0/2  │
│ ┃   ○ Dev Server                        │
│ ┃   ○ Storybook                         │
├─────────────────────────────────────────┤
│ + Add Group  ·  + New Worktree          │
└─────────────────────────────────────────┘
```

- Section divider with `⑂ branch-name` and worktree path separates worktree groups
- Left border accent (blue) on worktree groups
- Clicking a worktree section header switches the workspace bar to that worktree's workspaces
- Main context indicator at top lets user switch back

## Worktree Creation Flow

1. User clicks **"+ New Worktree"** at the bottom of the sidebar
2. A dialog appears with:
   - **Branch name** — text input with autocomplete from existing local and remote branches. Typing a name that doesn't exist creates a new branch.
   - **Path** — auto-populated as `<repo_path>-worktrees/<sanitized-branch-name>/`, editable by the user
3. Backend runs `git worktree add <path> <branch>` (existing branch) or `git worktree add -b <branch> <path>` (new branch)
4. All groups from `config.groups` are deep-cloned. For each cloned service, the `cwd` field has the original repo root prefix replaced with the worktree path. For example: if `repo_path` is `/projects/myapp` and a service has `cwd: /projects/myapp/packages/api`, and the worktree path is `/projects/myapp-worktrees/feature-auth`, the rewritten `cwd` becomes `/projects/myapp-worktrees/feature-auth/packages/api`.
5. A new `WorktreeDef` is saved to `config.worktrees`
6. A default workspace is created with `worktreeId` set to the new worktree's ID
7. The sidebar updates to show the new worktree section
8. The active context switches to the new worktree (workspace bar shows its workspaces)

## Workspace Scoping

- The workspace store tracks an `activeWorktreeId: string | null` (null = main)
- The workspace bar filters to only show workspaces matching `activeWorktreeId`
- Clicking a worktree section header in the sidebar sets `activeWorktreeId`
- Clicking the main context indicator resets `activeWorktreeId` to null
- New terminals created in a worktree workspace get their `cwd` set to the worktree path
- Each worktree starts with one default workspace on creation

## Worktree Deletion

1. Right-click or context menu on worktree section header → "Remove Worktree"
2. Confirmation dialog asks: **"Also remove worktree files from disk?"**
   - **Yes (full cleanup):**
     1. Stop all running services in the worktree's groups
     2. Close all workspaces and PTYs scoped to this worktree
     3. Run `git worktree remove <path>`
     4. Remove `WorktreeDef` from config
   - **No (UI only):**
     1. Stop all running services in the worktree's groups
     2. Close all workspaces and PTYs scoped to this worktree
     3. Remove `WorktreeDef` from config
     4. Leave worktree directory on disk

## Backend Commands (Rust/Tauri)

### New commands

- **`create_worktree(project_id, branch, path)`** — Validates repo, runs `git worktree add`, clones groups with rewritten `cwd`, saves to config. Returns the new `WorktreeDef`.
- **`remove_worktree(project_id, worktree_id, cleanup: bool)`** — Stops services, optionally runs `git worktree remove`, removes from config.
- **`list_branches(project_id)`** — Opens repo with `git2`, returns all local and remote branch names for autocomplete.

### Modified commands

- **`git_info`** — Changes from taking a `path` parameter to deriving the repo path from the project's `repo_path`. Can also be called for a specific worktree path.
- **`save_config` / `get_config`** — Handle the new `worktrees` array in `AppConfig`.
- **Service start/stop** — No changes needed. Cloned services already have correct absolute `cwd` paths.

### Removal of `repo_path` from groups

- Remove `repo_path` field from `ServiceGroup` struct (Rust) and `ServiceGroup` interface (TypeScript)
- Add `repo_path` field to `ProjectMeta` struct (Rust) and project metadata (TypeScript)
- Migrate existing configs: if any group has `repo_path` set, move it to the project level (take the first non-empty value), then strip it from all groups
- Update `git_info`, `git_fetch`, `git_pull` to use project-level `repo_path`
- Update sidebar git branch display to use project-level repo info instead of per-group

## Error Handling

- **No repo_path on project**: "New Worktree" button is hidden or disabled when the project has no `repo_path` set
- **Branch already has a worktree**: Show error — git doesn't allow two worktrees on the same branch
- **Worktree path already exists**: Show error, suggest a different path
- **git worktree remove fails** (e.g., uncommitted changes): Surface the git error message to the user, offer to force-remove or cancel
- **Service cwd doesn't start with repo root**: Skip rewriting for that service (edge case where cwd points outside the repo)

## Migration

When loading an existing config:
1. Check if any `ServiceGroup` has a `repo_path` field
2. If so, move the first non-empty `repo_path` to `ProjectMeta.repo_path`
3. Strip `repo_path` from all groups
4. If `config.worktrees` is missing, default to empty array `[]`
