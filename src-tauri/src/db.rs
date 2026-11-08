//! Databases: the viewer in the window (browse, search, run SQL) and
//! read-only access for agents over MCP.
//!
//! A connection is defined per project and opened per checkout, so
//! `${DATABASE_URL}` in its URL reads each worktree's own `.env` and a
//! worktree's database stays its own. Passwords never touch config.json: they
//! sit in the login Keychain under the connection's id.
//!
//! Sessions are kept open between calls and keyed by (project, connection,
//! checkout, mode). Agents never share the window's session: theirs is opened
//! read-only, and every statement they send is checked to be a single read
//! before it runs inside a read-only transaction — the database itself is
//! what refuses a write, not a keyword filter alone.

use futures_util::{pin_mut, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use super::mcp::{self, Checkout};
use super::AppState;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Postgres,
    Mysql,
    Sqlite,
}

impl Engine {
    fn label(self) -> &'static str {
        match self {
            Engine::Postgres => "PostgreSQL",
            Engine::Mysql => "MySQL",
            Engine::Sqlite => "SQLite",
        }
    }
}

fn yes() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DbConnectionDef {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    /// `postgres://user@host:5432/db`, `mysql://…`, or a file path for SQLite.
    /// `${VAR}` is read from the checkout's .env, then Lever's environment.
    #[serde(default)]
    pub url: String,
    /// Refuse writes from the window too, not only from agents.
    #[serde(default)]
    pub read_only: bool,
    /// Whether agents can see this connection over MCP at all.
    #[serde(default = "yes")]
    pub agent_access: bool,
    /// A tag colour, so production never looks like local.
    #[serde(default)]
    pub color: Option<String>,
}

// ---------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------

/// The window's statements return at most this many rows by default.
const DEFAULT_MAX_ROWS: usize = 1000;
const MAX_ROWS_CEILING: usize = 50_000;
/// A cell longer than this is cut, so one huge JSON document can't stall the
/// grid.
const MAX_CELL_CHARS: usize = 100_000;
const AGENT_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SCHEMA_TTL: Duration = Duration::from_secs(60);

#[derive(Serialize, Clone, Debug)]
pub struct ColumnMeta {
    pub name: String,
    /// The column's type when the driver reports it (MySQL, SQLite).
    #[serde(rename = "type")]
    pub data_type: Option<String>,
}

#[derive(Serialize, Default, Clone, Debug)]
pub struct ResultSet {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Option<String>>>,
    /// More rows existed than were fetched.
    pub truncated: bool,
    /// Rows changed, for a statement that returns none.
    pub affected: Option<u64>,
}

#[derive(Serialize)]
pub struct QueryOutput {
    pub sets: Vec<ResultSet>,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct DbError {
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character offset into the statement, when the server says
    /// where it went wrong.
    pub position: Option<u32>,
    /// The statement was cancelled rather than failed.
    #[serde(default)]
    pub cancelled: bool,
    /// Which of a batch of row changes failed, when one did.
    #[serde(rename = "changeIndex")]
    pub change_index: Option<usize>,
}

impl DbError {
    fn new(message: impl Into<String>) -> Self {
        DbError { message: message.into(), ..Default::default() }
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(d) = &self.detail {
            write!(f, "\nDetail: {}", d)?;
        }
        if let Some(h) = &self.hint {
            write!(f, "\nHint: {}", h)?;
        }
        if let Some(p) = self.position {
            write!(f, "\n(at character {})", p)?;
        }
        Ok(())
    }
}

impl From<String> for DbError {
    fn from(s: String) -> Self {
        DbError::new(s)
    }
}

impl From<&str> for DbError {
    fn from(s: &str) -> Self {
        DbError::new(s)
    }
}

impl From<tokio_postgres::Error> for DbError {
    fn from(e: tokio_postgres::Error) -> Self {
        if let Some(db) = e.as_db_error() {
            let position = match db.position() {
                Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                _ => None,
            };
            return DbError {
                message: db.message().to_string(),
                detail: db.detail().map(str::to_string),
                hint: db.hint().map(str::to_string),
                position,
                cancelled: db.code() == &tokio_postgres::error::SqlState::QUERY_CANCELED,
                change_index: None,
            };
        }
        // "error connecting to server: Connection refused (os error 61)" is
        // the useful part; the wrapper chain says it twice.
        let mut msg = e.to_string();
        if let Some(src) = std::error::Error::source(&e) {
            let s = src.to_string();
            if !msg.contains(&s) {
                msg = format!("{}: {}", msg, s);
            }
        }
        with_network_hint(DbError::new(msg))
    }
}

impl From<mysql::Error> for DbError {
    fn from(e: mysql::Error) -> Self {
        match e {
            mysql::Error::MySqlError(m) => DbError {
                cancelled: m.code == 1317,
                message: m.message,
                ..Default::default()
            },
            other => with_network_hint(DbError::new(other.to_string())),
        }
    }
}

/// The OS's words for a failed connect say what happened, not what to do.
fn with_network_hint(mut e: DbError) -> DbError {
    let m = e.message.to_ascii_lowercase();
    e.hint = if m.contains("connection refused") {
        Some("Nothing is accepting connections at that host and port. Is the database running, and is the port the one it listens on?".into())
    } else if m.contains("timed out") {
        Some("The server didn't answer. Check the host, and that a firewall or VPN isn't in the way.".into())
    } else if m.contains("failed to lookup") || m.contains("nodename nor servname") {
        Some("That host name doesn't resolve. A Docker service name only works inside Docker; from here it's usually localhost.".into())
    } else {
        e.hint
    };
    e
}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        let cancelled = matches!(
            &e,
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::OperationInterrupted
        );
        DbError { message: e.to_string(), cancelled, ..Default::default() }
    }
}

fn cut_cell(mut s: String) -> String {
    if s.len() > MAX_CELL_CHARS {
        let mut end = MAX_CELL_CHARS;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push('…');
    }
    s
}

fn hex_preview(b: &[u8]) -> String {
    let mut out = String::from("\\x");
    for byte in b.iter().take(64) {
        let _ = write!(out, "{:02x}", byte);
    }
    if b.len() > 64 {
        let _ = write!(out, "… ({} bytes)", b.len());
    }
    out
}

// ---------------------------------------------------------------------------
// Where a connection points: .env expansion and the Keychain
// ---------------------------------------------------------------------------

fn parse_dotenv(text: &str, into: &mut HashMap<String, String>) {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let value = value.trim();
        let value = if let Some(v) = value.strip_prefix('"').and_then(|v| v.rfind('"').map(|i| &v[..i])) {
            v.replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")
        } else if let Some(v) = value.strip_prefix('\'').and_then(|v| v.rfind('\'').map(|i| &v[..i])) {
            v.to_string()
        } else {
            // An unquoted value ends at an inline comment.
            match value.find(" #") {
                Some(i) => value[..i].trim_end().to_string(),
                None => value.to_string(),
            }
        };
        into.insert(key.to_string(), value);
    }
}

/// The checkout's .env, with .env.local on top — the order most frameworks
/// read them in.
fn dotenv(dir: &Path) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    for name in [".env", ".env.local"] {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            parse_dotenv(&text, &mut vars);
        }
    }
    vars
}

fn expand_vars(raw: &str, dir: &Path) -> Result<String, String> {
    if !raw.contains("${") {
        return Ok(raw.trim().to_string());
    }
    let vars = dotenv(dir);
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find('}').ok_or("Unclosed ${ in the connection URL")?;
        let name = &after[..end];
        let value = vars.get(name).cloned().or_else(|| std::env::var(name).ok()).ok_or_else(|| {
            format!("{} isn't set in {}/.env or in Lever's environment", name, dir.display())
        })?;
        out.push_str(&value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out.trim().to_string())
}

const KEYCHAIN_SERVICE: &str = "Lever database";

fn keychain_account(project_id: &str, conn_id: &str) -> String {
    format!("{}/{}", project_id, conn_id)
}

#[cfg(target_os = "macos")]
fn get_password(project_id: &str, conn_id: &str) -> Option<String> {
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, &keychain_account(project_id, conn_id))
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
}

