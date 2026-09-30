//! Defining projects and services from the command line: `lever init`, `add`
//! and `remove`. The same config the window edits, so a window open on the
//! project is told to reload it.

use serde_json::{json, Value};
use std::path::Path;
use tauri::{Emitter, Manager};

use super::{
    create_project_in, ensure_project_loaded, load_project_index, mcp, name_to_id,
    save_project_config, shell_escape, AppConfig, AppState, ServiceDef, ServiceGroup,
};
use mcp::{arg_str, canon, Checkout};

/// Makes the directory the CLI runs in a project, named after it unless told.
pub(crate) fn init(app: &tauri::AppHandle, args: &Value, cwd: Option<&Path>) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let dir = canon(cwd.ok_or("no working directory")?);
    let index = load_project_index(&state.projects_dir);
    if let Some(p) = index.projects.iter().find(|p| !p.repo_path.is_empty() && canon(Path::new(&p.repo_path)) == dir) {
        return Err(format!("{} is already the project '{}'.", dir.display(), p.name));
    }
    let name = match arg_str(args, "name") {
        Some(n) => n.to_string(),
        None => dir.file_name().map(|n| n.to_string_lossy().into_owned())
            .ok_or("this directory has no name; pass --name")?,
    };
    let meta = create_project_in(&state.projects_dir, name, Some(dir.to_string_lossy().into_owned()))
        .map_err(|e| if arg_str(args, "name").is_none() { format!("{}; pass --name", e) } else { e })?;
    let _ = app.emit_to("main", "projects-changed", ());
    Ok(json!({ "id": meta.id, "name": meta.name, "repoPath": meta.repo_path }))
}

/// Adds a service or task to a group of the checkout here, making the group
/// when it is named and missing.
pub(crate) fn add(app: &tauri::AppHandle, args: &Value, cwd: Option<&Path>) -> Result<Value, String> {
    let label = arg_str(args, "name").map(str::trim).filter(|s| !s.is_empty()).ok_or("a name is required")?;
    let command = arg_str(args, "command").map(str::trim).filter(|s| !s.is_empty()).ok_or("a command is required")?;
    let (project_id, checkout) = target(app, args, cwd)?;
    edit_config(app, &project_id, |config, project_name| {
        let id = unique_id(config, label);
        let groups = groups_mut(config, &checkout).ok_or("That worktree is gone.")?;
        let group = pick_group(groups, arg_str(args, "group"), project_name)?;
        group.services.push(ServiceDef {
            id: id.clone(),
            label: label.to_string(),
            description: arg_str(args, "description").unwrap_or("").to_string(),
            command: command.to_string(),
            args: vec![],
            cwd: arg_str(args, "cwd").unwrap_or("").to_string(),
            service_type: if args["task"] == true { "task" } else { "service" }.to_string(),
            stop_command: arg_str(args, "stop").map(|s| s.split_whitespace().map(String::from).collect()).unwrap_or_default(),
        });
        Ok(json!({ "id": id, "group": group.label }))
    })
}

/// Removes a service from the config. A running one has to be stopped first,
/// so nothing is left running that Lever no longer knows how to name.
pub(crate) fn remove(app: &tauri::AppHandle, args: &Value, cwd: Option<&Path>) -> Result<Value, String> {
    let want = arg_str(args, "service").ok_or("`service` is required")?;
    let (project_id, checkout) = target(app, args, cwd)?;
    {
        let state = app.state::<AppState>();
        let projects = state.projects.lock().unwrap();
        let ps = projects.get(&project_id).ok_or("Project not loaded")?;
        let id = find(&ps.config, &checkout, want)?;
        if ps.tracked.contains_key(&id) {
            return Err(format!("'{}' is running; stop it first.", id));
        }
    }
    edit_config(app, &project_id, |config, _| {
        let id = find(config, &checkout, want)?;
        for group in groups_mut(config, &checkout).into_iter().flatten() {
            group.services.retain(|s| s.id != id);
        }
        Ok(json!({ "id": id }))
    })
}

