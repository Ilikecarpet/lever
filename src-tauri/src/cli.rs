//! `lever`, the command line.
//!
//! The same executable as the app: installed as a symlink named `lever`, it
//! runs this instead of opening a window. It is a thin client of the running
//! Lever (daemon.rs), which owns every service; with no Lever running, it
//! starts one headless, through Launch Services, so the services it starts
//! run as Lever.app's and keep the privacy permissions granted to it.

use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::daemon::socket_path;

const LAUNCH_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Parser)]
#[command(name = "lever", version, about = "Define, run and watch your Lever services from the terminal.",
    long_about = "Define, run and watch your Lever services from the terminal.\n\n\
Commands act on the project and checkout (main or worktree) holding the current directory, \
like Lever's MCP tools. Services run inside Lever — it is started in the background when it \
is not running — so they show up in its window when you open one.")]
struct Cli {
    /// Project id or name, when not the one holding the current directory.
    #[arg(long, short = 'p', global = true)]
    project: Option<String>,
    /// "main", "all", or a worktree branch or path.
    #[arg(long, short = 'c', global = true)]
    checkout: Option<String>,
    /// Print the reply as JSON.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Services and tasks here, with status and ports.
    #[command(alias = "ls")]
    Status,
    /// Projects Lever knows about.
    Projects,
    /// Make the current directory a Lever project.
    Init {
        /// Named after the directory unless given.
        #[arg(long)]
        name: Option<String>,
    },
    /// Define a service (or, with --task, a task) here.
    #[command(after_help = "Examples:\n  lever add web npm run dev\n  lever add build --task \"cargo build 2>&1 | tee build.log\"\n\nOptions go before the command; everything after it is the command's.")]
    Add {
        /// What it is called; its id is made from this.
        name: String,
        /// The command line, as you would type it. Quote it as one argument to keep pipes and `&&`.
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<String>,
        /// The group to put it in, made if missing. Needed when there are several.
        #[arg(long, short = 'g')]
        group: Option<String>,
        /// A task runs to completion rather than staying up.
        #[arg(long)]
        task: bool,
        /// Where it runs; the checkout's directory unless given.
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// A command that stops it, run before it is signalled.
        #[arg(long)]
        stop: Option<String>,
        /// A note shown with it in the window.
        #[arg(long, short = 'd')]
        description: Option<String>,
    },
    /// Remove services from the project. Running ones must be stopped first.
    #[command(alias = "rm")]
    Remove {
        #[arg(required = true)]
        services: Vec<String>,
    },
    /// Start services and wait for each to come up.
    Start {
        #[arg(required = true)]
        services: Vec<String>,
        /// Wait up to this many seconds for a task to finish.
        #[arg(long)]
        wait: Option<u64>,
    },
    /// Stop services.
    Stop {
        #[arg(required = true)]
        services: Vec<String>,
    },
    /// Restart services.
    Restart {
        #[arg(required = true)]
        services: Vec<String>,
    },
    /// Start a group's services, or every service (not task) here.
    Up { group: Option<String> },
    /// Print a service's output.
    Logs {
        service: String,
        /// Keep printing new output.
        #[arg(long, short = 'f')]
        follow: bool,
        /// How many of the newest lines to print first.
        #[arg(long, short = 'n', default_value_t = 200)]
        lines: u64,
    },
    /// Run a service or task in the foreground; Ctrl-C stops it. Exits with its code.
    Run { service: String },
    /// Open this project in a Lever window.
    Open,
    /// The background Lever.
    Daemon {
        #[command(subcommand)]
        action: DaemonCmd,
    },
}

#[derive(Subcommand)]
enum DaemonCmd {
    /// Whether Lever is running.
    Status,
    /// Start Lever in the background.
    Start,
    /// Quit Lever, and the services it runs.
    Stop,
}

/// Run as the CLI rather than the app: called with a command, or, installed as
/// `lever` outside the bundle, with nothing (which prints help). A release app
/// is launched with no arguments, or `--headless`, or the `-psn_` macOS adds.
pub fn invoked_as_cli() -> bool {
    let mut args = std::env::args();
    let argv0 = args.next().unwrap_or_default();
    match args.next() {
        Some(a) => a != "--headless" && !a.starts_with("-psn_"),
        // `cargo tauri dev` runs the bare binary from target/.
        None => !cfg!(debug_assertions) && !argv0.contains(".app/Contents/MacOS/"),
    }
}

pub fn main() -> i32 {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("lever: {}", e);
            1
        }
    }
}

