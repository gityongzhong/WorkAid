// WorkAid v3 · Tauri 后端（Rust）
//
// 职责边界（重要）：
//   本文件**只做进程与文件系统的事**，不含任何转换/图像处理逻辑。
//   所有业务逻辑都在 Python 侧（converters.py），通过 workaid-cli.exe 调用。
//
// 通道：前端 WebView2 --invoke--> 本模块 --子进程--> workaid-cli.exe --JSON--> 前端

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 解析转换引擎路径：环境变量 WORKAID_CLI 优先，其次 exe 同目录，最后 PATH。
fn resolve_cli() -> PathBuf {
    if let Ok(p) = std::env::var("WORKAID_CLI") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join("workaid-cli").join("workaid-cli.exe");
            if cand.exists() {
                return cand;
            }
            let cand2 = dir.join("workaid-cli.exe");
            if cand2.exists() {
                return cand2;
            }
        }
    }
    PathBuf::from("workaid-cli")
}

/// 当前 exe 所在目录（引擎的标准位置就在这里）。
fn app_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
}

/// 引擎探活详情：不仅给出最终路径，还把「按顺序找过哪些地方」一并返回。
///
/// 为什么需要（v3.2.0）：普通用户遇到「未检测到转换引擎」完全无从下手。
/// 前端拿 candidates 直接列给用户看，他自己对照一下 exe 旁边有没有
/// workaid-cli 文件夹就能定位问题，省掉一轮人工答疑。
fn probe_cli() -> Value {
    let mut candidates: Vec<Value> = Vec::new();
    let app = app_dir();

    // ① 环境变量 WORKAID_CLI（优先级最高，给「引擎放在别处」的场景留口子）
    if let Ok(p) = std::env::var("WORKAID_CLI") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            let pb = PathBuf::from(&p);
            let ok = pb.exists();
            candidates.push(serde_json::json!({
                "from": "环境变量 WORKAID_CLI",
                "path": pb.display().to_string(),
                "exists": ok,
            }));
            if ok {
                return serde_json::json!({
                    "engine": pb.display().to_string(),
                    "exists": true,
                    "source": "环境变量 WORKAID_CLI",
                    "app_dir": app.as_ref().map(|d| d.display().to_string()).unwrap_or_default(),
                    "candidates": candidates,
                });
            }
        }
    }

    // ② 程序目录（绿色版的标准布局）
    if let Some(dir) = &app {
        let tries: [(&str, &str); 2] = [
            ("workaid-cli/workaid-cli.exe", "程序目录\\workaid-cli\\"),
            ("workaid-cli.exe", "程序目录（与 exe 同层）"),
        ];
        for (rel, label) in tries {
            let cand = dir.join(rel);
            let ok = cand.exists();
            candidates.push(serde_json::json!({
                "from": label,
                "path": cand.display().to_string(),
                "exists": ok,
            }));
            if ok {
                return serde_json::json!({
                    "engine": cand.display().to_string(),
                    "exists": true,
                    "source": label,
                    "app_dir": dir.display().to_string(),
                    "candidates": candidates,
                });
            }
        }
    }

    // ③ 最后退回 PATH（不做预检，交给 Command 自己查；开发者可选方式）
    candidates.push(serde_json::json!({
        "from": "系统 PATH（可选）",
        "path": "workaid-cli".to_string(),
        "exists": false,
        "note": "开发者可把 workaid-cli 加入 PATH，普通用户无需关心",
    }));

    serde_json::json!({
        "engine": "workaid-cli",
        "exists": false,
        "source": "未找到",
        "app_dir": app.as_ref().map(|d| d.display().to_string()).unwrap_or_default(),
        "candidates": candidates,
    })
}

/// 从子进程 stdout 里取最后一行可解析的 JSON（前面可能夹着 progress 行）。
fn last_json(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
}