#[cfg(not(target_os = "macos"))]
fn get_password(_: &str, _: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn set_password(project_id: &str, conn_id: &str, password: Option<&str>) -> Result<(), String> {
    use security_framework::passwords::{delete_generic_password, set_generic_password};
    let account = keychain_account(project_id, conn_id);
    match password.filter(|p| !p.is_empty()) {
        Some(p) => set_generic_password(KEYCHAIN_SERVICE, &account, p.as_bytes())
            .map_err(|e| format!("Couldn't save the password to the Keychain: {}", e)),
        None => {
            let _ = delete_generic_password(KEYCHAIN_SERVICE, &account);
            Ok(())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn set_password(_: &str, _: &str, _: Option<&str>) -> Result<(), String> {
    Err("Saved passwords need the macOS Keychain".into())
}

/// Everything needed to open a session, with secrets and variables resolved.
struct Target {
    engine: Engine,
    url: String,
    password: Option<String>,
    /// The checkout the connection was resolved in, for relative SQLite paths.
    dir: PathBuf,
}

fn target_for(def: &DbConnectionDef, dir: &Path, password: Option<String>) -> Result<Target, String> {
    if def.url.trim().is_empty() {
        return Err(match def.engine {
            Engine::Sqlite => "This connection has no database file set".into(),
            _ => "This connection has no URL set".into(),
        });
    }
    Ok(Target { engine: def.engine, url: expand_vars(&def.url, dir)?, password, dir: dir.to_path_buf() })
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// The window, with whatever rights the credentials have.
    Window,
    /// The window on a connection marked read-only.
    Guarded,
    /// An agent: read-only, single statements, a statement timeout.
    Agent,
}

impl Mode {
    fn key(self) -> &'static str {
        match self {
            Mode::Window => "window",
            Mode::Guarded => "guarded",
            Mode::Agent => "agent",
        }
    }
    fn guarded(self) -> bool {
        self != Mode::Window
    }
}

type PgTls = postgres_native_tls::MakeTlsConnector;

enum Conn {
    Pg(tokio_postgres::Client),
    My(mysql::Conn),
    Lite(rusqlite::Connection),
}

enum Canceller {
    Pg(tokio_postgres::CancelToken, PgTls),
    My(mysql::Opts, u32),
    Lite(rusqlite::InterruptHandle),
}

impl Canceller {
    fn cancel(&self) {
        match self {
            Canceller::Pg(token, tls) => {
                let _ = tauri::async_runtime::block_on(token.cancel_query(tls.clone()));
            }
            Canceller::My(opts, id) => {
                if let Ok(mut c) = mysql::Conn::new(opts.clone()) {
                    use mysql::prelude::Queryable;
                    let _ = c.query_drop(format!("KILL QUERY {}", id));
                }
            }
            Canceller::Lite(h) => h.interrupt(),
        }
    }
}

struct Session {
    conn: Mutex<Conn>,
    canceller: Canceller,
    mode: Mode,
    /// Set when a driver error suggests the link is gone, so the next call
    /// reconnects instead of failing the same way.
    broken: std::sync::atomic::AtomicBool,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
static SCHEMAS: OnceLock<Mutex<HashMap<String, (Instant, Arc<Schema>)>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    SESSIONS.get_or_init(Default::default)
}

fn schemas() -> &'static Mutex<HashMap<String, (Instant, Arc<Schema>)>> {
    SCHEMAS.get_or_init(Default::default)
}

/// The database a session talks to, without the mode: the window and an
/// agent looking at the same checkout see the same schema.
fn db_key(project_id: &str, conn_id: &str, worktree_id: Option<&str>) -> String {
    format!("{}\u{1f}{}\u{1f}{}", project_id, conn_id, worktree_id.unwrap_or("main"))
}

fn pg_tls() -> Result<PgTls, String> {
    // libpq's sslmode=prefer/require: encrypt when the server offers it, but
    // don't insist on a certificate chain a local or managed database rarely
    // has. verify-full users can still pass sslrootcert through psql.
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(postgres_native_tls::MakeTlsConnector::new(tls))
}

fn open(target: &Target, mode: Mode) -> Result<Session, DbError> {
    let (conn, canceller) = match target.engine {
        Engine::Postgres => {
            let mut cfg: tokio_postgres::Config =
                target.url.parse().map_err(|e| format!("Couldn't read the connection URL: {}", e))?;
            if cfg.get_password().is_none() {
                if let Some(p) = &target.password {
                    cfg.password(p);
                }
            }
            if cfg.get_user().is_none() {
                if let Ok(user) = std::env::var("USER") {
                    cfg.user(&user);
                }
            }
            if cfg.get_connect_timeout().is_none() {
                cfg.connect_timeout(CONNECT_TIMEOUT);
            }
            cfg.application_name(if mode == Mode::Agent { "Lever (agent)" } else { "Lever" });
            let tls = pg_tls()?;
            let (client, connection) = tauri::async_runtime::block_on(cfg.connect(tls.clone()))?;
            tauri::async_runtime::spawn(async move {
                let _ = connection.await;
            });
            if mode == Mode::Agent {
                tauri::async_runtime::block_on(client.batch_execute(&format!(
                    "SET statement_timeout = {}; SET default_transaction_read_only = on",
                    AGENT_TIMEOUT.as_millis()
                )))?;
            } else if mode == Mode::Guarded {
                tauri::async_runtime::block_on(client.batch_execute("SET default_transaction_read_only = on"))?;
            }
            let token = client.cancel_token();
            (Conn::Pg(client), Canceller::Pg(token, tls))
        }
        Engine::Mysql => {
            use mysql::prelude::Queryable;
            let opts = mysql::Opts::from_url(&target.url).map_err(|e| format!("Couldn't read the connection URL: {}", e))?;
            let mut builder = mysql::OptsBuilder::from_opts(opts.clone()).tcp_connect_timeout(Some(CONNECT_TIMEOUT));
            if opts.get_pass().is_none() {
                if let Some(p) = &target.password {
                    builder = builder.pass(Some(p.clone()));
                }
            }
            let opts: mysql::Opts = builder.into();
            let mut conn = mysql::Conn::new(opts.clone())?;
            if mode.guarded() {
                conn.query_drop("SET SESSION TRANSACTION READ ONLY")?;
            }
            if mode == Mode::Agent {
                // MySQL and MariaDB name this differently; whichever one isn't
                // the server's is just an unknown variable.
                let ms = AGENT_TIMEOUT.as_millis();
                let _ = conn.query_drop(format!("SET SESSION MAX_EXECUTION_TIME = {}", ms));
                let _ = conn.query_drop(format!("SET SESSION max_statement_time = {}", ms / 1000));
            }
            let id = conn.connection_id();
            (Conn::My(conn), Canceller::My(opts, id))
        }
        Engine::Sqlite => {
            use rusqlite::OpenFlags;
            let path = target.url.strip_prefix("sqlite://").or_else(|| target.url.strip_prefix("sqlite:")).unwrap_or(&target.url);
            let path = if let Some(rest) = path.strip_prefix("~/") {
                PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest)
            } else {
                let p = PathBuf::from(path);
                if p.is_absolute() { p } else { target.dir.join(p) }
            };
            if !path.exists() {
                return Err(DbError::new(format!("No database file at {}", path.display())));
            }
            let flags = if mode.guarded() {
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI
            } else {
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI
            };
            let conn = rusqlite::Connection::open_with_flags(&path, flags)?;
            // A dev server holding a write lock shouldn't fail a read outright.
            conn.busy_timeout(Duration::from_secs(5))?;
            if mode.guarded() {
                conn.execute_batch("PRAGMA query_only = ON")?;
            }
            let handle = conn.get_interrupt_handle();
            (Conn::Lite(conn), Canceller::Lite(handle))
        }
    };
    Ok(Session { conn: Mutex::new(conn), canceller, mode, broken: Default::default() })
}

/// The open session for a connection in a checkout, opened if it isn't.
fn session(project_id: &str, def: &DbConnectionDef, worktree_id: Option<&str>, dir: &Path, mode: Mode) -> Result<Arc<Session>, DbError> {
    let key = format!("{}\u{1f}{}", db_key(project_id, &def.id, worktree_id), mode.key());
    if let Some(s) = sessions().lock().unwrap().get(&key) {
        let alive = !s.broken.load(std::sync::atomic::Ordering::Relaxed)
            && match s.conn.try_lock().as_deref() {
                Ok(Conn::Pg(c)) => !c.is_closed(),
                _ => true,
            };
        if alive {
            return Ok(s.clone());
        }
    }
    let target = target_for(def, dir, get_password(project_id, &def.id))?;
    let s = Arc::new(open(&target, mode)?);
    sessions().lock().unwrap().insert(key, s.clone());
    Ok(s)
}

fn forget(project_id: &str, conn_id: &str) {
    let prefix = format!("{}\u{1f}{}\u{1f}", project_id, conn_id);
    sessions().lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
    schemas().lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
}

/// Drops every session a project holds, when its window goes away for good.
pub fn forget_project(project_id: &str) {
    let prefix = format!("{}\u{1f}", project_id);
    sessions().lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
    schemas().lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
}

// ---------------------------------------------------------------------------
// Running statements
// ---------------------------------------------------------------------------

/// The first keyword of a statement, past comments and parentheses.
fn leading_keyword(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else if let Some(rest) = s.strip_prefix('(') {
            s = rest.trim_start();
        } else {
            break;
        }
    }
    s.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_lowercase()
}

/// A statement an agent (or a read-only connection) may send. The database
/// enforces read-only on top of this; the list is what keeps a statement from
/// ending the read-only transaction before it does.
fn check_read(engine: Engine, sql: &str) -> Result<(), DbError> {
    let kw = leading_keyword(sql);
    let allowed: &[&str] = match engine {
        Engine::Postgres => &["select", "with", "values", "table", "show", "explain"],
        Engine::Mysql => &["select", "with", "values", "table", "show", "explain", "describe", "desc"],
        Engine::Sqlite => &["select", "with", "values", "explain", "pragma"],
    };
    if kw.is_empty() {
        return Err("Nothing to run".into());
    }
    if !allowed.contains(&kw.as_str()) {
        return Err(DbError {
            message: format!("This connection is read-only, so `{}` can't run here", kw.to_uppercase()),
            hint: Some(format!("Read statements start with {}", allowed.iter().map(|k| k.to_uppercase()).collect::<Vec<_>>().join(", "))),
            ..Default::default()
        });
    }
    let lower = sql.to_ascii_lowercase();
    if engine == Engine::Mysql && (lower.contains("into outfile") || lower.contains("into dumpfile")) {
        return Err("Writing query results to a file isn't allowed on a read-only connection".into());
    }
    if engine == Engine::Sqlite && kw == "pragma" && lower.contains('=') {
        return Err("Setting a PRAGMA isn't allowed on a read-only connection".into());
    }
    Ok(())
}

