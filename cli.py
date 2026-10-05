"""WorkAid 转换器命令行接口（供 Tauri / 任何外部程序调用）。

设计原则
--------
- **完全复用 converters.py**，本文件不含任何转换逻辑，只做「参数解析 + 调用 + 结果序列化」。
- 单一入口：`workaid-cli <action> --json '<json obj>'`，或从 stdin 读 JSON。
- 所有结果以**单行 JSON** 打到 stdout，便于 Rust 侧直接 parse；日志走 stderr。
- 退出码语义：0=成功(ok) / 1=业务失败(error) / 2=用法错误 / 3=内部异常。
  调用方既可以读 JSON 的 state 字段，也可以只看退出码。
- 支持 `--progress-json`：把进度回调转成 stdout 的 JSON 行（供前端实时显示）。

用法示例
--------
    workaid-cli pdf-to-images --json '{"pdf_file":"D:/a.pdf","out_dir":"D:/out","zoom":2.0,"fmt":"png"}'
    workaid-cli list-actions
    echo '{"pdf_file":...}' | workaid-cli merge-pdfs
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

# 让脚本无论从哪个 cwd 启动都能 import 同目录的 converters
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 【v3.0.3 必须保留】stdio 强制 UTF-8。
# Windows 管道模式下 Python 的 stdout/stderr 默认用 ANSI 代码页（中文系统 = GBK），
# 而调用方（Rust）按 UTF-8 解码 → JSON 里的中文全部变成乱码，
# 用户看到的错误信息是「♦◆s f♠♦9♦」根本读不了（v3.0.2 实际事故）。
# emit() 用 ensure_ascii=False 输出原文，因此这里必须显式统一编码。
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 — 编码统一失败不阻塞主流程
            pass

import converters  # noqa: E402


# ---------------------------------------------------------------- 退出码
EXIT_OK = 0
EXIT_BIZ = 1        # 业务失败（文件不存在、转换报错等）
EXIT_USAGE = 2      # 参数问题
EXIT_INTERNAL = 3   # 未预期异常


# ---------------------------------------------------------------- 动作表
# name -> (实现函数, 必填参数, 说明)
ACTIONS = {
    "doc-to-pdf": {
        "fn": lambda p, cb: converters.convert_doc_to_pdf(
            p["word_file"], p["out_dir"], progress_cb=cb),
        "required": ["word_file", "out_dir"],
        "desc": "Word 文档转 PDF（需本机 Office 或 WPS）",
    },
    "ppt-to-pdf": {
        "fn": lambda p, cb: converters.convert_ppt_to_pdf(
            p["ppt_file"], p["out_dir"], stop_flag=None),
        "required": ["ppt_file", "out_dir"],
        "desc": "PPT 演示文稿转 PDF（需本机 Office 或 WPS）",
    },
    "pdf-to-images": {
        "fn": lambda p, cb: converters.convert_pdf_to_images(
            p["pdf_file"], p["out_dir"], p.get("zoom", 2.0), p.get("fmt", "png")),
        "required": ["pdf_file", "out_dir"],
        "desc": "PDF 逐页导出为图片（zoom 缩放、fmt 格式）",
    },
    "pdf-to-word": {
        "fn": lambda p, cb: converters.convert_pdf_to_word(
            p["pdf_file"], p["out_dir"]),
        "required": ["pdf_file", "out_dir"],
        "desc": "PDF 转 Word（pdf2docx）",
    },
    "images-to-pdf": {
        "fn": lambda p, cb: converters.images_to_pdf(
            p["img_paths"], p["out_pdf"], p.get("page_mode", "auto"),
            p.get("margin_mm", 10), progress_cb=cb),
        "required": ["img_paths", "out_pdf"],
        "desc": "多张图片合成一个 PDF",
    },
    "merge-pdfs": {
        "fn": lambda p, cb: converters.merge_pdfs(
            p["pdf_paths"], p["out_pdf"], progress_cb=cb),
        "required": ["pdf_paths", "out_pdf"],
        "desc": "合并多个 PDF",
    },
    "split-pdf": {
        "fn": lambda p, cb: converters.split_pdf(
            p["pdf_file"], p["out_dir"],
            # converters 要的是 [(起,止), ...] 元组列表，不是字符串；
            # 传字符串会被逐个字符解包 → ValueError。这里做一次转换。
            _as_ranges(p.get("ranges")),
            progress_cb=cb),
        "required": ["pdf_file", "out_dir"],
        "desc": "按页码范围拆分 PDF（ranges 形如 '1-3,5,7-9'，省略则逐页拆）",
    },
    "add-watermark": {
        "fn": lambda p, cb: converters.add_watermark(
            p["pdf_file"], p["out_pdf"],
            wm_type=p.get("wm_type", "text"),
            text=p.get("text", "内部资料"),
            image=p.get("image"),
            tile=p.get("tile", True),
            opacity=p.get("opacity", 0.15),
            fontsize=p.get("fontsize", 48),
            color=tuple(p.get("color", (1, 0, 0))),
            angle=p.get("angle", 45),
            progress_cb=cb),
        "required": ["pdf_file", "out_pdf"],
        "desc": "给 PDF 加水印（wm_type=text/image）",
    },
    "image-convert": {
        "fn": lambda p, cb: converters.convert_image_format(
            p["src_path"], p["out_dir"], _norm_ext(p["target_ext"]),
            quality=p.get("quality")),
        "required": ["src_path", "out_dir", "target_ext"],
        "desc": "图片格式互转（PNG/JPG/WEBP/BMP/TIFF/ICO，扩展名可带点可不带）",
    },
    "parse-ranges": {
        "fn": lambda p, cb: ("ok", converters.parse_page_ranges(p["text"])),
        "required": ["text"],
        "desc": "解析页码范围文本（工具函数，返回页码列表）",
    },
    # 批量入口（性能关键）：一次进程处理多个任务，避免 N 次 Python 冷启动。
    # 前端批量页应优先走这里，而不是循环调用单个动作。
    # fn 由 main() 特判为 _run_batch（因为它需要触达 ACTIONS 自身，见下方特殊处理）。
    "batch": {
        "fn": None,
        "required": ["jobs"],
        "desc": "批量执行：jobs = [{action, params}, ...]，一次进程内顺序跑完（推荐）",
    },
}


def emit(obj: dict) -> None:
    """把结果以单行 JSON 打到 stdout（确保中文不转义、便于 Rust parse）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _norm_ext(ext) -> str:
    """把 'jpg' / 'JPG' / '.jpg' / '.jpeg' 统一成 converters 要的带点小写形式。

    converters.convert_image_format 要求 target_ext 带点（Pillow 的 save
    靠扩展名推断格式），外部调用方常常只传 'jpg'，故在此兜住。
    """
    e = str(ext or "").strip().lower()
    if not e:
        return ""
    if not e.startswith("."):
        e = "." + e
    return ".jpg" if e == ".jpeg" else e


