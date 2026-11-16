//! What differs between macOS and Windows, behind one set of names.
//!
//! macOS is the platform Lever grew up on, so its side is mostly the code that
//! used to sit inline: zsh, process groups and signals, `ps` and `lsof`. The
//! Windows side runs services through cmd.exe, ends them with `taskkill /T`,
//! and reads the process table and TCP table directly.

use std::path::PathBuf;
use std::process::Command;

pub fn home_dir() -> Option<PathBuf> {
    std::env::home_dir().filter(|h| !h.as_os_str().is_empty())
}

/// A `Command` for a helper Lever runs in the background (git, claude, npx…).
/// On Windows it resolves `.cmd` shims, which `Command` alone does not find,
/// and keeps a console window from flashing up for each one.
pub fn command(program: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new(which(program).unwrap_or_else(|| PathBuf::from(program)));
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    Command::new(program)
}

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The executable `name` resolves to on the PATH Lever hands its children,
/// trying each PATHEXT extension the way cmd.exe does.
#[cfg(windows)]
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::path::Path::new(name);
    if path.is_absolute() || name.contains(['\\', '/']) {
        return Some(path.to_path_buf());
    }
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    let has_ext = path.extension().is_some_and(|e| exts.iter().any(|x| x[1..].eq_ignore_ascii_case(&e.to_string_lossy())));
    for dir in std::env::split_paths(&crate::get_shell_path()) {
        if has_ext && dir.join(name).is_file() {
            return Some(dir.join(name));
        }
        for ext in &exts {
            let candidate = dir.join(format!("{}{}", name, ext));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

/// The PATH services and helpers run with.
pub fn shell_path() -> String {
    #[cfg(unix)]
    {
        // An interactive login zsh sources the user's full rc files, so it
        // sees what their terminal sees; Lever started from the Dock does not.
        if let Ok(output) = Command::new("/bin/zsh").args(["-il", "-c", "echo $PATH"]).output() {
            if let Ok(path) = String::from_utf8(output.stdout) {
                let trimmed = path.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    // Windows apps inherit the user's PATH from Explorer already.
    std::env::var("PATH").unwrap_or_default()
}

/// The PTY command a service's shell line runs under.
pub fn service_command(line: &str) -> portable_pty::CommandBuilder {
    #[cfg(unix)]
    {
        let mut cmd = portable_pty::CommandBuilder::new("/bin/zsh");
        cmd.args(["-il", "-c", line]);
        cmd
    }
    #[cfg(windows)]
    {
        // The line goes through an environment variable because the PTY
        // quotes arguments the C runtime way (\"), which cmd.exe does not
        // undo. cmd expands %VAR% before it looks for quotes, pipes and &&,
        // so the line runs exactly as typed.
        let mut cmd = portable_pty::CommandBuilder::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        cmd.args(["/d", "/c", "%LEVER_SERVICE_LINE%"]);
        cmd.env("LEVER_SERVICE_LINE", line);
        cmd
    }
}

/// The PTY command for an interactive terminal tab.
pub fn terminal_command() -> portable_pty::CommandBuilder {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = portable_pty::CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd
    }
    #[cfg(windows)]
    {
        let shell = which("pwsh.exe")
            .or_else(|| which("powershell.exe"))
            .map(|p| p.into_os_string())
            .unwrap_or_else(|| std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
        let mut cmd = portable_pty::CommandBuilder::new(shell);
        cmd.arg("-NoLogo");
        cmd
    }
}

/// `s` as one word of a shell line.
pub fn shell_escape(s: &str) -> String {
    if s.chars().all(|c| c.is_alphanumeric() || "-_./:=@\\".contains(c)) {
        return s.to_string();
    }
    if cfg!(windows) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/// Detaches a spawned helper from Lever's own process group, so ending the
/// group later reaches everything it started and nothing of Lever's.
pub fn own_process_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
    }
}

/// Asks `pid` and everything under it to end.
pub fn terminate_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
        libc::kill(pid as i32, libc::SIGTERM);
    }
    // Console programs have no polite way to be asked; this is the only stop.
    #[cfg(windows)]
    kill_tree(pid);
}

/// Ends `pid` and everything under it, now.
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = command("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).output();
    }
}

/// Whether `pid` still exists. Never reaps; see `is_pid_alive` for that.
pub fn pid_exists(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

/// Every process as `(pid, ppid, command line words)`.
pub fn process_list() -> Vec<(u32, u32, Vec<String>)> {
    #[cfg(unix)]
    {
        let output = match Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output() {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        parse_ps(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(windows)]
    {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );
        sys.processes()
            .iter()
            .map(|(pid, p)| {
                let mut words: Vec<String> = p.cmd().iter().map(|w| w.to_string_lossy().into_owned()).collect();
                if words.is_empty() {
                    words.push(p.name().to_string_lossy().into_owned());
                }
                (pid.as_u32(), p.parent().map_or(0, |pp| pp.as_u32()), words)
            })
            .collect()
    }
}

#[cfg_attr(windows, allow(dead_code))]
pub fn parse_ps(text: &str) -> Vec<(u32, u32, Vec<String>)> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            let ppid = parts.next()?.parse::<u32>().ok()?;
            Some((pid, ppid, parts.map(str::to_string).collect()))
        })
        .collect()
}

