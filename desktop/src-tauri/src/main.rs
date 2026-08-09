// RealtimeClipboard desktop — the native shell.
//
// The design constraint, and the reason this file is short: Rust never sees a
// frame, a room hash, or a key. It does exactly the things the web platform
// forbids a page from doing, hands the results to the webview, and stays out of
// the way. Everything else — the protocol, the encryption, the transport, the
// entire UI — is the same `src/` the website serves, loaded unmodified.
//
// That is what keeps the wire protocol at two implementations (this app's
// JavaScript, and the Python relay) no matter how many platforms ship. A Rust
// client would have been a second place for the crypto to be subtly wrong.
//
// What this file owns:
//   1. Watching the system clipboard in the background. The only thing here
//      that the browser version genuinely cannot do, and the whole product.
//   2. Writing incoming clips to the system clipboard without needing focus.
//   3. The tray icon and its menu, the window's lifetime, and a global hotkey.
//   4. Refusing to be started twice.
//
// It owns no application state beyond two booleans about the window. Where the
// tray needs to know something the app knows — whether sync is Live, what the
// share link is — it asks the webview rather than being told, because the
// answer is derived from the key.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, MenuBuilder, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, CloseRequestApi, Emitter, Manager, State, WindowEvent, Wry};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// How long after we WRITE the clipboard we refuse to read it back.
///
/// The mirror of TEXT.SUPPRESS_MS in src/core/config.js, and it exists on this
/// side too rather than trusting the JS window alone. The loop it prevents is:
/// a clip arrives, we write it to the clipboard, our own watcher sees a "new"
/// value, and sends it straight back — forever, across every device in the
/// session (docs/CLIPBOARD-FLOW.md §6).
///
/// In a browser that loop was bounded by the poller only running while focused.
/// A background watcher has no such bound, which is why this guard is here at
/// the source rather than only downstream.
const ECHO_SUPPRESS: Duration = Duration::from_millis(1500);

/// Show or hide the window from anywhere.
///
/// A Rust-side constant rather than one in core/config.js for the same reason
/// ECHO_SUPPRESS is: this side has to work when the window is hidden and
/// nothing in the webview is being looked at.
const SHOW_HIDE: &str = "CmdOrCtrl+Shift+V";

/// How long a close waits for the webview to answer before hiding anyway.
///
/// The window must never become unclosable because the page wedged.
const CLOSE_ANSWER_GRACE: Duration = Duration::from_millis(2000);

/// How many of our own recent writes to recognise.
///
/// One was not enough. Two clips arriving inside a single poll interval leave
/// the watcher holding the first while `remember` has already moved on to the
/// second, so the first fails to match, is read as a fresh local copy, and goes
/// back out to the room — the storm this guard exists to stop. Small because
/// entries older than ECHO_SUPPRESS are dead anyway.
const ECHO_MEMORY: usize = 8;

struct Watcher {
    /// What we put on the clipboard ourselves, newest last.
    echo: Mutex<VecDeque<(String, Instant)>>,
}

impl Watcher {
    /// True if this value is one we just wrote, and should not be re-sent.
    fn is_own(&self, text: &str) -> bool {
        let mut echo = self.echo.lock().unwrap();
        while echo.front().is_some_and(|(_, at)| at.elapsed() >= ECHO_SUPPRESS) {
            echo.pop_front();
        }
        echo.iter().any(|(last, _)| last == text)
    }

    fn remember(&self, text: &str) {
        let mut echo = self.echo.lock().unwrap();
        if echo.len() == ECHO_MEMORY {
            echo.pop_front();
        }
        echo.push_back((text.to_owned(), Instant::now()));
    }
}

/// The tray's one two-state item, kept so the webview can correct it.
///
/// The tray decides nothing: `settings.syncMode` lives in core/state.js and
/// this is a picture of it. A checkbox that set the mode itself would be the
/// second control for one behaviour that ui/features/syncMode.js exists to
/// avoid.
struct TrayItems {
    live: Mutex<Option<CheckMenuItem<Wry>>>,
}

/// What the X button does, and whether it has been explained yet.
///
/// Rust owns the behaviour because only Rust sees a close. The webview owns the
/// preference and persists it, and pushes it here on boot and on every change.
/// The defaults below are the shipped ones, so a close arriving before the page
/// has booted still behaves correctly.
struct WindowPrefs {
    close_to_tray: AtomicBool,
    ask_on_close: AtomicBool,
    /// A question is outstanding. Per-run and in memory on purpose: it guards
    /// a double-close race within one run, nothing longer.
    asking: AtomicBool,
}

impl Default for WindowPrefs {
    fn default() -> Self {
        Self {
            close_to_tray: AtomicBool::new(true),
            ask_on_close: AtomicBool::new(true),
            asking: AtomicBool::new(false),
        }
    }
}