/// 构造一个「不可见」的子进程命令。
///
/// 【务必保留 CREATE_NO_WINDOW —— 所有 spawn workaid-cli 的地方都必须走这里】
/// 本程序是 GUI 子程序（windows_subsystem = "windows"），自身没有控制台；
/// 但 workaid-cli.exe 是控制台程序 —— 若不加 CREATE_NO_WINDOW，Windows 会为
/// 新子进程分配一个控制台窗口，表现为「每次转换都闪出一个黑色命令行窗口」。
/// 子进程输出全部通过管道读取，不需要也不该有任何可见窗口。
///
/// 【务必保留 PYTHONIOENCODING=utf-8】Windows 管道模式下 Python stdio 默认是
/// ANSI 代码页（中文系统 = GBK），而本侧按 UTF-8 解码 → JSON 中文乱码
/// （v3.0.2 实际事故）。新 CLI 已在源码里 reconfigure(utf-8)，此环境变量
/// 是双保险：即使 exe 与新 Rust 混用（旧引擎 + 新壳）也不会再乱码。
fn cli_command(cli: &Path) -> Command {
    let mut cmd = Command::new(cli);
    cmd.env("PYTHONIOENCODING", "utf-8");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 调一次转换引擎，返回统一结构。
fn exec_cli(action: &str, params: &Value) -> Result<Value, String> {
    let cli = resolve_cli();
    let payload = serde_json::to_string(params).map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();

    let output = cli_command(&cli)
        .arg(action)
        .arg("--json")
        .arg(&payload)
        .output()
        .map_err(|e| format!("无法启动转换引擎 {}：{}", cli.display(), e))?;

    let ms = started.elapsed().as_millis() as u64;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    Ok(serde_json::json!({
        "engine": cli.display().to_string(),
        "action": action,
        "exit_code": output.status.code(),
        "elapsed_ms": ms,
        "result": last_json(&stdout),
        "raw_stdout": stdout.trim_end(),
        "stderr": stderr.trim_end(),
    }))
}

// ---------------------------------------------------------------- 命令

/// 引擎自描述：返回 10 个动作及必填参数，前端据此校验与展示。
#[tauri::command]
fn engine_actions() -> Result<Value, String> {
    let cli = resolve_cli();
    let started = std::time::Instant::now();
    let output = cli_command(&cli)
        .arg("--list")
        .output()
        .map_err(|e| format!("无法启动转换引擎 {}：{}", cli.display(), e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = last_json(&stdout);

    Ok(serde_json::json!({
        "available": parsed.is_some(),
        "engine": cli.display().to_string(),
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "actions": parsed
            .as_ref()
            .and_then(|v| v.get("actions"))
            .cloned()
            .unwrap_or(Value::Array(vec![])),
        "stderr": String::from_utf8_lossy(&output.stderr).trim_end(),
    }))
}

/// 探活：引擎路径 + 一次极轻量的自描述调用，用于侧栏底部状态灯。
/// 缺失时同时返回查找过的候选路径，供前端「引擎缺失」引导弹窗展示。
#[tauri::command]
fn engine_status() -> Value {
    let mut v = probe_cli();
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "claude_note".to_string(),
            serde_json::json!("仅表示引擎文件是否存在；实际可用性由每次调用的结果决定"),
        );
    }
    v
}

/// 通用动作调用：前端「转换」按钮走这里。
#[tauri::command]
fn run_action(action: String, params: Value) -> Result<Value, String> {
    exec_cli(&action, &params)
}

/// 给命令加 CREATE_NO_WINDOW（仅 Windows 生效）。
///
/// 与 cli_command 同一目的：GUI 子程序 spawn 任何子进程都不该带出可见窗口。
/// explorer / open / xdg-open 本身是 GUI 程序，正常不会弹控制台；
/// 但若路径异常或系统把启动器换成命令行实现，没有这个标志就会闪黑窗。
/// 统一加上，宁可多余不可遗漏。
#[allow(unused_mut, unused_variables)]
fn no_window(mut cmd: Command) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 在系统文件管理器里打开路径（输出目录 / 输出文件）。
///
/// 只允许打开存在的路径；Windows 用 explorer，macOS 用 open，Linux 用 xdg-open。
#[tauri::command]
fn open_path(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{}", path));
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        // explorer 选中文件需要 /select,<file>
        if p.is_file() {
            c.arg(format!("/select,{}", p.display()));
        } else {
            c.arg(p.display().to_string());
        }
        no_window(c)
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        if p.is_file() {
            c.arg("-R");
        }
        c.arg(p.display().to_string());
        no_window(c)
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(p.display().to_string());
        no_window(c)
    };

    cmd.spawn().map_err(|e| format!("打开失败：{}", e))?;
    Ok(serde_json::json!({ "ok": true, "path": path }))
}

/// 用系统默认浏览器打开 http/https 链接（目前用于跳转项目 GitHub 主页）。
///
/// 只放行 http/https，避免被前端任意协议（如 file:）滥用。
#[tauri::command]
fn open_url(url: String) -> Result<Value, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("只支持 http/https 链接：{}", url));
    }

    #[cfg(target_os = "windows")]
    // rundll32 走 ShellExecute，无需额外依赖；start 是 cmd 内建命令，.spawn() 找不到
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(&url);
        no_window(c)
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        no_window(c)
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        no_window(c)
    };

    cmd.spawn().map_err(|e| format!("打开链接失败：{}", e))?;
    Ok(serde_json::json!({ "ok": true, "url": url }))
}

