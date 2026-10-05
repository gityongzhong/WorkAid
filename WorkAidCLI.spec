# -*- mode: python ; coding: utf-8 -*-
"""WorkAid CLI 打包配置（供 Tauri / 外部程序调用的转换引擎）。

与 WorkAid.spec（GUI 版）的区别：
  - 入口是 cli.py 而非 word2pdf.py
  - console=True（命令行程序要能输出 stdout/stderr）
  - **onedir 模式**（COLLECT）：onefile 在本机会导致进程永不退出，见文件末尾说明
  - 不含任何 GUI 依赖（tkinterdnd2 / ttkbootstrap / PIL 的 ImageTk）
  - 不含图标、赞赏码等 UI 资源
  - 保留完整转换依赖：fitz / pymupdf / pdf2docx 及其链
"""
from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = ['pythoncom', 'pywintypes']

# PDF 读取与图片渲染依赖 PyMuPDF（import fitz），必须连原生库一起打入
for _pkg in ('fitz', 'pymupdf'):
    tmp_ret = collect_all(_pkg)
    datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# PDF 转 Word 依赖 pdf2docx（链：python-docx / lxml / numpy / opencv / fonttools / fire）
for _pkg in ('pdf2docx', 'docx', 'cv2', 'numpy', 'lxml', 'fire', 'fonttools'):
    tmp_ret = collect_all(_pkg)
    datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# 图片格式转换依赖 Pillow
tmp_ret = collect_all('PIL')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['cli.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 明确排除 GUI 栈，控制体积（CLI 完全不需要）
        'tkinter', 'tkinterdnd2', 'ttkbootstrap', 'PyQt5', 'PyQt6',
        'PySide2', 'PySide6', 'matplotlib', 'IPython', 'notebook',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,     # onedir：二进制不塞进 exe，由 COLLECT 收拢
    name='workaid-cli',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,            # 关键：命令行程序必须保留控制台输出
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# ---------------------------------------------------------------------------
# 必须用 onedir（COLLECT）而**不是** onefile（EXE 直接带 binaries）
#
# 【实测坑 · 1.14.x】onefile 模式在本机**进程永不退出**：结果已完整输出、main() 也已
# 返回，但进程存活（os._exit / TerminateProcess / NtTerminateProcess 全部无效），
# 只能由外部 taskkill 杀掉。换成 onedir 后 100% 正常退出，且启动从十余秒降到 0.35s。
# 已逐项排除：业务代码、多进程、COM、第三方 native 库（只打 numpy/cv2 的最小程序
# 在 onefile 下同样必挂）——问题出在 onefile 的 bootloader 一次性解压/清理模型。
#
# 因此：**不要**把本 spec 改回 onefile。
# ---------------------------------------------------------------------------
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='workaid-cli',       # 产物目录 dist/workaid-cli/，内含 workaid-cli.exe
)