fn run(session: &Session, sql: &str, max_rows: usize) -> Result<Vec<ResultSet>, DbError> {
    let mut conn = session.conn.lock().unwrap();
    let guarded = session.mode.guarded();
    let result = match &mut *conn {
        Conn::Pg(client) => {
            let tls = match &session.canceller {
                Canceller::Pg(_, tls) => tls.clone(),
                _ => unreachable!(),
            };
            tauri::async_runtime::block_on(async {
                if guarded {
                    check_read(Engine::Postgres, sql)?;
                    client.batch_execute("BEGIN READ ONLY").await?;
                    // Preparing is what proves it is one statement: the
                    // extended protocol refuses two.
                    let checked = client.prepare(sql).await.map_err(DbError::from);
                    let out = match checked {
                        Ok(_) => pg_run(client, &tls, sql, max_rows).await,
                        Err(e) => Err(e),
                    };
                    let _ = client.batch_execute("ROLLBACK").await;
                    out
                } else {
                    pg_run(client, &tls, sql, max_rows).await
                }
            })
        }
        Conn::My(c) => {
            if guarded {
                my_guarded(c, sql, max_rows, &session.canceller)
            } else {
                my_run(c, sql, max_rows, &session.canceller)
            }
        }
        Conn::Lite(c) => {
            if guarded {
                check_read(Engine::Sqlite, sql)
                    .and_then(|_| c.prepare(sql).map(|_| ()).map_err(DbError::from))
                    .and_then(|_| lite_run(c, sql, max_rows))
            } else {
                lite_run(c, sql, max_rows)
            }
        }
    };
    if let Err(e) = &result {
        let m = e.message.to_ascii_lowercase();
        if m.contains("connection closed") || m.contains("broken pipe") || m.contains("connection reset") || m.contains("server has gone away") || m.contains("lost connection") {
            session.broken.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    result
}

async fn pg_run(client: &tokio_postgres::Client, tls: &PgTls, sql: &str, max_rows: usize) -> Result<Vec<ResultSet>, DbError> {
    use tokio_postgres::SimpleQueryMessage as M;
    let stream = client.simple_query_raw(sql).await?;
    pin_mut!(stream);
    let mut sets = Vec::new();
    let mut current: Option<ResultSet> = None;
    let mut truncated = false;
    while let Some(msg) = stream.next().await {
        match msg? {
            M::RowDescription(cols) => {
                current = Some(ResultSet {
                    columns: cols.iter().map(|c| ColumnMeta { name: c.name().to_string(), data_type: None }).collect(),
                    ..Default::default()
                });
            }
            M::Row(row) => {
                let set = current.get_or_insert_with(Default::default);
                if set.rows.len() >= max_rows {
                    set.truncated = true;
                    truncated = true;
                    break;
                }
                set.rows.push((0..row.len()).map(|i| row.get(i).map(|v| cut_cell(v.to_string()))).collect());
            }
            M::CommandComplete(n) => {
                let mut set = current.take().unwrap_or_default();
                if set.columns.is_empty() {
                    set.affected = Some(n);
                }
                sets.push(set);
            }
            _ => {}
        }
    }
    if truncated {
        if let Some(set) = current.take() {
            sets.push(set);
        }
        // Stop the server producing rows nobody will read, then drain what
        // is in flight so the cancel can't land on the next statement.
        let _ = client.cancel_token().cancel_query(tls.clone()).await;
        while let Some(msg) = stream.next().await {
            if msg.is_err() {
                break;
            }
        }
    }
    Ok(sets)
}

fn my_type(t: mysql::consts::ColumnType) -> String {
    use mysql::consts::ColumnType::*;
    match t {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => "blob",
        MYSQL_TYPE_GEOMETRY => "geometry",
        _ => "varchar",
    }
    .to_string()
}

fn my_value(v: mysql::Value) -> Option<String> {
    use mysql::Value::*;
    Some(match v {
        NULL => return None,
        Bytes(b) => match String::from_utf8(b) {
            Ok(s) => cut_cell(s),
            Err(e) => hex_preview(e.as_bytes()),
        },
        Int(i) => i.to_string(),
        UInt(u) => u.to_string(),
        Float(f) => f.to_string(),
        Double(d) => d.to_string(),
        Date(y, mo, d, h, mi, s, us) => {
            if h == 0 && mi == 0 && s == 0 && us == 0 {
                format!("{:04}-{:02}-{:02}", y, mo, d)
            } else if us == 0 {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
            } else {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}", y, mo, d, h, mi, s, us)
            }
        }
        Time(neg, d, h, mi, s, us) => {
            let hours = d * 24 + h as u32;
            let sign = if neg { "-" } else { "" };
            if us == 0 {
                format!("{}{:02}:{:02}:{:02}", sign, hours, mi, s)
            } else {
                format!("{}{:02}:{:02}:{:02}.{:06}", sign, hours, mi, s, us)
            }
        }
    })
}

fn my_run(conn: &mut mysql::Conn, sql: &str, max_rows: usize, canceller: &Canceller) -> Result<Vec<ResultSet>, DbError> {
    use mysql::prelude::Queryable;
    let mut result = conn.query_iter(sql)?;
    let mut sets = Vec::new();
    let mut killed = false;
    while let Some(set_iter) = result.iter() {
        let columns: Vec<ColumnMeta> = set_iter
            .columns()
            .as_ref()
            .iter()
            .map(|c| ColumnMeta { name: c.name_str().to_string(), data_type: Some(my_type(c.column_type())) })
            .collect();
        let affected = set_iter.affected_rows();
        let mut set = ResultSet { columns, ..Default::default() };
        for row in set_iter {
            if set.rows.len() >= max_rows {
                set.truncated = true;
                if !killed {
                    canceller.cancel();
                    killed = true;
                }
                break;
            }
            let row = match row {
                Ok(r) => r,
                // The rest of the rows were killed on purpose.
                Err(_) if killed => break,
                Err(e) => return Err(e.into()),
            };
            set.rows.push(row.unwrap().into_iter().map(my_value).collect());
        }
        if set.columns.is_empty() {
            set.affected = Some(affected);
        }
        sets.push(set);
        if killed {
            break;
        }
    }
    drop(result);
    Ok(sets)
}

fn my_guarded(conn: &mut mysql::Conn, sql: &str, max_rows: usize, canceller: &Canceller) -> Result<Vec<ResultSet>, DbError> {
    use mysql::prelude::Queryable;
    check_read(Engine::Mysql, sql)?;
    // A prepared statement is one statement; the server refuses more.
    let stmt = conn.prep(sql)?;
    conn.close(stmt)?;
    conn.query_drop("START TRANSACTION READ ONLY")?;
    let out = my_run(conn, sql, max_rows, canceller);
    let _ = conn.query_drop("ROLLBACK");
    out
}

fn lite_value(v: rusqlite::types::ValueRef<'_>) -> Option<String> {
    use rusqlite::types::ValueRef::*;
    Some(match v {
        Null => return None,
        Integer(i) => i.to_string(),
        Real(f) => f.to_string(),
        Text(t) => cut_cell(String::from_utf8_lossy(t).into_owned()),
        Blob(b) => hex_preview(b),
    })
}

fn lite_run(conn: &rusqlite::Connection, sql: &str, max_rows: usize) -> Result<Vec<ResultSet>, DbError> {
    let mut sets = Vec::new();
    let mut batch = rusqlite::Batch::new(conn, sql);
    while let Some(mut stmt) = batch.next()? {
        if stmt.column_count() == 0 {
            let n = stmt.raw_execute()?;
            sets.push(ResultSet { affected: Some(n as u64), ..Default::default() });
            continue;
        }
        let columns: Vec<ColumnMeta> = stmt
            .columns()
            .iter()
            .map(|c| ColumnMeta { name: c.name().to_string(), data_type: c.decl_type().map(|t| t.to_ascii_lowercase()) })
            .collect();
        let width = columns.len();
        let mut set = ResultSet { columns, ..Default::default() };
        let mut rows = stmt.raw_query();
        while let Some(row) = rows.next()? {
            if set.rows.len() >= max_rows {
                set.truncated = true;
                break;
            }
            let mut cells = Vec::with_capacity(width);
            for i in 0..width {
                cells.push(lite_value(row.get_ref(i)?));
            }
            set.rows.push(cells);
        }
        sets.push(set);
    }
    Ok(sets)
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    pub nullable: bool,
    pub pk: bool,
    pub default: Option<String>,
    /// `schema.table.column` this column is a foreign key to.
    pub references: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct TableInfo {
    pub name: String,
    /// table, view, materialized view, foreign table
    pub kind: String,
    /// The planner's estimate, where the engine keeps one.
    pub rows: Option<i64>,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Serialize, Clone)]
pub struct Namespace {
    pub name: String,
    pub tables: Vec<TableInfo>,
}

#[derive(Serialize, Clone)]
pub struct Schema {
    pub engine: Engine,
    pub version: String,
    /// The namespace unqualified names resolve in.
    pub current: Option<String>,
    pub namespaces: Vec<Namespace>,
}

/// Rows of a catalog query, every cell as text.
fn catalog(session: &Session, sql: &str) -> Result<Vec<Vec<Option<String>>>, DbError> {
    Ok(run(session, sql, MAX_ROWS_CEILING * 4)?.into_iter().next().map(|s| s.rows).unwrap_or_default())
}

fn cell(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

/// Groups flat catalog rows into namespaces of tables.
struct SchemaBuilder {
    namespaces: Vec<Namespace>,
    index: HashMap<(String, String), (usize, usize)>,
}

impl SchemaBuilder {
    fn new() -> Self {
        SchemaBuilder { namespaces: Vec::new(), index: HashMap::new() }
    }
    fn table(&mut self, ns: String, name: String, kind: &str, rows: Option<i64>) {
        let ni = match self.namespaces.iter().position(|n| n.name == ns) {
            Some(i) => i,
            None => {
                self.namespaces.push(Namespace { name: ns.clone(), tables: Vec::new() });
                self.namespaces.len() - 1
            }
        };
        let tables = &mut self.namespaces[ni].tables;
        tables.push(TableInfo { name: name.clone(), kind: kind.to_string(), rows, columns: Vec::new() });
        self.index.insert((ns, name), (ni, tables.len() - 1));
    }
    fn get(&mut self, ns: &str, table: &str) -> Option<&mut TableInfo> {
        let &(ni, ti) = self.index.get(&(ns.to_string(), table.to_string()))?;
        Some(&mut self.namespaces[ni].tables[ti])
    }
    fn column(&mut self, ns: &str, table: &str, col: ColumnInfo) {
        if let Some(t) = self.get(ns, table) {
            t.columns.push(col);
        }
    }
    fn mark(&mut self, ns: &str, table: &str, col: &str, pk: bool, references: Option<String>) {
        if let Some(c) = self.get(ns, table).and_then(|t| t.columns.iter_mut().find(|c| c.name == col)) {
            if pk {
                c.pk = true;
            }
            if references.is_some() {
                c.references = references;
            }
        }
    }
}

const PG_NS_FILTER: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
    AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'";

fn introspect(session: &Session, engine: Engine) -> Result<Schema, DbError> {
    let mut b = SchemaBuilder::new();
    let (version, current) = match engine {
        Engine::Postgres => {
            let head = catalog(session, "SELECT current_setting('server_version'), current_schema()")?;
            let row = head.first().cloned().unwrap_or_default();
            for r in catalog(session, &format!(
                "SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND {} \
                 ORDER BY 1, 2", PG_NS_FILTER))?
            {
                let kind = match cell(&r, 2).as_str() {
                    "v" => "view",
                    "m" => "materialized view",
                    "f" => "foreign table",
                    _ => "table",
                };
                let rows = cell(&r, 3).parse::<i64>().ok().filter(|n| *n >= 0);
                b.table(cell(&r, 0), cell(&r, 1), kind, rows);
            }
            for r in catalog(session, &format!(
                "SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), \
                        NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid) \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE a.attnum > 0 AND NOT a.attisdropped \
                   AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND {} \
                 ORDER BY 1, 2, a.attnum", PG_NS_FILTER))?
            {
                b.column(&cell(&r, 0), &cell(&r, 1), ColumnInfo {
                    name: cell(&r, 2),
                    data_type: cell(&r, 3),
                    nullable: cell(&r, 4) == "t",
                    pk: false,
                    default: r.get(5).cloned().flatten(),
                    references: None,
                });
            }
            for r in catalog(session, &format!(
                "SELECT n.nspname, c.relname, a.attname, con.contype, fn.nspname, fc.relname, fa.attname \
                 FROM pg_constraint con \
                 JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, fattnum) \
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum \
                 LEFT JOIN pg_class fc ON fc.oid = con.confrelid \
                 LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
                 LEFT JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fattnum \
                 WHERE con.contype IN ('p', 'f') AND {}", PG_NS_FILTER))?
            {
                let pk = cell(&r, 3) == "p";
                let refs = (!pk).then(|| format!("{}.{}.{}", cell(&r, 4), cell(&r, 5), cell(&r, 6)));
                b.mark(&cell(&r, 0), &cell(&r, 1), &cell(&r, 2), pk, refs);
            }
            (cell(&row, 0), row.get(1).cloned().flatten())
        }
        Engine::Mysql => {
            let head = catalog(session, "SELECT VERSION(), DATABASE()")?;
            let row = head.first().cloned().unwrap_or_default();
            let filter = "TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')";
            for r in catalog(session, &format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES \
                 WHERE {} ORDER BY 1, 2", filter))?
            {
                let kind = if cell(&r, 2).contains("VIEW") { "view" } else { "table" };
                b.table(cell(&r, 0), cell(&r, 1), kind, cell(&r, 3).parse().ok());
            }
            for r in catalog(session, &format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY \
                 FROM information_schema.COLUMNS WHERE {} ORDER BY 1, 2, ORDINAL_POSITION", filter))?
            {
                b.column(&cell(&r, 0), &cell(&r, 1), ColumnInfo {
                    name: cell(&r, 2),
                    data_type: cell(&r, 3),
                    nullable: cell(&r, 4) == "YES",
                    pk: cell(&r, 6) == "PRI",
                    default: r.get(5).cloned().flatten(),
                    references: None,
                });
            }
            for r in catalog(session, &format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
                 FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND {}", filter))?
            {
                let refs = format!("{}.{}.{}", cell(&r, 3), cell(&r, 4), cell(&r, 5));
                b.mark(&cell(&r, 0), &cell(&r, 1), &cell(&r, 2), false, Some(refs));
            }
            (cell(&row, 0), row.get(1).cloned().flatten())
        }
        Engine::Sqlite => {
            let version = catalog(session, "SELECT sqlite_version()")?.first().map(|r| cell(r, 0)).unwrap_or_default();
            let tables = catalog(session, "SELECT name, type FROM sqlite_master \
                WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")?;
            for r in &tables {
                b.table("main".into(), cell(r, 0), &cell(r, 1), None);
            }
            for r in &tables {
                let table = cell(r, 0);
                let quoted = quote_ident(Engine::Sqlite, &table);
                for c in catalog(session, &format!("PRAGMA table_info({})", quoted))? {
                    b.column("main", &table, ColumnInfo {
                        name: cell(&c, 1),
                        data_type: cell(&c, 2).to_ascii_lowercase(),
                        nullable: cell(&c, 3) == "0",
                        pk: cell(&c, 5) != "0" && !cell(&c, 5).is_empty(),
                        default: c.get(4).cloned().flatten(),
                        references: None,
                    });
                }
                for f in catalog(session, &format!("PRAGMA foreign_key_list({})", quoted))? {
                    let refs = format!("main.{}.{}", cell(&f, 2), cell(&f, 4));
                    b.mark("main", &table, &cell(&f, 3), false, Some(refs));
                }
            }
            (version, Some("main".to_string()))
        }
    };
    Ok(Schema { engine, version, current, namespaces: b.namespaces })
}

fn schema_for(key: &str, session: &Session, engine: Engine, refresh: bool) -> Result<Arc<Schema>, DbError> {
    if !refresh {
        if let Some((at, s)) = schemas().lock().unwrap().get(key) {
            if at.elapsed() < SCHEMA_TTL {
                return Ok(s.clone());
            }
        }
    }
    let s = Arc::new(introspect(session, engine)?);
    schemas().lock().unwrap().insert(key.to_string(), (Instant::now(), s.clone()));
    Ok(s)
}

// ---------------------------------------------------------------------------
// SQL building (browse, value search)
// ---------------------------------------------------------------------------

fn quote_ident(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Mysql => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn qualified(engine: Engine, ns: &str, table: &str) -> String {
    if engine == Engine::Sqlite && ns == "main" {
        quote_ident(engine, table)
    } else {
        format!("{}.{}", quote_ident(engine, ns), quote_ident(engine, table))
    }
}

/// `col LIKE '%text%'` across every column, case-insensitively, with the
/// text taken literally.
fn search_predicate(engine: Engine, columns: &[ColumnInfo], text: &str) -> String {
    let like = text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let parts: Vec<String> = columns
        .iter()
        .map(|c| {
            let col = quote_ident(engine, &c.name);
            match engine {
                Engine::Postgres => format!("{}::text ILIKE '%{}%'", col, like.replace('\'', "''")),
                Engine::Mysql => format!(
                    "CAST({} AS CHAR) LIKE '%{}%'",
                    col,
                    like.replace('\\', "\\\\").replace('\'', "''")
                ),
                Engine::Sqlite => format!("CAST({} AS TEXT) LIKE '%{}%' ESCAPE '\\'", col, like.replace('\'', "''")),
            }
        })
        .collect();
    if parts.is_empty() {
        "FALSE".into()
    } else {
        parts.join(" OR ")
    }
}

#[derive(Deserialize)]
pub struct BrowseRequest {
    pub namespace: String,
    pub table: String,
    /// Text to find in any column.
    #[serde(default)]
    pub search: Option<String>,
    /// A raw WHERE clause, as typed.
    #[serde(default, rename = "where")]
    pub where_clause: Option<String>,
    #[serde(default, rename = "orderBy")]
    pub order_by: Option<String>,
    #[serde(default)]
    pub descending: bool,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "default_page")]
    pub limit: u64,
}

fn default_page() -> u64 {
    200
}

#[derive(Serialize)]
pub struct BrowseOutput {
    pub set: ResultSet,
    /// Rows matching the filter, counted separately.
    pub total: Option<i64>,
    /// The SELECT that produced the page, for "open in console".
    pub sql: String,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

fn browse_sql(engine: Engine, table: &TableInfo, req: &BrowseRequest) -> (String, String) {
    let from = qualified(engine, &req.namespace, &req.table);
    let mut filters = Vec::new();
    if let Some(w) = req.where_clause.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        filters.push(format!("({})", w));
    }
    if let Some(s) = req.search.as_deref().filter(|s| !s.trim().is_empty()) {
        filters.push(format!("({})", search_predicate(engine, &table.columns, s.trim())));
    }
    let where_sql = if filters.is_empty() { String::new() } else { format!(" WHERE {}", filters.join(" AND ")) };
    let order = match req.order_by.as_deref().filter(|c| table.columns.iter().any(|col| col.name == *c)) {
        Some(c) => format!(" ORDER BY {}{}", quote_ident(engine, c), if req.descending { " DESC" } else { "" }),
        None => String::new(),
    };
    let page = format!(
        "SELECT * FROM {}{}{} LIMIT {}{}",
        from,
        where_sql,
        order,
        req.limit.clamp(1, 5000),
        if req.offset > 0 { format!(" OFFSET {}", req.offset) } else { String::new() }
    );
    let count = format!("SELECT COUNT(*) FROM {}{}", from, where_sql);
    (page, count)
}

// ---------------------------------------------------------------------------
// Editing rows
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone)]
pub struct CellValue {
    pub column: String,
    /// None is NULL.
    pub value: Option<String>,
}

/// One edit from the grid. Rows are found by their primary key, as it was
/// when the page loaded.
#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RowChange {
    Update { key: Vec<CellValue>, set: Vec<CellValue> },
    Insert { values: Vec<CellValue> },
    Delete { key: Vec<CellValue> },
}

#[derive(Serialize)]
pub struct ApplyOutput {
    pub statements: Vec<String>,
    /// Rows written; zero for a preview.
    pub applied: usize,
}

/// A value as SQL text. Untyped literals let the server coerce to the
/// column's type — integers, timestamps, JSON, enums — the same as a typed
/// statement would.
fn literal(engine: Engine, v: &Option<String>) -> String {
    let Some(s) = v else { return "NULL".into() };
    match engine {
        // E'' reads backslashes the same whatever standard_conforming_strings is.
        Engine::Postgres if s.contains('\\') => format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        // MySQL treats backslash as an escape unless a mode says otherwise; a
        // hex literal means exactly these bytes either way.
        Engine::Mysql if s.contains('\\') => {
            let mut hex = String::with_capacity(s.len() * 2);
            for b in s.bytes() {
                let _ = write!(hex, "{:02x}", b);
            }
            format!("_utf8mb4 X'{}'", hex)
        }
        _ => format!("'{}'", s.replace('\'', "''")),
    }
}

fn change_sql(engine: Engine, ns: &str, table: &TableInfo, change: &RowChange) -> Result<String, String> {
    let known = |c: &str| -> Result<String, String> {
        table
            .columns
            .iter()
            .find(|col| col.name == c)
            .map(|col| quote_ident(engine, &col.name))
            .ok_or_else(|| format!("{} has no column {}", table.name, c))
    };
    let where_key = |key: &[CellValue]| -> Result<String, String> {
        let pk: Vec<&str> = table.columns.iter().filter(|c| c.pk).map(|c| c.name.as_str()).collect();
        if pk.is_empty() {
            return Err(format!("{} has no primary key, so a row can't be picked out safely", table.name));
        }
        if key.len() != pk.len() || !key.iter().all(|k| pk.contains(&k.column.as_str())) {
            return Err(format!("A row of {} is identified by {}", table.name, pk.join(", ")));
        }
        key.iter()
            .map(|k| Ok(match &k.value {
                None => format!("{} IS NULL", known(&k.column)?),
                v => format!("{} = {}", known(&k.column)?, literal(engine, v)),
            }))
            .collect::<Result<Vec<_>, String>>()
            .map(|parts| parts.join(" AND "))
    };
    let target = qualified(engine, ns, &table.name);
    Ok(match change {
        RowChange::Update { key, set } => {
            if set.is_empty() {
                return Err("An update with nothing to set".into());
            }
            let sets = set
                .iter()
                .map(|c| Ok(format!("{} = {}", known(&c.column)?, literal(engine, &c.value))))
                .collect::<Result<Vec<_>, String>>()?;
            format!("UPDATE {} SET {} WHERE {}", target, sets.join(", "), where_key(key)?)
        }
        RowChange::Delete { key } => format!("DELETE FROM {} WHERE {}", target, where_key(key)?),
        RowChange::Insert { values } if values.is_empty() => match engine {
            Engine::Mysql => format!("INSERT INTO {} () VALUES ()", target),
            _ => format!("INSERT INTO {} DEFAULT VALUES", target),
        },
        RowChange::Insert { values } => {
            let cols = values.iter().map(|c| known(&c.column)).collect::<Result<Vec<_>, String>>()?;
            let vals: Vec<String> = values.iter().map(|c| literal(engine, &c.value)).collect();
            format!("INSERT INTO {} ({}) VALUES ({})", target, cols.join(", "), vals.join(", "))
        }
    })
}

/// Runs a batch in one transaction: all of it lands, or none. An update or
/// delete that no longer finds exactly its row stops the batch, so an edit
/// made against a stale page never lands on the wrong row.
fn apply_batch(session: &Session, statements: &[(String, bool)]) -> Result<usize, DbError> {
    let fail = |i: usize, mut e: DbError| {
        e.change_index = Some(i);
        e
    };
    let stale = |i: usize, n: u64| DbError {
        message: if n == 0 {
            format!("Change {} found no row — it was changed or deleted since the page loaded. Nothing was saved.", i + 1)
        } else {
            format!("Change {} matched {} rows instead of one. Nothing was saved.", i + 1, n)
        },
        hint: Some("Reload the table and make the change again.".into()),
        change_index: Some(i),
        ..Default::default()
    };
    let mut conn = session.conn.lock().unwrap();
    match &mut *conn {
        Conn::Pg(client) => tauri::async_runtime::block_on(async {
            client.batch_execute("BEGIN").await?;
            for (i, (sql, keyed)) in statements.iter().enumerate() {
                let n = match client.execute(sql.as_str(), &[]).await {
                    Ok(n) => n,
                    Err(e) => {
                        let _ = client.batch_execute("ROLLBACK").await;
                        return Err(fail(i, e.into()));
                    }
                };
                if *keyed && n != 1 {
                    let _ = client.batch_execute("ROLLBACK").await;
                    return Err(stale(i, n));
                }
            }
            client.batch_execute("COMMIT").await?;
            Ok(statements.len())
        }),
        Conn::My(c) => {
            use mysql::prelude::Queryable;
            c.query_drop("START TRANSACTION")?;
            for (i, (sql, keyed)) in statements.iter().enumerate() {
                if let Err(e) = c.query_drop(sql) {
                    let _ = c.query_drop("ROLLBACK");
                    return Err(fail(i, e.into()));
                }
                if *keyed {
                    // MySQL counts changed rows, not matched ones; setting a
                    // value to itself would read as "not found" otherwise.
                    let info = c.info_str().to_string();
                    let matched = info
                        .split("Rows matched:")
                        .nth(1)
                        .and_then(|r| r.split_whitespace().next())
                        .and_then(|n| n.parse::<u64>().ok())
                        .unwrap_or_else(|| c.affected_rows());
                    if matched != 1 {
                        let _ = c.query_drop("ROLLBACK");
                        return Err(stale(i, matched));
                    }
                }
            }
            c.query_drop("COMMIT")?;
            Ok(statements.len())
        }
        Conn::Lite(c) => {
            let tx = c.transaction()?;
            for (i, (sql, keyed)) in statements.iter().enumerate() {
                let n = tx.execute(sql, []).map_err(|e| fail(i, e.into()))?;
                if *keyed && n != 1 {
                    return Err(stale(i, n as u64));
                }
            }
            tx.commit()?;
            Ok(statements.len())
        }
    }
}

// ---------------------------------------------------------------------------
// Looking a connection up
// ---------------------------------------------------------------------------

struct Located {
    def: DbConnectionDef,
    dir: PathBuf,
    worktree_id: Option<String>,
}

fn locate(state: &AppState, project_id: &str, conn_id: &str, worktree_id: Option<&str>) -> Result<Located, DbError> {
    let projects = state.projects.lock().unwrap();
    let ps = projects.get(project_id).ok_or("Project not loaded")?;
    let def = ps
        .config
        .databases
        .iter()
        .find(|d| d.id == conn_id)
        .cloned()
        .ok_or("That connection no longer exists")?;
    let dir = match worktree_id {
        Some(id) => ps
            .config
            .worktrees
            .iter()
            .find(|w| w.id == id)
            .map(|w| PathBuf::from(&w.path))
            .ok_or("That worktree no longer exists")?,
        None => PathBuf::from(&ps.repo_path),
    };
    Ok(Located { def, dir, worktree_id: worktree_id.map(str::to_string) })
}

fn window_mode(def: &DbConnectionDef) -> Mode {
    if def.read_only { Mode::Guarded } else { Mode::Window }
}

fn max_rows(n: Option<u32>) -> usize {
    n.map(|n| n as usize).unwrap_or(DEFAULT_MAX_ROWS).clamp(1, MAX_ROWS_CEILING)
}

/// Runs blocking database work off the async runtime's workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, DbError> + Send + 'static) -> Result<T, DbError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| DbError::new(e.to_string()))?
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_test(
    project_id: String,
    connection: DbConnectionDef,
    password: Option<String>,
    worktree_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, DbError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let dir = {
            let projects = state.projects.lock().unwrap();
            let ps = projects.get(&project_id).ok_or("Project not loaded")?;
            match worktree_id.as_deref().and_then(|id| ps.config.worktrees.iter().find(|w| w.id == id)) {
                Some(w) => PathBuf::from(&w.path),
                None => PathBuf::from(&ps.repo_path),
            }
        };
        let password = password.filter(|p| !p.is_empty()).or_else(|| get_password(&project_id, &connection.id));
        let target = target_for(&connection, &dir, password)?;
        let session = open(&target, Mode::Window)?;
        let sql = match connection.engine {
            Engine::Postgres => "SELECT current_setting('server_version')",
            Engine::Mysql => "SELECT VERSION()",
            Engine::Sqlite => "SELECT sqlite_version()",
        };
        let version = catalog(&session, sql)?.first().map(|r| cell(r, 0)).unwrap_or_default();
        Ok(format!("{} {}", connection.engine.label(), version.split_whitespace().next().unwrap_or("")))
    })
    .await
}

#[tauri::command]
pub fn db_has_password(project_id: String, conn_id: String) -> bool {
    get_password(&project_id, &conn_id).is_some()
}

#[tauri::command]
pub fn db_set_password(project_id: String, conn_id: String, password: Option<String>) -> Result<(), String> {
    set_password(&project_id, &conn_id, password.as_deref())?;
    forget(&project_id, &conn_id);
    Ok(())
}

/// Closes a connection's sessions so the next call reopens them with its
/// current definition; called after it is edited or removed.
#[tauri::command]
pub fn db_disconnect(project_id: String, conn_id: String, remove: Option<bool>) {
    forget(&project_id, &conn_id);
    if remove.unwrap_or(false) {
        let _ = set_password(&project_id, &conn_id, None);
    }
}

#[tauri::command]
pub async fn db_schema(
    project_id: String,
    conn_id: String,
    worktree_id: Option<String>,
    refresh: Option<bool>,
    app: tauri::AppHandle,
) -> Result<Arc<Schema>, DbError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let loc = locate(&state, &project_id, &conn_id, worktree_id.as_deref())?;
        let s = session(&project_id, &loc.def, loc.worktree_id.as_deref(), &loc.dir, window_mode(&loc.def))?;
        let key = db_key(&project_id, &conn_id, loc.worktree_id.as_deref());
        schema_for(&key, &s, loc.def.engine, refresh.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn db_query(
    project_id: String,
    conn_id: String,
    worktree_id: Option<String>,
    sql: String,
    max_rows: Option<u32>,
    app: tauri::AppHandle,
) -> Result<QueryOutput, DbError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let loc = locate(&state, &project_id, &conn_id, worktree_id.as_deref())?;
        let s = session(&project_id, &loc.def, loc.worktree_id.as_deref(), &loc.dir, window_mode(&loc.def))?;
        let started = Instant::now();
        let sets = run(&s, &sql, self::max_rows(max_rows))?;
        // A statement that changes no rows may still change the schema.
        if sets.iter().any(|set| set.columns.is_empty()) {
            schemas().lock().unwrap().remove(&db_key(&project_id, &conn_id, loc.worktree_id.as_deref()));
        }
        Ok(QueryOutput { sets, elapsed_ms: started.elapsed().as_millis() as u64 })
    })
    .await
}

