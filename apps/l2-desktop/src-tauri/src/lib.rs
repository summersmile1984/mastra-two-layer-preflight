use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

const DEFAULT_L1: &str = "https://mastra-l1.summersmile1984.workers.dev";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettings {
    pub l1_url: String,
    pub token: String,
    pub interval_ms: u64,
}

impl Default for DeviceSettings {
    fn default() -> Self {
        Self {
            l1_url: DEFAULT_L1.to_string(),
            token: String::new(),
            interval_ms: 2000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopStatus {
    pub running: bool,
    pub online: bool,
    pub last_claim_at: Option<String>,
    pub last_task_id: Option<String>,
    pub last_kind: Option<String>,
    pub last_state: Option<String>,
    pub last_summary: Option<String>,
    pub queue_hint: Option<String>,
    pub error: Option<String>,
    pub pid: Option<u32>,
}

impl Default for LoopStatus {
    fn default() -> Self {
        Self {
            running: false,
            online: false,
            last_claim_at: None,
            last_task_id: None,
            last_kind: None,
            last_state: None,
            last_summary: None,
            queue_hint: None,
            error: None,
            pid: None,
        }
    }
}

struct AppState {
    child: Mutex<Option<Child>>,
}

fn config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("mastra-l2")
}

fn device_path() -> PathBuf {
    config_dir().join("device.json")
}

fn status_path() -> PathBuf {
    config_dir().join("status.json")
}

fn read_device() -> DeviceSettings {
    let p = device_path();
    if !p.exists() {
        return DeviceSettings::default();
    }
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => DeviceSettings::default(),
    }
}

fn write_device(settings: &DeviceSettings) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(device_path(), raw).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_status_file() -> Option<LoopStatus> {
    let p = status_path();
    if !p.exists() {
        return None;
    }
    let s = fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn package_root(app: &tauri::AppHandle) -> PathBuf {
    // Dev: resource_dir is target/...; prefer CARGO_MANIFEST_DIR parent (= apps/l2-desktop)
    let from_env = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let pkg = from_env.parent().map(|p| p.to_path_buf());
    if let Some(p) = pkg {
        if p.join("src").join("main.ts").exists() {
            return p;
        }
    }
    app.path()
        .resource_dir()
        .ok()
        .and_then(|r| r.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resolve_tsx(pkg: &PathBuf) -> (String, Vec<String>) {
    // Prefer local node_modules/.bin/tsx, then npx tsx, then node --import tsx
    let local = pkg.join("node_modules").join(".bin").join("tsx");
    if local.exists() {
        return (local.to_string_lossy().to_string(), vec!["src/main.ts".into()]);
    }
    let npx = which("npx");
    if let Some(npx) = npx {
        return (npx, vec!["tsx".into(), "src/main.ts".into()]);
    }
    ("node".into(), vec!["--import".into(), "tsx".into(), "src/main.ts".into()])
}

fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(bin);
        if cand.is_file() {
            return Some(cand.to_string_lossy().to_string());
        }
    }
    // common mac homebrew / local
    for extra in [
        "/opt/homebrew/opt/node@24/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ] {
        let cand = PathBuf::from(extra).join(bin);
        if cand.is_file() {
            return Some(cand.to_string_lossy().to_string());
        }
    }
    None
}

#[tauri::command]
fn get_settings() -> DeviceSettings {
    read_device()
}

#[tauri::command]
fn save_settings(settings: DeviceSettings) -> Result<DeviceSettings, String> {
    let mut s = settings;
    s.l1_url = s.l1_url.trim_end_matches('/').to_string();
    if s.interval_ms < 1000 {
        s.interval_ms = 1000;
    }
    write_device(&s)?;
    Ok(s)
}

#[tauri::command]
fn get_loop_status(state: tauri::State<'_, AppState>) -> LoopStatus {
    let mut st = read_status_file().unwrap_or_default();
    let child_running = {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) => {
                    *guard = None;
                    false
                }
                Err(_) => false,
            }
        } else {
            false
        }
    };
    if child_running {
        st.running = true;
        if st.pid.is_none() {
            if let Ok(g) = state.child.lock() {
                if let Some(c) = g.as_ref() {
                    st.pid = Some(c.id());
                }
            }
        }
    } else if st.running && st.pid.is_some() {
        // status file may be stale after crash
        st.running = false;
        st.online = false;
    }
    st
}

#[tauri::command]
fn start_claim_loop(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<u32, String> {
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if let Ok(None) = child.try_wait() {
                return Ok(child.id());
            }
            *guard = None;
        }
    }

    let settings = read_device();
    if settings.token.trim().is_empty() {
        return Err("Device token is empty — save settings first".into());
    }

    let pkg = package_root(&app);
    let main_ts = pkg.join("src").join("main.ts");
    if !main_ts.exists() {
        return Err(format!("claim entry missing: {}", main_ts.display()));
    }

    let (bin, args) = resolve_tsx(&pkg);
    // ensure path relative to pkg
    if args.last().map(|s| s.as_str()) == Some("src/main.ts") {
        // ok
    }

    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .current_dir(&pkg)
        .env("L1_PULL_URL", &settings.l1_url)
        .env("PUSH_TOKEN", &settings.token)
        .env("L2_DEVICE_TOKEN", &settings.token)
        .env("L2_PULL_INTERVAL_MS", settings.interval_ms.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Help Node find tools on Mac
    let mut path = std::env::var("PATH").unwrap_or_default();
    for extra in [
        "/opt/homebrew/opt/node@24/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        &format!("{}/.local/bin", std::env::var("HOME").unwrap_or_default()),
        &format!("{}/.cargo/bin", std::env::var("HOME").unwrap_or_default()),
    ] {
        if !path.split(':').any(|p| p == extra) {
            path = format!("{}:{}", extra, path);
        }
    }
    cmd.env("PATH", path);

    let child = cmd.spawn().map_err(|e| format!("spawn claim loop failed ({bin}): {e}"))?;
    let pid = child.id();
    *state.child.lock().unwrap() = Some(child);

    // seed status
    let seed = LoopStatus {
        running: true,
        online: true,
        last_claim_at: None,
        last_task_id: None,
        last_kind: None,
        last_state: None,
        last_summary: Some(format!("started pid {pid}")),
        queue_hint: Some("starting".into()),
        error: None,
        pid: Some(pid),
    };
    let _ = fs::create_dir_all(config_dir());
    let _ = fs::write(status_path(), serde_json::to_string_pretty(&seed).unwrap_or_default());

    Ok(pid)
}

#[tauri::command]
fn stop_claim_loop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(guard);
    let prev = read_status_file().unwrap_or_default();
    let stopped = LoopStatus {
        running: false,
        online: false,
        last_claim_at: prev.last_claim_at,
        last_task_id: prev.last_task_id,
        last_kind: prev.last_kind,
        last_state: prev.last_state,
        last_summary: Some("stopped from UI".into()),
        queue_hint: Some("stopped".into()),
        error: None,
        pid: None,
    };
    let _ = fs::create_dir_all(config_dir());
    let _ = fs::write(status_path(), serde_json::to_string_pretty(&stopped).unwrap_or_default());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_loop_status,
            start_claim_loop,
            stop_claim_loop
        ])
        .setup(|app| {
            // Ensure config dir exists
            let _ = fs::create_dir_all(config_dir());
            let _ = app;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    let mut guard = state.child.lock().unwrap();
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Mastra Desktop");
}