fn run(cli: Cli) -> Result<i32, String> {
    let mut scope = json!({});
    if let Some(p) = &cli.project {
        scope["project"] = json!(p);
    }
    if let Some(c) = &cli.checkout {
        scope["checkout"] = json!(c);
    }
    let tool = |name: &str, extra: Value| {
        let mut args = scope.clone();
        if let (Some(a), Some(e)) = (args.as_object_mut(), extra.as_object()) {
            a.extend(e.clone());
        }
        json!({ "name": name, "args": args })
    };
    let with_scope = |extra: Value| {
        let mut args = scope.clone();
        if let (Some(a), Some(e)) = (args.as_object_mut(), extra.as_object()) {
            a.extend(e.clone());
        }
        args
    };

    match cli.command {
        Cmd::Status => {
            let text = call_text("tool", tool("list_services", json!({})))?;
            if cli.json {
                println!("{}", text);
            } else {
                print_status(&serde_json::from_str(&text).map_err(|e| e.to_string())?);
            }
            Ok(0)
        }
        Cmd::Projects => {
            let result = call("projects", with_scope(json!({})), |_| {})?;
            if cli.json {
                println!("{}", result);
            } else {
                print_projects(&result);
            }
            Ok(0)
        }
        Cmd::Init { name } => {
            let mut extra = json!({});
            if let Some(n) = name {
                extra["name"] = json!(n);
            }
            let result = call("init", extra, |_| {})?;
            if cli.json {
                println!("{}", result);
            } else {
                println!("Made {} the project '{}'. Add services with `lever add`.", str_of(&result["repoPath"]), str_of(&result["name"]));
            }
            Ok(0)
        }
        Cmd::Add { name, command, group, task, cwd, stop, description } => {
            let mut extra = json!({ "name": name, "command": super::define::command_line(&command), "task": task });
            if let Some(g) = group {
                extra["group"] = json!(g);
            }
            if let Some(c) = cwd {
                let here = std::env::current_dir().map_err(|e| e.to_string())?;
                extra["cwd"] = json!(here.join(c).to_string_lossy());
            }
            if let Some(s) = stop {
                extra["stop"] = json!(s);
            }
            if let Some(d) = description {
                extra["description"] = json!(d);
            }
            let result = call("add", with_scope(extra), |_| {})?;
            if cli.json {
                println!("{}", result);
            } else {
                println!("Added {} '{}' to {}.", if task { "task" } else { "service" }, str_of(&result["id"]), str_of(&result["group"]));
            }
            Ok(0)
        }
        Cmd::Remove { services } => each(&services, |s| {
            call("remove", with_scope(json!({ "service": s })), |_| {})
                .map(|r| format!("Removed '{}'.", str_of(&r["id"])))
        }),
        Cmd::Start { services, wait } => each(&services, |s| {
            let mut extra = json!({ "service": s });
            if let Some(w) = wait {
                extra["wait_seconds"] = json!(w);
            }
            call_text("tool", tool("start_service", extra))
        }),
        Cmd::Stop { services } => each(&services, |s| call_text("tool", tool("stop_service", json!({ "service": s })))),
        Cmd::Restart { services } => each(&services, |s| call_text("tool", tool("restart_service", json!({ "service": s })))),
        Cmd::Up { group } => {
            let mut extra = json!({});
            if let Some(g) = group {
                extra["group"] = json!(g);
            }
            let result = call("up", with_scope(extra), |_| {})?;
            if cli.json {
                println!("{}", result);
                return Ok(0);
            }
            let rows = result.as_array().cloned().unwrap_or_default();
            if rows.is_empty() {
                println!("Nothing to start here.");
            }
            let mut failed = false;
            for r in rows {
                let status = r["status"].as_str().unwrap_or("");
                failed |= status == "failed";
                match r["error"].as_str() {
                    Some(e) => println!("{:<28} {}: {}", str_of(&r["service"]), status, e),
                    None => println!("{:<28} {}", str_of(&r["service"]), status),
                }
            }
            Ok(if failed { 1 } else { 0 })
        }
        Cmd::Logs { service, follow, lines } => {
            call("logs", with_scope(json!({ "service": service, "follow": follow, "lines": lines })), print_chunk)?;
            Ok(0)
        }
        Cmd::Run { service } => {
            let result = call("run", with_scope(json!({ "service": service })), print_chunk)?;
            let _ = std::io::stdout().flush();
            if let Some(s) = result["summary"].as_str() {
                eprintln!("\n{}", s);
            }
            Ok(match (result["exitCode"].as_i64(), result["signal"].as_str()) {
                (Some(c), _) => c as i32,
                (None, Some(_)) => 130,
                _ => 1,
            })
        }
        Cmd::Open => {
            call("open", with_scope(json!({})), |_| {})?;
            Ok(0)
        }
        Cmd::Daemon { action } => daemon(action),
    }
}

