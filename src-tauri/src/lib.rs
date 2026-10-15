use serde::Serialize;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Output, Stdio};
use tauri::Manager;

mod companion;

use companion::{
    clear_place, ensure_companion, read_refresh, set_open_book, stop_companion, stop_on_exit,
    write_place, BookShell,
};

#[derive(Serialize)]
struct DirItem {
    name: String,
    kind: String,
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| error.to_string())
}

fn ensure_parent(path: &str) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    ensure_parent(&path)?;
    fs::write(&path, text).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirItem>, String> {
    let mut items = Vec::new();
    for entry in fs::read_dir(&path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            "dir"
        } else {
            "file"
        };
        items.push(DirItem {
            name,
            kind: kind.to_string(),
        });
    }
    Ok(items)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    ensure_parent(&to)?;
    fs::rename(&from, &to).map_err(|error| error.to_string())
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    fs::remove_dir_all(&path)
        .or_else(|_| remove_one(&path))
        .map_err(|error| error.to_string())
}

fn remove_one(path: &str) -> Result<(), std::io::Error> {
    fs::remove_file(path).or_else(ignore_missing)
}

fn ignore_missing(error: std::io::Error) -> Result<(), std::io::Error> {
    if error.kind() == ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

#[tauri::command]
fn canonicalize_path(path: String) -> Result<String, String> {
    fs::canonicalize(&path)
        .map(|found| found.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

fn remove_copied_source(from: &str, to: &str) -> Result<(), String> {
    if let Err(remove_error) = fs::remove_file(from) {
        let _ = fs::remove_file(to);
        return Err(remove_error.to_string());
    }
    Ok(())
}

fn copy_then_remove(from: &str, to: &str) -> Result<(), String> {
    fs::copy(from, to).map_err(|error| error.to_string())?;
    remove_copied_source(from, to)
}

#[tauri::command]
fn move_file(from: String, to: String) -> Result<(), String> {
    ensure_parent(&to)?;
    match fs::rename(&from, &to) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::CrossesDevices => copy_then_remove(&from, &to),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn allow_book(app: tauri::AppHandle, root: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|error| error.to_string())
}

fn spec_book_path() -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../spec-book");
    path.canonicalize()
        .ok()
        .map(|found| found.to_string_lossy().into_owned())
}

const USAGE: &str = include_str!("../../usage.txt");

fn book_from_args() -> Result<Option<String>, String> {
    book_from(std::env::args().skip(1))
}

fn help_requested() -> bool {
    help_flag(std::env::args().skip(1))
}

fn help_flag<I>(args: I) -> bool
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    for arg in args {
        let arg = arg.as_ref();
        if arg == "--" {
            return false;
        }
        if is_help(arg) {
            return true;
        }
    }
    false
}

fn is_help(arg: &str) -> bool {
    arg == "--help" || arg == "-h"
}

fn book_from<I>(args: I) -> Result<Option<String>, String>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    for arg in args {
        let arg = arg.as_ref();
        if arg == "--" || arg.starts_with('-') {
            continue;
        }
        let path = PathBuf::from(arg);
        if !path.is_dir() {
            return Err(format!("not a directory: {arg}"));
        }
        let full = path.canonicalize().map_err(|error| error.to_string())?;
        return Ok(Some(full.to_string_lossy().into_owned()));
    }
    Ok(None)
}

#[tauri::command]
fn startup_book_path() -> Result<String, String> {
    if let Some(path) = book_from_args()? {
        return Ok(path);
    }
    spec_book_path().ok_or_else(|| "Open a book.".to_string())
}

#[tauri::command]
fn pandoc_docx(markdown: String, output: String, resource_dir: String) -> Result<(), String> {
    let produced = run_pandoc(&markdown, &output, &resource_dir).map_err(pandoc_io_error)?;
    finish_pandoc(produced)
}

fn run_pandoc(markdown: &str, output: &str, resource_dir: &str) -> std::io::Result<Output> {
    spawn_pandoc(output, resource_dir).and_then(|child| feed_pandoc(child, markdown))
}

fn spawn_pandoc(output: &str, resource_dir: &str) -> std::io::Result<Child> {
    Command::new("pandoc")
        .current_dir(resource_dir)
        .args(["--from=markdown", "--to=docx", "-o", output])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
}

fn feed_pandoc(mut child: Child, markdown: &str) -> std::io::Result<Output> {
    write_stdin(child.stdin.as_mut(), markdown)?;
    child.wait_with_output()
}

fn write_stdin(stdin: Option<&mut ChildStdin>, markdown: &str) -> std::io::Result<()> {
    stdin
        .map(|pipe| pipe.write_all(markdown.as_bytes()))
        .unwrap_or(Ok(()))
}

fn finish_pandoc(output: Output) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(pandoc_stderr(&output))
    }
}

fn pandoc_stderr(output: &Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if text.is_empty() {
        "Pandoc failed.".to_string()
    } else {
        text
    }
}