/// The project and checkout an edit is for. Unlike reading, editing never
/// guesses: outside a project's directory, `--project` has to say which.
fn target(app: &tauri::AppHandle, args: &Value, cwd: Option<&Path>) -> Result<(String, Checkout), String> {
    let state = app.state::<AppState>();
    let here = cwd.and_then(|c| mcp::locate(&mcp::open_checkouts(&state), &canon(c)));
    if here.is_none() && arg_str(args, "project").is_none() {
        return Err("This directory is not in a Lever project. Run `lever init` here, or pass --project.".into());
    }
    let scope = mcp::resolve_scope(&state, args, cwd)?;
    let checkout = match scope.checkout {
        // Named the project from outside it: its main checkout.
        Checkout::All if arg_str(args, "checkout").is_none() => Checkout::Main,
        Checkout::All => return Err("Pick one checkout: \"main\" or a worktree branch.".into()),
        c => c,
    };
    Ok((scope.project_id, checkout))
}

/// Applies `f` to the project's config, saves it, and tells an open window.
fn edit_config(
    app: &tauri::AppHandle,
    project_id: &str,
    f: impl FnOnce(&mut AppConfig, &str) -> Result<Value, String>,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    ensure_project_loaded(&state, project_id)?;
    let name = load_project_index(&state.projects_dir).projects.into_iter()
        .find(|p| p.id == project_id).map(|p| p.name).unwrap_or_else(|| project_id.to_string());
    let result = {
        let mut projects = state.projects.lock().unwrap();
        let ps = projects.get_mut(project_id).ok_or("Project not loaded")?;
        let mut config = ps.config.clone();
        let result = f(&mut config, &name)?;
        save_project_config(&state.projects_dir, project_id, &config)?;
        ps.config = config;
        result
    };
    let _ = app.emit_to(format!("project-{}", project_id).as_str(), "config-changed", ());
    Ok(result)
}

fn groups_mut<'a>(config: &'a mut AppConfig, checkout: &Checkout) -> Option<&'a mut Vec<ServiceGroup>> {
    match checkout {
        Checkout::Worktree(id) => config.worktrees.iter_mut().find(|w| &w.id == id).map(|w| &mut w.groups),
        _ => Some(&mut config.groups),
    }
}

/// The group named — by id or label — or a new one by that name. Unnamed: the
/// only group, or a first one named after the project.
fn pick_group<'a>(groups: &'a mut Vec<ServiceGroup>, want: Option<&str>, project_name: &str) -> Result<&'a mut ServiceGroup, String> {
    let label = match want {
        Some(w) => w.trim(),
        None if groups.len() == 1 => return Ok(&mut groups[0]),
        None if groups.is_empty() => project_name,
        None => return Err(format!(
            "Several groups here; pass --group: {}",
            groups.iter().map(|g| g.label.as_str()).collect::<Vec<_>>().join(", "),
        )),
    };
    let at = match groups.iter().position(|g| g.id == label || g.label.eq_ignore_ascii_case(label)) {
        Some(i) => i,
        None => {
            let base = name_to_id(label);
            let base = if base.is_empty() { "group".to_string() } else { base };
            let mut id = base.clone();
            let mut n = 1;
            while groups.iter().any(|g| g.id == id) {
                n += 1;
                id = format!("{}-{}", base, n);
            }
            groups.push(ServiceGroup { id, label: label.to_string(), services: vec![] });
            groups.len() - 1
        }
    };
    Ok(&mut groups[at])
}

/// An id from the label, unique across every checkout: the runtime tracks
/// services by id alone. The same rule as the window's.
fn unique_id(config: &AppConfig, label: &str) -> String {
    let taken: Vec<&str> = mcp::groups_in(config, &Checkout::All).into_iter()
        .flat_map(|(_, gs)| gs.iter().flat_map(|g| g.services.iter().map(|s| s.id.as_str())))
        .collect();
    let base = name_to_id(label);
    let base = if base.is_empty() { "service".to_string() } else { base };
    let mut id = base.clone();
    let mut n = 1;
    while taken.contains(&id.as_str()) {
        n += 1;
        id = format!("{}-{}", base, n);
    }
    id
}