/// The last component of an executable path, without Windows' `.exe`/`.cmd`.
pub fn exe_basename(s: &str) -> &str {
    let base = s.rsplit(['/', '\\']).next().unwrap_or(s);
    if cfg!(windows) {
        for ext in [".exe", ".cmd", ".bat", ".EXE", ".CMD", ".BAT"] {
            if let Some(stem) = base.strip_suffix(ext) {
                return stem;
            }
        }
    }
    base
}

/// The working directory of another process.
#[cfg(windows)]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    let pid = Pid::from_u32(pid);
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    sys.process(pid)?.cwd().filter(|p| !p.as_os_str().is_empty()).map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// TCP: who listens where, and who is on the far end of a connection
// ---------------------------------------------------------------------------

/// `netstat -ano -p TCP` rows as (local, remote, state, pid).
#[cfg(windows)]
pub fn netstat_tcp() -> Vec<(String, String, String, u32)> {
    let Ok(out) = command("netstat").args(["-ano", "-p", "TCP"]).output() else { return Vec::new() };
    parse_netstat(&String::from_utf8_lossy(&out.stdout))
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_netstat(text: &str) -> Vec<(String, String, String, u32)> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            match cols.as_slice() {
                [proto, local, remote, state, pid] if proto.eq_ignore_ascii_case("TCP") => {
                    Some((local.to_string(), remote.to_string(), state.to_string(), pid.parse().ok()?))
                }
                _ => None,
            }
        })
        .collect()
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn port_of(addr: &str) -> Option<u16> {
    addr.rsplit(':').next()?.parse().ok()
}

// ---------------------------------------------------------------------------
// Windows Credential Manager: where the Keychain's passwords go on Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
pub fn credential_get(target: &str) -> Option<String> {
    use windows_sys::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};
    let target = wide(target);
    unsafe {
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) == 0 {
            return None;
        }
        let blob = std::slice::from_raw_parts((*cred).CredentialBlob, (*cred).CredentialBlobSize as usize).to_vec();
        CredFree(cred as *const _);
        String::from_utf8(blob).ok()
    }
}

#[cfg(windows)]
pub fn credential_set(target: &str, secret: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};
    let mut target = wide(target);
    let mut blob = secret.as_bytes().to_vec();
    unsafe {
        let mut cred: CREDENTIALW = std::mem::zeroed();
        cred.Type = CRED_TYPE_GENERIC;
        cred.TargetName = target.as_mut_ptr();
        cred.CredentialBlobSize = blob.len() as u32;
        cred.CredentialBlob = blob.as_mut_ptr();
        cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
        if CredWriteW(&cred, 0) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn credential_delete(target: &str) {
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
    let target = wide(target);
    unsafe {
        CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0);
    }
}

// ---------------------------------------------------------------------------
// The CLI's console
// ---------------------------------------------------------------------------

/// A release build is a GUI program on Windows, which gets no console of its
/// own; run as `lever …` it borrows the terminal it was started from.
pub fn attach_parent_console() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netstat_rows_parse() {
        let rows = parse_netstat(
            "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4120\n  TCP    [::1]:8080             [::]:0                 LISTENING       77\n  TCP    127.0.0.1:51234        127.0.0.1:18281        ESTABLISHED     900\n",
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], ("0.0.0.0:5173".into(), "0.0.0.0:0".into(), "LISTENING".into(), 4120));
        assert_eq!(port_of(&rows[1].0), Some(8080));
        assert_eq!(rows[2].3, 900);
    }

    #[test]
    fn exe_basenames_drop_the_directory() {
        assert_eq!(exe_basename("/opt/node_modules/.bin/claude"), "claude");
        assert_eq!(exe_basename("claude"), "claude");
    }
}
