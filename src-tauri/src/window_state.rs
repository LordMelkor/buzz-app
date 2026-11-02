use serde::Deserialize;
use std::collections::HashMap;
use tauri::{Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, Window};
use tauri_plugin_window_state::{AppHandleExt, Builder, StateFlags, WindowExt};

pub(crate) fn builder() -> Builder {
    Builder::default()
        // Closing on macOS hides the window. Never persist that hidden state or
        // platform-owned decorations; a fresh launch must remain reachable.
        .with_state_flags(
            StateFlags::SIZE
                | StateFlags::POSITION
                | StateFlags::MAXIMIZED
                | StateFlags::FULLSCREEN,
        )
        .with_filter(|label| label == "main")
        // Restore geometry and validate reachability before entering a saved mode.
        .skip_initial_state("main")
}

// Called from app setup, after the configured main window has been created.
pub(crate) fn restore<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    if let Err(error) = restore_geometry(window) {
        eprintln!("Could not restore Buzz window geometry: {error}");
    }
    window.restore_state(StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)
}

// Read-only adapter for window-state 2.4.1's format: position is the outer
// origin, size is the client size, and maximized windows use prev_x/prev_y.
// Keep all required fields typed so corrupt state falls back just as it does
// in the plugin. The plugin remains the only writer and mode/lifecycle owner.
#[derive(Deserialize)]
struct SavedGeometry {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    #[serde(rename = "visible")]
    _visible: bool,
    #[serde(rename = "decorated")]
    _decorated: bool,
    #[serde(rename = "fullscreen")]
    _fullscreen: bool,
}

fn saved_geometry(bytes: &[u8], label: &str) -> Option<SavedGeometry> {
    serde_json::from_slice::<HashMap<String, SavedGeometry>>(bytes)
        .ok()?
        .remove(label)
        .filter(|state| state.width > 0 && state.height > 0)
}

fn restore_geometry<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let path = window
        .app_handle()
        .path()
        .app_config_dir()?
        .join(window.app_handle().filename());
    let Some(saved) = std::fs::read(path)
        .ok()
        .and_then(|bytes| saved_geometry(&bytes, window.label()))
    else {
        return Ok(());
    };
    let monitors = window.available_monitors()?;
    let areas: Vec<_> = monitors
        .iter()
        .map(|monitor| *monitor.work_area())
        .collect();
    let fallback = window
        .primary_monitor()?
        .map(|monitor| *monitor.work_area())
        .or_else(|| areas.first().copied());
    if let Some(fallback) = fallback {
        // Only the client-to-frame origin offset is needed. Linux's initial
        // outer_size is not reliable until its first configure event.
        let outer = window.outer_position()?;
        let inner = window.inner_position()?;
        let offset = PhysicalPosition::new(
            inner.x.saturating_sub(outer.x),
            inner.y.saturating_sub(outer.y),
        );
        // AppShell owns a 48 logical-pixel header on all desktop platforms.
        let header_height = (48.0 * window.scale_factor()?).ceil() as u32;
        let (position, size) = restore_request(&saved, offset, header_height, &areas, fallback);
        // Validate the requested geometry BEFORE sending it. Native setters
        // may apply asynchronously (Linux/macOS); getters can still report the
        // startup frame.
        window.set_size(size)?;
        window.set_position(position)?;
    }
    Ok(())
}

fn restore_request(
    saved: &SavedGeometry,
    client_offset: PhysicalPosition<i32>,
    header_height: u32,
    areas: &[PhysicalRect<i32, u32>],
    fallback: PhysicalRect<i32, u32>,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let position = if saved.maximized {
        PhysicalPosition::new(saved.prev_x, saved.prev_y)
    } else {
        PhysicalPosition::new(saved.x, saved.y)
    };
    let client = PhysicalRect {
        position: PhysicalPosition::new(
            position.x.saturating_add(client_offset.x),
            position.y.saturating_add(client_offset.y),
        ),
        size: PhysicalSize::new(saved.width, saved.height),
    };
    let target = reachable_client(client, header_height, areas, fallback).unwrap_or(client);
    (
        PhysicalPosition::new(
            target.position.x.saturating_sub(client_offset.x),
            target.position.y.saturating_sub(client_offset.y),
        ),
        target.size,
    )
}