/// A service of the checkout by id, or by a label naming exactly one.
fn find(config: &AppConfig, checkout: &Checkout, want: &str) -> Result<String, String> {
    let services: Vec<&ServiceDef> = mcp::groups_in(config, checkout).into_iter()
        .flat_map(|(_, gs)| gs.iter().flat_map(|g| g.services.iter()))
        .collect();
    if let Some(s) = services.iter().find(|s| s.id == want) {
        return Ok(s.id.clone());
    }
    let named: Vec<_> = services.iter().filter(|s| s.label.eq_ignore_ascii_case(want)).collect();
    match named.as_slice() {
        [s] => Ok(s.id.clone()),
        [] => Err(format!("No service '{}' here.", want)),
        _ => Err(format!("Several services are called '{}'; use its id.", want)),
    }
}

/// A command given as several words is quoted back into one line; one word is
/// taken as the line itself, so `"npm run dev | tee log"` keeps its pipe.
pub(crate) fn command_line(words: &[String]) -> String {
    match words {
        [line] => line.clone(),
        _ => words.iter().map(|w| shell_escape(w)).collect::<Vec<_>>().join(" "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(id: &str, services: &[&str]) -> ServiceGroup {
        ServiceGroup {
            id: id.into(),
            label: id.to_uppercase(),
            services: services.iter().map(|s| ServiceDef {
                id: s.to_string(),
                label: s.to_string(),
                description: String::new(),
                command: "true".into(),
                args: vec![],
                cwd: String::new(),
                service_type: "service".into(),
                stop_command: vec![],
            }).collect(),
        }
    }

    #[test]
    fn a_first_service_gets_a_group_named_after_the_project() {
        let mut groups = vec![];
        assert_eq!(pick_group(&mut groups, None, "My App").unwrap().id, "my-app");
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn with_one_group_it_is_the_one() {
        let mut groups = vec![group("web", &[])];
        assert_eq!(pick_group(&mut groups, None, "x").unwrap().id, "web");
    }

    #[test]
    fn with_several_groups_one_has_to_be_named() {
        let mut groups = vec![group("web", &[]), group("db", &[])];
        assert!(pick_group(&mut groups, None, "x").err().unwrap().contains("WEB, DB"));
        assert_eq!(pick_group(&mut groups, Some("db"), "x").unwrap().id, "db");
        // By label too, whatever its case.
        assert_eq!(pick_group(&mut groups, Some("Web"), "x").unwrap().id, "web");
    }

    #[test]
    fn a_group_named_and_missing_is_made() {
        let mut groups = vec![group("web", &[])];
        assert_eq!(pick_group(&mut groups, Some("Workers"), "x").unwrap().label, "Workers");
        assert_eq!(groups.len(), 2);
    }

    #[test]
    fn ids_are_unique_across_worktrees() {
        let mut config = AppConfig { groups: vec![group("g", &["web"])], worktrees: vec![] };
        config.worktrees.push(super::super::WorktreeDef {
            id: "wt".into(), branch: "b".into(), path: "/x".into(), groups: vec![group("g", &["web-2"])],
        });
        assert_eq!(unique_id(&config, "Web"), "web-3");
        assert_eq!(unique_id(&config, "API server"), "api-server");
    }

    #[test]
    fn a_service_is_found_by_id_or_by_a_label_naming_one() {
        let config = AppConfig { groups: vec![group("g", &["web", "Api"])], worktrees: vec![] };
        assert_eq!(find(&config, &Checkout::Main, "web").unwrap(), "web");
        assert_eq!(find(&config, &Checkout::Main, "api").unwrap(), "Api");
        assert!(find(&config, &Checkout::Main, "db").is_err());
    }

    #[test]
    fn one_word_is_the_whole_line_and_several_are_quoted() {
        assert_eq!(command_line(&["npm run dev | tee log".into()]), "npm run dev | tee log");
        assert_eq!(command_line(&["echo".into(), "hi there".into()]), "echo 'hi there'");
    }
}