#[tauri::command]
pub async fn db_browse(
    project_id: String,
    conn_id: String,
    worktree_id: Option<String>,
    request: BrowseRequest,
    app: tauri::AppHandle,
) -> Result<BrowseOutput, DbError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let loc = locate(&state, &project_id, &conn_id, worktree_id.as_deref())?;
        let s = session(&project_id, &loc.def, loc.worktree_id.as_deref(), &loc.dir, window_mode(&loc.def))?;
        let key = db_key(&project_id, &conn_id, loc.worktree_id.as_deref());
        let schema = schema_for(&key, &s, loc.def.engine, false)?;
        let table = schema
            .namespaces
            .iter()
            .find(|n| n.name == request.namespace)
            .and_then(|n| n.tables.iter().find(|t| t.name == request.table))
            .ok_or_else(|| format!("No table {}.{}", request.namespace, request.table))?;
        let (page, count) = browse_sql(loc.def.engine, table, &request);
        let started = Instant::now();
        let set = run(&s, &page, MAX_ROWS_CEILING)?.into_iter().next().unwrap_or_default();
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let total = catalog(&s, &count).ok().and_then(|r| r.first().map(|r| cell(r, 0))).and_then(|n| n.parse().ok());
        Ok(BrowseOutput { set, total, sql: page, elapsed_ms })
    })
    .await
}