def _as_ranges(ranges):
    """把 API 友好的输入转成 converters.split_pdf 要求的 [(起,止), ...]。

    接受三种形式：
      - None / ""            -> None（逐页拆）
      - "1-3,5,7-9"          -> [(1,3),(5,5),(7,9)]
      - [[1,3],[5,5]] / [{"start":1,"end":3}] -> 直接归一化成元组列表
    """
    if ranges is None or (isinstance(ranges, str) and not ranges.strip()):
        return None
    if isinstance(ranges, str):
        return [tuple(pair) for pair in converters.parse_page_ranges(ranges)]
    if isinstance(ranges, (list, tuple)):
        out = []
        for item in ranges:
            if isinstance(item, dict):
                out.append((int(item["start"]), int(item.get("end", item["start"]))))
            elif isinstance(item, (list, tuple)) and len(item) == 2:
                out.append((int(item[0]), int(item[1])))
            elif isinstance(item, int):
                out.append((item, item))
            else:
                raise ValueError(f"无法识别的 ranges 片段：{item!r}")
        return out
    raise ValueError(f"无法识别的 ranges 类型：{type(ranges).__name__}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="workaid-cli",
        description="WorkAid 转换器命令行接口",
    )
    ap.add_argument("action", nargs="?", help="动作名，见 --list")
    ap.add_argument("--json", dest="payload", help="JSON 参数对象（字符串）")
    ap.add_argument("--json-file", dest="payload_file", help="从文件读取 JSON 参数")
    ap.add_argument("--list", action="store_true", help="列出所有动作")
    ap.add_argument("--pretty", action="store_true", help="输出缩进 JSON（调试用）")
    args = ap.parse_args(argv)

    # --list：给调用方一份自描述清单
    if args.list or not args.action:
        emit({
            "ok": True,
            "actions": [
                {"name": k, "required": v["required"], "desc": v["desc"]}
                for k, v in sorted(ACTIONS.items())
            ],
        })
        return EXIT_OK

    spec = ACTIONS.get(args.action)
    if spec is None:
        emit({"ok": False, "state": "error",
              "message": f"未知动作：{args.action}",
              "available": sorted(ACTIONS.keys())})
        return EXIT_USAGE

    # ---- 取参数：--json > --json-file > stdin
    raw = args.payload
    if raw is None and args.payload_file:
        try:
            with open(args.payload_file, encoding="utf-8") as f:
                raw = f.read()
        except Exception as e:
            emit({"ok": False, "state": "error",
                  "message": f"读取参数文件失败：{e}"})
            return EXIT_USAGE
    if raw is None:
        if not sys.stdin.isatty():
            raw = sys.stdin.read()
    if raw is None or not raw.strip():
        emit({"ok": False, "state": "error", "message": "未提供 JSON 参数"})
        return EXIT_USAGE

    try:
        params = json.loads(raw)
    except json.JSONDecodeError as e:
        emit({"ok": False, "state": "error",
              "message": f"JSON 解析失败：{e}"})
        return EXIT_USAGE

    if not isinstance(params, dict):
        emit({"ok": False, "state": "error",
              "message": "JSON 参数必须是对象（{...}）"})
        return EXIT_USAGE

    # 必填校验（比让转换函数内部报错更早、更清晰）
    missing = [k for k in spec["required"] if not params.get(k)]
    if missing:
        emit({"ok": False, "state": "error",
              "message": f"缺少必填参数：{', '.join(missing)}",
              "required": spec["required"]})
        return EXIT_USAGE

    # ---- 进度回调：把每次回调转成一行 JSON（前端可实时消费）
    progress_events = []

    def progress_cb(*args):
        """进度回调【签名兼容层，绝不抛错】。

        converters.py 各动作的回调调用签名不统一：
          - doc-to-pdf 传 (filename,)              —— 单参数完成通知
          - 其余批量动作传 (done, total)           —— 两参数进度
        【v3.0.2 实际事故，务必记住】本回调若是固定签
        `progress_cb(done, total, *rest)`，doc-to-pdf 的单参调用会抛
        TypeError → 被 converters 的 except 捕获 → **把 SaveAs 已落盘的
        成功转换误报成「转换失败」**。这里必须吞掉任意签名。
        """
        ev = {"type": "progress"}
        try:
            if len(args) == 1:
                ev["detail"] = str(args[0])
            elif len(args) >= 2:
                d, t = args[0], args[1]
                if isinstance(d, (int, float)) and isinstance(t, (int, float)) and t:
                    ev["done"], ev["total"] = d, t
                else:
                    ev["detail"] = " ".join(str(a) for a in args)
                if len(args) >= 3:
                    ev["detail"] = str(args[2])
        except Exception:  # noqa: BLE001 — 进度事件永不影响转换结果
            return
        progress_events.append(ev)
        emit(ev)

    started = time.perf_counter()
    try:
        # batch 是唯一的「元动作」：它需要触达 ACTIONS 表本身来分派子任务，
        # 因此在此特判，而不是走 spec["fn"]。
        if args.action == "batch":
            result = _run_batch(params, progress_cb)
        else:
            result = spec["fn"](params, progress_cb)
    except Exception as e:                      # 兜底，绝不让调用方拿到裸栈
        emit({
            "ok": False,
            "state": "error",
            "action": args.action,
            "message": f"内部异常：{type(e).__name__}: {e}",
            "traceback": traceback.format_exc() if os.environ.get("WORKAID_CLI_DEBUG") else None,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        })
        return EXIT_INTERNAL

    # 结果归一化：支持 2 元组 (state, message) 与 3 元组 (state, message, extra)
    extra = None
    if isinstance(result, tuple) and len(result) == 3:
        state, message, extra = result
    elif isinstance(result, tuple) and len(result) == 2:
        state, message = result
    else:
        state, message = "ok", str(result)

    out = {
        "ok": state == "ok",
        "state": state,                     # ok / error / skip
        "action": args.action,
        "message": message,
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
    }
    # 批量动作的逐项明细（results / ok_count / fail_count / total）合并到顶层
    if isinstance(extra, dict):
        out.update(extra)
    if progress_events:
        out["progress_count"] = len(progress_events)

    # 若 message 看起来是个产物路径，额外给出结构化字段，方便前端直接打开
    if state == "ok" and isinstance(message, str):
        if os.path.exists(message):
            out["output"] = os.path.abspath(message)
        elif os.path.isdir(params.get("out_dir", "")):
            out["output_dir"] = os.path.abspath(params["out_dir"])
        elif params.get("out_pdf"):
            out["output"] = os.path.abspath(params["out_pdf"])

    emit(out)
    return EXIT_OK if state == "ok" else EXIT_BIZ