fn pandoc_io_error(error: std::io::Error) -> String {
    if error.kind() == ErrorKind::NotFound {
        "Pandoc is not installed.".to_string()
    } else {
        error.to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if help_requested() {
        print!("{USAGE}");
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(BookShell::default())
        .invoke_handler(tauri::generate_handler![
            read_text,
            read_bytes,
            write_text,
            read_dir,
            rename_path,
            make_dir,
            canonicalize_path,
            move_file,
            remove_path,
            allow_book,
            startup_book_path,
            pandoc_docx,
            set_open_book,
            ensure_companion,
            stop_companion,
            read_refresh,
            write_place,
            clear_place
        ])
        .build(tauri::generate_context!())
        .expect("error while running Bookwriter")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_on_exit(&app.state::<BookShell>());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("bookwriter-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn writes_reads_and_lists_a_book_folder() {
        let dir = temp_dir();
        let file = dir.join("chapters").join("one.md");
        let path = file.to_string_lossy().into_owned();
        write_text(path.clone(), "hello".into()).unwrap();
        assert_eq!(read_text(path.clone()).unwrap(), "hello");
        read_bytes(path).unwrap();
        fs::create_dir(dir.join("pictures")).unwrap();
        let names: Vec<_> = read_dir(dir.to_string_lossy().into_owned())
            .unwrap()
            .into_iter()
            .map(|item| (item.name, item.kind))
            .collect();
        assert!(names.contains(&("chapters".into(), "dir".into())));
        assert!(names.contains(&("pictures".into(), "dir".into())));
        let chapter = read_dir(dir.join("chapters").to_string_lossy().into_owned()).unwrap();
        assert!(chapter
            .iter()
            .any(|item| item.name == "one.md" && item.kind == "file"));
    }

    #[test]
    fn renames_and_moves_a_file() {
        let dir = temp_dir();
        let from = dir.join("one.md");
        fs::write(&from, "body").unwrap();
        let renamed = dir.join("nested").join("two.md");
        rename_path(
            from.to_string_lossy().into_owned(),
            renamed.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "body");

        let moved = dir.join("elsewhere").join("three.md");
        move_file(
            renamed.to_string_lossy().into_owned(),
            moved.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&moved).unwrap(), "body");
        assert!(move_file(
            dir.join("missing.md").to_string_lossy().into_owned(),
            dir.join("nope.md").to_string_lossy().into_owned()
        )
        .is_err());
    }

    #[test]
    fn copies_across_when_asked_and_restores_a_failed_remove() {
        let dir = temp_dir();
        let from = dir.join("one.md");
        let to = dir.join("two.md");
        fs::write(&from, "body").unwrap();
        copy_then_remove(from.to_str().unwrap(), to.to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&to).unwrap(), "body");
        assert!(!from.exists());

        let stuck = dir.join("stuck");
        fs::create_dir(&stuck).unwrap();
        let leftover = dir.join("leftover.md");
        fs::write(&leftover, "x").unwrap();
        assert!(remove_copied_source(stuck.to_str().unwrap(), leftover.to_str().unwrap()).is_err());
        assert!(!leftover.exists());
        assert!(copy_then_remove(
            dir.join("gone.md").to_str().unwrap(),
            dir.join("out.md").to_str().unwrap()
        )
        .is_err());
    }

    #[test]
    fn removes_a_file_or_a_directory_and_ignores_a_missing_path() {
        let dir = temp_dir();
        let file = dir.join("one.md");
        fs::write(&file, "body").unwrap();
        remove_path(file.to_string_lossy().into_owned()).unwrap();
        assert!(!file.exists());

        let nested = dir.join("folder").join("inner");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("note.md"), "x").unwrap();
        remove_path(dir.join("folder").to_string_lossy().into_owned()).unwrap();
        assert!(!dir.join("folder").exists());

        remove_path(dir.join("missing").to_string_lossy().into_owned()).unwrap();
    }

    #[test]
    fn reads_a_book_path_from_arguments() {
        let dir = temp_dir();
        let found = book_from(["--", "-x", dir.to_str().unwrap()])
            .unwrap()
            .unwrap();
        assert_eq!(found, dir.canonicalize().unwrap().to_string_lossy());
        assert!(book_from(["notes.md"]).is_err());
        assert!(book_from(["--", "-h"]).unwrap().is_none());
        assert!(help_flag(["--help"]));
        assert!(help_flag(["-h", "/tmp"]));
        assert!(!help_flag(["--", "--help"]));
        assert!(!help_flag([dir.to_str().unwrap()]));
        assert!(include_str!("../../README.md").contains(USAGE.trim_end()));
        let _ = startup_book_path();
        let _ = spec_book_path();
    }

    #[test]
    fn writes_a_docx_when_pandoc_is_installed() {
        if Command::new("pandoc").arg("--version").output().is_err() {
            return;
        }
        let dir = temp_dir();
        let output = dir.join("one.docx");
        pandoc_docx(
            "<p class=\"chapter-number\">Chapter 2</p>\n\n# Rule\n\n![Missing](images/missing.png)\n\nSee.[^a]\n\n[^a]: Note.\n".into(),
            output.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
        )
        .unwrap();
        let document = unzip_entry(&output, "word/document.xml");
        assert!(document.contains("Chapter 2"));
        assert!(document.contains("Rule"));
        let notes = unzip_entry(&output, "word/footnotes.xml");
        assert!(notes.contains("Note."));
    }

    fn unzip_entry(path: &std::path::Path, name: &str) -> String {
        let output = Command::new("unzip")
            .args(["-p", &path.to_string_lossy(), name])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn reports_pandoc_failure() {
        assert_eq!(
            finish_pandoc(failed_pandoc("")).unwrap_err(),
            "Pandoc failed."
        );
        assert_eq!(
            finish_pandoc(failed_pandoc("pandoc: boom\n")).unwrap_err(),
            "pandoc: boom"
        );
        let missing = std::io::Error::new(ErrorKind::NotFound, "no such file");
        assert_eq!(pandoc_io_error(missing), "Pandoc is not installed.");
        let denied = std::io::Error::new(ErrorKind::PermissionDenied, "denied");
        assert_eq!(pandoc_io_error(denied), "denied");
    }

    fn failed_pandoc(stderr: &str) -> Output {
        Output {
            status: Command::new("false").status().unwrap(),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }
}
