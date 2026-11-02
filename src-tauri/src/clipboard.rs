//! App-lifetime clipboard ownership keeps copied content available on Linux.
use std::sync::Mutex;

use tauri::Manager as _;

#[derive(Default)]
pub(crate) struct Clipboard(Mutex<Option<arboard::Clipboard>>);

impl Clipboard {
    pub(crate) fn release(&self) {
        if let Ok(mut clipboard) = self.0.lock() {
            clipboard.take();
        }
    }
}

async fn write<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    set: impl FnOnce(&mut arboard::Clipboard) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let state = handle.state::<Clipboard>();
            let mut stored = state
                .0
                .lock()
                .map_err(|_| "Clipboard unavailable".to_owned())?;
            if stored.is_none() {
                *stored = Some(
                    arboard::Clipboard::new().map_err(|_| "Clipboard unavailable".to_owned())?,
                );
            }
            set(stored.as_mut().expect("clipboard initialized"))
        })();
        let _ = send.send(result);
    })
    .map_err(|_| "Clipboard unavailable".to_owned())?;
    receive
        .await
        .map_err(|_| "Clipboard unavailable".to_owned())?
}

pub(crate) async fn write_image<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    width: usize,
    height: usize,
    bytes: Vec<u8>,
) -> Result<(), String> {
    write(app, move |clipboard| {
        clipboard
            .set_image(arboard::ImageData {
                width,
                height,
                bytes: std::borrow::Cow::Owned(bytes),
            })
            .map_err(|_| "Could not copy image".to_owned())
    })
    .await
}

/// WebKit rejects `navigator.clipboard` writes without transient user
/// activation, and each host script evaluation (how Tauri delivers events and
/// channel messages) clears it. A click that races host traffic then fails to
/// copy, so macOS text copies go through the host clipboard instead.
#[tauri::command]
pub(crate) async fn clipboard_write_text<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    text: String,
) -> Result<(), String> {
    write(&app, move |clipboard| {
        clipboard
            .set_text(text)
            .map_err(|_| "Could not copy text".to_owned())
    })
    .await
}