/// 展开一组路径：目录 → 其下按扩展名过滤的文件（不递归子目录外的内容）。
///
/// 拖入文件夹时前端只拿到目录路径，需要后端做一次展开。
#[tauri::command]
fn expand_paths(paths: Vec<String>, exts: Vec<String>) -> Value {
    let exts: Vec<String> = exts.iter().map(|e| e.to_lowercase()).collect();
    let mut files: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    fn match_ext(p: &Path, exts: &[String]) -> bool {
        if exts.is_empty() {
            return true;
        }
        match p.extension() {
            Some(e) => exts.contains(&format!(".{}", e.to_string_lossy().to_lowercase())),
            None => false,
        }
    }

    fn walk(dir: &Path, exts: &[String], out: &mut Vec<String>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.filter_map(|x| x.ok()) {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, exts, out);
                } else if match_ext(&p, exts) {
                    out.push(p.display().to_string());
                }
            }
        }
    }

    for raw in &paths {
        let p = PathBuf::from(raw);
        if p.is_dir() {
            walk(&p, &exts, &mut files);
        } else if p.is_file() {
            if match_ext(&p, &exts) {
                files.push(p.display().to_string());
            } else {
                skipped.push(raw.clone());
            }
        } else {
            skipped.push(raw.clone());
        }
    }

    serde_json::json!({
        "files": files,
        "skipped": skipped,
        "count": files.len(),
    })
}

/// 读文件的基本元信息（大小 / 修改时间），用于列表的「大小」列。
#[tauri::command]
fn file_meta(path: String) -> Value {
    let p = PathBuf::from(&path);
    match std::fs::metadata(&p) {
        Ok(m) => {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            serde_json::json!({
                "ok": true,
                "path": path,
                "name": p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                "dir": p.parent().map(|s| s.display().to_string()).unwrap_or_default(),
                "ext": p.extension().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default(),
                "size": m.len(),
                "is_file": m.is_file(),
                "modified": modified,
            })
        }
        Err(e) => serde_json::json!({ "ok": false, "path": path, "error": e.to_string() }),
    }
}

/// 批量取元信息（列表一次刷新，避免 N 次 invoke 往返）。
#[tauri::command]
fn file_meta_many(paths: Vec<String>) -> Value {
    let items: Vec<Value> = paths
        .iter()
        .map(|p| {
            let path = PathBuf::from(p);
            match std::fs::metadata(&path) {
                Ok(m) => serde_json::json!({
                    "ok": true,
                    "path": p,
                    "name": path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                    "dir": path.parent().map(|s| s.display().to_string()).unwrap_or_default(),
                    "ext": path.extension().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default(),
                    "size": m.len(),
                    "is_file": m.is_file(),
                }),
                Err(e) => serde_json::json!({ "ok": false, "path": p, "name": Path::new(p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), "error": e.to_string() }),
            }
        })
        .collect();
    Value::Array(items)
}

/// 批量重命名（图片重命名页专用，纯文件系统操作）。
///
/// items 的 to 是**文件名**（不是完整路径），目标目录取 from 所在目录。
/// 返回与输入等长的 results 数组（done / conflict / error 三态），
/// 前端按 index 对齐列表状态徽章。
/// 冲突检测：目标已存在且不是自身（Windows 仅大小写改名时目标"存在"就是自身，
/// fs::rename 对仅大小写差异会成功，放行）。
#[derive(serde::Deserialize)]
struct RenameItem {
    from: String,
    to: String,
}

#[tauri::command]
fn rename_files(items: Vec<RenameItem>) -> Value {
    use serde_json::json;

    let mut results: Vec<Value> = Vec::with_capacity(items.len());

    for it in &items {
        let from = PathBuf::from(&it.from);
        let dir = match from.parent() {
            Some(d) => d.to_path_buf(),
            None => {
                results.push(json!({
                    "ok": false, "kind": "error",
                    "to": it.to, "message": "无法解析所在目录"
                }));
                continue;
            }
        };
        let to = dir.join(&it.to);

        // 仅大小写不同的"改名"：目标与源是同一文件，放行
        let same_file = from.exists()
            && to.exists()
            && std::fs::canonicalize(&from)
                .ok()
                .zip(std::fs::canonicalize(&to).ok())
                .map(|(a, b)| a == b)
                .unwrap_or(false);

        if to.exists() && !same_file {
            results.push(json!({
                "ok": false, "kind": "conflict",
                "to": it.to, "message": "目标文件名已存在"
            }));
            continue;
        }

        match std::fs::rename(&from, &to) {
            Ok(_) => results.push(json!({
                "ok": true, "kind": "done",
                "to": it.to, "message": null
            })),
            Err(e) => results.push(json!({
                "ok": false, "kind": "error",
                "to": it.to, "message": e.to_string()
            })),
        }
    }

    let done_count = results.iter().filter(|r| r["ok"] == true).count();
    serde_json::json!({
        "ok": done_count == results.len(),
        "done_count": done_count,
        "conflict_count": results.iter().filter(|r| r["kind"] == "conflict").count(),
        "error_count": results.iter().filter(|r| r["kind"] == "error").count(),
        "results": results,
    })
}

/// 应用元信息（标题栏 / 侧栏底部展示）。
#[tauri::command]
fn app_info() -> Value {
    serde_json::json!({
        "name": "WorkAid",
        "version": "3.3.1",
        "tauri": "2.x",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            engine_actions,
            engine_status,
            run_action,
            open_path,
            open_url,
            expand_paths,
            file_meta,
            file_meta_many,
            rename_files,
            app_info
        ])
        .run(tauri::generate_context!())
        .expect("WorkAid 启动失败");
}
