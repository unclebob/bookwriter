use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct BookShell(Mutex<BookState>);

#[derive(Default)]
struct BookState {
    root: Option<PathBuf>,
    companion: Option<CompanionProc>,
}

struct CompanionProc {
    session: String,
    window_id: Option<String>,
}

#[tauri::command]
pub fn set_open_book(state: State<'_, BookShell>, root: String) -> Result<(), String> {
    open_book(&state, root)
}

pub fn open_book(shell: &BookShell, root: String) -> Result<(), String> {
    let path = canonical_directory(Path::new(&root))?;
    stop_record(swap_root(shell, path)?);
    Ok(())
}

fn swap_root(shell: &BookShell, path: PathBuf) -> Result<Option<CompanionProc>, String> {
    let mut state = lock(shell)?;
    if state.root.as_ref() == Some(&path) {
        return Ok(None);
    }
    state.root = Some(path);
    Ok(state.companion.take())
}

#[tauri::command]
pub fn ensure_companion(state: State<'_, BookShell>) -> Result<(), String> {
    ensure_for(&state)
}

fn ensure_for(shell: &BookShell) -> Result<(), String> {
    let root = active_root(shell)?;
    let session = session_id(&root);
    retire_other(shell, &session)?;
    start_unless_live(&root, &session)?;
    remember_companion(shell, &root, &session)
}

fn retire_other(shell: &BookShell, session: &str) -> Result<(), String> {
    stop_record(take_if_other(shell, session)?);
    Ok(())
}

fn take_if_other(shell: &BookShell, session: &str) -> Result<Option<CompanionProc>, String> {
    let mut state = lock(shell)?;
    if state
        .companion
        .as_ref()
        .is_some_and(|companion| companion.session == session)
    {
        return Ok(None);
    }
    Ok(state.companion.take())
}

fn start_unless_live(root: &Path, session: &str) -> Result<(), String> {
    if session_live(session) {
        return Ok(());
    }
    launch_session(root, session)
}

fn session_live(session: &str) -> bool {
    matches!(
        tmux_quiet(&tmux_args(&["has-session", "-t", session])),
        Ok(0)
    )
}

fn launch_session(root: &Path, session: &str) -> Result<(), String> {
    let code = tmux_status(&new_session_args(root, session))?;
    if code != 0 {
        return Err(format!(
            "Bookwriter could not start the companion for {session}."
        ));
    }
    arm_respawn(session);
    publish_terminal(root, session)
}

fn arm_respawn(session: &str) {
    let pane = format!("{session}:0.0");
    let _ = tmux_quiet(&tmux_args(&[
        "set-option",
        "-p",
        "-t",
        &pane,
        "remain-on-exit",
        "on",
    ]));
    let _ = tmux_quiet(&tmux_args(&[
        "set-hook",
        "-t",
        session,
        "pane-died",
        "respawn-pane -k",
    ]));
    let _ = tmux_quiet(&tmux_args(&["set-option", "-t", session, "status", "off"]));
}

fn publish_terminal(root: &Path, session: &str) -> Result<(), String> {
    let out = command_output(
        "osascript",
        &[
            "-e".into(),
            terminal_script(session, &applescript_title(root)),
        ],
    )?;
    let Some(window) = first_number(&out) else {
        return Err("Bookwriter could not open the companion window.".into());
    };
    write_companion(root, session, Some(&window))
}

fn remember_companion(shell: &BookShell, root: &Path, session: &str) -> Result<(), String> {
    let record = read_companion(root).unwrap_or(CompanionProc {
        session: session.to_string(),
        window_id: None,
    });
    lock(shell)?.companion = Some(record);
    Ok(())
}

#[tauri::command]
pub fn stop_companion(state: State<'_, BookShell>) -> Result<(), String> {
    stop_for(&state)
}

pub fn stop_on_exit(shell: &BookShell) {
    let _ = stop_for(shell);
}

fn stop_for(shell: &BookShell) -> Result<(), String> {
    stop_record(take_companion(shell)?);
    if let Ok(root) = active_root(shell) {
        stop_record(read_companion(&root));
    }
    Ok(())
}

fn take_companion(shell: &BookShell) -> Result<Option<CompanionProc>, String> {
    Ok(lock(shell)?.companion.take())
}

fn stop_record(record: Option<CompanionProc>) {
    let Some(record) = record else {
        return;
    };
    let _ = tmux_quiet(&tmux_args(&[
        "set-hook",
        "-t",
        &record.session,
        "-u",
        "pane-died",
    ]));
    let _ = tmux_quiet(&tmux_args(&["kill-session", "-t", &record.session]));
    close_window(record.window_id.as_deref());
}

