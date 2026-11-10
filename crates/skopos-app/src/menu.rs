//! The macOS menu bar (spec C §9.2). The layout is plain data that every platform
//! builds and tests; only `install` turns it into a Tauri menu, on macOS.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// The ids of the app items. Selecting one emits `menu://command` with `{ id }`.
pub const APP_COMMANDS: [&str; 4] = ["about", "preferences", "palette", "shortcuts"];
pub const MENU_EVENT: &str = "menu://command";

/// The Tauri predefined items the menu uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredefinedItem {
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Zoom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuEntry {
    App {
        id: &'static str,
        label: &'static str,
        accelerator: Option<&'static str>,
    },
    Predefined(PredefinedItem, &'static str),
    Separator,
}

pub struct MenuSpec {
    pub title: &'static str,
    pub entries: Vec<MenuEntry>,
}

/// The menus of §9.2, in order. There is no Close Window: ⌘W would close the only
/// window and quit.
pub fn menu_layout() -> Vec<MenuSpec> {
    use MenuEntry::{App, Predefined as P, Separator};
    use PredefinedItem as I;
    vec![
        MenuSpec {
            title: "SkoposIDE",
            entries: vec![
                App {
                    id: "about",
                    label: "About SkoposIDE",
                    accelerator: None,
                },
                Separator,
                App {
                    id: "preferences",
                    label: "Settings…",
                    accelerator: Some("CmdOrCtrl+,"),
                },
                Separator,
                P(I::Services, "Services"),
                Separator,
                P(I::Hide, "Hide SkoposIDE"),
                P(I::HideOthers, "Hide Others"),
                P(I::ShowAll, "Show All"),
                Separator,
                P(I::Quit, "Quit SkoposIDE"),
            ],
        },
        MenuSpec {
            title: "Edit",
            entries: vec![
                P(I::Undo, "Undo"),
                P(I::Redo, "Redo"),
                Separator,
                P(I::Cut, "Cut"),
                P(I::Copy, "Copy"),
                P(I::Paste, "Paste"),
                P(I::SelectAll, "Select All"),
            ],
        },
        MenuSpec {
            title: "View",
            entries: vec![
                App {
                    id: "palette",
                    label: "Command Palette",
                    accelerator: Some("CmdOrCtrl+Shift+P"),
                },
                Separator,
                P(I::Fullscreen, "Enter Full Screen"),
            ],
        },
        MenuSpec {
            title: "Window",
            entries: vec![P(I::Minimize, "Minimize"), P(I::Zoom, "Zoom")],
        },
        MenuSpec {
            title: "Help",
            entries: vec![App {
                id: "shortcuts",
                label: "Keyboard Shortcuts",
                accelerator: Some("CmdOrCtrl+/"),
            }],
        },
    ]
}

/// Builds the layout into the app's menu bar and forwards the app items to the UI.
/// Quit is the predefined item, so it takes the normal exit path and
/// `core.shutdown()` runs.
#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::Emitter;

    let menu = Menu::new(app)?;
    for spec in menu_layout() {
        let submenu = Submenu::new(app, spec.title, true)?;
        for entry in spec.entries {
            match entry {
                MenuEntry::App {
                    id,
                    label,
                    accelerator,
                } => submenu.append(&MenuItem::with_id(app, id, label, true, accelerator)?)?,
                MenuEntry::Separator => submenu.append(&PredefinedMenuItem::separator(app)?)?,
                MenuEntry::Predefined(item, label) => {
                    submenu.append(&predefined(app, item, label)?)?
                }
            }
        }
        menu.append(&submenu)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if APP_COMMANDS.contains(&id) {
            if let Err(error) = app.emit(MENU_EVENT, serde_json::json!({ "id": id })) {
                tracing::warn!("menu command {id} not sent: {error}");
            }
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn predefined(
    app: &tauri::AppHandle,
    item: PredefinedItem,
    label: &str,
) -> tauri::Result<tauri::menu::PredefinedMenuItem<tauri::Wry>> {
    use tauri::menu::PredefinedMenuItem as P;
    let text = Some(label);
    match item {
        PredefinedItem::Services => P::services(app, text),
        PredefinedItem::Hide => P::hide(app, text),
        PredefinedItem::HideOthers => P::hide_others(app, text),
        PredefinedItem::ShowAll => P::show_all(app, text),
        PredefinedItem::Quit => P::quit(app, text),
        PredefinedItem::Undo => P::undo(app, text),
        PredefinedItem::Redo => P::redo(app, text),
        PredefinedItem::Cut => P::cut(app, text),
        PredefinedItem::Copy => P::copy(app, text),
        PredefinedItem::Paste => P::paste(app, text),
        PredefinedItem::SelectAll => P::select_all(app, text),
        PredefinedItem::Fullscreen => P::fullscreen(app, text),
        PredefinedItem::Minimize => P::minimize(app, text),
        PredefinedItem::Zoom => P::maximize(app, text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(spec: &MenuSpec) -> Vec<&'static str> {
        spec.entries
            .iter()
            .map(|entry| match entry {
                MenuEntry::App { label, .. } | MenuEntry::Predefined(_, label) => *label,
                MenuEntry::Separator => "-",
            })
            .collect()
    }

    #[test]
    fn menus_and_items_read_as_the_spec_draws_them() {
        let layout = menu_layout();
        let read: Vec<(&str, Vec<&str>)> = layout.iter().map(|m| (m.title, labels(m))).collect();
        assert_eq!(
            read,
            vec![
                (
                    "SkoposIDE",
                    vec![
                        "About SkoposIDE",
                        "-",
                        "Settings…",
                        "-",
                        "Services",
                        "-",
                        "Hide SkoposIDE",
                        "Hide Others",
                        "Show All",
                        "-",
                        "Quit SkoposIDE",
                    ]
                ),
                (
                    "Edit",
                    vec!["Undo", "Redo", "-", "Cut", "Copy", "Paste", "Select All"]
                ),
                ("View", vec!["Command Palette", "-", "Enter Full Screen"]),
                ("Window", vec!["Minimize", "Zoom"]),
                ("Help", vec!["Keyboard Shortcuts"]),
            ]
        );
    }

    #[test]
    fn app_items_carry_their_ids_and_accelerators() {
        let apps: Vec<(&str, Option<&str>)> = menu_layout()
            .into_iter()
            .flat_map(|m| m.entries)
            .filter_map(|entry| match entry {
                MenuEntry::App {
                    id, accelerator, ..
                } => Some((id, accelerator)),
                _ => None,
            })
            .collect();
        assert_eq!(
            apps,
            vec![
                ("about", None),
                ("preferences", Some("CmdOrCtrl+,")),
                ("palette", Some("CmdOrCtrl+Shift+P")),
                ("shortcuts", Some("CmdOrCtrl+/")),
            ]
        );
        for (id, _) in apps {
            assert!(APP_COMMANDS.contains(&id), "{id} is not sent to the UI");
        }
    }

    #[test]
    fn the_rest_are_system_items() {
        let items: Vec<PredefinedItem> = menu_layout()
            .into_iter()
            .flat_map(|m| m.entries)
            .filter_map(|entry| match entry {
                MenuEntry::Predefined(item, _) => Some(item),
                _ => None,
            })
            .collect();
        assert_eq!(
            items,
            vec![
                PredefinedItem::Services,
                PredefinedItem::Hide,
                PredefinedItem::HideOthers,
                PredefinedItem::ShowAll,
                PredefinedItem::Quit,
                PredefinedItem::Undo,
                PredefinedItem::Redo,
                PredefinedItem::Cut,
                PredefinedItem::Copy,
                PredefinedItem::Paste,
                PredefinedItem::SelectAll,
                PredefinedItem::Fullscreen,
                PredefinedItem::Minimize,
                PredefinedItem::Zoom,
            ]
        );
    }
}