fn reachable_client(
    client: PhysicalRect<i32, u32>,
    header_height: u32,
    areas: &[PhysicalRect<i32, u32>],
    fallback: PhysicalRect<i32, u32>,
) -> Option<PhysicalRect<i32, u32>> {
    let x = i64::from(client.position.x);
    let y = i64::from(client.position.y);
    let right = x + i64::from(client.size.width.saturating_sub(1));
    let bottom = y + i64::from(header_height.saturating_sub(1));
    // A header may span adjacent monitors. Both control regions must remain
    // reachable, but need not belong to the same monitor.
    let reachable = [(x, y), (right, y), (x, bottom), (right, bottom)]
        .into_iter()
        .all(|(x, y)| {
            areas.iter().any(|area| {
                x >= i64::from(area.position.x)
                    && y >= i64::from(area.position.y)
                    && x < i64::from(area.position.x) + i64::from(area.size.width)
                    && y < i64::from(area.position.y) + i64::from(area.size.height)
            })
        });
    if reachable {
        return None;
    }
    // Unlike any-corner intersection, this keeps the drag strip and both sets
    // of platform controls on-screen, including after removing an upper monitor.
    let size = PhysicalSize::new(
        client.size.width.min(fallback.size.width),
        client.size.height.min(fallback.size.height),
    );
    Some(PhysicalRect {
        position: PhysicalPosition::new(
            fallback
                .position
                .x
                .saturating_add(((fallback.size.width - size.width) / 2) as i32),
            fallback.position.y,
        ),
        size,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tauri::{
        plugin::Plugin,
        test::{mock_builder, mock_context, noop_assets, MockRuntime},
        Manager,
    };
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};

    fn rect(x: i32, y: i32, width: u32, height: u32) -> tauri::PhysicalRect<i32, u32> {
        tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(x, y),
            size: tauri::PhysicalSize::new(width, height),
        }
    }

    fn assert_frame(
        actual: Option<tauri::PhysicalRect<i32, u32>>,
        expected: Option<tauri::PhysicalRect<i32, u32>>,
    ) {
        assert_eq!(
            actual.map(|r| (r.position, r.size)),
            expected.map(|r| (r.position, r.size))
        );
    }

    #[test]
    fn partial_overlap_after_removing_upper_monitor_recovers_entire_header() {
        let laptop = rect(0, 25, 1440, 875);
        let saved = rect(100, -450, 960, 640);
        assert_frame(
            super::reachable_client(saved, 48, &[laptop], laptop),
            Some(rect(240, 25, 960, 640)),
        );
        let upper = rect(0, -900, 1440, 900);
        assert_frame(
            super::reachable_client(saved, 48, &[laptop, upper], laptop),
            None,
        );
    }

    #[test]
    fn reachable_geometry_is_unchanged_including_negative_coordinates() {
        let primary = rect(0, 25, 1440, 875);
        let left = rect(-1920, 0, 1920, 1080);
        for saved in [rect(100, 120, 960, 640), rect(-1800, 80, 960, 640)] {
            assert_frame(
                super::reachable_client(saved, 48, &[primary, left], primary),
                None,
            );
        }
    }

    #[test]
    fn side_overlap_and_menu_bar_occlusion_recover_controls_not_just_a_corner() {
        let area = rect(0, 25, 1440, 875);
        for saved in [
            rect(-600, 100, 960, 640),
            rect(1300, 100, 960, 640),
            rect(100, 0, 960, 640),
            rect(100, 860, 960, 640),
        ] {
            assert_frame(
                super::reachable_client(saved, 48, &[area], area),
                Some(rect(240, 25, 960, 640)),
            );
        }
    }

    #[test]
    fn oversized_window_fits_remaining_work_area_and_scaled_header_is_checked() {
        let area = rect(0, 50, 1440, 850);
        assert_frame(
            super::reachable_client(rect(0, 50, 2800, 1800), 96, &[area], area),
            Some(area),
        );
        assert_frame(
            super::reachable_client(rect(100, 820, 960, 640), 48, &[area], area),
            None,
        );
        assert_frame(
            super::reachable_client(rect(100, 820, 960, 640), 96, &[area], area),
            Some(rect(240, 50, 960, 640)),
        );
    }

    #[test]
    fn invisible_windows_frame_border_does_not_displace_edge_flush_client() {
        let area = rect(0, 0, 1920, 1040);
        let saved = decode(&saved_state(-7, 0, 1920, 1040));
        assert_eq!(
            super::restore_request(
                &saved,
                tauri::PhysicalPosition::new(7, 0),
                48,
                &[area],
                area
            ),
            (tauri::PhysicalPosition::new(-7, 0), area.size),
        );
    }

    #[test]
    fn header_can_span_adjacent_monitors_but_not_extend_above_either() {
        let left = rect(-1920, 0, 1920, 1080);
        let right = rect(0, 0, 1920, 1080);
        let spanning = rect(-480, 100, 960, 640);
        assert_frame(
            super::reachable_client(spanning, 48, &[left, right], right),
            None,
        );
        let below = rect(0, 300, 1920, 1080);
        assert_frame(
            super::reachable_client(spanning, 48, &[left, below], left),
            Some(rect(-1440, 0, 960, 640)),
        );
    }

    fn saved_state(x: i32, y: i32, width: u32, height: u32) -> Value {
        json!({"main": {
            "width": width, "height": height, "x": x, "y": y,
            "prev_x": x, "prev_y": y, "maximized": false,
            "fullscreen": false, "visible": false, "decorated": false
        }})
    }

    fn decode(state: &Value) -> super::SavedGeometry {
        super::saved_geometry(&serde_json::to_vec(state).unwrap(), "main").unwrap()
    }

    #[test]
    fn requested_geometry_is_safe_even_while_getters_still_report_startup_bounds() {
        let area = rect(0, 25, 1440, 875);
        let startup = rect(100, 120, 1200, 800);
        let completed = rect(100, -450, 960, 640);
        let saved = decode(&saved_state(100, -450, 960, 640));
        // The old post-set guard approves this stale, reachable startup frame.
        assert_frame(super::reachable_client(startup, 48, &[area], area), None);
        // The planner accepts no current bounds: they can be either startup or
        // completed bounds. Only the frame-to-client offset (zero for this
        // undecorated window) is used. The unsafe origin is never sent to GTK.
        let expected = (
            tauri::PhysicalPosition::new(240, 25),
            tauri::PhysicalSize::new(960, 640),
        );
        assert_frame(
            super::reachable_client(completed, 48, &[area], area),
            Some(rect(240, 25, 960, 640)),
        );
        let offset = tauri::PhysicalPosition::new(0, 0);
        assert_eq!(
            super::restore_request(&saved, offset, 48, &[area], area),
            expected
        );
        // Resize is asynchronous too: validating only startup width misses
        // the right-hand controls of a wider saved client.
        let saved = decode(&saved_state(100, 120, 1800, 800));
        assert_eq!(
            super::restore_request(&saved, offset, 48, &[area], area),
            (area.position, tauri::PhysicalSize::new(1440, 800)),
        );
    }

    #[test]
    fn requested_geometry_uses_client_size_and_normal_origin_for_saved_modes() {
        let area = rect(0, 0, 1920, 1040);
        let offset = tauri::PhysicalPosition::new(7, 0);
        let saved = decode(&saved_state(-7, 0, 1920, 1000));
        assert_eq!(
            super::restore_request(&saved, offset, 48, &[area], area),
            (
                tauri::PhysicalPosition::new(-7, 0),
                tauri::PhysicalSize::new(1920, 1000)
            ),
        );
        let mut state = saved_state(0, 0, 960, 640);
        state["main"]["maximized"] = json!(true);
        state["main"]["prev_x"] = json!(100);
        state["main"]["prev_y"] = json!(-450);
        assert_eq!(
            super::restore_request(&decode(&state), offset, 48, &[area], area),
            (
                tauri::PhysicalPosition::new(473, 0),
                tauri::PhysicalSize::new(960, 640)
            ),
        );
        // Fullscreen uses x/y, not prev_x/prev_y, matching the plugin format.
        state["main"]["maximized"] = json!(false);
        state["main"]["fullscreen"] = json!(true);
        assert_eq!(
            super::restore_request(&decode(&state), offset, 48, &[area], area),
            (
                tauri::PhysicalPosition::new(0, 0),
                tauri::PhysicalSize::new(960, 640)
            ),
        );
    }

    #[test]
    fn saved_geometry_matches_plugin_schema_and_rejects_invalid_snapshots() {
        let valid = saved_state(100, 120, 960, 640);
        let mut missing_mode = valid.clone();
        missing_mode["main"]
            .as_object_mut()
            .unwrap()
            .remove("fullscreen");
        let mut invalid_other_window = valid.clone();
        invalid_other_window["other"] = json!({"width": 960});
        let mut wrong_type = valid.clone();
        wrong_type["main"]["maximized"] = json!("false");
        for state in [
            json!({}),
            json!(null),
            missing_mode,
            invalid_other_window,
            wrong_type,
            saved_state(0, 0, 0, 0),
        ] {
            assert!(super::saved_geometry(&serde_json::to_vec(&state).unwrap(), "main").is_none());
        }
        assert!(super::saved_geometry(b"not json", "main").is_none());
        assert!(super::saved_geometry(&serde_json::to_vec(&valid).unwrap(), "other").is_none());
        assert!(super::saved_geometry(&serde_json::to_vec(&valid).unwrap(), "main").is_some());
    }

    fn fixture() -> (tempfile::TempDir, tauri::App<MockRuntime>) {
        let dir = tempfile::tempdir().unwrap();
        let mut context = mock_context(noop_assets());
        // Absolute identifiers keep the plugin's real config-file IO inside the
        // fixture without changing process-global HOME or touching user state.
        context.config_mut().identifier = dir.path().to_string_lossy().into_owned();
        let app = mock_builder().build(context).unwrap();
        assert_eq!(app.path().app_config_dir().unwrap(), dir.path());
        (dir, app)
    }

    #[test]
    fn exit_saves_only_the_main_window() {
        let (dir, app) = fixture();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        for label in ["main", "other"] {
            let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap()
                .as_ref()
                .window();
            plugin.window_created(window.clone());
            if label == "main" {
                super::restore(&window).unwrap();
            }
        }
        plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
        let state: Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(state.as_object().unwrap().len(), 1);
        assert!(state.get("main").is_some());
    }

    #[test]
    fn reload_keeps_geometry_without_restoring_visibility_or_decorations() {
        let (dir, app) = fixture();
        let path = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
        let saved = json!({"main": {
            "width": 960, "height": 640, "x": 100, "y": 120,
            "prev_x": 100, "prev_y": 120, "maximized": true,
            "fullscreen": true, "visible": false, "decorated": false
        }});
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        plugin.window_created(view.as_ref().window().clone());
        super::restore(&view.as_ref().window()).unwrap();
        app.handle().save_window_state(StateFlags::empty()).unwrap();
        let loaded: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded, saved);

        // MockRuntime reports false modes, true visibility/decorations, zero
        // size/position. Exit must update modes/position, keep the last nonzero
        // size, and leave visibility/decorations alone. Native restore itself
        // needs OS acceptance: MockRuntime's geometry setters are no-ops.
        plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
        let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["main"]["width"], 960);
        assert_eq!(stored["main"]["height"], 640);
        assert_eq!(stored["main"]["x"], 0);
        assert_eq!(stored["main"]["y"], 0);
        assert_eq!(stored["main"]["maximized"], false);
        assert_eq!(stored["main"]["fullscreen"], false);
        assert_eq!(stored["main"]["visible"], false);
        assert_eq!(stored["main"]["decorated"], false);
        // Parse an actual plugin-produced snapshot, not just our handwritten fixture.
        let geometry = super::saved_geometry(&std::fs::read(&path).unwrap(), "main").unwrap();
        assert_eq!(
            (geometry.width, geometry.height, geometry.x, geometry.y),
            (960, 640, 0, 0)
        );
    }

    #[test]
    fn missing_or_corrupt_state_does_not_block_window_creation() {
        for contents in [None, Some("not json")] {
            let (dir, app) = fixture();
            let path = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
            if let Some(contents) = contents {
                std::fs::write(&path, contents).unwrap();
            }
            let mut plugin = super::builder().build();
            plugin.initialize(app.handle(), Value::Null).unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap()
                .as_ref()
                .window();
            plugin.window_created(window.clone());
            super::restore(&window).unwrap();
            plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
            let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(state.get("main").is_some());
        }
    }
}