fn close_window(window: Option<&str>) {
    let Some(digits) = all_digits(window.unwrap_or("")) else {
        return;
    };
    let _ = command_status(
        "osascript",
        &["-e".into(), close_terminal_script(digits)],
        false,
    );
}

#[tauri::command]
pub fn read_refresh(state: State<'_, BookShell>) -> Result<Option<String>, String> {
    refresh_token(&state)
}

pub fn refresh_token(shell: &BookShell) -> Result<Option<String>, String> {
    let root = active_root(shell)?;
    read_refresh_file(&root)
}

fn read_refresh_file(root: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(root.join(".bookwriter").join("refresh")) {
        Ok(text) => Ok(first_token(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn first_token(text: String) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[tauri::command]
pub fn write_place(state: State<'_, BookShell>, json: String) -> Result<(), String> {
    write_place_file(&state, &json)
}

pub fn write_place_file(shell: &BookShell, json: &str) -> Result<(), String> {
    let root = active_root(shell)?;
    let path = root.join(".bookwriter").join("place.json");
    reject_symlink(&path)?;
    atomic_replace(&path, json.as_bytes())
}

#[tauri::command]
pub fn clear_place(state: State<'_, BookShell>) -> Result<(), String> {
    clear_place_file(&state)
}

pub fn clear_place_file(shell: &BookShell) -> Result<(), String> {
    let Ok(root) = active_root(shell) else {
        return Ok(());
    };
    match fs::remove_file(root.join(".bookwriter").join("place.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn active_root(shell: &BookShell) -> Result<PathBuf, String> {
    lock(shell)?
        .root
        .clone()
        .ok_or_else(|| "No book is open.".to_string())
}

fn lock(shell: &BookShell) -> Result<std::sync::MutexGuard<'_, BookState>, String> {
    shell
        .0
        .lock()
        .map_err(|_| "Book state is unavailable.".to_string())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    path.canonicalize().map_err(|error| error.to_string())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "refusing to replace symbolic link: {}",
            path.display()
        )),
        Ok(metadata) if !metadata.is_file() => {
            Err(format!("not a regular file: {}", path.display()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("place.json has no folder")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("place")
    ));
    write_temp(&temp, bytes)?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn write_temp(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn session_id(root: &Path) -> String {
    let name = root
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("book");
    format!(
        "bookwriter-{}-{}",
        session_label(name),
        stable_hash(&root.to_string_lossy())
    )
}

fn session_label(name: &str) -> String {
    let label: String = name.chars().map(session_char).collect();
    if label.is_empty() {
        "book".to_string()
    } else {
        label
    }
}

fn session_char(ch: char) -> char {
    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
        ch
    } else {
        '-'
    }
}

fn stable_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:x}")
}

fn new_session_args(root: &Path, session: &str) -> Vec<String> {
    let cwd = root.to_string_lossy().into_owned();
    let mut args = tmux_args(&[
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        &cwd,
        "-e",
        "GROK_THEME=terminal",
        "-e",
        "GROK_TERMINAL_THEME=1",
        "-e",
        "COLORTERM=truecolor",
    ]);
    args.push(grok_executable());
    args.push("--yolo".into());
    args.push("--trust".into());
    args.push("--rules".into());
    args.push(standing_rules().to_string());
    args.push(launch_prompt().to_string());
    args
}

fn tmux_args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_string()).collect()
}

fn tmux_status(args: &[String]) -> Result<i32, String> {
    command_status(&tmux_executable(), args, false).map_err(missing_tmux)
}

fn tmux_quiet(args: &[String]) -> Result<i32, String> {
    command_status(&tmux_executable(), args, true).map_err(missing_tmux)
}

fn missing_tmux(error: String) -> String {
    if error.contains("No such file") {
        "Bookwriter could not find tmux.".to_string()
    } else {
        error
    }
}

fn tmux_executable() -> String {
    ["/usr/local/bin/tmux", "/opt/homebrew/bin/tmux"]
        .into_iter()
        .find(|path| runnable(Path::new(path)))
        .unwrap_or("tmux")
        .to_string()
}

fn grok_executable() -> String {
    if let Some(path) = std::env::var("GROK_BIN")
        .ok()
        .filter(|path| runnable(Path::new(path)))
    {
        return path;
    }
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(PathBuf::from(home).join(".grok/bin/grok"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/grok"));
    paths.push(PathBuf::from("/usr/local/bin/grok"));
    paths
        .iter()
        .find(|path| runnable(path))
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "grok".to_string())
}

fn runnable(path: &Path) -> bool {
    path.is_file() && executable_mode(path)
}

#[cfg(unix)]
fn executable_mode(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn executable_mode(path: &Path) -> bool {
    path.metadata().is_ok()
}

const TERMINAL_BG: &str = "{5654, 7196, 8224}";
const TERMINAL_INK: &str = "{60652, 60652, 58596}";
const TERMINAL_GOLD: &str = "{59624, 50372, 18504}";

fn terminal_script(session: &str, title: &str) -> String {
    let shell = format!("{} attach -t {session}; exit", tmux_executable());
    format!(
        "tell application \"Terminal\"\n\
         launch\n\
         set grokTab to do script \"{shell}\"\n\
         set background color of grokTab to {bg}\n\
         set normal text color of grokTab to {ink}\n\
         set bold text color of grokTab to {gold}\n\
         set cursor color of grokTab to {gold}\n\
         set font name of grokTab to \"Menlo\"\n\
         set font size of grokTab to 13\n\
         set custom title of grokTab to \"{title}\"\n\
         set title displays custom title of grokTab to true\n\
         set title displays device name of grokTab to false\n\
         set title displays shell path of grokTab to false\n\
         try\n\
         set title displays settings name of grokTab to false\n\
         end try\n\
         set winID to id of front window\n\
         end tell\n\
         tell application \"System Events\"\n\
         tell process \"Terminal\"\n\
         try\n\
         perform action \"AXRaise\" of (first window whose name contains \"{title}\")\n\
         end try\n\
         end tell\n\
         end tell\n\
         return winID",
        shell = shell,
        bg = TERMINAL_BG,
        ink = TERMINAL_INK,
        gold = TERMINAL_GOLD,
    )
}

fn applescript_title(root: &Path) -> String {
    let name = root
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("book");
    format!("Bookwriter: {}", session_label(name))
}

fn close_terminal_script(window: &str) -> String {
    format!(
        "tell application \"Terminal\"\n\
         try\n\
         close (first window whose id is {window}) saving no\n\
         end try\n\
         end tell"
    )
}

fn first_number(text: &str) -> Option<String> {
    let digits: String = text
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

fn all_digits(window: &str) -> Option<&str> {
    if window.is_empty() || !window.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(window)
}

fn write_companion(root: &Path, session: &str, window: Option<&str>) -> Result<(), String> {
    let dir = root.join(".bookwriter");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    fs::write(
        dir.join("companion.txt"),
        format!("{session}\n{}\n", window.unwrap_or("")),
    )
    .map_err(|error| error.to_string())
}

fn read_companion(root: &Path) -> Option<CompanionProc> {
    let text = fs::read_to_string(root.join(".bookwriter").join("companion.txt")).ok()?;
    let mut lines = text.lines();
    let session = lines.next()?.trim();
    if session.is_empty() {
        return None;
    }
    let window = lines
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string);
    Some(CompanionProc {
        session: session.to_string(),
        window_id: window,
    })
}

fn command_status(program: &str, args: &[String], quiet: bool) -> Result<i32, String> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    if quiet {
        command.stderr(std::process::Stdio::null());
    }
    let status = command.status().map_err(|error| error.to_string())?;
    Ok(status.code().unwrap_or(1))
}

fn command_output(program: &str, args: &[String]) -> Result<String, String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        return Err(stderr.trim().to_string());
    }
    Err("Bookwriter could not open the companion window.".into())
}