/// Write an incoming clip to the system clipboard.
///
/// Called from the webview when a clip arrives. The ordering is the invariant
/// from docs/ARCHITECTURE.md §5: remember FIRST, write SECOND. Reversed, the
/// watcher thread can observe the new value before we have recorded it, and the
/// storm starts.
#[tauri::command]
fn set_clipboard(text: String, watcher: State<Watcher>, app: AppHandle) -> Result<(), String> {
    watcher.remember(&text);
    tauri_plugin_clipboard_manager::ClipboardExt::clipboard(&app)
        .write_text(text)
        .map_err(|e| e.to_string())
}

/// Plain boolean preferences — the only kind of app state this side owns.
#[tauri::command]
fn set_window_prefs(close_to_tray: bool, ask_on_close: bool, prefs: State<WindowPrefs>) {
    prefs.close_to_tray.store(close_to_tray, Ordering::Relaxed);
    prefs.ask_on_close.store(ask_on_close, Ordering::Relaxed);
}

/// The webview's answer to the close dialog.
#[tauri::command]
fn resolve_close(quit: bool, app: AppHandle, prefs: State<WindowPrefs>) {
    prefs.asking.store(false, Ordering::Relaxed);
    if quit {
        app.exit(0);
        return;
    }
    hide_main(&app);
}

/// Keep the tray's Live checkbox honest. The webview is the only place the mode
/// lives, so the tray is told rather than asked.
#[tauri::command]
fn set_sync_indicator(live: bool, tray: State<TrayItems>) {
    if let Some(item) = tray.live.lock().unwrap().as_ref() {
        let _ = item.set_checked(live);
    }
}

