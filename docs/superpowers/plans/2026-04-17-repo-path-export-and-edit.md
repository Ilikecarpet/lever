# Repo Path in Exports + Editable Repo Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Round-trip `repo_path` through config export/import, and let the user change a project's repo path from the Start-page context menu and from the in-project Settings (ConfigModal).

**Architecture:** Exports become a versioned wrapper `{ version, name, repo_path, config }`. The import modal sniffs the format — legacy bare `AppConfig` files continue to work; new-format files pre-fill the project name and open a folder picker pre-filled with `repo_path`. Two new UI surfaces call the existing `set_repo_path` Tauri command: a Start-page context-menu item and a "Repository path" section at the top of the ConfigModal. The backend gets a minimal change: `import_project` gains an optional `repo_path` parameter.

**Tech Stack:** Rust (Tauri), TypeScript + React, `@tauri-apps/plugin-dialog` (already in use for `open` / `save`).

**Testing note:** This repo has no JS/Rust unit-test scaffolding. We follow the project's existing convention: type-check via `tsc -b`, build via `cargo build`, and rely on the manual test plan in Task 8. We do NOT introduce a test runner in this plan (YAGNI).

---

## File Structure

**Modify:**
- `src-tauri/src/main.rs` — extend `import_project` to accept `repo_path: Option<String>`.
- `ui/src/types/index.ts` — add `ProjectExport` interface.
- `ui/src/lib/tauri.ts` — update `importProject` wrapper signature; add a new `buildExportJson` / `parseImportFile` pair OR keep parsing inline (see Task 3 & 4).
- `ui/src/components/Sidebar/Sidebar.tsx` — update `handleExport` to write the new wrapper.
- `ui/src/components/StartPage/StartPage.tsx` — update `ImportModal` to detect format and show folder picker; add "Change repo path…" to the project-card context menu.
- `ui/src/components/Modals/ConfigModal.tsx` — add a "Repository path" row at the top of the modal body.

**Create:** none.

---

## Task 1: Extend `import_project` backend command

**Files:**
- Modify: `src-tauri/src/main.rs:520-543` (the `import_project` fn) and `src-tauri/src/main.rs:1293-1321` (the `generate_handler!` macro — no change needed because the fn name is already registered; only the signature expands).

- [ ] **Step 1: Update `import_project` signature and body**

Replace the current fn (starts at line 520) with:

```rust
#[tauri::command]
fn import_project(
    name: String,
    config_json: String,
    repo_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<ProjectMeta, String> {
    let config: AppConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("Invalid config JSON: {}", e))?;
    let id = name_to_id(&name);
    if id.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    let mut index = load_project_index(&state.projects_dir);
    if index.projects.iter().any(|p| p.id == id) {
        return Err(format!("Project '{}' already exists", name));
    }
    save_project_config(&state.projects_dir, &id, &config)?;
    let meta = ProjectMeta {
        id,
        name,
        repo_path: repo_path.unwrap_or_default(),
        created_at: now_unix(),
        last_opened: now_unix(),
    };
    index.projects.push(meta.clone());
    save_project_index(&state.projects_dir, &index)?;
    Ok(meta)
}
```

- [ ] **Step 2: Compile to verify**

Run: `cd src-tauri && cargo build`
Expected: build succeeds (warnings OK, no errors).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(backend): accept optional repo_path in import_project"
```

---

## Task 2: Add `ProjectExport` type and update `importProject` wrapper

**Files:**
- Modify: `ui/src/types/index.ts` (append near the existing `AppConfig`).
- Modify: `ui/src/lib/tauri.ts:64-66` (the `importProject` wrapper).

- [ ] **Step 1: Add `ProjectExport` to types**

Append to `ui/src/types/index.ts` (after the `AppConfig` interface, before the `// Service runtime types` section starting at line 34):

```ts
// ---------------------------------------------------------------------------
// Config export wrapper (on-disk format, versioned)
// ---------------------------------------------------------------------------

export interface ProjectExport {
  version: 1;
  name: string;
  repo_path: string;
  config: AppConfig;
}
```

- [ ] **Step 2: Update the `importProject` TS wrapper**

Replace `ui/src/lib/tauri.ts:64-66` with:

```ts
export function importProject(
  name: string,
  configJson: string,
  repoPath?: string,
): Promise<ProjectMeta> {
  return invoke<ProjectMeta>("import_project", {
    name,
    configJson,
    repoPath: repoPath ?? null,
  });
}
```