#[tauri::command]
pub async fn db_apply(
    project_id: String,
    conn_id: String,
    worktree_id: Option<String>,
    namespace: String,
    table: String,
    changes: Vec<RowChange>,
    dry_run: Option<bool>,
    app: tauri::AppHandle,
) -> Result<ApplyOutput, DbError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let loc = locate(&state, &project_id, &conn_id, worktree_id.as_deref())?;
        if loc.def.read_only {
            return Err("This connection is read-only".into());
        }
        let s = session(&project_id, &loc.def, loc.worktree_id.as_deref(), &loc.dir, Mode::Window)?;
        let key = db_key(&project_id, &conn_id, loc.worktree_id.as_deref());
        let schema = schema_for(&key, &s, loc.def.engine, false)?;
        let info = schema
            .namespaces
            .iter()
            .find(|n| n.name == namespace)
            .and_then(|n| n.tables.iter().find(|t| t.name == table))
            .ok_or_else(|| format!("No table {}.{}", namespace, table))?;
        if info.kind != "table" {
            return Err(format!("{} is a {}; only tables can be edited here", table, info.kind).into());
        }
        let statements = changes
            .iter()
            .enumerate()
            .map(|(i, c)| {
                change_sql(loc.def.engine, &namespace, info, c)
                    .map(|sql| (sql, !matches!(c, RowChange::Insert { .. })))
                    .map_err(|m| DbError { message: m, change_index: Some(i), ..Default::default() })
            })
            .collect::<Result<Vec<_>, DbError>>()?;
        let applied = if dry_run.unwrap_or(false) || statements.is_empty() { 0 } else { apply_batch(&s, &statements)? };
        Ok(ApplyOutput { statements: statements.into_iter().map(|(sql, _)| sql).collect(), applied })
    })
    .await
}