def _run_batch(params, progress_cb=None) -> tuple:
    """批量执行：一次进程内顺序跑多个子任务。

    存在的意义（性能）：此前 Rust 侧是「每个文件 spawn 一次 workaid-cli.exe」，
    每次都要付 Python 解释器冷启动（~0.7s）+ 原生库加载。批量 20 个文件
    = 20 次冷启动，用户感知为「越来越卡」。改为一次进程内循环后，
    冷启动只付一次。

    入参：{"jobs": [{"action": "...", "params": {...}}, ...]}
    出参：({"ok"|"error", 摘要消息}, 结构里带 results 逐项明细)

    每完成一项，立刻以 **单行 JSON** 打到 stdout（{"type":"job", ...}），
    Rust 侧只取最后一行总结果；前端若接了流式读取也能实时消费逐项进度。
    """
    jobs = params.get("jobs") or []
    if not isinstance(jobs, list):
        return ("error", "jobs 必须是数组")

    results = []
    ok_n = fail_n = 0
    for idx, job in enumerate(jobs):
        action = (job or {}).get("action")
        jp = (job or {}).get("params") or {}
        spec = ACTIONS.get(action)
        if spec is None:
            results.append({"index": idx, "ok": False, "state": "error",
                            "message": f"未知动作：{action}"})
            fail_n += 1
            continue

        missing = [k for k in spec["required"] if not jp.get(k)]
        if missing:
            results.append({"index": idx, "ok": False, "state": "error",
                            "message": f"缺少必填参数：{', '.join(missing)}"})
            fail_n += 1
            continue

        # 逐项进度回调：签名兼容层（与 main() 里的 progress_cb 同理，绝不抛错）。
        # converters 的调用签名不统一（doc-to-pdf 单参、批量动作双参），
        # 这里吞掉任意参数原样上抛；_i 仅用于排查，不参与结果判定。
        def cb(*args, _i=idx):
            if progress_cb:
                progress_cb(*args)

        started = time.perf_counter()
        try:
            r = spec["fn"](jp, cb)
        except Exception as e:
            results.append({"index": idx, "ok": False, "state": "error",
                            "action": action,
                            "message": f"{type(e).__name__}: {e}"})
            fail_n += 1
            emit({"type": "job", "index": idx, "ok": False,
                  "message": str(e)[:200],
                  "elapsed_ms": int((time.perf_counter() - started) * 1000)})
            continue

        state, message = r if isinstance(r, tuple) and len(r) == 2 else ("ok", str(r))
        item = {
            "index": idx,
            "ok": state == "ok",
            "state": state,
            "action": action,
            "message": message,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }
        # 产物路径结构化（与单动作保持一致）
        if state == "ok" and isinstance(message, str):
            if os.path.exists(message):
                item["output"] = os.path.abspath(message)
            elif os.path.isdir(jp.get("out_dir", "")):
                item["output_dir"] = os.path.abspath(jp["out_dir"])
            elif jp.get("out_pdf"):
                item["output"] = os.path.abspath(jp["out_pdf"])
        results.append(item)
        if state == "ok":
            ok_n += 1
        elif state == "skip":
            pass
        else:
            fail_n += 1
        emit({"type": "job", "index": idx, "ok": state == "ok",
              "state": state, "message": str(message)[:200],
              "elapsed_ms": item["elapsed_ms"]})

    summary = {
        "results": results,
        "ok_count": ok_n,
        "fail_count": fail_n,
        "total": len(jobs),
    }
    state = "ok" if fail_n == 0 else "error"
    msg = f"批量完成：成功 {ok_n} · 失败 {fail_n} · 共 {len(jobs)}"
    return (state, msg, summary)