fn daemon(action: DaemonCmd) -> Result<i32, String> {
    let path = socket_path().ok_or("HOME is not set")?;
    let running = || UnixStream::connect(&path).is_ok();
    match action {
        DaemonCmd::Status => {
            if running() {
                let info = call("ping", json!({}), |_| {})?;
                println!("Lever {} is running (pid {}).", str_of(&info["version"]), info["pid"]);
                Ok(0)
            } else {
                println!("Lever is not running.");
                Ok(1)
            }
        }
        DaemonCmd::Start => {
            call("ping", json!({}), |_| {})?;
            println!("Lever is running.");
            Ok(0)
        }
        DaemonCmd::Stop => {
            if !running() {
                println!("Lever is not running.");
                return Ok(0);
            }
            call("shutdown", json!({}), |_| {})?;
            println!("Lever quit.");
            Ok(0)
        }
    }
}

/// Runs `f` for each service in turn, printing what it says; fails if any did.
fn each(services: &[String], f: impl Fn(&str) -> Result<String, String>) -> Result<i32, String> {
    let mut code = 0;
    for s in services {
        match f(s) {
            Ok(text) => println!("{}", text),
            Err(e) => {
                eprintln!("lever: {}", e);
                code = 1;
            }
        }
    }
    Ok(code)
}

fn print_chunk(data: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(data.as_bytes());
    let _ = out.flush();
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn print_status(v: &Value) {
    for c in v["checkouts"].as_array().into_iter().flatten() {
        let title = match c["branch"].as_str() {
            Some(b) => format!("worktree {}", b),
            None => "main".to_string(),
        };
        println!("{}  {}", title, str_of(&c["path"]));
        for g in c["groups"].as_array().into_iter().flatten() {
            println!("  {}", str_of(&g["label"]));
            for s in g["services"].as_array().into_iter().flatten() {
                let running = s["status"] == "running";
                let mut detail = String::new();
                if let Some(ports) = s["ports"].as_array() {
                    let ports: Vec<String> = ports.iter().map(|p| format!(":{}", p)).collect();
                    detail = ports.join(" ");
                } else if let Some(run) = s["lastRun"].as_object() {
                    detail = match (run.get("exitCode").and_then(Value::as_i64), run.get("signal").and_then(Value::as_str)) {
                        (Some(c), _) => format!("exited {}", c),
                        (None, Some(sig)) => format!("ended by {}", sig),
                        _ => "exited".into(),
                    };
                }
                println!("    {} {:<24} {:<5} {:<8} {}",
                    if running { "●" } else { "○" },
                    str_of(&s["id"]),
                    if s["kind"] == "task" { "task" } else { "" },
                    str_of(&s["status"]),
                    detail);
            }
        }
    }
}

fn print_projects(v: &Value) {
    let list = v.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        println!("Lever has no projects yet. Run `lever init` in one, or add it in the Lever window.");
    }
    for p in list {
        let here = if p["here"] == true { "  ← here" } else { "" };
        println!("{:<24} {:<24} {}{}", str_of(&p["name"]), str_of(&p["id"]), str_of(&p["repoPath"]), here);
    }
}

// ---------------------------------------------------------------------------
// Talking to Lever
// ---------------------------------------------------------------------------

/// Sends one request, handing streamed output to `on_data`, and returns the
/// result.
fn call(op: &str, args: Value, on_data: impl Fn(&str)) -> Result<Value, String> {
    let mut stream = connect()?;
    let cwd = std::env::current_dir().ok();
    let mut line = json!({ "op": op, "cwd": cwd, "args": args }).to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    for reply in BufReader::new(&stream).lines() {
        let reply: Value = serde_json::from_str(&reply.map_err(|e| e.to_string())?)
            .map_err(|e| format!("bad reply from Lever: {}", e))?;
        match reply["type"].as_str() {
            Some("data") => on_data(str_of(&reply["data"])),
            Some("done") => {
                return if reply["ok"] == true {
                    Ok(reply["result"].clone())
                } else {
                    Err(str_of(&reply["error"]).to_string())
                };
            }
            _ => {}
        }
    }
    Err("Lever closed the connection".into())
}

fn call_text(op: &str, args: Value) -> Result<String, String> {
    call(op, args, |_| {}).map(|v| str_of(&v).to_string())
}

fn connect() -> Result<UnixStream, String> {
    let path = socket_path().ok_or("HOME is not set")?;
    // sun_path holds 104 bytes on macOS; a longer path can never be bound.
    if path.as_os_str().len() >= 104 {
        return Err(format!("{} is too long a path for a socket", path.display()));
    }
    if let Ok(s) = UnixStream::connect(&path) {
        return Ok(s);
    }
    launch_headless()?;
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(s) = UnixStream::connect(&path) {
            return Ok(s);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("started Lever, but it did not answer on {} within {}s", path.display(), LAUNCH_TIMEOUT.as_secs()))
}