#[tauri::command]
pub fn db_cancel(project_id: String, conn_id: String, worktree_id: Option<String>) {
    let prefix = db_key(&project_id, &conn_id, worktree_id.as_deref());
    let found: Vec<Arc<Session>> = sessions()
        .lock()
        .unwrap()
        .iter()
        .filter(|(k, s)| k.starts_with(&prefix) && s.mode != Mode::Agent)
        .map(|(_, s)| s.clone())
        .collect();
    std::thread::spawn(move || {
        for s in found {
            s.canceller.cancel();
        }
    });
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

/// Rows an agent gets back by default, and at most.
const AGENT_ROWS: usize = 100;
const AGENT_ROWS_MAX: usize = 1000;
/// Same ceiling as get_logs: past this an answer costs more than it helps.
const AGENT_MAX_CHARS: usize = 40_000;
const AGENT_CELL_CHARS: usize = 300;

pub fn tool_definitions(project: &Value, checkout: &Value) -> Vec<Value> {
    let connection = json!({
        "type": "string",
        "description": "Connection name or id from db_connections. Optional when the project has only one."
    });
    vec![
        json!({
            "name": "db_connections",
            "description": "Databases defined in Lever for this project: name, engine, and where each points in your checkout (password hidden). Lever resolves ${VAR}s from your worktree's .env, so a worktree gets its own database.",
            "inputSchema": { "type": "object", "properties": { "project": project, "checkout": checkout } },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "db_schema",
            "description": "Tables and views in a database, with columns, types, primary keys (PK) and foreign keys (→). Pass `table` for one table in detail, or `schema` to list one namespace.",
            "inputSchema": { "type": "object", "properties": {
                "project": project, "checkout": checkout, "connection": connection,
                "schema": { "type": "string", "description": "Only this namespace (e.g. public)." },
                "table": { "type": "string", "description": "One table, as name or schema.name." }
            } },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "db_search",
            "description": "Find things in a database. Without `table`: tables and columns whose names contain `query`. With `table`: rows of that table where any column contains `query` (case-insensitive).",
            "inputSchema": { "type": "object", "properties": {
                "project": project, "checkout": checkout, "connection": connection,
                "query": { "type": "string", "description": "Text to look for." },
                "table": { "type": "string", "description": "Search this table's rows (name or schema.name) instead of names." },
                "limit": { "type": "integer", "description": "Rows to return when searching a table (default 50)." }
            }, "required": ["query"] },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "db_query",
            "description": "Run one read-only SQL statement (SELECT, WITH, EXPLAIN, SHOW…) and get the rows back as tab-separated text. Runs in a read-only transaction with a 30 s timeout; writes are refused by the database. Results are capped, so filter and LIMIT in SQL.",
            "inputSchema": { "type": "object", "properties": {
                "project": project, "checkout": checkout, "connection": connection,
                "sql": { "type": "string", "description": "A single statement." },
                "limit": { "type": "integer", "description": "Rows to return (default 100, at most 1000)." }
            }, "required": ["sql"] },
            "annotations": { "readOnlyHint": true },
        }),
    ]
}

/// The project, checkout directory and agent-visible connections a call is
/// scoped to.
struct AgentScope {
    project_id: String,
    worktree_id: Option<String>,
    dir: PathBuf,
    checkout_name: String,
    connections: Vec<DbConnectionDef>,
}

fn agent_scope(state: &AppState, args: &Value, cwd: Option<&Path>) -> Result<AgentScope, String> {
    let scope = mcp::resolve_scope(state, args, cwd)?;
    let projects = state.projects.lock().unwrap();
    let ps = projects.get(&scope.project_id).ok_or("Project not loaded")?;
    let (worktree_id, dir, checkout_name) = match &scope.checkout {
        Checkout::Worktree(id) => {
            let w = ps.config.worktrees.iter().find(|w| &w.id == id).ok_or("Worktree not found")?;
            (Some(id.clone()), PathBuf::from(&w.path), format!("worktree {}", w.branch))
        }
        // "all" has no single .env to read; the main checkout's is the
        // sensible default.
        _ => (None, PathBuf::from(&ps.repo_path), "the main checkout".to_string()),
    };
    let connections = ps.config.databases.iter().filter(|d| d.agent_access).cloned().collect();
    Ok(AgentScope { project_id: scope.project_id, worktree_id, dir, checkout_name, connections })
}

fn pick_connection<'a>(scope: &'a AgentScope, args: &Value) -> Result<&'a DbConnectionDef, String> {
    let names = || scope.connections.iter().map(|d| d.name.as_str()).collect::<Vec<_>>().join(", ");
    match mcp::arg_str(args, "connection") {
        Some(want) => scope
            .connections
            .iter()
            .find(|d| d.id == want)
            .or_else(|| scope.connections.iter().find(|d| d.name.eq_ignore_ascii_case(want)))
            .ok_or_else(|| {
                if scope.connections.is_empty() {
                    "This project has no databases agents can use. The user can add one in Lever's sidebar.".to_string()
                } else {
                    format!("No connection '{}'. Available: {}", want, names())
                }
            }),
        None => match scope.connections.as_slice() {
            [only] => Ok(only),
            [] => Err("This project has no databases agents can use. The user can add one in Lever's sidebar.".into()),
            _ => Err(format!("Several databases are defined; pass `connection`: {}", names())),
        },
    }
}

fn agent_session(scope: &AgentScope, def: &DbConnectionDef) -> Result<Arc<Session>, String> {
    session(&scope.project_id, def, scope.worktree_id.as_deref(), &scope.dir, Mode::Agent).map_err(|e| e.to_string())
}

fn agent_schema(scope: &AgentScope, def: &DbConnectionDef) -> Result<Arc<Schema>, String> {
    let s = agent_session(scope, def)?;
    let key = db_key(&scope.project_id, &def.id, scope.worktree_id.as_deref());
    schema_for(&key, &s, def.engine, false).map_err(|e| e.to_string())
}

/// A URL with any password masked, for telling an agent where a connection
/// points.
fn redact(url: &str) -> String {
    if let Some(scheme_end) = url.find("://") {
        let rest = &url[scheme_end + 3..];
        let auth_end = rest.find('/').unwrap_or(rest.len());
        if let Some(at) = rest[..auth_end].rfind('@') {
            let userinfo = &rest[..at];
            if let Some(colon) = userinfo.find(':') {
                return format!("{}://{}:•••@{}", &url[..scheme_end], &userinfo[..colon], &rest[at + 1..]);
            }
        }
    }
    url.to_string()
}

fn find_table<'a>(schema: &'a Schema, want: &str) -> Result<(&'a str, &'a TableInfo), String> {
    let (ns, name) = match want.rsplit_once('.') {
        Some((ns, name)) => (Some(ns), name),
        None => (None, want),
    };
    let unquote = |s: &str| s.trim_matches(|c| c == '"' || c == '`').to_string();
    let name = unquote(name);
    let ns = ns.map(unquote);
    let mut found: Vec<(&str, &TableInfo)> = schema
        .namespaces
        .iter()
        .filter(|n| ns.as_deref().map_or(true, |want| n.name.eq_ignore_ascii_case(want)))
        .flat_map(|n| n.tables.iter().map(move |t| (n.name.as_str(), t)))
        .filter(|(_, t)| t.name.eq_ignore_ascii_case(&name))
        .collect();
    if found.len() > 1 {
        // Prefer the namespace unqualified names resolve in.
        if let Some(cur) = &schema.current {
            if let Some(i) = found.iter().position(|(n, _)| n == cur) {
                return Ok(found.swap_remove(i));
            }
        }
    }
    found.into_iter().next().ok_or_else(|| format!("No table '{}'. Use db_search to find it.", want))
}

fn describe_column(c: &ColumnInfo) -> String {
    let mut s = format!("{} {}", c.name, c.data_type);
    if c.pk {
        s.push_str(" PK");
    }
    if !c.nullable && !c.pk {
        s.push_str(" NOT NULL");
    }
    if let Some(r) = &c.references {
        let _ = write!(s, " → {}", r);
    }
    s
}

fn table_heading(ns: &str, t: &TableInfo) -> String {
    let mut s = format!("{}.{} ({}", ns, t.name, t.kind);
    if let Some(n) = t.rows {
        let _ = write!(s, ", ~{} rows", n);
    }
    s.push(')');
    s
}

fn emit_activity(app: &tauri::AppHandle, scope: &AgentScope, def: &DbConnectionDef, tool: &str, sql: Option<&str>, outcome: &Result<String, String>) {
    let _ = app.emit_to(
        mcp::window_label(&scope.project_id).as_str(),
        "db-agent-activity",
        json!({
            "connId": def.id,
            "worktreeId": scope.worktree_id,
            "tool": tool,
            "sql": sql,
            "error": outcome.as_ref().err(),
            "at": super::now_millis(),
        }),
    );
}

pub fn call_tool(app: &tauri::AppHandle, state: &AppState, name: &str, args: &Value, cwd: Option<&Path>) -> Result<String, String> {
    let scope = agent_scope(state, args, cwd)?;
    if name == "db_connections" {
        return db_connections_tool(&scope);
    }
    let def = pick_connection(&scope, args)?.clone();
    let (outcome, sql) = match name {
        "db_schema" => (db_schema_tool(&scope, &def, args), None),
        "db_search" => db_search_tool(&scope, &def, args),
        "db_query" => {
            let sql = mcp::arg_str(args, "sql").map(str::to_string);
            (db_query_tool(&scope, &def, args), sql)
        }
        _ => return Err(format!("unknown tool: {}", name)),
    };
    emit_activity(app, &scope, &def, name, sql.as_deref(), &outcome);
    outcome
}

fn db_connections_tool(scope: &AgentScope) -> Result<String, String> {
    if scope.connections.is_empty() {
        return Ok("This project has no databases agents can use. The user can add one in Lever's sidebar.".into());
    }
    let list: Vec<Value> = scope
        .connections
        .iter()
        .map(|d| {
            let points_to = match expand_vars(&d.url, &scope.dir) {
                Ok(u) => redact(&u),
                Err(e) => format!("(unresolved: {})", e),
            };
            json!({
                "id": d.id,
                "name": d.name,
                "engine": d.engine.label(),
                "pointsTo": points_to,
            })
        })
        .collect();
    serde_json::to_string(&json!({ "checkout": scope.checkout_name, "connections": list })).map_err(|e| e.to_string())
}

