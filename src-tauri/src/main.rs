// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use postgres::{Client, NoTls};
use tauri::{Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, CustomMenuItem};
use std::time::Duration;
use std::sync::Mutex;
use tokio::time::sleep;

struct AppState {
    // Em uma versão completa, isso viria de um DB local / config file
    db_config: Mutex<Option<(String, String, String, String, String)>>,
    server_on: Mutex<bool>,
}

#[tauri::command]
fn test_connection(host: &str, port: &str, db: &str, user: &str, pass: &str, state: tauri::State<AppState>) -> Result<String, String> {
    let conn_str = format!("host={} port={} dbname={} user={} password={}", host, port, db, user, pass);
    
    match Client::connect(&conn_str, NoTls) {
        Ok(mut client) => {
            match client.query("SELECT 1", &[]) {
                Ok(_) => {
                    // Salvar config na memória (ou DB)
                    let mut config = state.db_config.lock().unwrap();
                    *config = Some((host.to_string(), port.to_string(), db.to_string(), user.to_string(), pass.to_string()));
                    
                    let mut on = state.server_on.lock().unwrap();
                    *on = true;
                    
                    Ok("ok".into())
                },
                Err(e) => Err(format!("Falha na query: {}", e)),
            }
        }
        Err(e) => Err(format!("Falha ao conectar: {}", e)),
    }
}

#[cfg(target_os = "windows")]
fn get_pg_dump_path() -> String {
    use std::path::Path;
    // Check common PostgreSQL installation paths on Windows
    let common_versions = ["17", "16", "15", "14", "13", "12", "11", "10"];
    for version in common_versions.iter() {
        let path = format!("C:\\Program Files\\PostgreSQL\\{}\\bin\\pg_dump.exe", version);
        if Path::new(&path).exists() {
            return path;
        }
        let path_x86 = format!("C:\\Program Files (x86)\\PostgreSQL\\{}\\bin\\pg_dump.exe", version);
        if Path::new(&path_x86).exists() {
            return path_x86;
        }
    }
    // Fallback to system PATH
    "pg_dump".to_string()
}

#[cfg(not(target_os = "windows"))]
fn get_pg_dump_path() -> String {
    "pg_dump".to_string()
}

#[tauri::command]
fn execute_backup(host: &str, port: &str, db: &str, user: &str, pass: &str, dest: &str, custom_pg_dump_path: Option<String>) -> Result<f64, String> {
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::fs;
    
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let filename = format!("backup_{}_{}.sql", db, timestamp);
    let filepath = std::path::Path::new(dest).join(&filename);
    let filepath_str = filepath.to_str().unwrap();

    let pg_dump_cmd = match custom_pg_dump_path {
        Some(path) if !path.trim().is_empty() => path,
        _ => get_pg_dump_path(),
    };

    let output = Command::new(&pg_dump_cmd)
        .env("PGPASSWORD", pass)
        .arg("-h").arg(host)
        .arg("-p").arg(port)
        .arg("-U").arg(user)
        .arg("-F").arg("p") // p = plain (SQL)
        .arg("-f").arg(filepath_str)
        .arg(db)
        .output();

    match output {
        Ok(out) => {
            if out.status.success() {
                if let Ok(metadata) = fs::metadata(&filepath) {
                    let size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
                    Ok(size_mb)
                } else {
                    Ok(0.0)
                }
            } else {
                let err = String::from_utf8_lossy(&out.stderr);
                Err(format!("Erro no pg_dump: {}", err))
            }
        }
        Err(e) => Err(format!("Falha ao iniciar pg_dump (instale o postgresql-client): {}", e))
    }
}

#[tauri::command]
fn cleanup_old_backups(dest: &str, days: u64) -> Result<u64, String> {
    use std::fs;
    use std::time::SystemTime;

    let path = std::path::Path::new(dest);
    if !path.exists() {
        return Ok(0);
    }

    let mut deleted_count = 0;
    let now = SystemTime::now();
    let max_age = std::time::Duration::from_secs(days * 24 * 60 * 60);

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(age) = now.duration_since(modified) {
                        if age > max_age {
                            let filepath = entry.path();
                            if let Some(ext) = filepath.extension() {
                                if ext == "sql" {
                                    if fs::remove_file(&filepath).is_ok() {
                                        deleted_count += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(deleted_count)
}

#[tauri::command]
fn get_database_tables(host: &str, port: &str, db: &str, user: &str, pass: &str) -> Result<Vec<String>, String> {
    use postgres::{Client, NoTls};
    let conn_str = format!("host={} port={} dbname={} user={} password={}", host, port, db, user, pass);
    
    match Client::connect(&conn_str, NoTls) {
        Ok(mut client) => {
            let query = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;";
            match client.query(query, &[]) {
                Ok(rows) => {
                    let mut tables = Vec::new();
                    for row in rows {
                        let table_name: String = row.get(0);
                        tables.push(table_name);
                    }
                    Ok(tables)
                },
                Err(e) => Err(format!("Falha ao buscar tabelas: {}", e)),
            }
        }
        Err(e) => Err(format!("Falha ao conectar: {}", e)),
    }
}

#[tauri::command]
fn get_table_data(host: &str, port: &str, db: &str, user: &str, pass: &str, table: &str) -> Result<String, String> {
    use postgres::{Client, NoTls};
    let conn_str = format!("host={} port={} dbname={} user={} password={}", host, port, db, user, pass);
    
    if !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Nome de tabela inválido".into());
    }

    match Client::connect(&conn_str, NoTls) {
        Ok(mut client) => {
            let query = format!("SELECT COALESCE(json_agg(t)::text, '[]') FROM (SELECT * FROM \"{}\" LIMIT 50) t;", table);
            match client.query(&query, &[]) {
                Ok(rows) => {
                    if let Some(row) = rows.get(0) {
                        let json_data: String = row.get(0);
                        Ok(json_data)
                    } else {
                        Ok("[]".into())
                    }
                },
                Err(e) => Err(format!("Falha ao buscar dados: {}", e)),
            }
        }
        Err(e) => Err(format!("Falha ao conectar: {}", e)),
    }
}

fn main() {
    let show = CustomMenuItem::new("show".to_string(), "Abrir Painel");
    let quit = CustomMenuItem::new("quit".to_string(), "Sair do Backup Manager");
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_item(quit);
        
    let tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(window) = app.get_window("main") {
                window.show().unwrap();
                window.unminimize().unwrap();
                window.set_focus().unwrap();
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(AppState {
            db_config: Mutex::new(None),
            server_on: Mutex::new(false),
        })
        .system_tray(tray)
        .on_system_tray_event(|app: &tauri::AppHandle, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => {
                match id.as_str() {
                    "quit" => {
                        std::process::exit(0);
                    }
                    "show" => {
                        let window = app.get_window("main").unwrap();
                        window.show().unwrap();
                        window.set_focus().unwrap();
                    }
                    _ => {}
                }
            }
            _ => {}
        })
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                event.window().hide().unwrap();
                api.prevent_close();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![test_connection, execute_backup, cleanup_old_backups, get_database_tables, get_table_data])
        .setup(|app: &mut tauri::App| -> Result<(), Box<dyn std::error::Error>> {
            // Enable autostart automatically
            use tauri_plugin_autostart::ManagerExt;
            let autostart_manager = app.autolaunch();
            let _ = autostart_manager.enable();

            // Inicializar a thread de background
            let app_handle = app.handle();
            tauri::async_runtime::spawn(async move {
                loop {
                    sleep(Duration::from_secs(60)).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Previne que a aplicação morra ao fechar a janela
                api.prevent_exit();
            }
            _ => {}
        });
}

