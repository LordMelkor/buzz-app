//! Keeps the Mac from idle sleep while the owner's keep-awake setting asks.
//! The webview owns when to hold; this owns the one macOS power assertion.
//! macOS releases it when the process exits, so a crash cannot strand it.
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct KeepAwake(Mutex<Option<u32>>);

#[tauri::command]
pub(crate) fn keep_awake_set(state: tauri::State<'_, KeepAwake>, hold: bool) -> Result<(), String> {
    let mut held = state.0.lock().map_err(|e| e.to_string())?;
    match (hold, *held) {
        (true, None) => *held = Some(power::acquire()?),
        (false, Some(id)) => {
            power::release(id);
            *held = None;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod power {
    use std::ffi::{c_char, c_void};

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const c_void,
            level: u32,
            name: *const c_void,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    const ASSERTION_LEVEL_ON: u32 = 255;
    const UTF8: u32 = 0x0800_0100;

    /// Prevents idle system sleep; the display may still sleep.
    pub(super) fn acquire() -> Result<u32, String> {
        unsafe {
            let kind = CFStringCreateWithCString(
                std::ptr::null(),
                c"PreventUserIdleSystemSleep".as_ptr(),
                UTF8,
            );
            let reason = CFStringCreateWithCString(
                std::ptr::null(),
                c"Buzz keeps this Mac awake for its agents".as_ptr(),
                UTF8,
            );
            let mut id = 0;
            let result = if kind.is_null() || reason.is_null() {
                -1
            } else {
                IOPMAssertionCreateWithName(kind, ASSERTION_LEVEL_ON, reason, &mut id)
            };
            for value in [kind, reason] {
                if !value.is_null() {
                    CFRelease(value);
                }
            }
            if result == 0 {
                Ok(id)
            } else {
                Err(format!("macOS refused the keep-awake assertion ({result})"))
            }
        }
    }

    pub(super) fn release(id: u32) {
        unsafe {
            IOPMAssertionRelease(id);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod power {
    pub(super) fn acquire() -> Result<u32, String> {
        Err("Keeping the computer awake is only available on macOS".into())
    }

    pub(super) fn release(_: u32) {}
}