pub fn standing_rules() -> &'static str {
    STANDING_RULES
}

pub fn launch_prompt() -> &'static str {
    LAUNCH_PROMPT
}

const STANDING_RULES: &str = "\
You are the Bookwriter companion. The current working directory is the book\n\
folder open in Bookwriter, not the Bookwriter source.\n\
\n\
book.yaml has title. manuscript/ is the tree. A directory is a group and its\n\
prose is _index.md. Any other .md file is a section. Sibling order is the\n\
numeric prefix in the name. The id in the header is stable. A rename of the\n\
title does not rename the file. Reordering rewrites prefixes only.\n\
\n\
A section file and a group's _index.md start with YAML front matter. The\n\
header has id, title, synopsis, status, and role. status is idea, draft,\n\
revise, or done. role is front or body. unit, when present, is part, chapter,\n\
section, or text. A file that has break and no unit keeps that break line.\n\
Do not invent header keys. The app rewrites the header and leaves the body\n\
bytes as they are. It writes unit when unit is set, and otherwise leaves\n\
break when that line is a boolean. The body is Pandoc Markdown and starts\n\
immediately after the closing --- line and its one newline. The body does\n\
not repeat the title. A heading in the body is a subsection.\n\
\n\
The writer is looking at one place in .bookwriter/place.json. You only read\n\
that file. You never write it. The app replaces it atomically.\n\
\n\
{\"kind\":\"manuscript\"} means the whole book is on screen. There is no file and\n\
no caret. Do not invent one.\n\
{\"kind\":\"reading\",\"groupId\":\"<id>\"} means that group is rendered straight\n\
through. There is no file and no caret. Do not edit that group's _index.md\n\
as if the caret were there. Find the section that holds the sentence.\n\
{\"kind\":\"body\",\"file\":\"<path>\",\"nodeId\":\"<id>\",\"selection\":...} means the\n\
writer is in that file's body. file is relative to the book folder. Check\n\
that the header id matches nodeId. If it does not, find the manuscript file\n\
whose id matches, and edit that file.\n\
{\"kind\":\"title\",\"file\":\"book.yaml\",\"selection\":...} means the title field.\n\
The caret counts Unicode code points in the title value, not bytes of the file.\n\
\n\
A selection is {\"kind\":\"caret\",\"at\":N} or {\"kind\":\"range\",\"anchor\":N,\"head\":N}\n\
with anchor and head different. N counts Unicode code points in the body or\n\
in the title value. It does not count the header. It is not a byte offset.\n\
\n\
Edit the files yourself. Write them completely. Then write a new one-line\n\
token to .bookwriter/refresh. Use a different token each time. The same token\n\
twice does not ask again. Write every changed file before the token.\n\
Bookwriter refreshes when that token is new, and when the writer presses\n\
Refresh. It does not refresh on a file change alone.\n\
\n\
If place.json names a file the writer is mid-edit in, the app keeps their\n\
keystrokes on screen and keeps your bytes on disk. It will not save their\n\
buffer over your write, and it will not throw their keystrokes away. You\n\
cannot see that buffer. Do not try to merge it. A file they are not editing\n\
is reloaded, including another section while this one is open.\n\
\n\
Do not start Bookwriter. Closing its window stops only this companion.\n\
Do not commit or push unless asked.\n";