def _hard_exit(code: int) -> None:
    """保证进程一定退出（Windows 冻结环境下的必要兜底）。

    【实测坑 · 1.14.x，务必保留本函数】

    现象：打包成 exe 后，转换**结果已完整打到 stdout**、`main()` 也正常返回，
    但进程永不退出（`--list` 这种不碰文件的动作同样会挂）。源码运行完全正常。

    定位过程（已逐层验证）：
      1. 排除业务逻辑 —— 用 trace 插桩确认 `main()` 正常返回、代码走到了收尾；
      2. 排除多进程 —— 全项目无 multiprocessing / 线程；
      3. 排除 COM —— 已把 win32com 改为惰性导入，仍挂；
      4. 关键判定 —— `os._exit()` 都杀不死进程，但 `taskkill /F` 能。
         二者差异：`os._exit()` → `ExitProcess()`，**会逐个调用所有已加载 DLL 的
         `DllMain(PROCESS_DETACH)`**；某个 native DLL 在 detach 时死锁。
      5. 最小复现 —— 只打进 numpy/cv2/lxml/PIL/pymupdf 等原生库、代码仅 `os._exit(0)`，
         必挂；不打包这些库则秒退。故与业务代码无关，是**本机环境级**的
         `ExitProcess` 死锁（疑似某 DLL 与本机 CRT / 沙箱注入的 hook DLL 冲突）。

    解决：用 **`NtTerminateProcess`**（ntdll 层）自毁 —— 它由内核直接结束进程，
    **不等待 DLL detach**，因此不会死锁，且退出码能准确传递（0/1/2/3 已实测）。
    调用方（Tauri/Rust）照常读 stdout JSON 与退出码，感知不到差异。

    ⚠️ 注意：`kernel32.TerminateProcess` **不一定可靠**（实测在真实 CLI 里同样会卡住，
    只在部分最小复现里成功）；`ntdll.NtTerminateProcess` 才是稳定解。
    末尾保留 `os._exit()` 兜底 + 外部 `taskkill` 双保险。

    CLI 是短命进程，本就不需要优雅收尾；这是完全正当的做法。
    """
    # 结果必须真正到达管道后才允许终止进程
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass

    if os.name == "nt":
        try:
            import ctypes
            ntdll = ctypes.WinDLL("ntdll")
            ntdll.NtTerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_long]
            ntdll.NtTerminateProcess.restype = ctypes.c_long
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            ntdll.NtTerminateProcess(handle, int(code))
            # 正常情况下不会走到这里（进程已被内核结束）
        except Exception:  # noqa: BLE001
            pass

    os._exit(code)          # 非 Windows 或上面失败时的兜底


if __name__ == "__main__":
    # 非冻结环境（源码直接跑）走正常路径，便于调试与捕获异常；
    # 冻结环境强制走 _hard_exit，绕开 COM 收尾挂死。
    _frozen = getattr(sys, "frozen", False)
    try:
        _code = main()
    except SystemExit as e:                      # argparse 等主动退出
        _code = e.code if isinstance(e.code, int) else EXIT_USAGE
    except BaseException:                        # 兜底：绝不让异常吞掉退出码
        traceback.print_exc()
        _code = EXIT_INTERNAL
    if _frozen:
        _hard_exit(_code)
    sys.exit(_code)