fn db_schema_tool(scope: &AgentScope, def: &DbConnectionDef, args: &Value) -> Result<String, String> {
    let schema = agent_schema(scope, def)?;
    if let Some(want) = mcp::arg_str(args, "table") {
        let (ns, t) = find_table(&schema, want)?;
        let mut out = table_heading(ns, t);
        for c in &t.columns {
            let _ = write!(out, "\n  {}", describe_column(c));
            if let Some(d) = &c.default {
                let _ = write!(out, " DEFAULT {}", d);
            }
        }
        // Who points here, which is half of knowing how to join it.
        let target = format!("{}.{}.", ns, t.name);
        let incoming: Vec<String> = schema
            .namespaces
            .iter()
            .flat_map(|n| n.tables.iter().map(move |t| (n, t)))
            .flat_map(|(n, other)| {
                let target = target.clone();
                other.columns.iter().filter_map(move |c| {
                    c.references.as_ref().filter(|r| r.starts_with(&target)).map(|r| {
                        format!("{}.{}.{} → {}", n.name, other.name, c.name, r)
                    })
                })
            })
            .collect();
        if !incoming.is_empty() {
            out.push_str("\nReferenced by:");
            for r in incoming {
                let _ = write!(out, "\n  {}", r);
            }
        }
        return Ok(out);
    }
    let only = mcp::arg_str(args, "schema");
    let mut out = format!("{} {} · {}", def.engine.label(), schema.version, scope.checkout_name);
    if let Some(cur) = &schema.current {
        let _ = write!(out, " · default schema {}", cur);
    }
    let mut tables = 0;
    let mut compact = String::new();
    for n in schema.namespaces.iter().filter(|n| only.map_or(true, |o| n.name.eq_ignore_ascii_case(o))) {
        for t in &n.tables {
            tables += 1;
            let _ = write!(out, "\n{}: {}", table_heading(&n.name, t), t.columns.iter().map(describe_column).collect::<Vec<_>>().join(", "));
            let _ = write!(compact, "\n{}", table_heading(&n.name, t));
        }
    }
    if tables == 0 {
        return Ok(match only {
            Some(o) => format!("No tables in schema '{}'.", o),
            None => "The database has no tables.".into(),
        });
    }
    if out.len() > AGENT_MAX_CHARS {
        // Too big to list with columns: names only, and how to drill in.
        let mut short = format!("{} tables; too many to list with columns. Pass `table` for one, or `schema` to narrow.{}", tables, compact);
        if short.len() > AGENT_MAX_CHARS {
            let mut end = AGENT_MAX_CHARS;
            while !short.is_char_boundary(end) {
                end -= 1;
            }
            short.truncate(end);
            short.push_str("\n… (cut; use db_search to find a table by name)");
        }
        return Ok(short);
    }
    Ok(out)
}

fn db_search_tool(scope: &AgentScope, def: &DbConnectionDef, args: &Value) -> (Result<String, String>, Option<String>) {
    let query = match mcp::arg_str(args, "query") {
        Some(q) => q.to_string(),
        None => return (Err("`query` is required".into()), None),
    };
    let schema = match agent_schema(scope, def) {
        Ok(s) => s,
        Err(e) => return (Err(e), None),
    };
    if let Some(want) = mcp::arg_str(args, "table") {
        let (ns, t) = match find_table(&schema, want) {
            Ok(t) => t,
            Err(e) => return (Err(e), None),
        };
        let limit = mcp::arg_u64(args, "limit").map(|n| n as usize).unwrap_or(50).clamp(1, AGENT_ROWS_MAX);
        let sql = format!(
            "SELECT * FROM {} WHERE {} LIMIT {}",
            qualified(def.engine, ns, &t.name),
            search_predicate(def.engine, &t.columns, &query),
            limit
        );
        let out = agent_session(scope, def)
            .and_then(|s| run(&s, &sql, limit).map_err(|e| e.to_string()))
            .map(|sets| format_sets(&sets, None));
        return (out, Some(sql));
    }
    let needle = query.to_lowercase();
    let mut tables = Vec::new();
    let mut columns = Vec::new();
    for n in &schema.namespaces {
        for t in &n.tables {
            if t.name.to_lowercase().contains(&needle) {
                tables.push(table_heading(&n.name, t));
            }
            for c in &t.columns {
                if c.name.to_lowercase().contains(&needle) {
                    columns.push(format!("{}.{}.{}", n.name, t.name, describe_column(c)));
                }
            }
        }
    }
    if tables.is_empty() && columns.is_empty() {
        return (Ok(format!("No table or column name contains '{}'. To search inside rows, pass `table`.", query)), None);
    }
    let mut out = String::new();
    if !tables.is_empty() {
        let _ = write!(out, "Tables ({}):", tables.len());
        for t in tables.iter().take(200) {
            let _ = write!(out, "\n  {}", t);
        }
    }
    if !columns.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        let _ = write!(out, "Columns ({}):", columns.len());
        for c in columns.iter().take(400) {
            let _ = write!(out, "\n  {}", c);
        }
    }
    (Ok(out), None)
}

fn db_query_tool(scope: &AgentScope, def: &DbConnectionDef, args: &Value) -> Result<String, String> {
    let sql = mcp::arg_str(args, "sql").ok_or("`sql` is required")?;
    let limit = mcp::arg_u64(args, "limit").map(|n| n as usize).unwrap_or(AGENT_ROWS).clamp(1, AGENT_ROWS_MAX);
    let s = agent_session(scope, def)?;
    let started = Instant::now();
    let sets = run(&s, sql, limit).map_err(|e| e.to_string())?;
    Ok(format_sets(&sets, Some(started.elapsed())))
}

fn agent_cell(v: &Option<String>) -> String {
    match v {
        None => "NULL".into(),
        Some(s) => {
            let mut s = s.replace('\\', "\\\\").replace('\t', "\\t").replace('\n', "\\n").replace('\r', "\\r");
            if s.chars().count() > AGENT_CELL_CHARS {
                s = s.chars().take(AGENT_CELL_CHARS).collect::<String>() + "…";
            }
            s
        }
    }
}

