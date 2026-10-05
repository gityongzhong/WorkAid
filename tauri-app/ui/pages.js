/* ============================================================
   WorkAid v3 · 页面注册表（配置化）
   ------------------------------------------------------------
   每个页面 = 一份配置。侧栏、标题、工具栏、参数区、列表列宽、
   引擎动作名与参数映射，全部由这里声明，app.js 通用渲染。

   新增一个功能页只需在这里加一项，不用碰渲染逻辑。
   字段说明：
     id        唯一标识（同时作为侧栏与路由 key）
     group     侧栏分组名
     title     页标题（主区 H1）
     sub       页副标题
     icon      侧栏 SVG（16×16 viewBox）
     exts      可接受的扩展名（小写，带点）；[] 表示不限
     multi     是否批量（true 走列表 + 逐文件循环调用）
     pickMode  'files' | 'folder-of-files' | 'single'
     action    引擎动作名（对应 cli.py 的 ACTIONS key）；'' 表示纯前端页
     tools     标题行工具按钮：add / folder / remove / clear / move
     note      列表上方或参数区里的补充说明
     out       输出模式：'dir' 输出目录 | 'pdf' 输出单个 PDF | 'auto' 留空=原目录
     params    参数控件声明数组（见下方类型）
     toAction(files, p) → { action, params } 纯函数，把界面状态翻译成引擎调用
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------- 图标库（16×16，stroke=currentColor） ---------- */
  const I = {
    docIn:   '<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/>',
    docOut:  '<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M6 8l2 2 2-2M8 10V5.5"/>',
    ppt:     '<rect x="2" y="3" width="9" height="10" rx="1.5"/><path d="M11 6h3v7.5a1 1 0 0 1-1 1h-8"/>',
    pdfImg:  '<rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="5.6" cy="5.8" r="1.3"/><path d="M2.5 11l3.2-3.2 2.5 2.5 2.3-2.3 3 3"/>',
    wm:      '<path d="M3 13h10M5 3h6v8H5z"/><path d="M8 5v4M6.3 6.7L8 5l1.7 1.7"/>',
    merge:   '<rect x="2" y="4" width="7" height="8" rx="1.2"/><rect x="8.5" y="4" width="5.5" height="8" rx="1.2"/>',
    split:   '<path d="M8 2v5M8 7l-2.5-2.5M8 7l2.5-2.5"/><rect x="2" y="9" width="12" height="5" rx="1.2"/>',
    img2pdf: '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M4.5 9.5l2.2-2.2 2 2 1.8-1.8 2 2"/><circle cx="10.5" cy="5.4" r="1"/>',
    rename:  '<path d="M3 12.5h10M5.5 3h5v7h-5z"/><path d="M7 1.8h2"/>',
    convert: '<path d="M2.5 13.5l8-8 3 3-8 8H2.5z"/><path d="M9 7l-2-2"/>',
    plus:    '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M8 5.5v5M5.5 8h5"/>',
    folderP: '<path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5l1 1.5h6.5A1.5 1.5 0 0 1 14 5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"/>',
    trash:   '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>',
    up:      '<path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"/>',
    down:    '<path d="M8 3.5v9M4.5 9L8 12.5 11.5 9"/>',
    close:   '<path d="M4 4l8 8M12 4l-8 8"/>',
    upload:  '<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 16.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2.5"/>',
    play:    '<path d="M3 8h10M9 4l4 4-4 4"/>',
    check:   '<path d="M2.5 6.5l3 3 6-6.5"/>',
  };

  const svg = (path, w) =>
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${w || 1.5}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

  /* ---------- 分组顺序 ---------- */
  const GROUPS = ['文档转换', 'PDF 工具', '图片工具'];

  /* ---------- 通用参数片段 ---------- */

  // 「保存到」参数（输出目录）：所有批量页共用
  const P_OUT_DIR = {
    key: 'out_dir', kind: 'outdir',
    label: '保存到', placeholder: '留空 = 保存到原文件所在文件夹',
  };

  /* ---------- 页面表 ---------- */
  const PAGES = [

    /* ============ 文档转换 ============ */
    {
      id: 'doc2pdf',
      group: '文档转换',
      title: 'Word 转 PDF',
      sub: '批量把 Word 文档转换为 PDF · 需本机安装 Microsoft Word 或 WPS',
      icon: I.docIn,
      exts: ['.doc', '.docx', '.docm', '.rtf', '.wps', '.wpt', '.odt'],
      multi: true,
      pickMode: 'files',
      action: 'doc-to-pdf',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '把 Word 文件拖进来，剩下的交给我', sub: '支持 .doc / .docx / .docm / .rtf / .wps，可整个文件夹拖入' },
      out: 'dir',
      outLabel: '输出目录',
      params: [P_OUT_DIR],
      toAction: (file, p) => ({
        action: 'doc-to-pdf',
        params: { word_file: file, out_dir: p.out_dir || dirOf(file) },
      }),
    },
    {
      id: 'pdf2docx',
      group: '文档转换',
      title: 'PDF 转 Word',
      sub: '把 PDF 还原成可编辑的 Word 文档 · 复杂排版可能有偏差',
      icon: I.docOut,
      exts: ['.pdf'],
      multi: true,
      pickMode: 'files',
      action: 'pdf-to-word',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入 PDF，转成可编辑的 Word', sub: '支持 .pdf，可整个文件夹拖入' },
      out: 'dir',
      outLabel: '输出目录',
      params: [P_OUT_DIR],
      toAction: (file, p) => ({
        action: 'pdf-to-word',
        params: { pdf_file: file, out_dir: p.out_dir || dirOf(file) },
      }),
    },
    {
      id: 'ppt2pdf',
      group: '文档转换',
      title: 'PPT 转 PDF',
      sub: '批量把 PPT 演示文稿转换为 PDF · 需本机安装 Microsoft Office 或 WPS',
      icon: I.ppt,
      exts: ['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.odp', '.dps'],
      multi: true,
      pickMode: 'files',
      action: 'ppt-to-pdf',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入 PPT，批量转成 PDF', sub: '支持 .ppt / .pptx / .pps，可整个文件夹拖入' },
      out: 'dir',
      outLabel: '输出目录',
      params: [P_OUT_DIR],
      toAction: (file, p) => ({
        action: 'ppt-to-pdf',
        params: { ppt_file: file, out_dir: p.out_dir || dirOf(file) },
      }),
    },

    /* ============ PDF 工具 ============ */
    {
      id: 'pdf2img',
      group: 'PDF 工具',
      title: 'PDF 转图片',
      sub: 'PDF 逐页导出为 PNG / JPG 图片',
      icon: I.pdfImg,
      exts: ['.pdf'],
      multi: true,
      pickMode: 'files',
      action: 'pdf-to-images',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入 PDF，逐页导出成图片', sub: '每页一张图，文件名按页码排序' },
      out: 'dir',
      outLabel: '输出目录',
      params: [
        {
          key: 'zoom', kind: 'select', label: '清晰度', default: '2.0',
          options: [
            { value: '1.0', text: '标准 (1×)' },
            { value: '2.0', text: '高清 (2×)' },
            { value: '3.0', text: '超清 (3×)' },
            { value: '4.0', text: '极致 (4×)' },
          ],
        },
        {
          key: 'fmt', kind: 'select', label: '格式', default: 'png',
          options: [
            { value: 'png', text: 'PNG（无损）' },
            { value: 'jpg', text: 'JPG（体积小）' },
          ],
        },
        P_OUT_DIR,
      ],
      toAction: (file, p) => ({
        action: 'pdf-to-images',
        params: {
          pdf_file: file,
          out_dir: p.out_dir || dirOf(file),
          zoom: parseFloat(p.zoom) || 2.0,
          fmt: p.fmt || 'png',
        },
      }),
    },
    {
      id: 'watermark',
      group: 'PDF 工具',
      title: 'PDF 加水印',
      sub: '给 PDF 添加文字或图片水印 · 支持平铺与透明度调节',
      icon: I.wm,
      exts: ['.pdf'],
      multi: true,
      pickMode: 'files',
      action: 'add-watermark',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入 PDF，加上你的专属水印', sub: '文字水印直接输入；图片水印选择一张 PNG / JPG' },
      out: 'dir',
      outLabel: '输出目录',
      params: [
        {
          key: 'wm_type', kind: 'select', label: '类型', default: 'text',
          options: [
            { value: 'text', text: '文字水印' },
            { value: 'image', text: '图片水印' },
          ],
        },
        { key: 'text', kind: 'text', label: '内容', default: '内部资料', placeholder: '水印文字', showIf: (p) => p.wm_type !== 'image' },
        { key: 'image', kind: 'file', label: '图片', placeholder: '选择图片…', exts: ['.png', '.jpg', '.jpeg'], showIf: (p) => p.wm_type === 'image' },
        {
          key: 'opacity', kind: 'select', label: '透明度', default: '0.15',
          options: [
            { value: '0.08', text: '很淡' },
            { value: '0.15', text: '淡' },
            { value: '0.30', text: '中等' },
            { value: '0.50', text: '明显' },
          ],
        },
        { key: 'fontsize', kind: 'number', label: '字号', default: 48, min: 12, max: 200, showIf: (p) => p.wm_type !== 'image' },
        {
          key: 'angle', kind: 'select', label: '角度', default: '45',
          options: [
            { value: '0', text: '水平' }, { value: '45', text: '45°' }, { value: '90', text: '垂直' },
          ],
          showIf: (p) => p.wm_type !== 'image',
        },
        {
          key: 'color', kind: 'select', label: '颜色', default: '1,0,0',
          options: [
            { value: '1,0,0', text: '红' }, { value: '0.5,0.5,0.5', text: '灰' },
            { value: '0,0,0', text: '黑' }, { value: '0,0.3,0.8', text: '蓝' },
          ],
          showIf: (p) => p.wm_type !== 'image',
        },
        { key: 'tile', kind: 'check', label: '平铺满页', default: true },
        P_OUT_DIR,
      ],
      toAction: (file, p) => {
        const outPdf = joinOut(p.out_dir || dirOf(file), baseName(file) + '_水印.pdf');
        const params = {
          pdf_file: file,
          out_pdf: outPdf,
          wm_type: p.wm_type || 'text',
          tile: p.tile !== false,
          opacity: parseFloat(p.opacity) || 0.15,
        };
        if (p.wm_type === 'image') {
          params.image = p.image || '';
        } else {
          params.text = p.text || '内部资料';
          params.fontsize = parseInt(p.fontsize, 10) || 48;
          params.angle = parseFloat(p.angle) || 45;
          params.color = (p.color || '1,0,0').split(',').map(Number);
        }
        return { action: 'add-watermark', params };
      },
    },
    {
      id: 'merge',
      group: 'PDF 工具',
      title: 'PDF 合并',
      sub: '把多个 PDF 按列表顺序合并成一个文件',
      icon: I.merge,
      exts: ['.pdf'],
      multi: true,
      pickMode: 'files',
      action: 'merge-pdfs',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入要合并的 PDF，顺序即结果顺序', sub: '用列表右侧的上移 / 下移调整页面次序' },
      out: 'pdf',
      outLabel: '合并结果',
      outName: '合并结果.pdf',
      params: [
        { key: 'out_name', kind: 'text', label: '文件名', default: '合并结果', placeholder: '合并结果' },
        P_OUT_DIR,
      ],
      // 合并是多文件单次调用，不用多文件循环
      single: true,
      toAction: (files, p) => {
        const name = (p.out_name || '合并结果').replace(/\.pdf$/i, '') + '.pdf';
        const dir = p.out_dir || (files.length ? dirOf(files[0]) : '');
        return {
          action: 'merge-pdfs',
          params: { pdf_paths: files, out_pdf: joinOut(dir, name) },
        };
      },
    },
    {
      id: 'split',
      group: 'PDF 工具',
      title: 'PDF 拆分',
      sub: '按页码范围拆分 PDF · 留空则逐页拆成单独文件',
      icon: I.split,
      exts: ['.pdf'],
      multi: true,
      pickMode: 'files',
      action: 'split-pdf',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入 PDF，按页码范围拆分', sub: '范围写法：1-3,5,7-9（留空 = 每页一个文件）' },
      out: 'dir',
      outLabel: '输出目录',
      params: [
        { key: 'ranges', kind: 'text', label: '页码范围', placeholder: '如 1-3,5,7-9（留空 = 逐页拆）', wide: true },
        P_OUT_DIR,
      ],
      toAction: (file, p) => ({
        action: 'split-pdf',
        params: {
          pdf_file: file,
          out_dir: p.out_dir || dirOf(file),
          ranges: (p.ranges || '').trim() || null,
        },
      }),
    },

    /* ============ 图片工具 ============ */
    {
      id: 'img2pdf',
      group: '图片工具',
      title: '图片转 PDF',
      sub: '把多张图片按列表顺序合成一个 PDF',
      icon: I.img2pdf,
      exts: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif'],
      multi: true,
      pickMode: 'files',
      action: 'images-to-pdf',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入图片，合成一个 PDF', sub: '支持 PNG / JPG / WEBP / BMP / TIFF，顺序即页面顺序' },
      out: 'pdf',
      outLabel: '输出 PDF',
      outName: '图片合集.pdf',
      params: [
        { key: 'out_name', kind: 'text', label: '文件名', default: '图片合集', placeholder: '图片合集' },
        {
          key: 'page_mode', kind: 'select', label: '页面尺寸', default: 'auto',
          options: [
            { value: 'auto', text: '跟随图片' },
            { value: 'a4', text: 'A4 竖版' },
            { value: 'a4-l', text: 'A4 横版' },
          ],
        },
        { key: 'margin_mm', kind: 'number', label: '页边距', default: 10, min: 0, max: 50, suffix: 'mm' },
        P_OUT_DIR,
      ],
      single: true,
      toAction: (files, p) => {
        const name = (p.out_name || '图片合集').replace(/\.pdf$/i, '') + '.pdf';
        const dir = p.out_dir || (files.length ? dirOf(files[0]) : '');
        return {
          action: 'images-to-pdf',
          params: {
            img_paths: files,
            out_pdf: joinOut(dir, name),
            page_mode: p.page_mode || 'auto',
            margin_mm: parseFloat(p.margin_mm) || 0,
          },
        };
      },
    },
    {
      id: 'rename',
      group: '图片工具',
      title: '图片重命名',
      sub: '批量按模板重命名图片 · 支持编号、前缀后缀与查找替换',
      icon: I.rename,
      exts: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif', '.heic'],
      multi: true,
      pickMode: 'files',
      action: '',                       // 纯前端页：直接调用 Rust 侧的重命名命令
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入图片，批量改成你想要的名字', sub: '先预览新文件名，确认无误再执行' },
      out: 'auto',                      // 原地重命名
      params: [
        { key: 'pattern', kind: 'text', label: '命名模板', default: '图片_{n:03}', placeholder: '{n} 为编号占位', wide: true },
        { key: 'start', kind: 'number', label: '起始编号', default: 1, min: 0, max: 9999 },
        { key: 'prefix', kind: 'text', label: '前缀', default: '', placeholder: '可留空' },
        { key: 'suffix', kind: 'text', label: '后缀', default: '', placeholder: '可留空' },
        { key: 'find', kind: 'text', label: '查找', default: '', placeholder: '原文' },
        { key: 'replace', kind: 'text', label: '替换为', default: '', placeholder: '新文本' },
        { key: 'keep_ext', kind: 'check', label: '保留原扩展名', default: true },
        { key: 'preview', kind: 'preview' },   // 预览列（app.js 特殊渲染）
      ],
      toAction: null,
    },
    {
      id: 'imgconvert',
      group: '图片工具',
      title: '图片格式转换',
      sub: 'PNG / JPG / WEBP / BMP / TIFF / ICO 互相转换',
      icon: I.convert,
      exts: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.ico', '.gif', '.heic'],
      multi: true,
      pickMode: 'files',
      action: 'image-convert',
      tools: ['add', 'folder', 'remove', 'clear', 'move'],
      empty: { title: '拖入图片，转成你需要的格式', sub: '支持 PNG / JPG / WEBP / BMP / TIFF / ICO' },
      out: 'auto',
      outLabel: '输出目录',
      params: [
        {
          key: 'target_ext', kind: 'select', label: '目标格式', default: 'png',
          options: [
            { value: 'png', text: 'PNG' }, { value: 'jpg', text: 'JPG' },
            { value: 'webp', text: 'WEBP' }, { value: 'bmp', text: 'BMP' },
            { value: 'tiff', text: 'TIFF' }, { value: 'ico', text: 'ICO' },
          ],
        },
        {
          key: 'quality', kind: 'select', label: '质量', default: '90',
          options: [
            { value: '70', text: '较小体积' },
            { value: '85', text: '推荐' },
            { value: '95', text: '高质量' },
            { value: '100', text: '无损' },
          ],
        },
        {
          key: 'out_dir_mode', kind: 'select', label: '保存位置', default: 'same',
          options: [
            { value: 'same', text: '原文件所在文件夹' },
            { value: 'custom', text: '指定文件夹…' },
          ],
        },
        { key: 'out_dir', kind: 'outdir', label: '', placeholder: '选择输出文件夹', showIf: (p) => p.out_dir_mode === 'custom' },
      ],
      toAction: (file, p) => ({
        action: 'image-convert',
        params: {
          src_path: file,
          out_dir: (p.out_dir_mode === 'custom' && p.out_dir) ? p.out_dir : dirOf(file),
          target_ext: p.target_ext || 'png',
          quality: p.target_ext === 'jpg' || p.target_ext === 'webp'
            ? parseInt(p.quality, 10) || 90 : null,
        },
      }),
      // 目标格式与原格式相同时跳过（与 tkinter 版一致的 _norm_img_ext 语义）
      skipIf: (file, p) => {
        const cur = extOf(file).toLowerCase();
        const tgt = '.' + (p.target_ext || 'png').toLowerCase();
        const norm = (e) => (e === '.jpeg' ? '.jpg' : e);
        return norm(cur) === norm(tgt);
      },
      skipReason: '格式相同，已跳过',
    },
  ];

  /* ---------- 路径小工具 ---------- */
  function dirOf(p) {
    if (!p) return '';
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : p;
  }
  function baseName(p) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    const n = i >= 0 ? p.slice(i + 1) : p;
    const d = n.lastIndexOf('.');
    return d > 0 ? n.slice(0, d) : n;
  }
  function extOf(p) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    const n = i >= 0 ? p.slice(i + 1) : p;
    const d = n.lastIndexOf('.');
    return d > 0 ? n.slice(d) : '';
  }
  function joinOut(dir, name) {
    if (!dir) return name;
    const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }

  global.WorkAid = {
    I, svg, GROUPS, PAGES,
    page: (id) => PAGES.find((p) => p.id === id) || PAGES[0],
    helpers: { dirOf, baseName, extOf, joinOut },
  };
})(window);