const LAUNCH_PROMPT: &str = "\
The book in this directory is open in Bookwriter. When asked, edit the \
manuscript files, then write a new one-line token to .bookwriter/refresh so \
the window reads those files. Read .bookwriter/place.json first. Wait for \
directives.";

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("bookwriter-companion-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn names_a_companion_for_the_book_folder() {
        let dir = temp_dir();
        let nested = dir.join("My Book");
        fs::create_dir(&nested).unwrap();
        let id = session_id(&nested);
        assert_eq!(id, session_id(&nested));
        assert!(id.starts_with("bookwriter-My-Book-"));
        assert!(!id.contains(' '));
        assert_eq!(session_label(""), "book");
        assert!(standing_rules().contains("book.yaml"));
        assert!(standing_rules().contains("manuscript/"));
        assert!(standing_rules().contains("break"));
        assert!(standing_rules().contains(".bookwriter/place.json"));
        assert!(standing_rules().contains(".bookwriter/refresh"));
        assert!(!standing_rules().contains("already on disk"));
        assert!(launch_prompt().contains(".bookwriter/place.json"));
        assert!(launch_prompt().contains(".bookwriter/refresh"));
        let args = new_session_args(&nested, &id);
        assert!(args.iter().any(|arg| arg == "--yolo"));
        assert!(args.iter().any(|arg| arg == "--rules"));
    }

    #[test]
    fn reads_a_refresh_token_and_writes_place() {
        let dir = temp_dir().canonicalize().unwrap();
        let shell = BookShell::default();
        open_book(&shell, dir.to_string_lossy().into_owned()).unwrap();
        assert!(refresh_token(&shell).unwrap().is_none());
        fs::create_dir_all(dir.join(".bookwriter")).unwrap();
        fs::write(dir.join(".bookwriter").join("refresh"), " \n2\n").unwrap();
        assert_eq!(refresh_token(&shell).unwrap().as_deref(), Some("2"));
        assert_eq!(refresh_token(&shell).unwrap().as_deref(), Some("2"));
        write_place_file(&shell, "{\"kind\":\"manuscript\"}").unwrap();
        let place = dir.join(".bookwriter").join("place.json");
        assert_eq!(
            fs::read_to_string(&place).unwrap(),
            "{\"kind\":\"manuscript\"}"
        );
        write_place_file(&shell, "{\"kind\":\"reading\",\"groupId\":\"naming\"}").unwrap();
        assert_eq!(
            fs::read_to_string(&place).unwrap(),
            "{\"kind\":\"reading\",\"groupId\":\"naming\"}"
        );
        clear_place_file(&shell).unwrap();
        assert!(!place.exists());
        clear_place_file(&shell).unwrap();
    }
}