/// Rows as tab-separated text with a header: compact, and every model reads
/// it.
fn format_sets(sets: &[ResultSet], elapsed: Option<Duration>) -> String {
    let mut out = String::new();
    for set in sets {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        if set.columns.is_empty() {
            let _ = write!(out, "OK, {} row{} affected", set.affected.unwrap_or(0), if set.affected == Some(1) { "" } else { "s" });
            continue;
        }
        let mut head = format!("{} row{}", set.rows.len(), if set.rows.len() == 1 { "" } else { "s" });
        if set.truncated {
            head.push_str(" (more exist; raise `limit` or narrow the query)");
        }
        if let Some(e) = elapsed {
            let _ = write!(head, " · {} ms", e.as_millis());
        }
        out.push_str(&head);
        out.push('\n');
        out.push_str(&set.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join("\t"));
        let mut shown = 0;
        for row in &set.rows {
            let line = row.iter().map(agent_cell).collect::<Vec<_>>().join("\t");
            if out.len() + line.len() + 1 > AGENT_MAX_CHARS {
                let _ = write!(out, "\n… {} more rows cut to fit; select fewer columns or rows", set.rows.len() - shown);
                break;
            }
            out.push('\n');
            out.push_str(&line);
            shown += 1;
        }
    }
    if out.is_empty() {
        out.push_str("OK");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotenv_reads_quotes_comments_and_export() {
        let mut v = HashMap::new();
        parse_dotenv("# c\nexport A=1\nB=\"x y\" \nC='lit $X'\nD=plain # note\n bad line\n", &mut v);
        assert_eq!(v["A"], "1");
        assert_eq!(v["B"], "x y");
        assert_eq!(v["C"], "lit $X");
        assert_eq!(v["D"], "plain");
        assert!(!v.contains_key("bad line"));
    }

    #[test]
    fn expands_from_dotenv_and_reports_missing() {
        let dir = std::env::temp_dir().join(format!("lever-db-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), "DATABASE_URL=postgres://a@h/db\n").unwrap();
        std::fs::write(dir.join(".env.local"), "DATABASE_URL=postgres://b@h/db\n").unwrap();
        assert_eq!(expand_vars("${DATABASE_URL}", &dir).unwrap(), "postgres://b@h/db");
        assert!(expand_vars("${LEVER_SURELY_UNSET_VAR}", &dir).unwrap_err().contains("LEVER_SURELY_UNSET_VAR"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_check_allows_reads_and_refuses_writes() {
        assert!(check_read(Engine::Postgres, "  -- hi\n/* x */ (SELECT 1)").is_ok());
        assert!(check_read(Engine::Postgres, "with x as (select 1) select * from x").is_ok());
        assert!(check_read(Engine::Postgres, "DELETE FROM users").is_err());
        assert!(check_read(Engine::Postgres, "commit").is_err());
        assert!(check_read(Engine::Mysql, "SELECT * FROM t INTO OUTFILE '/tmp/x'").is_err());
        assert!(check_read(Engine::Sqlite, "PRAGMA table_info(t)").is_ok());
        assert!(check_read(Engine::Sqlite, "PRAGMA query_only = OFF").is_err());
        assert!(check_read(Engine::Sqlite, "").is_err());
    }

    #[test]
    fn search_escapes_like_and_quotes() {
        let cols = vec![ColumnInfo { name: "na\"me".into(), data_type: "text".into(), nullable: true, pk: false, default: None, references: None }];
        assert_eq!(search_predicate(Engine::Postgres, &cols, "50%_o'k"), "\"na\"\"me\"::text ILIKE '%50\\%\\_o''k%'");
        assert_eq!(search_predicate(Engine::Sqlite, &[], "x"), "FALSE");
    }

    #[test]
    fn refused_connections_say_what_to_check() {
        let e = with_network_hint(DbError::new("error connecting to server: Connection refused (os error 61)"));
        assert!(e.hint.unwrap().contains("Is the database running"));
    }

    #[test]
    fn literals_survive_quotes_and_backslashes() {
        assert_eq!(literal(Engine::Postgres, &Some("it's".into())), "'it''s'");
        assert_eq!(literal(Engine::Postgres, &Some("a\\b'".into())), "E'a\\\\b'''");
        assert_eq!(literal(Engine::Mysql, &Some("a\\b".into())), "_utf8mb4 X'615c62'");
        assert_eq!(literal(Engine::Sqlite, &None), "NULL");
    }

    #[test]
    fn redacts_passwords_only() {
        assert_eq!(redact("postgres://u:secret@h:5432/db"), "postgres://u:•••@h:5432/db");
        assert_eq!(redact("postgres://u@h/db"), "postgres://u@h/db");
        assert_eq!(redact("./dev.sqlite"), "./dev.sqlite");
    }

    fn sqlite_fixture() -> (PathBuf, Target) {
        let dir = std::env::temp_dir().join(format!("lever-db-lite-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.sqlite");
        let _ = std::fs::remove_file(&path);
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, org_id INTEGER REFERENCES orgs(id), avatar BLOB);
             INSERT INTO orgs VALUES (1, 'Acme');
             INSERT INTO users VALUES (1, 'a@acme.dev', 1, x'00ff'), (2, NULL, 1, NULL), (3, 'c@b.dev', NULL, NULL);",
        )
        .unwrap();
        (dir.clone(), Target { engine: Engine::Sqlite, url: "t.sqlite".into(), password: None, dir })
    }

    #[test]
    fn sqlite_runs_introspects_and_caps() {
        let (dir, target) = sqlite_fixture();
        let s = open(&target, Mode::Window).unwrap();
        let sets = run(&s, "SELECT * FROM users ORDER BY id; UPDATE users SET email = email", 2).unwrap();
        assert_eq!(sets.len(), 2);
        assert_eq!(sets[0].rows.len(), 2);
        assert!(sets[0].truncated);
        assert_eq!(sets[0].rows[0][3].as_deref(), Some("\\x00ff"));
        assert_eq!(sets[0].rows[1][1], None);
        assert_eq!(sets[1].affected, Some(3));

        let schema = introspect(&s, Engine::Sqlite).unwrap();
        let users = &schema.namespaces[0].tables.iter().find(|t| t.name == "users").unwrap();
        assert!(users.columns[0].pk);
        assert_eq!(users.columns[2].references.as_deref(), Some("main.orgs.id"));

        let (page, count) = browse_sql(Engine::Sqlite, users, &BrowseRequest {
            namespace: "main".into(), table: "users".into(), search: Some("acme".into()),
            where_clause: None, order_by: Some("id".into()), descending: true, offset: 0, limit: 10,
        });
        let found = run(&s, &page, 100).unwrap();
        assert_eq!(found[0].rows.len(), 1);
        assert_eq!(catalog(&s, &count).unwrap()[0][0].as_deref(), Some("1"));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn cv(c: &str, v: Option<&str>) -> CellValue {
        CellValue { column: c.into(), value: v.map(str::to_string) }
    }

    fn exercise_edits(s: &Session, engine: Engine, ns: &str, table: &TableInfo) {
        let count = |sql: &str| catalog(s, sql).unwrap()[0][0].clone();
        let batch = |changes: Vec<RowChange>| {
            let stmts: Vec<(String, bool)> = changes
                .iter()
                .map(|c| (change_sql(engine, ns, table, c).unwrap(), !matches!(c, RowChange::Insert { .. })))
                .collect();
            apply_batch(s, &stmts)
        };
        assert_eq!(batch(vec![
            RowChange::Update { key: vec![cv("id", Some("2"))], set: vec![cv("label", Some("it's \\ fine")), cv("price", None)] },
            RowChange::Insert { values: vec![cv("id", Some("9")), cv("label", Some("new"))] },
            RowChange::Delete { key: vec![cv("id", Some("3"))] },
        ]).unwrap(), 3);
        assert_eq!(count("SELECT label FROM lever_items WHERE id = 2").as_deref(), Some("it's \\ fine"));
        assert_eq!(count("SELECT COUNT(*) FROM lever_items WHERE id = 2 AND price IS NULL").as_deref(), Some("1"));
        assert_eq!(count("SELECT COUNT(*) FROM lever_items").as_deref(), Some("5"));
        // Setting a value to itself still finds its row (MySQL counts it as unchanged).
        assert!(batch(vec![RowChange::Update { key: vec![cv("id", Some("2"))], set: vec![cv("label", Some("it's \\ fine"))] }]).is_ok());
        // A stale row stops the batch, and the earlier change in it is rolled back.
        let err = batch(vec![
            RowChange::Update { key: vec![cv("id", Some("1"))], set: vec![cv("label", Some("changed"))] },
            RowChange::Delete { key: vec![cv("id", Some("3"))] },
        ]).unwrap_err();
        assert_eq!(err.change_index, Some(1));
        assert_ne!(count("SELECT label FROM lever_items WHERE id = 1").as_deref(), Some("changed"));
        assert!(change_sql(engine, ns, table, &RowChange::Delete { key: vec![cv("label", Some("x"))] }).is_err());
    }

    #[test]
    fn sqlite_edits_apply_atomically() {
        let (dir, target) = sqlite_fixture();
        let s = open(&target, Mode::Window).unwrap();
        run(&s, "CREATE TABLE lever_items (id INTEGER PRIMARY KEY, label TEXT, price REAL)", 10).unwrap();
        run(&s, "INSERT INTO lever_items VALUES (1, 'a', 1.5), (2, 'b', 2.5), (3, 'c', 3.5), (4, 'd', 4.5), (5, 'e', 5.5)", 10).unwrap();
        let schema = introspect(&s, Engine::Sqlite).unwrap();
        let table = schema.namespaces[0].tables.iter().find(|t| t.name == "lever_items").unwrap().clone();
        exercise_edits(&s, Engine::Sqlite, "main", &table);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sqlite_agent_mode_refuses_writes() {
        let (dir, target) = sqlite_fixture();
        let s = open(&target, Mode::Agent).unwrap();
        assert!(run(&s, "SELECT count(*) FROM users", 10).is_ok());
        assert!(run(&s, "DELETE FROM users", 10).is_err());
        // Two statements can't sneak a write in behind a read.
        assert!(run(&s, "SELECT 1; DELETE FROM users", 10).is_err());
        // And even a statement past the keyword check can't write.
        assert!(run(&s, "WITH x AS (SELECT 1) DELETE FROM users", 10).is_err());
        let w = open(&target, Mode::Window).unwrap();
        assert_eq!(catalog(&w, "SELECT count(*) FROM users").unwrap()[0][0].as_deref(), Some("3"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Exercises a live server end to end. Run with, e.g.:
    /// LEVER_TEST_PG=postgres://postgres:pw@localhost:5432/postgres cargo test db::tests::live -- --ignored
    fn live(engine: Engine, var: &str) -> Option<Target> {
        let url = std::env::var(var).ok()?;
        Some(Target { engine, url, password: None, dir: std::env::temp_dir() })
    }

    fn exercise_live(target: Target) {
        let engine = target.engine;
        let w = open(&target, Mode::Window).unwrap();
        run(&w, "DROP TABLE IF EXISTS lever_items", 10).unwrap();
        run(&w, "DROP TABLE IF EXISTS lever_orgs", 10).unwrap();
        run(&w, "CREATE TABLE lever_orgs (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL)", 10).unwrap();
        run(&w, "CREATE TABLE lever_items (id INT PRIMARY KEY, org_id INT, label TEXT, price DECIMAL(10,2), made DATE, FOREIGN KEY (org_id) REFERENCES lever_orgs(id))", 10).unwrap();
        run(&w, "INSERT INTO lever_orgs VALUES (1, 'Acme')", 10).unwrap();
        let ins = run(&w, "INSERT INTO lever_items SELECT n, 1, CONCAT('item ', n), n * 1.5, DATE '2024-01-02' FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) t", 10).unwrap();
        assert_eq!(ins[0].affected, Some(5));

        let sets = run(&w, "SELECT id, label, price, made FROM lever_items ORDER BY id", 3).unwrap();
        assert_eq!(sets[0].rows.len(), 3);
        assert!(sets[0].truncated);
        assert_eq!(sets[0].rows[0][1].as_deref(), Some("item 1"));
        assert_eq!(sets[0].rows[0][2].as_deref(), Some("1.50"));
        assert_eq!(sets[0].rows[0][3].as_deref(), Some("2024-01-02"));
        // The session survives a truncated read.
        assert_eq!(catalog(&w, "SELECT COUNT(*) FROM lever_items").unwrap()[0][0].as_deref(), Some("5"));

        let schema = introspect(&w, engine).unwrap();
        let ns = schema.current.clone().unwrap();
        let items = schema.namespaces.iter().find(|n| n.name == ns).unwrap().tables.iter().find(|t| t.name == "lever_items").unwrap();
        assert!(items.columns[0].pk);
        assert_eq!(items.columns[1].references.as_deref(), Some(format!("{}.lever_orgs.id", ns).as_str()));

        let (page, _) = browse_sql(engine, items, &BrowseRequest {
            namespace: ns.clone(), table: "lever_items".into(), search: Some("ITEM 4".into()),
            where_clause: None, order_by: None, descending: false, offset: 0, limit: 10,
        });
        assert_eq!(run(&w, &page, 10).unwrap()[0].rows.len(), 1);

        exercise_edits(&w, engine, &ns, items);
        run(&w, "DELETE FROM lever_items", 10).unwrap();
        run(&w, "INSERT INTO lever_items SELECT n, 1, CONCAT('item ', n), n * 1.5, DATE '2024-01-02' FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) t", 10).unwrap();

        let err = run(&w, "SELECT nope FROM lever_items", 10).unwrap_err();
        assert!(!err.message.is_empty());

        let a = open(&target, Mode::Agent).unwrap();
        assert_eq!(run(&a, "SELECT COUNT(*) FROM lever_items", 10).unwrap()[0].rows[0][0].as_deref(), Some("5"));
        assert!(run(&a, "DELETE FROM lever_items", 10).is_err());
        assert!(run(&a, "SELECT 1; DELETE FROM lever_items", 10).is_err());
        assert!(run(&a, "COMMIT", 10).is_err());
        if engine == Engine::Postgres {
            // Past the keyword check, the read-only transaction still refuses.
            assert!(run(&a, "WITH d AS (DELETE FROM lever_items RETURNING 1) SELECT * FROM d", 10).is_err());
        }
        assert_eq!(catalog(&w, "SELECT COUNT(*) FROM lever_items").unwrap()[0][0].as_deref(), Some("5"));

        // Cancelling a long statement from another thread.
        let w = Arc::new(w);
        let w2 = w.clone();
        let sleeper = std::thread::spawn(move || {
            let sql = if engine == Engine::Postgres { "SELECT pg_sleep(10)" } else { "SELECT SLEEP(10)" };
            run(&w2, sql, 10)
        });
        std::thread::sleep(Duration::from_millis(500));
        let started = Instant::now();
        w.canceller.cancel();
        let out = sleeper.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        if engine == Engine::Postgres {
            assert!(out.unwrap_err().cancelled);
        }
        run(&w, "DROP TABLE lever_items", 10).unwrap();
        run(&w, "DROP TABLE lever_orgs", 10).unwrap();
    }

    #[test]
    #[ignore]
    fn live_postgres() {
        if let Some(t) = live(Engine::Postgres, "LEVER_TEST_PG") {
            exercise_live(t);
        }
    }

    #[test]
    #[ignore]
    fn live_mysql() {
        if let Some(t) = live(Engine::Mysql, "LEVER_TEST_MYSQL") {
            exercise_live(t);
        }
    }
}