/// Open one of the project's own links in the user's real browser.
///
/// The webview swallows `target="_blank"` — it has no browser to hand the
/// request to and Tauri registers no new-window handler — so every project link
/// in the app was a click that did nothing. See src/ui/features/externalLinks.js.
///
/// The allowlist is HERE and not in the webview, because the webview is the side
/// that renders other people's clipboard text: "open this URL" is precisely the
/// command a pastejacked page would reach for, and a JavaScript-side check is
/// one XSS away from being no check. https only, two hosts, and the URL is a
/// single argv entry that never reaches a shell — `rundll32` rather than
/// `cmd /c start` for that reason.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    const HOSTS: [&str; 2] = ["github.com", "realtimeclipboard.com"];

    // The fragment is dropped before the URL becomes another process's argv,
    // where anyone listing processes can read it. No link in the app carries one
    // — but a share link is a fragment, and this side never holds a key.
    let url = url.split('#').next().unwrap_or_default().to_string();

    let host = url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or_default();
    if !HOSTS.contains(&host) {
        return Err(format!("refused: {url}"));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn show_main(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// The tray icon, its menu, and the click mapping.
///
/// Built here rather than declared in tauri.conf.json for three reasons. The
/// config cannot express a per-platform `show_menu_on_left_click` — and worse,
/// its `menuOnLeftClick` is applied first and then overwritten by
/// `showMenuOnLeftClick`, which defaults to true, so the config's `false` never
/// took effect at all. The Linux icon may not appear unless a menu is set at
/// creation. And this way the icon, the menu and both handlers are one block.
///
/// The click mapping is not uniform because the platforms are not:
///
///   Windows   left or double click raises the window; right click menus.
///   macOS     any click opens the menu — the menu-bar convention.
///   Linux     no click event is ever delivered (libappindicator offers only a
///             menu), so the menu is the entire interaction.
///
/// Hence "Open RealtimeClipboard" is the first item: on two of three platforms
/// it is the only way in. The menu is the guarantee; clicks are a convenience.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open RealtimeClipboard", true, None::<&str>)?;
    let link = MenuItem::with_id(app, "link", "Copy share link", true, None::<&str>)?;
    let live = CheckMenuItem::with_id(app, "live", "Share what I copy", true, true, None::<&str>)?;
    let guide = MenuItem::with_id(app, "guide", "How this works", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit RealtimeClipboard", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .items(&[&open, &link])
        .separator()
        .items(&[&live])
        .separator()
        .items(&[&guide])
        .separator()
        .items(&[&quit])
        .build()?;

    app.manage(TrayItems {
        live: Mutex::new(Some(live)),
    });

    TrayIconBuilder::with_id("main")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("bundle.icon must provide a default window icon"),
        )
        .tooltip("RealtimeClipboard")
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .menu(&menu)
        .on_menu_event(on_menu)
        .on_tray_icon_event(|tray, event| {
            // On macOS this same click is already opening the menu; raising the
            // window as well would do both at once.
            if cfg!(target_os = "macos") {
                return;
            }
            // DoubleClick is Windows-only and Click is never delivered on
            // Linux. Both are handled, neither is relied on — the menu is.
            let wants_window = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );
            if wants_window {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_main(app),
        // The webview does the copying. The share link is derived from the key,
        // and the key does not cross into this process.
        "link" => {
            let _ = app.emit("ui://copy-link", ());
        }
        "guide" => {
            show_main(app);
            let _ = app.emit("ui://guide", ());
        }
        "live" => {
            let _ = app.emit("ui://toggle-sync", ());
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// The X button.
///
/// Hiding is right for an app whose job is to keep watching, and wrong to
/// impose silently — the standing complaint about tray apps is being left with
/// a background process you can neither find nor stop, which is exactly what
/// this app did before: close hid the window, the tray did nothing, and Task
/// Manager was the only way out.
///
/// So the first close asks, the answer becomes a visible setting, and Quit is
/// in the tray menu either way. prevent_close() means the window is still on
/// screen while we ask, which is why the question can be an ordinary dialog in
/// the page rather than a native notification.
fn on_close(app: &AppHandle, api: &CloseRequestApi) {
    let prefs = app.state::<WindowPrefs>();

    if !prefs.close_to_tray.load(Ordering::Relaxed) {
        return; // let it close; the app exits with its last window
    }
    api.prevent_close();

    if !prefs.ask_on_close.load(Ordering::Relaxed) {
        hide_main(app);
        return;
    }
    if prefs.asking.swap(true, Ordering::Relaxed) {
        return; // already asking — a second X is not a second question
    }
    let _ = app.emit("window://close-requested", ());

    // If the page cannot answer, hide anyway. An unclosable window is a worse
    // failure than a missing explanation.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_ANSWER_GRACE);
        if app
            .state::<WindowPrefs>()
            .asking
            .swap(false, Ordering::Relaxed)
        {
            hide_main(&app);
        }
    });
}

/// Registered here rather than from the webview, because the whole point of it
/// is reaching an app whose window is hidden.
fn register_shortcut(app: &AppHandle) {
    let registered = app
        .global_shortcut()
        .on_shortcut(SHOW_HIDE, |app, _sc, event| {
            // Pressed only, or the release toggles it straight back.
            if event.state != ShortcutState::Pressed {
                return;
            }
            let Some(w) = app.get_webview_window("main") else {
                return;
            };
            if w.is_visible().unwrap_or(false) {
                let _ = w.hide();
            } else {
                show_main(app);
            }
        });

    // Another application already owns it. Say so — a documented shortcut that
    // silently does nothing is worse than not having one.
    if registered.is_err() {
        let _ = app.emit("shortcut://unavailable", SHOW_HIDE);
    }
}

/// Poll the clipboard and emit what changes.
///
/// Polling rather than the OS change notifications, and that is a considered
/// choice rather than laziness. The native APIs differ per platform
/// (AddClipboardFormatListener, NSPasteboard changeCount, XFixes) and none of
/// them exists on GNOME Wayland at all — there is no clipboard-monitoring
/// portal, so no application can watch it there. A 400 ms poll of an in-process
/// value is cheap, behaves identically everywhere it works, and degrades to
/// "nothing happens" where the platform forbids reading rather than to a
/// per-platform failure. `clipboard-master` is the upgrade path if the cost
/// ever shows up in a measurement.
fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<String> = None;
        loop {
            std::thread::sleep(Duration::from_millis(400));

            let current =
                match tauri_plugin_clipboard_manager::ClipboardExt::clipboard(&app).read_text() {
                    Ok(t) => t,
                    // Not an error worth reporting: a clipboard holding an image
                    // or a file list has no text, and that is most of the time.
                    Err(_) => continue,
                };

            if current.is_empty() || last.as_deref() == Some(current.as_str()) {
                continue;
            }
            last = Some(current.clone());

            // Ours, from a clip we just applied. Dropping it here is the first
            // of the three guards in docs/CLIPBOARD-FLOW.md §6.
            if app.state::<Watcher>().is_own(&current) {
                continue;
            }

            // The webview decides what to do with it — including whether the
            // session is in Manual mode, which is checked there because that is
            // where the setting lives.
            let _ = app.emit("clipboard://text", current);
        }
    });
}

fn main() {
    tauri::Builder::default()
        // Two instances would fight over one clipboard, each seeing the other's
        // writes as new values. Not a nuisance — a loop.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(Watcher {
            echo: Mutex::new(VecDeque::new()),
        })
        .manage(WindowPrefs::default())
        .invoke_handler(tauri::generate_handler![
            set_clipboard,
            set_window_prefs,
            resolve_close,
            set_sync_indicator,
            open_external
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            spawn_watcher(handle.clone());

            // `?`, deliberately: an app that hides its window on close and has
            // no tray is the trap this replaced. Failing to start is better.
            build_tray(&handle)?;
            register_shortcut(&handle);

            if let Some(window) = app.get_webview_window("main") {
                let handle = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        on_close(&handle, api);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start RealtimeClipboard")
        .run(|_app, _event| {
            // Clicking the Dock icon of an app whose window is hidden does
            // nothing on its own, which on macOS reads as the app being broken.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = _event
            {
                if !has_visible_windows {
                    show_main(_app);
                }
            }
        });
}