- [ ] **Step 3: Type-check**

Run: `cd ui && npx tsc -b`
Expected: no errors. (If `tsc -b` flags existing call sites of `importProject`, they'll still compile because `repoPath` is optional — but verify no other call sites broke.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/types/index.ts ui/src/lib/tauri.ts
git commit -m "feat(ui): add ProjectExport type and optional repoPath to importProject"
```

---

## Task 3: Export in the new wrapper format

**Files:**
- Modify: `ui/src/components/Sidebar/Sidebar.tsx:105-117` (the `handleExport` fn).

- [ ] **Step 1: Update `handleExport` to build the wrapper**

Replace `handleExport` (lines 105-117) with:

```tsx
  const handleExport = async () => {
    setMenuOpen(false);
    const projectId = api.getProjectId() ?? "project";
    const projects = await api.listProjects();
    const project = projects.find((p) => p.id === projectId);
    const name = project?.name ?? projectId;
    const repoPath = project?.repo_path ?? "";

    const filePath = await save({
      title: "Export Config",
      defaultPath: `${projectId}-config.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!filePath) return;

    const config = await api.getConfig();
    const exportDoc: ProjectExport = {
      version: 1,
      name,
      repo_path: repoPath,
      config,
    };
    const json = JSON.stringify(exportDoc, null, 2);
    await api.writeTextFile(filePath, json);
  };
```

- [ ] **Step 2: Add the import for `ProjectExport`**

In `ui/src/components/Sidebar/Sidebar.tsx` near the top of the file, find the existing type imports. There are currently none from `../../types` in this file. Add this line after line 8 (after `useThemeStore` import):

```tsx
import type { ProjectExport } from "../../types";
```

- [ ] **Step 3: Type-check and build**

Run: `cd ui && npx tsc -b`
Expected: no errors.

Run: `cd ui && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/Sidebar/Sidebar.tsx
git commit -m "feat(ui): export config as versioned wrapper including repo_path"
```

---

## Task 4: Import modal — detect format and (for new format) pre-fill + pick path

**Files:**
- Modify: `ui/src/components/StartPage/StartPage.tsx` — the `ImportModal` component (lines 310-370).

- [ ] **Step 1: Add imports and a parse helper at module scope**

At the top of `ui/src/components/StartPage/StartPage.tsx`, find the existing imports. Add `ProjectExport` and `AppConfig` from `../../types` (the file already imports `ProjectMeta` from there):

Replace the existing `import type { ProjectMeta } from "../../types";` line (line 4) with:

```tsx
import type { AppConfig, ProjectExport, ProjectMeta } from "../../types";
```

Then, just above the `export default function StartPage()` line (around line 17), add this helper:

```tsx
/**
 * Parse an exported config file. Returns normalized fields:
 *  - `configJson`: bare AppConfig as JSON (what the backend expects).
 *  - `suggestedName`, `suggestedRepoPath`: only set for new-format files.
 *  - `isNewFormat`: true if the file was a versioned wrapper.
 * Throws if the JSON is malformed or the version is unsupported.
 */
function parseImportFile(text: string): {
  configJson: string;
  suggestedName?: string;
  suggestedRepoPath?: string;
  isNewFormat: boolean;
} {
  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === "object" && "version" in parsed && "config" in parsed) {
    const wrapper = parsed as ProjectExport;
    if (wrapper.version !== 1) {
      throw new Error(`Unsupported export version ${wrapper.version}. Please update Lever.`);
    }
    return {
      configJson: JSON.stringify(wrapper.config),
      suggestedName: typeof wrapper.name === "string" ? wrapper.name : undefined,
      suggestedRepoPath: typeof wrapper.repo_path === "string" ? wrapper.repo_path : undefined,
      isNewFormat: true,
    };
  }
  // Legacy bare AppConfig — re-stringify to normalize.
  const legacy = parsed as AppConfig;
  return { configJson: JSON.stringify(legacy), isNewFormat: false };
}
```

- [ ] **Step 2: Replace the `ImportModal` component**

Find `function ImportModal(...)` starting at line 310 and replace the entire function (through its closing brace at line 370) with:

```tsx
function ImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [parsedConfigJson, setParsedConfigJson] = useState<string | null>(null);
  const [isNewFormat, setIsNewFormat] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  const handleFileChange = async () => {
    setError("");
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setParsedConfigJson(null);
      setIsNewFormat(false);
      return;
    }
    try {
      const text = await file.text();
      const result = parseImportFile(text);
      setParsedConfigJson(result.configJson);
      setIsNewFormat(result.isNewFormat);
      if (result.suggestedName) setName(result.suggestedName);
      if (result.suggestedRepoPath !== undefined) setRepoPath(result.suggestedRepoPath);
    } catch (e) {
      setParsedConfigJson(null);
      setIsNewFormat(false);
      setError(String(e));
    }
  };

  const handlePickRepoPath = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: repoPath || undefined,
    });
    if (selected) setRepoPath(selected as string);
  };

  const handleImport = async () => {
    if (!parsedConfigJson) {
      setError("Please select a valid config file");
      return;
    }
    if (!name.trim()) {
      setError("Please enter a project name");
      return;
    }
    try {
      const repoArg = isNewFormat ? repoPath : undefined;
      await api.importProject(name.trim(), parsedConfigJson, repoArg);
      onImported();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      className={styles.modalOverlay}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className={styles.modal}>
        <div className={styles.modalTitle}>Import Config</div>

        <label className={styles.fieldLabel}>Config file</label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ marginBottom: 12 }}
          onChange={handleFileChange}
        />

        <label className={styles.fieldLabel}>Project Name</label>
        <input
          className={styles.modalInput}
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {isNewFormat && (
          <>
            <label className={styles.fieldLabel}>Repository path</label>
            <button
              className={styles.folderPicker}
              onClick={handlePickRepoPath}
              type="button"
            >
              {repoPath ? (
                <span className={styles.folderPath}>{repoPath}</span>
              ) : (
                <span className={styles.folderPlaceholder}>Choose a folder...</span>
              )}
              <span className={styles.folderBtn}>Browse</span>
            </button>
          </>
        )}

        {error && <div className={styles.modalError}>{error}</div>}
        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.btnPrimary} onClick={handleImport}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
```

Note: this reuses the existing `styles.folderPicker`, `styles.folderPath`, `styles.folderPlaceholder`, `styles.folderBtn`, and `styles.fieldLabel` classes that `CreateModal` already uses (see lines 264-276 of the same file), so no CSS changes are needed.

- [ ] **Step 3: Type-check and build**

Run: `cd ui && npx tsc -b`
Expected: no errors.

Run: `cd ui && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/StartPage/StartPage.tsx
git commit -m "feat(ui): detect export format and prompt for repo path on import"
```

---

## Task 5: Add "Change repo path…" to the Start-page context menu

**Files:**
- Modify: `ui/src/components/StartPage/StartPage.tsx` — the `StartPage` component's context menu and handlers (lines 51-85 for handlers; lines 160-175 for the menu markup).

- [ ] **Step 1: Add the handler**

In `StartPage` (the top-level component), find `handleClone` (lines 78-85) and add this handler immediately after it:

```tsx
  const handleChangeRepoPath = async (project: ProjectMeta) => {
    setContextMenu(null);
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: project.repo_path || undefined,
    });
    if (!selected) return;
    await api.setRepoPath(project.id, selected as string);
    refresh();
  };
```

(The `open` function from `@tauri-apps/plugin-dialog` is already imported at line 3.)

- [ ] **Step 2: Add the menu item**

Find the context menu block (lines 160-175). Insert a new button between the Clone button and the Delete button, so the final block reads:

```tsx
      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button className={styles.contextMenuItem} onClick={() => handleRename(contextMenu.project)}>
            Rename
          </button>
          <button className={styles.contextMenuItem} onClick={() => handleClone(contextMenu.project)}>
            Clone
          </button>
          <button className={styles.contextMenuItem} onClick={() => handleChangeRepoPath(contextMenu.project)}>
            Change repo path…
          </button>
          <button className={styles.contextMenuDanger} onClick={() => handleDelete(contextMenu.project)}>
            Delete
          </button>
        </div>
      )}
```

- [ ] **Step 3: Type-check and build**

Run: `cd ui && npx tsc -b`
Expected: no errors.

Run: `cd ui && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/StartPage/StartPage.tsx
git commit -m "feat(ui): add Change repo path to Start-page context menu"
```

---

## Task 6: Add "Repository path" section to `ConfigModal`

**Files:**
- Modify: `ui/src/components/Modals/ConfigModal.tsx` — add state + UI at the top of `modalBody`.
- Modify: `ui/src/components/Modals/ConfigModal.module.css` — add minimal styles for the new row. (Verify file path first.)

- [ ] **Step 1: Verify the CSS file exists**

Run: `ls ui/src/components/Modals/ConfigModal.module.css`
Expected: the file exists. If it does not exist (e.g. styles are co-located differently), stop and inspect the import at `ui/src/components/Modals/ConfigModal.tsx:7` to find the actual stylesheet, then adapt Step 4 accordingly.

- [ ] **Step 2: Add imports and state**

At the top of `ui/src/components/Modals/ConfigModal.tsx`, add these imports (the `open` function is needed; `api` is needed for `getRepoPath` / `setRepoPath`; `getProjectId` comes from the same module):

Replace the existing first two imports (lines 1-2) with:

```tsx
import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "../../lib/tauri";
import { useConfigStore } from "../../stores/configStore";
```

(Preserve the rest of the existing imports.)

Inside the `ConfigModal` component, find the line:

```tsx
  const mouseDownOnFormOverlay = useRef(false);
```

(around line 106). Immediately after it, add:

```tsx
  const [repoPath, setRepoPathState] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    const projectId = api.getProjectId();
    if (!projectId) return;
    api.getRepoPath(projectId)
      .then((p) => setRepoPathState(p))
      .catch(() => setRepoPathState(""));
  }, [open]);

  const handleChangeRepoPath = async () => {
    const projectId = api.getProjectId();
    if (!projectId) return;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: repoPath || undefined,
    });
    if (!selected) return;
    const next = selected as string;
    await api.setRepoPath(projectId, next);
    setRepoPathState(next);
  };
```

Note: there is a name collision — the `open` *prop* on `ConfigModal` and the `open` *function* imported from `@tauri-apps/plugin-dialog`. Rename the imported function. Change the import line you added above from:

```tsx
import { open } from "@tauri-apps/plugin-dialog";
```

to:

```tsx
import { open as openDialog } from "@tauri-apps/plugin-dialog";
```

And the handler already calls `openDialog(...)` — good.

- [ ] **Step 3: Add the UI row at the top of `modalBody`**

Find the existing `modalBody` block (around line 388):

```tsx
          <div className={styles.modalBody}>
            {sections.map((sec) => (
```

Insert a new block immediately inside `<div className={styles.modalBody}>`, before `{sections.map(...)}`:

```tsx
          <div className={styles.modalBody}>
            <div className={styles.repoPathRow}>
              <div className={styles.repoPathLabel}>Repository path</div>
              <div className={styles.repoPathValue}>
                {repoPath || <span className={styles.repoPathEmpty}>Not set</span>}
              </div>
              <button
                className={`${styles.mBtn} ${styles.mBtnSm}`}
                onClick={handleChangeRepoPath}
              >
                Change…
              </button>
            </div>
            {sections.map((sec) => (
```

(Leave the rest of the `modalBody` content unchanged.)

- [ ] **Step 4: Add styles**

Open `ui/src/components/Modals/ConfigModal.module.css` and append:

```css
.repoPathRow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 16px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  background: var(--surface-2, rgba(255, 255, 255, 0.03));
}

.repoPathLabel {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
  flex-shrink: 0;
}

.repoPathValue {
  flex: 1;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text, #eee);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repoPathEmpty {
  font-style: italic;
  color: var(--text-muted, #888);
}
```

Note: if the existing stylesheet uses different CSS variable names (inspect a few rules at the top of the file first), substitute the project's variables. The fallbacks in `var(--x, fallback)` will keep things readable even if the variable names don't match exactly — but matching them is better.

- [ ] **Step 5: Type-check and build**

Run: `cd ui && npx tsc -b`
Expected: no errors.

Run: `cd ui && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/Modals/ConfigModal.tsx ui/src/components/Modals/ConfigModal.module.css
git commit -m "feat(ui): add Repository path section to ConfigModal with Change action"
```

---

## Task 7: End-to-end build check

- [ ] **Step 1: Backend build**

Run: `cd src-tauri && cargo build`
Expected: clean build.

- [ ] **Step 2: Frontend build**

Run: `cd ui && npm run build`
Expected: clean build.

- [ ] **Step 3: No commit needed** (build artifacts only; no source changes)

---

## Task 8: Manual QA

Launch `cargo tauri dev` (or the project's usual dev command) and verify each of the following. For each scenario, capture PASS/FAIL; if any fail, stop and fix before committing any doc updates.

- [ ] **Test 1 — Legacy import still works**
  1. Locate a pre-change export file if one exists, or hand-craft a file with just `{"groups": [], "worktrees": []}`.
  2. On the Start page, click **Import Config**.
  3. Pick the legacy file.
  4. Expected: no repository-path row appears (legacy format), name input is empty, user types a name and clicks Import.
  5. Project is created, `repo_path` is empty.

- [ ] **Test 2 — New-format export**
  1. Open an existing project.
  2. From the sidebar dropdown (Lever menu), click **Export Config** and save to disk.
  3. Open the saved file in a text editor.
  4. Expected: JSON has `version: 1`, `name`, `repo_path`, and `config` keys at the top level; `config` contains `groups` and `worktrees`.

- [ ] **Test 3 — New-format import with repo-path confirmation**
  1. Delete (or rename) the source project to avoid the "already exists" error.
  2. Back on the Start page, click **Import Config** and pick the file from Test 2.
  3. Expected: name input pre-fills from file, repository-path row appears and is pre-filled.
  4. Click **Browse** on the repo-path row → folder picker opens starting at the pre-filled path → pick a different folder.
  5. Click **Import**.
  6. Expected: project is created with the folder chosen in step 4 as `repo_path`. Open it and verify.

- [ ] **Test 4 — Change repo path from Start-page context menu**
  1. Right-click a project on the Start page.
  2. Expected: menu shows Rename, Clone, **Change repo path…**, Delete.
  3. Click **Change repo path…** → folder picker opens at the current path → pick a new folder.
  4. Expected: picker closes, no visible change on the card (card does not display path), but open the project and confirm the sidebar/services use the new path. Close the app and re-open to confirm the change persisted.

- [ ] **Test 5 — Change repo path from ConfigModal**
  1. Open a project.
  2. Open the ConfigModal (Sidebar → Settings, or the main-repo context menu → Manage Services).
  3. Expected: "Repository path" row appears at the top with the current path shown, and a **Change…** button.
  4. Click **Change…** → folder picker opens at the current path → pick a new folder.
  5. Expected: the displayed path updates immediately. Close and re-open the modal → new path is still shown.

- [ ] **Test 6 — Malformed JSON import**
  1. Create a file with invalid JSON (e.g. `{broken`).
  2. Import it.
  3. Expected: error is shown inline in the modal, no project is created.

- [ ] **Test 7 — Unsupported version import**
  1. Create a file like `{"version": 2, "name": "x", "repo_path": "/tmp", "config": {"groups": [], "worktrees": []}}`.
  2. Import it.
  3. Expected: error message mentions "Unsupported export version 2", no project is created.

- [ ] **Test 8 — Cancel in folder picker**
  1. Trigger any of the folder pickers (import repo path, context menu change, ConfigModal change).
  2. Cancel the dialog.
  3. Expected: no errors, no state change.

- [ ] **Step 9: Commit if doc fixes needed** (none expected — this is a QA-only task). If bugs were found and fixed, each fix should have been its own commit.

---

## Self-Review Notes (applied)

Checked against the spec:

- **Export format** (spec §"Export format") → Task 3.
- **Format detection** (spec §"Import format detection") → Task 4 `parseImportFile`.
- **Import flow pre-fill + folder picker** (spec §"Import UI flow") → Task 4 `ImportModal`.
- **Export UI** (spec §"Export UI flow") → Task 3.
- **Change path from Start-page context menu** (spec §"Change repo path — Start page context menu") → Task 5.
- **Change path from ConfigModal** (spec §"Change repo path — ConfigModal") → Task 6.
- **Backend signature change** (spec §"Backend changes") → Task 1.
- **TS types update** (spec §"TypeScript types") → Task 2.
- **Error handling: malformed JSON, unsupported version, cancel, missing path** (spec §"Error handling") → Task 4 (parse + UI error state) + Task 8 Tests 6/7/8.

No placeholders, no "TBD" / "TODO", types and method signatures are consistent across tasks (`parseImportFile`, `importProject(name, configJson, repoPath?)`, `ProjectExport`, `repo_path` field name matches backend `ProjectMeta.repo_path`).
