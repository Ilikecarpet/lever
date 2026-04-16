# Repo Path in Exports + Editable Repo Path

**Date:** 2026-04-17
**Status:** Proposed

## Problem

Exporting a project config today produces a JSON file containing only `AppConfig` (groups + worktrees). The `repo_path` — which lives on `ProjectMeta`, not `AppConfig` — is lost. When a user imports that config on another machine (or after moving folders), the resulting project has an empty `repo_path` and no UI to fix it; `set_repo_path` / `get_repo_path` exist on the backend but aren't wired up.

Two gaps follow:

1. Exports don't round-trip the repo path.
2. There's no user-visible way to change the repo path after a project exists.

## Goals

- Include the repo path in exports so imports can restore it.
- On import, let the user confirm or change the path before the project is created.
- Let the user change the repo path of an existing project from two places:
  - The Start page project-card context menu (escape hatch when a project can't be opened).
  - The in-project `ConfigModal` (discoverable while already configuring the project).
- Remain backwards compatible with legacy export files that contain only a bare `AppConfig`.

## Non-Goals

- No changes to how `repo_path` is stored or consumed by services at runtime.
- No dedicated new "Settings page" — the existing `ConfigModal` is the settings surface.
- No multi-project export. One file = one project, same as today.
- No validation that the chosen path is a git repo — `repo_path` has always been a plain directory string.

## Design

### Export format

New wrapper shape, versioned for forward compatibility:

```json
{
  "version": 1,
  "name": "lever",
  "repo_path": "/Users/onil/Repos/Personal/lever",
  "config": {
    "groups": [ ... ],
    "worktrees": [ ... ]
  }
}
```

- `version`: integer. `1` for this iteration.
- `name`: the project name (`ProjectMeta.name`). Used as a default on import.
- `repo_path`: absolute path as it exists on the exporter's machine. Used as the default in the import folder picker; the importer can change it.
- `config`: the existing `AppConfig` object, unchanged.

### Import format detection

The importer sniffs the parsed JSON:

- If the top-level object has a `version` field **and** a `config` field → treat as the new wrapper.
- Otherwise → treat as a legacy bare `AppConfig` (the file has top-level `groups` / `worktrees`).

Legacy files continue to import exactly as they do today (name typed by user, empty `repo_path`).

### Import UI flow (new wrapper)

In the existing import modal (`StartPage.tsx:310-370`):

1. User picks a `.json` file.
2. UI parses it and detects the format.
3. If new wrapper:
   - Project name input pre-filled with `name` from the file (user can edit).
   - New "Repository path" row appears, showing the `repo_path` from the file with a "Change…" button next to it that opens a Tauri folder picker.
   - Confirm button stays disabled until both name and repo path are non-empty.
4. If legacy: current behavior — name input only, no repo path row.
5. On confirm: call `import_project(name, config_json, repo_path)`. The Tauri command writes `repo_path` into `ProjectMeta.repo_path` after creating the project.

### Export UI flow

In `Sidebar.tsx` export handler (currently lines 105-117):

1. Fetch `AppConfig` via `getConfig()` (unchanged).
2. Fetch `repo_path` via `getRepoPath(projectId)` and project name from the project meta already available in that scope.
3. Build the wrapper `{ version: 1, name, repo_path, config }`.
4. `JSON.stringify` with 2-space indent.
5. Write to file via the existing save-file dialog. Default filename: `<project-name>.lever.json` (match whatever the current default is if one exists; otherwise this).

### Change repo path — Start page context menu

In `StartPage.tsx` project-card context menu (currently lines 160-175 — Rename / Clone / Delete):

- Add a new item "Change repo path…" between Clone and Delete.
- Handler: open Tauri folder picker pre-filled with the project's current `repo_path`.
- On confirm: call `setRepoPath(id, newPath)` and refresh the project list so the displayed path (if any) updates.
- Cancel: no-op.

### Change repo path — ConfigModal

In `ConfigModal.tsx`, add a "Repository path" section at the top of the modal, above the groups section.

- Displays the current `repo_path` as read-only text.
- A "Change…" button next to it opens the same Tauri folder picker as the context menu entry.
- On confirm: call `setRepoPath(currentProjectId, newPath)`, update local state, and update the displayed text.
- No "save" step — path is persisted immediately on pick (matches the existing `set_repo_path` semantics).

Both entry points share the same helper function so behavior doesn't drift.

### Backend changes

`import_project` signature gains an optional `repo_path`:

```rust
#[tauri::command]
fn import_project(
    name: String,
    config_json: String,
    repo_path: Option<String>,
) -> Result<ProjectMeta, String>
```

- `None` → existing behavior (create with empty `repo_path`, used by legacy imports and programmatic callers).
- `Some(path)` → write `path` into `ProjectMeta.repo_path` after the project is created, via the same code path `set_repo_path` uses.

No other backend changes. `get_repo_path`, `set_repo_path`, `get_config`, and `save_config` already exist and are sufficient.

### TypeScript types

Add to `ui/src/types/index.ts`:

```ts
export interface ProjectExport {
  version: 1;
  name: string;
  repo_path: string;
  config: AppConfig;
}
```

Update the `importProject` wrapper in `ui/src/lib/tauri.ts` to accept an optional `repo_path`.

## Error handling

- **Malformed JSON on import:** show the same error message the import flow uses today.
- **Wrapper has `version` we don't recognize (e.g. `2` later):** show "Unsupported export version. Please update Lever." and abort.
- **User cancels the folder picker:** treat as cancel; leave the path unchanged.
- **Path doesn't exist on disk:** no special validation — match current behavior (paths are plain strings; service startup already handles missing paths).

## Testing

Manual test plan:

1. Export a project in the current build → file is a bare `AppConfig`. Import it after this change lands → falls through legacy path, name typed manually, no repo path prompt. Project imports correctly with empty `repo_path`.
2. Export a project after this change → file is the new wrapper with `version: 1`, `name`, `repo_path`, `config`.
3. Import the new-format file → name pre-filled, repo path pre-filled, folder picker opens and lets the path be changed, project imports with the chosen path.
4. Right-click a project on the Start page → "Change repo path…" opens folder picker pre-filled with current path. Pick a new path → `repo_path` updates and persists across app restart.
5. Open a project → open `ConfigModal` → repo path section shows current path, "Change…" picks a new path, change persists after closing and reopening the modal.
6. Import a malformed JSON file → error surfaces cleanly, no project is created.

## Open Questions

None at spec time.