/// The Lever.app this executable is part of, following the `lever` symlink.
fn app_bundle() -> Option<PathBuf> {
    let exe = std::fs::canonicalize(std::env::current_exe().ok()?).ok()?;
    exe.ancestors().find(|p| p.extension().map_or(false, |e| e == "app")).map(PathBuf::from)
}

fn launch_headless() -> Result<(), String> {
    match app_bundle() {
        // Through Launch Services, so Lever runs as Lever.app — the app macOS
        // attributes its services' privacy permissions to — not as a child of
        // this terminal. -g: don't come to the front. -j: launch hidden.
        Some(app) => std::process::Command::new("/usr/bin/open")
            .args(["-g", "-j", "-a"])
            .arg(&app)
            .args(["--args", "--headless"])
            .status()
            .map_err(|e| format!("could not start Lever: {}", e))
            .and_then(|s| if s.success() { Ok(()) } else { Err(format!("`open` could not start {}", app.display())) }),
        // A development build outside any bundle.
        None => {
            use std::os::unix::process::CommandExt;
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            std::process::Command::new(exe)
                .arg("--headless")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .process_group(0)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("could not start Lever: {}", e))
        }
    }
}

// ---------------------------------------------------------------------------
// Installing `lever` (from the app's settings)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliState {
    /// Where `lever` links to this Lever, when it does.
    path: Option<String>,
    /// Whether that directory is on the login shell's PATH.
    on_path: bool,
}

/// /usr/local/bin where it can be written without a password, which on Apple
/// Silicon — no Homebrew there — it often cannot; then ~/.local/bin.
fn link_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/usr/local/bin")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    dirs
}

fn this_exe() -> Result<PathBuf, String> {
    std::env::current_exe().and_then(std::fs::canonicalize).map_err(|e| e.to_string())
}

/// The `lever` link in `dir`, if it is one to this Lever.
fn our_link(dir: &std::path::Path, exe: &std::path::Path) -> Option<PathBuf> {
    let link = dir.join("lever");
    let target = std::fs::read_link(&link).ok()?;
    (std::fs::canonicalize(&target).ok()? == exe).then_some(link)
}

fn cli_state_now() -> Result<CliState, String> {
    let exe = this_exe()?;
    let path = link_dirs().iter().find_map(|d| our_link(d, &exe));
    let shell_path = super::get_shell_path();
    let on_path = path.as_ref()
        .and_then(|p| p.parent())
        .map_or(false, |dir| std::env::split_paths(&shell_path).any(|p| p == dir));
    Ok(CliState { path: path.map(|p| p.display().to_string()), on_path })
}

#[tauri::command]
pub fn cli_state() -> Result<CliState, String> {
    cli_state_now()
}

#[tauri::command]
pub fn install_cli() -> Result<CliState, String> {
    let exe = this_exe()?;
    if link_dirs().iter().any(|d| our_link(d, &exe).is_some()) {
        return cli_state_now();
    }
    let mut last_err = String::from("nowhere to put it");
    for dir in link_dirs() {
        let link = dir.join("lever");
        if link.symlink_metadata().is_ok() {
            last_err = format!("{} already exists and is not this Lever; remove it first", link.display());
            continue;
        }
        if dir.starts_with(std::env::var_os("HOME").unwrap_or_default()) {
            let _ = std::fs::create_dir_all(&dir);
        }
        match std::os::unix::fs::symlink(&exe, &link) {
            Ok(()) => return cli_state_now(),
            Err(e) => last_err = format!("could not create {}: {}", link.display(), e),
        }
    }
    Err(last_err)
}

#[tauri::command]
pub fn uninstall_cli() -> Result<CliState, String> {
    let exe = this_exe()?;
    for dir in link_dirs() {
        if let Some(link) = our_link(&dir, &exe) {
            std::fs::remove_file(&link).map_err(|e| format!("could not remove {}: {}", link.display(), e))?;
        }
    }
    cli_state_now()
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_line_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn only_a_link_to_this_lever_counts_as_installed() {
        let dir = std::env::temp_dir().join(format!("lever-cli-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = this_exe().unwrap();
        assert!(our_link(&dir, &exe).is_none());
        std::os::unix::fs::symlink("/bin/ls", dir.join("lever")).unwrap();
        assert!(our_link(&dir, &exe).is_none());
        std::fs::remove_file(dir.join("lever")).unwrap();
        std::os::unix::fs::symlink(&exe, dir.join("lever")).unwrap();
        assert_eq!(our_link(&dir, &exe), Some(dir.join("lever")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn global_flags_go_anywhere() {
        let cli = Cli::try_parse_from(["lever", "logs", "web", "-f", "--checkout", "main"]).unwrap();
        assert_eq!(cli.checkout.as_deref(), Some("main"));
        assert!(matches!(cli.command, Cmd::Logs { follow: true, lines: 200, .. }));
        assert!(Cli::try_parse_from(["lever", "start"]).is_err());
    }
}
