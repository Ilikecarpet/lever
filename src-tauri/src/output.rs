//! What a service has printed, kept in the backend.
//!
//! A service's output used to exist only in the terminal of the window that
//! started it, so closing that window lost it and nothing without a window —
//! the CLI, an agent over MCP — could read it. Every service run now keeps its
//! newest output here, whoever is watching, and anyone can subscribe to what
//! comes next.
//!
//! Output is kept as the chunks the pump emitted, which are whole UTF-8, and
//! dropped a whole chunk at a time from the front once over the cap. Each chunk
//! carries its byte offset in the run's output, so a window that fetches the
//! backlog and also listens for live chunks can drop the ones it already has.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Per run. A noisy dev server prints this in minutes; a task's whole run fits.
const CAP_BYTES: usize = 1 << 20;

/// Per subscriber: how far a reader may fall behind (a paused pager) before
/// chunks are skipped rather than queued without end.
const SUBSCRIBER_CAP_BYTES: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Data(String),
    /// The run's terminal closed; nothing more will come.
    Closed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlog {
    pub data: String,
    /// Byte offset just past `data`: a live chunk starting before it is
    /// already in `data`.
    pub end_offset: u64,
    pub closed: bool,
}

#[derive(Default)]
struct Run {
    chunks: VecDeque<(u64, String)>,
    kept: usize,
    end: u64,
    closed: bool,
    subscribers: Vec<Subscriber>,
}

struct Subscriber {
    tx: mpsc::Sender<Event>,
    /// Bytes sent and not yet received.
    queued: Arc<AtomicUsize>,
    /// Bytes skipped since the reader last had room.
    skipped: usize,
}

impl Subscriber {
    /// False once the reader has gone.
    fn send(&mut self, data: &str) -> bool {
        let queued = self.queued.load(Ordering::SeqCst);
        if queued + data.len() > SUBSCRIBER_CAP_BYTES && queued > 0 {
            self.skipped += data.len();
            return true;
        }
        let mut out = String::new();
        if self.skipped > 0 {
            out = format!("\r\n[lever: {} skipped while not reading]\r\n", size(self.skipped));
            self.skipped = 0;
        }
        out.push_str(data);
        self.queued.fetch_add(out.len(), Ordering::SeqCst);
        self.tx.send(Event::Data(out)).is_ok()
    }
}

fn size(bytes: usize) -> String {
    match bytes {
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / (1 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.1} KB", b as f64 / (1 << 10) as f64),
        b => format!("{} bytes", b),
    }
}

/// A run's live output, from a subscribe.
pub struct Subscription {
    rx: mpsc::Receiver<Event>,
    queued: Arc<AtomicUsize>,
}

impl Subscription {
    fn received(&self, e: Event) -> Event {
        if let Event::Data(d) = &e {
            self.queued.fetch_sub(d.len(), Ordering::SeqCst);
        }
        e
    }

    pub fn recv(&self) -> Result<Event, mpsc::RecvError> {
        self.rx.recv().map(|e| self.received(e))
    }

    pub fn recv_timeout(&self, t: Duration) -> Result<Event, mpsc::RecvTimeoutError> {
        self.rx.recv_timeout(t).map(|e| self.received(e))
    }
}

impl Run {
    fn push(&mut self, data: &str) -> u64 {
        let offset = self.end;
        self.end += data.len() as u64;
        self.kept += data.len();
        self.chunks.push_back((offset, data.to_string()));
        while self.kept > CAP_BYTES && self.chunks.len() > 1 {
            if let Some((_, c)) = self.chunks.pop_front() {
                self.kept -= c.len();
            }
        }
        self.subscribers.retain_mut(|s| s.send(data));
        offset
    }

    fn backlog(&self) -> Backlog {
        Backlog {
            data: self.chunks.iter().map(|(_, c)| c.as_str()).collect(),
            end_offset: self.end,
            closed: self.closed,
        }
    }
}

#[derive(Default)]
pub struct Hub {
    runs: Mutex<HashMap<String, Run>>,
}

pub fn hub() -> &'static Hub {
    static HUB: OnceLock<Hub> = OnceLock::new();
    HUB.get_or_init(Hub::default)
}

impl Hub {
    /// Starts keeping `pty_id`'s output.
    pub fn open(&self, pty_id: &str) {
        self.runs.lock().unwrap().insert(pty_id.to_string(), Run::default());
    }

    /// Appends a chunk, returning its offset; None when the run is not kept.
    pub fn push(&self, pty_id: &str, data: &str) -> Option<u64> {
        self.runs.lock().unwrap().get_mut(pty_id).map(|r| r.push(data))
    }

    pub fn close(&self, pty_id: &str) {
        if let Some(r) = self.runs.lock().unwrap().get_mut(pty_id) {
            r.closed = true;
            for s in r.subscribers.drain(..) {
                let _ = s.tx.send(Event::Closed);
            }
        }
    }

    /// Forgets a run, once a newer run of the same service replaces it.
    pub fn forget(&self, pty_id: &str) {
        self.runs.lock().unwrap().remove(pty_id);
    }

    pub fn backlog(&self, pty_id: &str) -> Option<Backlog> {
        self.runs.lock().unwrap().get(pty_id).map(Run::backlog)
    }

    /// The backlog, and everything after it. Taken under one lock, so no chunk
    /// falls between the two or arrives in both.
    pub fn subscribe(&self, pty_id: &str) -> Option<(Backlog, Subscription)> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get_mut(pty_id)?;
        let (tx, rx) = mpsc::channel();
        let queued = Arc::new(AtomicUsize::new(0));
        if run.closed {
            let _ = tx.send(Event::Closed);
        } else {
            run.subscribers.push(Subscriber { tx, queued: queued.clone(), skipped: 0 });
        }
        Some((run.backlog(), Subscription { rx, queued }))
    }

    /// The run's output as lines of plain text.
    pub fn lines(&self, pty_id: &str) -> Option<Vec<String>> {
        self.backlog(pty_id).map(|b| text_lines(&b.data))
    }
}

/// Terminal output as the lines a terminal would end up showing, near enough:
/// escape sequences dropped, a bare `\r` starting the line over (progress bars),
/// backspace taking back a character.
pub fn text_lines(raw: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters, then one final byte in @..~
                Some('[') => {
                    while let Some(n) = chars.next() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC and friends: up to BEL or ST (ESC \)
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                // Charset selection takes one more character.
                Some('(') | Some(')') => {
                    chars.next();
                }
                _ => {}
            },
            '\n' => lines.push(std::mem::take(&mut line)),
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    line.clear();
                }
            }
            '\x08' => {
                line.pop();
            }
            c if c.is_control() && c != '\t' => {}
            c => line.push(c),
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    for l in lines.iter_mut() {
        l.truncate(l.trim_end().len());
    }
    // Blank lines after the last output are screen, not output.
    while lines.last().map_or(false, |l| l.is_empty()) {
        lines.pop();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_count_every_byte_and_old_chunks_fall_off() {
        let h = Hub::default();
        h.open("p");
        let big = "x".repeat(CAP_BYTES / 2 + 1);
        assert_eq!(h.push("p", &big), Some(0));
        assert_eq!(h.push("p", &big), Some(big.len() as u64));
        assert_eq!(h.push("p", "tail"), Some(2 * big.len() as u64));
        let b = h.backlog("p").unwrap();
        assert_eq!(b.end_offset, 2 * big.len() as u64 + 4);
        assert_eq!(b.data.len(), big.len() + 4);
        assert!(b.data.ends_with("tail"));
    }

    #[test]
    fn one_chunk_over_the_cap_is_still_kept() {
        let h = Hub::default();
        h.open("p");
        h.push("p", &"y".repeat(CAP_BYTES + 10));
        assert_eq!(h.backlog("p").unwrap().data.len(), CAP_BYTES + 10);
    }

    #[test]
    fn a_subscriber_gets_the_backlog_then_only_what_follows() {
        let h = Hub::default();
        h.open("p");
        h.push("p", "one\n");
        let (b, rx) = h.subscribe("p").unwrap();
        assert_eq!(b.data, "one\n");
        h.push("p", "two\n");
        h.close("p");
        assert_eq!(rx.recv().unwrap(), Event::Data("two\n".into()));
        assert_eq!(rx.recv().unwrap(), Event::Closed);
    }

    #[test]
    fn a_reader_that_falls_behind_skips_ahead_and_is_told() {
        let h = Hub::default();
        h.open("p");
        let (_, rx) = h.subscribe("p").unwrap();
        let big = "x".repeat(SUBSCRIBER_CAP_BYTES / 2);
        h.push("p", &big);
        h.push("p", &big);
        h.push("p", "lost\n");
        h.push("p", &big);
        assert_eq!(rx.recv().unwrap(), Event::Data(big.clone()));
        assert_eq!(rx.recv().unwrap(), Event::Data(big.clone()));
        h.push("p", "back\n");
        h.close("p");
        assert_eq!(
            rx.recv().unwrap(),
            Event::Data(format!("\r\n[lever: {} skipped while not reading]\r\nback\n", size(big.len() + 5)))
        );
        assert_eq!(rx.recv().unwrap(), Event::Closed);
    }

    #[test]
    fn subscribing_to_a_finished_run_ends_at_once() {
        let h = Hub::default();
        h.open("p");
        h.push("p", "done\n");
        h.close("p");
        let (b, rx) = h.subscribe("p").unwrap();
        assert!(b.closed);
        assert_eq!(rx.recv().unwrap(), Event::Closed);
    }

    #[test]
    fn unkept_runs_are_ignored() {
        let h = Hub::default();
        assert_eq!(h.push("nope", "x"), None);
        assert!(h.subscribe("nope").is_none());
    }

    #[test]
    fn text_drops_escapes_and_honours_carriage_returns() {
        let raw = "\x1b[32mready\x1b[0m on :3000\r\n\x1b]0;title\x07progress 10%\rprogress 100%\nab\x08c\n";
        assert_eq!(text_lines(raw), vec!["ready on :3000", "progress 100%", "ac"]);
    }

    #[test]
    fn a_line_without_its_newline_yet_still_shows() {
        assert_eq!(text_lines("a\nwaiting"), vec!["a", "waiting"]);
        assert_eq!(text_lines("a  \n\n\r\n"), vec!["a"]);
    }
}
