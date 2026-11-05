/* ============================================================
   WorkAid v3 · 前端渲染与交互
   ------------------------------------------------------------
   职责：读 pages.js 的配置 → 渲染侧栏/列表/参数区 → 收集参数
        → 通过 invoke('run_action') 交给 Rust → 展示进度与结果。

   本文件不含任何转换逻辑。
   ============================================================ */

(function () {
  'use strict';

  const W = window.WorkAid;
  const { PAGES, GROUPS, I, svg, page: findPage } = W;
  const H = W.helpers;

  /* ---------- Tauri 桥（无 Tauri 时降级为 mock，便于浏览器里调样式） ---------- */
  /* 实测坑（2026-10-05）：**禁止缓存 window.__TAURI__ 的引用**。
     WebView2 注入脚本会在页面生命期内重建 __TAURI__ 对象——启动瞬间捕获的
     旧引用 IPC 通道已断，用它 invoke 会永久 pending（表现为所有检测超时）。
     每次调用动态读取 window.__TAURI__ 即可（CDP 手动调用总是成功的原因）。 */
  function tauriCore() {
    const t = window.__TAURI__;
    return (t && t.core && t.core.invoke) ? t : null;
  }

  async function invoke(cmd, args) {
    const t = tauriCore();
    if (t) return t.core.invoke(cmd, args);
    console.warn('[mock invoke]', cmd, args);
    return mockInvoke(cmd, args);
  }

  /* 带超时的 invoke。
     实测坑（2026-10-05）：页面脚本执行瞬间发起的 invoke 会永久 pending
     （WebView2 IPC 通道尚未建立），同样的命令在 load 后调用 2ms 返回。
     因此：启动期的检测一律用本封装 + 超时重试，绝不裸调。 */
  function invokeT(cmd, args, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('invoke-timeout: ' + cmd)), ms || 4000);
      invoke(cmd, args).then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  async function mockInvoke(cmd, args) {
    if (cmd === 'app_info') return { name: 'WorkAid', version: '3.3.1', tauri: '2.x', platform: 'windows', arch: 'x86_64' };
    if (cmd === 'engine_status') return {
      engine: '(mock) workaid-cli.exe', exists: true, source: '程序目录\\workaid-cli\\',
      app_dir: '(mock) 程序目录',
      candidates: [{ from: '程序目录\\workaid-cli\\', path: '(mock) workaid-cli.exe', exists: true }],
    };
    if (cmd === 'engine_actions') return { available: true, engine: '(mock)', actions: PAGES.filter(p => p.action).map(p => ({ name: p.action, required: [], desc: p.title })) };
    if (cmd === 'file_meta_many') return (args.paths || []).map((p) => ({
      ok: true, path: p, name: H.baseName(p) + H.extOf(p), dir: H.dirOf(p),
      ext: H.extOf(p).slice(1), size: 1024 * 180, is_file: true,
    }));
    if (cmd === 'expand_paths') return { files: args.paths || [], skipped: [], count: (args.paths || []).length };
    if (cmd === 'run_action') {
      await new Promise((r) => setTimeout(r, 700));
      return { engine: '(mock)', action: args.action, exit_code: 0, elapsed_ms: 700, result: { ok: true, state: 'ok', message: '（模拟）完成' }, raw_stdout: '', stderr: '' };
    }
    if (cmd === 'open_path') return { ok: true };
    if (cmd === 'open_url') return { ok: true, url: args.url };
    return {};
  }

  /* ---------- 全局状态 ---------- */
  const S = {
    pageId: PAGES[0].id,
    files: [],          // [{ path, name, dir, ext, size, status, msg }]
    params: {},         // 当前页参数值
    sel: -1,
    running: false,
    lastOutDir: '',
    logs: [],
    engineOk: null,
  };

  const $ = (id) => document.getElementById(id);

  /* ============================================================
     ① 侧栏
     ============================================================ */
  /* 侧栏导航：每个分组渲染成一块独立的「浮岛」面板（v3.1.0）
     分组感由面板容器承载，不再依赖裸标题；面板底色比侧栏底略亮一档，
     形成 侧栏底 < 面板 < 选中项 三层纵深。 */
  function renderNav() {
    const host = $('navHost');
    let html = '';
    for (const g of GROUPS) {
      const items = PAGES.filter((p) => p.group === g);
      if (!items.length) continue;
      let inner = `<div class="grp">${g}</div>`;
      for (const p of items) {
        inner += `<div class="nav-item${p.id === S.pageId ? ' on' : ''}" data-page="${p.id}">${svg(p.icon)}${p.title}</div>`;
      }
      html += `<div class="grp-card">${inner}</div>`;
    }
    host.innerHTML = html;
    host.querySelectorAll('.nav-item').forEach((el) => {
      el.addEventListener('click', () => switchPage(el.dataset.page));
    });
  }

  function switchPage(id) {
    if (S.running) { toast('转换进行中，请稍候…'); return; }
    if (id === S.pageId) return;
    S.pageId = id;
    S.files = [];
    S.sel = -1;
    S.params = {};
    S.logs = [];
    hideResult();
    renderNav();
    renderPage();
    renderList();
    renderParams();
    renderLogs();
    setProgress(0, false);
    setStatus('就绪');
    setGo('idle');
    $('logDrawer').classList.remove('open');
    $('logBar').classList.remove('open');
  }

  /* ============================================================
     ② 标题行 / 工具栏
     ============================================================ */
  function renderPage() {
    const p = findPage(S.pageId);
    $('pgTitle').textContent = p.title;
    $('pgSub').textContent = p.sub;

    const tools = $('pgTools');
    const t = p.tools || [];
    let html = '';
    if (t.includes('add')) html += `<button class="btn" data-act="add">${svg(I.plus, 1.6)}添加文件</button>`;
    if (t.includes('folder')) html += `<button class="btn" data-act="folder">${svg(I.folderP, 1.6)}添加文件夹</button>`;
    if (t.includes('remove')) html += `<button class="btn ghost" data-act="remove">移除选中</button>`;
    if (t.includes('clear')) html += `<button class="btn ghost" data-act="clear">清空</button>`;
    tools.innerHTML = html;

    tools.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => onTool(b.dataset.act));
    });
  }

  async function onTool(act) {
    if (S.running) return;
    const p = findPage(S.pageId);
    if (act === 'add') return pickFiles(p);
    if (act === 'folder') return pickFolder(p);
    if (act === 'remove') {
      if (S.sel < 0) return toast('请先在列表中选择一项');
      S.files.splice(S.sel, 1);
      S.sel = Math.min(S.sel, S.files.length - 1);
      renderList();
      return;
    }
    if (act === 'clear') {
      if (S.running) return;
      S.files = [];
      S.sel = -1;
      hideResult();
      renderList();
    }
  }

  /* ---------- 选文件（Tauri 对话框插件，浏览器里用 input 兜底） ---------- */
  async function openDialog(opts) {
    const t = window.__TAURI__;
    if (t && t.dialog && t.dialog.open) return t.dialog.open(opts);
    // 浏览器降级
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = !!opts.multiple;
      if (opts.filters && opts.filters[0]) inp.accept = opts.filters[0].extensions.map((e) => '.' + e).join(',');
      inp.addEventListener('change', () => {
        // 浏览器拿不到绝对路径，这里仅用于样式调试
        resolve(Array.from(inp.files).map((f) => f.name));
      });
      inp.click();
    });
  }

  async function pickFiles(p) {
    const filters = p.exts && p.exts.length
      ? [{ name: p.title, extensions: p.exts.map((e) => e.replace('.', '')) }]
      : [];
    const res = await openDialog({ multiple: p.pickMode !== 'single', directory: false, filters });
    if (!res) return;
    const paths = Array.isArray(res) ? res : [res];
    await addPaths(paths);
  }

  async function pickFolder(p) {
    const res = await openDialog({ directory: true, multiple: false });
    if (!res) return;
    const paths = Array.isArray(res) ? res : [res];
    await addPaths(paths);
  }

  async function addPaths(paths) {
    const p = findPage(S.pageId);
    const r = await invoke('expand_paths', { paths, exts: p.exts || [] });
    const incoming = (r && r.files) || [];
    const known = new Set(S.files.map((f) => f.path.toLowerCase()));
    const fresh = incoming.filter((f) => !known.has(f.toLowerCase()));
    const dup = incoming.length - fresh.length;

    if (!fresh.length) {
      toast(dup ? '这些文件已在列表中' : '没有符合格式的文件');
      return;
    }

    const metas = await invoke('file_meta_many', { paths: fresh });
    for (const m of metas) {
      if (!m || !m.ok) continue;
      S.files.push({
        path: m.path, name: m.name, dir: m.dir,
        ext: (m.ext || '').toLowerCase(), size: m.size || 0,
        status: 'pend', msg: '',
      });
    }
    renderList();
    const skipped = (r && r.skipped && r.skipped.length) || 0;
    let msg = `已添加 ${fresh.length} 个文件`;
    if (dup) msg += ` · 跳过重复 ${dup}`;
    if (skipped) msg += ` · 格式不符 ${skipped}`;
    toast(msg);
  }

  /* ============================================================
     ③ 列表
     ============================================================ */
  const EXT_COLOR = {
    doc: '#2B579A', docx: '#2B579A', docm: '#2B579A', rtf: '#B3413C', odt: '#1A7F6B',
    wps: '#7A4DD8', wpt: '#7A4DD8',
    pdf: '#D33A2C',
    ppt: '#D24726', pptx: '#D24726', pptm: '#D24726', pps: '#D24726', ppsx: '#D24726', odp: '#1A7F6B', dps: '#7A4DD8',
    png: '#4C9A2A', jpg: '#4C9A2A', jpeg: '#4C9A2A', webp: '#4C9A2A', bmp: '#4C9A2A',
    tif: '#4C9A2A', tiff: '#4C9A2A', gif: '#4C9A2A', ico: '#4C9A2A', heic: '#4C9A2A',
  };

  function fmtSize(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  const STATUS_TEXT = { pend: '待处理', work: '处理中…', ok: '完成', err: '失败', skip: '已跳过' };

  function renderList() {
    const host = $('rowsHost');
    const p = findPage(S.pageId);
    const showMove = (p.tools || []).includes('move');

    if (!S.files.length) {
      host.innerHTML = `
        <div class="empty">
          <div class="ring"><img src="assets/arrow-up.png" alt=""></div>
          <b>${p.empty ? p.empty.title : '把文件拖进来'}</b>
          <p>${p.empty ? p.empty.sub : ''}</p>
          <div class="eb">
            <button class="btn pri" style="height:34px" data-empty="add">选择文件</button>
            <button class="btn" style="height:34px" data-empty="folder">选择文件夹</button>
          </div>
        </div>`;
      host.querySelectorAll('[data-empty]').forEach((b) => {
        b.addEventListener('click', () => onTool(b.dataset.empty));
      });
      updateGo();
      return;
    }

    host.innerHTML = S.files.map((f, i) => {
      const color = EXT_COLOR[f.ext] || '#4A4A55';
      const badge = (f.ext || '?').toUpperCase().slice(0, 4);
      const st = f.status || 'pend';
      const cls = st === 'ok' ? 'ok' : st === 'err' ? 'err' : st === 'work' ? 'work' : 'pend';
      const label = f.msg || STATUS_TEXT[st] || '待处理';
      const tools = `
        <div class="row-tools">
          ${showMove ? `<button class="iconbtn" data-mv="up" data-i="${i}" title="上移">${svg(I.up, 1.8)}</button>
                        <button class="iconbtn" data-mv="down" data-i="${i}" title="下移">${svg(I.down, 1.8)}</button>` : ''}
          <button class="iconbtn" data-del="${i}" title="移除">${svg(I.close, 1.8)}</button>
        </div>`;
      return `<div class="row${i === S.sel ? ' sel' : ''}" data-i="${i}">
        <div class="c">
          <div class="fico" style="background:${color}">${badge}</div>
          <div style="min-width:0">
            <div class="f-name">${esc(f.name)}</div>
            <div class="f-sub">${esc(f.dir)}</div>
          </div>
        </div>
        <div class="c narrow">${fmtSize(f.size)}</div>
        <div class="c stat"><span class="pill ${cls}">${esc(label)}</span></div>
        <div class="c" style="flex:0 0 62px;justify-content:flex-end">${tools}</div>
      </div>`;
    }).join('');

    host.querySelectorAll('.row').forEach((el) => {
      const i = +el.dataset.i;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.row-tools')) return;
        S.sel = i;
        renderList();
      });
      el.addEventListener('dblclick', () => invoke('open_path', { path: S.files[i].path }));
    });
    host.querySelectorAll('[data-mv]').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); move(+b.dataset.i, b.dataset.mv === 'up' ? -1 : 1); });
    });
    host.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = +b.dataset.del;
        S.files.splice(i, 1);
        if (S.sel >= S.files.length) S.sel = S.files.length - 1;
        renderList();
      });
    });

    updateGo();
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= S.files.length) return;
    const [x] = S.files.splice(i, 1);
    S.files.splice(j, 0, x);
    S.sel = j;
    renderList();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ============================================================
     ④ 参数区
     ============================================================ */
  function defaultParams(p) {
    const o = {};
    (p.params || []).forEach((d) => {
      if (d.default !== undefined) o[d.key] = d.default;
      else if (d.kind === 'check') o[d.key] = false;
      else if (d.kind === 'number') o[d.key] = d.min || 0;
      else o[d.key] = '';
    });
    return o;
  }

  function ensureParams() {
    const p = findPage(S.pageId);
    const def = defaultParams(p);
    // 保留用户已填的值（切页已清空，这里只在键缺失时补默认）
    for (const k of Object.keys(def)) {
      if (!(k in S.params)) S.params[k] = def[k];
    }
    // 清掉不属于本页的键
    for (const k of Object.keys(S.params)) {
      if (!(k in def)) delete S.params[k];
    }
  }

  function renderParams() {
    ensureParams();
    const p = findPage(S.pageId);
    const host = $('paramsHost');
    const defs = (p.params || []).filter((d) => !d.showIf || d.showIf(S.params));

    if (!defs.length) { host.innerHTML = ''; return; }

    // 按 label 归组为卡片：输出参数单独一卡
    const OUT_KEYS = new Set(['out_dir', 'out_name', 'out_dir_mode']);
    const outDefs = defs.filter((d) => OUT_KEYS.has(d.key));
    const optDefs = defs.filter((d) => !OUT_KEYS.has(d.key) && d.kind !== 'preview');

    let html = '';
    if (optDefs.length) {
      html += `<div class="pcard"><span class="plabel">选 项</span><div class="pbody">${
        optDefs.map((d) => fieldHtml(d)).join('')
      }</div></div>`;
    }
    if (outDefs.length) {
      html += `<div class="pcard"><span class="plabel">输 出</span><div class="pbody">${
        outDefs.map((d) => fieldHtml(d)).join('')
      }</div></div>`;
    }
    // 预览类（重命名页）
    const pv = defs.find((d) => d.kind === 'preview');
    if (pv) {
      html += `<div class="pcard" style="flex-direction:column;align-items:stretch;gap:8px">
        <span class="plabel" style="min-width:0">预览</span>
        <div class="pbody" style="display:block"><div id="renamePreview" class="hint">添加图片后显示新文件名预览</div></div>
      </div>`;
    }
    host.innerHTML = html;

    bindParams();
    if (pv) refreshRenamePreview();
    updateGo();
  }

  function fieldHtml(d) {
    const v = S.params[d.key];
    switch (d.kind) {
      case 'select':
        return `<div class="opt"><label>${d.label}</label><select class="combo" data-k="${d.key}">${
          d.options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(v) ? ' selected' : ''}>${esc(o.text)}</option>`).join('')
        }</select></div>`;
      case 'check':
        return `<label class="check"><input type="checkbox" data-k="${d.key}"${v ? ' checked' : ''}>
          <span class="box">${svg(I.check, 2.4)}</span><span>${d.label}</span></label>`;
      case 'number':
        return `<div class="opt">${d.label ? `<label>${d.label}</label>` : ''}<input class="field num" type="number" data-k="${d.key}"
          value="${esc(v)}"${d.min !== undefined ? ` min="${d.min}"` : ''}${d.max !== undefined ? ` max="${d.max}"` : ''}>
          ${d.suffix ? `<span class="hint">${d.suffix}</span>` : ''}</div>`;
      case 'outdir':
        return `<div class="opt" style="flex:1 1 auto;min-width:220px">
          ${d.label ? `<label>${d.label}</label>` : ''}
          <input class="field wide" data-k="${d.key}" value="${esc(v)}" placeholder="${esc(d.placeholder || '')}">
          <button class="btn ghost sm" data-browse="${d.key}">浏览…</button></div>`;
      case 'file':
        return `<div class="opt"><label>${d.label}</label>
          <input class="field text" data-k="${d.key}" value="${esc(v)}" placeholder="${esc(d.placeholder || '')}" style="width:170px">
          <button class="btn ghost sm" data-pick="${d.key}">选择…</button></div>`;
      case 'text':
      default:
        return `<div class="opt"${d.wide ? ' style="flex:1 1 auto;min-width:220px"' : ''}>
          ${d.label ? `<label>${d.label}</label>` : ''}
          <input class="field${d.wide ? ' wide' : ' text'}" data-k="${d.key}" value="${esc(v)}" placeholder="${esc(d.placeholder || '')}"></div>`;
    }
  }

  function bindParams() {
    const host = $('paramsHost');

    host.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k;
      const isCheck = el.type === 'checkbox';
      el.addEventListener('change', () => {
        S.params[k] = isCheck ? el.checked : el.value;
        onParamChange(k);
      });
      if (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.tagName !== 'SELECT') {
        el.addEventListener('input', () => { S.params[k] = el.value; if (needRerender(k)) onParamChange(k, true); });
      }
    });

    host.querySelectorAll('[data-browse]').forEach((b) => {
      b.addEventListener('click', async () => {
        const res = await openDialog({ directory: true, multiple: false });
        if (!res) return;
        S.params[b.dataset.browse] = Array.isArray(res) ? res[0] : res;
        renderParams();
      });
    });

    host.querySelectorAll('[data-pick]').forEach((b) => {
      b.addEventListener('click', async () => {
        const p = findPage(S.pageId);
        const def = (p.params || []).find((x) => x.key === b.dataset.pick) || {};
        const res = await openDialog({
          multiple: false, directory: false,
          filters: def.exts ? [{ name: '图片', extensions: def.exts.map((e) => e.replace('.', '')) }] : [],
        });
        if (!res) return;
        S.params[b.dataset.pick] = Array.isArray(res) ? res[0] : res;
        renderParams();
      });
    });
  }

  // 会触发联动重渲染的键（showIf 依赖它们）
  function needRerender(k) {
    return ['wm_type', 'out_dir_mode'].includes(k);
  }

  function onParamChange(k, keepFocus) {
    if (needRerender(k)) { renderParams(); return; }
    if (k === 'pattern' || k === 'start' || k === 'prefix' || k === 'suffix' || k === 'find' || k === 'replace') {
      refreshRenamePreview();
    }
    updateGo();
  }

  function refreshRenamePreview() {
    const box = $('renamePreview');
    if (!box) return;
    if (!S.files.length) { box.textContent = '添加图片后显示新文件名预览'; return; }
    const rows = S.files.slice(0, 8).map((f, i) => {
      const nn = newNameFor(f, i);
      return `<div style="display:flex;gap:8px;font-size:12px;line-height:1.9">
        <span style="color:var(--fg3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(f.name)}</span>
        <span style="color:var(--fg4)">→</span>
        <span style="color:var(--fg);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(nn)}</span>
      </div>`;
    }).join('');
    const more = S.files.length > 8 ? `<div class="hint" style="margin-top:4px">…还有 ${S.files.length - 8} 个</div>` : '';
    box.innerHTML = rows + more;
  }

  function newNameFor(f, i) {
    const p = S.params;
    const start = parseInt(p.start, 10) || 0;
    const n = String(start + i);
    const pat = p.pattern || '{n}';
    let base = baseFromPattern(f, pat, n, i);
    let name = (p.prefix || '') + base + (p.suffix || '');
    if (p.find) name = name.split(p.find).join(p.replace || '');
    const ext = p.keep_ext === false ? '' : (H.extOf(f.name) || H.extOf(f.path));
    return name + ext;
  }
  function baseFromPattern(f, pat, n, i) {
    const now = new Date();
    const pad = (x, w) => String(x).padStart(w, '0');
    const origBase = H.baseName(f.name || f.path);
    return pat
      .replace(/\{n:(\d+)\}/g, (_, w) => pad(n, +w))
      .replace(/\{n\}/g, n)
      .replace(/\{i:(\d+)\}/g, (_, w) => pad(i + 1, +w))
      .replace(/\{i\}/g, i + 1)
      .replace(/\{name\}/g, origBase)
      .replace(/\{date\}/g, `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`)
      .replace(/\{time\}/g, `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`);
  }

  /* ============================================================
     ⑤ 执行
     ============================================================ */
  function updateGo() {
    const p = findPage(S.pageId);
    const enough = p.single ? S.files.length >= (p.id === 'merge' || p.id === 'img2pdf' ? 1 : 1) : S.files.length > 0;
    $('goBtn').disabled = S.running || !enough;
    if (!S.running) $('goText').textContent = p.action ? '开 始' : '执 行';
  }

  function setGo(state) {
    const btn = $('goBtn');
    if (state === 'done') {
      btn.classList.add('done');
      $('goText').textContent = '重新开始';
    } else {
      btn.classList.remove('done');
      updateGo();
    }
  }

  function setStatus(txt) { $('execStatus').innerHTML = txt; }

  function setProgress(pct, active) {
    const w = $('progWrap');
    const b = $('progBar');
    b.style.width = Math.max(0, Math.min(100, pct)) + '%';
    w.classList.toggle('idle', !active);
    b.classList.toggle('done', pct >= 100);
  }

  async function run() {
    if (S.running) return;
    const p = findPage(S.pageId);
    hideResult();

    if (!S.files.length) return toast('请先添加文件');

    if (!p.action) {
      return runFrontendOnly(p);
    }

    // 引擎缺失时提前拦住：别让用户拖完一堆文件、点开始才失败
    if (S.engineOk === false) {
      log('转换引擎不可用，已阻止本次执行', 'err');
      return openEngineHelp();
    }

    S.running = true;
    updateGo();
    setGo('run');
    $('goText').textContent = '执行中…';

    const single = !!p.single;
    const t0 = performance.now();
    let ok = 0, fail = 0, skip = 0;
    let lastOut = '';

    log('开始执行：' + p.title, 'info');

    /* ---- ① 前置过滤 + 组装调用计划（此阶段零进程开销） ----
       skipIf 命中的文件不发给引擎；其余编译成引擎调用。
       单文件调用的动作（合并 / 图片转 PDF）只编译出 1 个计划。 */
    const plans = [];          // { action, params, fileIdx }  fileIdx=-1 表示整批单调用
    const skipIdx = [];

    if (single) {
      try {
        const plan = p.toAction(S.files.map((f) => f.path), S.params);
        plans.push({ action: plan.action, params: plan.params, fileIdx: -1 });
      } catch (e) {
        fail++;
        log(`参数构造失败：${e.message}`, 'err');
      }
    } else {
      for (let i = 0; i < S.files.length; i++) {
        if (p.skipIf && p.skipIf(S.files[i].path, S.params)) {
          S.files[i].status = 'skip';
          S.files[i].msg = p.skipReason || '已跳过';
          skip++;
          skipIdx.push(i);
          log(`跳过 ${S.files[i].name}（${p.skipReason || '无需处理'}）`, 'warn');
          continue;
        }
        try {
          const plan = p.toAction(S.files[i].path, S.params);
          plans.push({ action: plan.action, params: plan.params, fileIdx: i });
        } catch (e) {
          S.files[i].status = 'err';
          S.files[i].msg = '参数错误';
          fail++;
          log(`参数构造失败：${S.files[i].name} — ${e.message}`, 'err');
        }
      }
    }

    // 待处理的文件先统一置为「处理中」
    for (const pl of plans) {
      if (pl.fileIdx >= 0) { S.files[pl.fileIdx].status = 'work'; S.files[pl.fileIdx].msg = ''; }
      else { for (const f of S.files) { if (f.status !== 'skip') { f.status = 'work'; f.msg = ''; } } }
    }
    renderList();
    setProgress(skip ? (skip / S.files.length) * 100 : 0, true);
    setStatus(`正在处理 <b>${plans.length}</b> 个任务${skip ? ` · 跳过 ${skip}` : ''}`);

    if (!plans.length) {
      finishRun();
      return;
    }

    /* ---- ② 一次性批量调用（性能关键）----
       旧写法是「每个文件 spawn 一次 workaid-cli.exe」，每次付 Python 冷启动
       （~0.7s）；20 个文件 = 20 次冷启动，用户感知为越用越卡。
       改为把全部任务塞进一次 batch 调用，冷启动只付一次（实测快 ~60%）。 */
    let resp;
    try {
      log(`调用引擎 batch（${plans.length} 个任务）…`, 'info');
      resp = await invoke('run_action', {
        action: 'batch',
        params: { jobs: plans.map((pl) => ({ action: pl.action, params: pl.params })) },
      });
    } catch (e) {
      for (const pl of plans) {
        if (pl.fileIdx >= 0) { S.files[pl.fileIdx].status = 'err'; S.files[pl.fileIdx].msg = '引擎启动失败'; }
        else { for (const f of S.files) { if (f.status === 'work') { f.status = 'err'; f.msg = '引擎启动失败'; } } }
      }
      fail += plans.length;
      renderList();
      log(`引擎启动失败：${e}`, 'err');
      finishRun();
      return;
    }

    /* ---- ③ 结果对齐 ---- */
    const res = (resp && resp.result) || {};
    const items = Array.isArray(res.results) ? res.results : [];

    if (!items.length) {
      // batch 头信息缺失 → 回落到整体成败判定，避免静默失败
      const good = res.ok === true || resp.exit_code === 0;
      for (const pl of plans) {
        if (pl.fileIdx >= 0) {
          S.files[pl.fileIdx].status = good ? 'ok' : 'err';
          S.files[pl.fileIdx].msg = good ? '完成' : shortErr(res.message || '失败');
        }
      }
      if (good) ok += plans.length; else fail += plans.length;
      lastOut = res.output_dir || lastOut;
    } else {
      items.forEach((it, k) => {
        const pl = plans[k];
        if (!pl) return;
        const target = pl.fileIdx >= 0 ? S.files[pl.fileIdx].name : p.title;
        if (it.ok || it.state === 'ok') {
          ok++;
          if (pl.fileIdx >= 0) { S.files[pl.fileIdx].status = 'ok'; S.files[pl.fileIdx].msg = '完成'; }
          else { for (const f of S.files) { if (f.status === 'work') { f.status = 'ok'; f.msg = '完成'; } } }
          lastOut = it.output_dir || it.output || lastOut;
          log(`完成：${target} · ${it.elapsed_ms}ms`, 'ok');
        } else if (it.state === 'skip') {
          skip++;
          if (pl.fileIdx >= 0) { S.files[pl.fileIdx].status = 'skip'; S.files[pl.fileIdx].msg = '已跳过'; }
        } else {
          fail++;
          const msg = shortErr(it.message || '失败');
          if (pl.fileIdx >= 0) { S.files[pl.fileIdx].status = 'err'; S.files[pl.fileIdx].msg = msg; }
          else { for (const f of S.files) { if (f.status === 'work') { f.status = 'err'; f.msg = msg; } } }
          log(`失败：${target} — ${it.message || '未知错误'}`, 'err');
        }
      });
      // 结果条数少于计划数（引擎中途异常）时，剩余项标记失败
      for (let k = items.length; k < plans.length; k++) {
        const pl = plans[k];
        fail++;
        if (pl.fileIdx >= 0) { S.files[pl.fileIdx].status = 'err'; S.files[pl.fileIdx].msg = '未执行'; }
      }
    }

    renderList();
    setProgress(100, true);
    finishRun();

    function finishRun() {
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      S.running = false;
      S.lastOutDir = lastOut;
      setProgress(100, true);
      setStatus(`全部完成 · 用时 ${secs} 秒`);
      setGo('done');
      showResult({ ok, fail, skip, secs, out: lastOut });
      log(`本轮结束：成功 ${ok} · 失败 ${fail}${skip ? ' · 跳过 ' + skip : ''} · 用时 ${secs} 秒`,
          fail ? 'warn' : 'ok');
    }
  }

  function shortErr(s) {
    s = String(s || '失败');
    return s.length > 12 ? '失败 · ' + s.slice(0, 10) + '…' : '失败';
  }

  /* ---------- 打赏弹窗 ---------- */
  function openDonate() { $('donateMask').classList.add('show'); }
  function closeDonate() { $('donateMask').classList.remove('show'); }

  /* 项目主页：交给系统默认浏览器打开
     指向公开的下载仓库 —— 源码仓库已转为私有，链过去会是 404 */
  const GITHUB_URL = 'https://github.com/gityongzhong/WorkAid-releases';
  function openGithub() {
    invoke('open_url', { url: GITHUB_URL }).catch((e) => toast('打开链接失败：' + e));
  }
  /* 页脚链接绑定：boot 里已绑一次，这里用标记位兜底保证只绑一次，
     避免后续改动把 boot 的绑定语句冲掉时链接静默失效 */
  function bindFootLinks() {
    const gh = $('footGithub');
    if (gh && !gh.dataset.bound) { gh.dataset.bound = '1'; gh.addEventListener('click', openGithub); }
    const sp = $('footSupport');
    if (sp && !sp.dataset.bound) { sp.dataset.bound = '1'; sp.addEventListener('click', openDonate); }
  }
  /* ---------- 主题切换（v3.3.0） ----------
     三种模式：dark / light / auto（跟随系统）。
     设计要点：
     ① 颜色只看 <html data-theme="dark|light">，由 theme.css 的两套 token 驱动；
        data-tm 记录的是「模式」（含 auto），两者分开，auto 才能表达清楚。
     ② 首帧由 index.html 头部的内联脚本预先决定，这里只负责后续变更。
     ③ 切换瞬间给 <html> 挂 .theme-switching 打开颜色过渡，220ms 后摘掉，
        这样只有换主题有动画，hover 手感不受影响。 */
  const THEME_KEY = 'wa-theme';
  const THEME_MODES = ['dark', 'light', 'auto'];
  const THEME_LABEL = { dark: '深色', light: '浅色', auto: '跟随系统' };
  let themeMode = 'dark';

  function sysTheme() {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light' : 'dark';
  }

  /* 让系统标题栏跟随。Win11 有效；Win10 不支持深色标题栏，
     会保持系统色，界面本身不受影响，故失败也不提示。 */
  function syncWindowTheme(resolved) {
    try {
      const t = window.__TAURI__;
      if (!t || !t.window || !t.window.getCurrentWindow) return;
      t.window.getCurrentWindow().setTheme(themeMode === 'auto' ? null : resolved);
    } catch (e) { /* 浏览器预览 / 旧版 WebView 下忽略 */ }
  }

  function applyTheme(mode, persist) {
    themeMode = THEME_MODES.indexOf(mode) >= 0 ? mode : 'dark';
    const resolved = themeMode === 'auto' ? sysTheme() : themeMode;
    const root = document.documentElement;

    root.classList.add('theme-switching');
    root.setAttribute('data-tm', themeMode);
    root.setAttribute('data-theme', resolved);
    syncWindowTheme(resolved);

    clearTimeout(applyTheme._timer);
    applyTheme._timer = setTimeout(() => root.classList.remove('theme-switching'), 240);

    const btn = $('themeBtn');
    if (btn) btn.title = '主题：' + THEME_LABEL[themeMode] + '（点击切换）';

    if (persist) {
      try { localStorage.setItem(THEME_KEY, themeMode); } catch (e) {}
    }
    return resolved;
  }

  function cycleTheme() {
    const next = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
    applyTheme(next, true);
    toast('主题：' + THEME_LABEL[next]);
  }

  function initTheme() {
    let saved = 'dark';
    try { saved = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
    applyTheme(saved, false);

    const btn = $('themeBtn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', cycleTheme);
    }
    // auto 模式下，系统切换主题要实时跟随
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: light)')
          .addEventListener('change', () => { if (themeMode === 'auto') applyTheme('auto', false); });
      } catch (e) { /* 旧内核只支持 addListener，忽略即可 */ }
    }
  }

  /* ---------- 引擎缺失引导弹窗（v3.2.0） ----------
     背景：引擎缺失原先只在侧栏底部显示一行小字，普通用户看不到也修不了。
     现在启动检测失败即弹窗，把「找过哪些路径」直接列出来，
     并给「打开程序文件夹」按钮，用户自己对照就能定位。 */
  let engineInfo = null;   // 最近一次 engine_status 的完整结果

  function openEngineHelp(info) {
    if (info) engineInfo = info;
    const list = $('engineCands');
    /* 路径太长会把关键信息（末尾的 workaid-cli.exe）挤掉，
       这里做「中间省略」：保留盘符开头 + 末尾两级，完整路径挂 title。 */
    const midShort = (p) => {
      const s = String(p || '');
      if (s.length <= 66) return s;
      return s.slice(0, 20) + '…' + s.slice(-45);
    };
    if (list) {
      const cands = (engineInfo && engineInfo.candidates) || [];
      list.innerHTML = cands.length
        ? cands.map((c) => `<div class="cand${c.exists ? ' ok' : ''}">
             <span class="cand-from">${esc(c.from)}</span>
             <span class="cand-st">${c.exists ? '✓' : '✗'}</span>
             <code title="${esc(c.path)}">${esc(midShort(c.path))}</code>
           </div>`).join('')
        : '<div class="cand"><code>（没能取到路径信息）</code></div>';
    }
    $('engineMask').classList.add('show');
  }

  function closeEngineHelp() { $('engineMask').classList.remove('show'); }

  function engineOpenDir() {
    const dir = (engineInfo && engineInfo.app_dir) || '';
    if (!dir) return toast('无法定位程序所在文件夹');
    invoke('open_path', { path: dir }).catch((e) => toast('打开失败：' + e));
  }

  async function engineRecheck() {
    const btn = $('engineRecheck');
    btn.disabled = true;
    btn.textContent = '检测中…';
    try {
      const st = await invokeT('engine_status', null, 5000);
      engineInfo = st || null;
      const foot = $('navFoot');
      if (st && st.exists) {
        S.engineOk = true;
        foot.classList.remove('bad');
        foot.classList.add('ok');
        $('footText').textContent = '就绪 · 转换引擎可用';
        closeEngineHelp();
        log('转换引擎已就绪：' + st.engine, 'ok');
        toast('转换引擎已就绪');
      } else {
        S.engineOk = false;
        openEngineHelp(st);
        toast('仍未找到转换引擎');
      }
    } catch (e) {
      toast('检测失败：' + e);
    } finally {
      btn.disabled = false;
      btn.textContent = '重新检测';
    }
  }

  $('engineClose').addEventListener('click', closeEngineHelp);
  $('engineOpenDir').addEventListener('click', engineOpenDir);
  $('engineRecheck').addEventListener('click', engineRecheck);
  $('engineMask').addEventListener('click', (e) => {
    if (e.target === $('engineMask')) closeEngineHelp();
  });

  $('donateClose').addEventListener('click', closeDonate);
  $('donateMask').addEventListener('click', (e) => {
    if (e.target === $('donateMask')) closeDonate();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDonate(); closeEngineHelp(); }
  });

  /* ---------- 纯前端页（图片重命名） ---------- */
  async function runFrontendOnly(p) {
    if (p.id !== 'rename') return toast('该页尚未接入');

    // 同名预检（同一目录内新名字互相冲突）
    const names = S.files.map((f, i) => newNameFor(f, i));
    const seen = new Set();
    const dupIdx = new Set();
    S.files.forEach((f, i) => {
      const key = (H.dirOf(f.path) + '\\' + names[i]).toLowerCase();
      if (seen.has(key)) dupIdx.add(i);
      seen.add(key);
    });
    if (dupIdx.size) {
      dupIdx.forEach((i) => { S.files[i].status = 'err'; S.files[i].msg = '名称冲突'; });
      renderList();
      toast('存在重名冲突，请调整命名规则');
      return;
    }

    S.running = true;
    setGo('run');
    S.files.forEach((f) => { f.status = 'work'; f.msg = ''; });
    setStatus(`正在重命名 <b>0/${S.files.length}</b>`);
    renderList();

    let resp;
    try {
      resp = await invoke('rename_files', {
        items: S.files.map((f, i) => ({ from: f.path, to: names[i] })),
      });
    } catch (e) {
      S.running = false;
      S.files.forEach((f) => { f.status = 'err'; f.msg = '执行失败'; });
      renderList();
      log('重命名执行失败：' + e, 'err');
      return;
    }

    // 逐项对齐状态
    let ok = 0, fail = 0;
    (resp.results || []).forEach((r, i) => {
      const f = S.files[i];
      if (!f) return;
      if (r.ok) {
        ok++;
        f.status = 'ok';
        f.msg = '完成';
        f.name = r.to || names[i];
        f.ext = H.extOf(f.name).slice(1);
        f.path = H.joinOut(f.dir, f.name);
        log(`${names[i]} 已重命名`, 'ok');
      } else if (r.kind === 'conflict') {
        fail++;
        f.status = 'err';
        f.msg = '名称冲突';
        log(`冲突：${f.name} → ${r.to}（${r.message}）`, 'warn');
      } else {
        fail++;
        f.status = 'err';
        f.msg = '失败';
        log(`失败：${f.name} → ${r.to}（${r.message}）`, 'err');
      }
    });

    S.running = false;
    setGo('done');
    setProgress(100, true);
    setStatus(`全部完成 · 成功 ${ok}${fail ? ` · 失败 ${fail}` : ''}`);
    renderList();
    showResult({ ok, fail, skip: 0, secs: '0.1', out: S.files.length ? H.dirOf(S.files[0].path) : '' });
  }

  /* ============================================================
     ⑥ 结果条 / 日志 / 提示
     ============================================================ */
  function showResult(o) {
    const bar = $('resultBar');
    bar.style.display = 'flex';
    bar.classList.toggle('warn', o.fail > 0);
    bar.querySelector('.ck').textContent = o.fail > 0 ? '!' : '✓';
    $('resultTitle').textContent = o.fail > 0
      ? `处理完成：成功 ${o.ok} · 失败 ${o.fail}`
      : `处理完成：共 ${o.ok} 个${o.skip ? ` · 跳过 ${o.skip}` : ''}`;
    $('resultSub').textContent = (o.out ? `输出目录 ${o.out} · ` : '') + `用时 ${o.secs} 秒`;
    $('resultOpen').style.display = o.out ? 'inline' : 'none';
    $('resultOpen').dataset.path = o.out || '';
  }

  function hideResult() { $('resultBar').style.display = 'none'; }

  $('resultOpen').addEventListener('click', () => {
    const p = $('resultOpen').dataset.path;
    if (p) invoke('open_path', { path: p }).catch((e) => toast('打开失败：' + e));
  });

  function log(msg, kind) {
    const d = new Date();
    const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    S.logs.push({ t, msg, kind: kind || 'info' });
    renderLogs();
  }

  function renderLogs() {
    const cls = { ok: 'ok', err: 'err', warn: 'warn' };
    const host = $('logDrawer');
    host.innerHTML = S.logs.slice(-200).map((l) =>
      `<div class="lg ${cls[l.kind] || ''}"><span class="t">${l.t}</span>${esc(l.msg)}</div>`).join('');
    host.scrollTop = host.scrollHeight;
    $('logLabel').textContent = S.logs.length ? `运行日志（${S.logs.length} 条）` : '运行日志';
  }

  $('logBar').addEventListener('click', () => {
    $('logDrawer').classList.toggle('open');
    $('logBar').classList.toggle('open');
  });

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  $('goBtn').addEventListener('click', run);

  /* ============================================================
     ⑦ 拖拽
     ------------------------------------------------------------
     Tauri 环境（dragDropEnabled）下 HTML5 drop 的 File.path 拿不到
     真实路径，必须用 webview.onDragDropEvent（payload.paths 是绝对路径）。
     浏览器 mock 调试时保留 HTML5 流程。
     ============================================================ */
  const mask = $('dropMask');

  function dropHintFor(p) {
    if (p.pickMode === 'single') return '拖入单个文件';
    return p.exts && p.exts.length ? `支持 ${p.exts.join(' / ')}，可整个文件夹拖入` : '可拖入文件或文件夹';
  }

  function showDropMask() {
    const p = findPage(S.pageId);
    $('dropHint').textContent = dropHintFor(p);
    mask.classList.add('show');
  }

  async function handleDroppedPaths(paths) {
    if (S.running) return toast('转换进行中');
    if (!paths || !paths.length) return;
    await addPaths(paths);
  }

  function bindTauriDragDrop() {
    const t = tauriCore();
    if (!t || !t.webview || !t.webview.getCurrentWebview) return false;
    try {
      t.webview.getCurrentWebview().onDragDropEvent((event) => {
        const type = event.payload && event.payload.type;
        if (type === 'enter') showDropMask();
        else if (type === 'leave') mask.classList.remove('show');
        else if (type === 'drop') {
          mask.classList.remove('show');
          handleDroppedPaths(event.payload.paths || []);
        }
        // over：无需处理（遮罩已显示）
      });
      return true;
    } catch (e) {
      console.warn('onDragDropEvent 绑定失败', e);
      return false;
    }
  }

  // HTML5 流程（浏览器 mock 用；Tauri 下被原生拖拽接管，不触发）
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (tauriCore()) return;               // Tauri 环境交给 onDragDropEvent
    dragDepth++;
    showDropMask();
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (tauriCore()) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) mask.classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (tauriCore()) return;
    dragDepth = 0;
    mask.classList.remove('show');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    // 浏览器里拿不到绝对路径，只能拿到文件名（仅用于样式调试）
    handleDroppedPaths(files.map((f) => f.path || f.name).filter(Boolean));
  });

  /* ============================================================
     ⑧ 启动
     ------------------------------------------------------------
     原则：**先渲染 UI，后端检测延迟到 load 事件后**。
     实测坑（本机 WebView2）：页面脚本执行瞬间发起的 invoke 会永久
     pending（IPC 未就绪）→ 曾经把整个渲染阻塞成空骨架。
     UI 渲染必须零等待、零 invoke；检测一律走 invokeT + 重试。
     ============================================================ */
  function boot() {
    // ① 界面立即渲染（纯 DOM，零 invoke）
    initTheme();                  // 主题先定，避免后续渲染出现深浅混搭的一帧
    renderNav();
    renderPage();
    renderParams();
    renderList();
    renderLogs();
    setProgress(0, false);
    setStatus('就绪');
    $('footSupport').addEventListener('click', openDonate);
    $('footGithub').addEventListener('click', openGithub);
    bindFootLinks();

    // ② 后端检测：等 load + 下一轮事件循环，IPC 通道就绪后再发
    const start = () => {
      setTimeout(backendChecks, 30);
      bindTauriDragDrop();        // 真实路径拖拽（Tauri 环境）
      // 窗口就绪后再同步一次标题栏主题：boot 瞬间 __TAURI__ 可能还没注入
      syncWindowTheme(themeMode === 'auto' ? sysTheme() : themeMode);
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);

    // 自动化/调试钩子（CDP 驱动端到端验证用；生产环境无副作用）
    window.__WA_DEBUG__ = {
      state: S,
      addPaths,
      run,
      switchPage,
      helpers: H,
      setParam: (k, v) => { S.params[k] = v; },
      theme: () => ({ mode: themeMode, resolved: document.documentElement.getAttribute('data-theme') }),
      setTheme: (m) => applyTheme(m, true),
      cycleTheme,
    };
  }

  /* ============================================================
     启动期后端检测（性能要点，勿改回递归重跑整个函数）
     ------------------------------------------------------------
     坑（2026-10-05 实测）：旧写法把 engine_status 的重试写成
       setTimeout(() => backendChecks(n+1))
     会连带 engine_actions 一起重复执行 —— 每次 spawn 一个 Python 子进程
     （~0.7s），启动期日志刷屏「引擎就绪，共 10 个动作」多遍，就绪拖到 17s。
     正确做法：
       ① 轻量探针（app_info / engine_status）走「单次 + 指数退避」重试；
       ② 重量检查（engine_actions，会 spawn）只在通道打通后跑**一次**。
     ============================================================ */

  function backendChecks() {
    log('后端检测开始', 'info');
    // app_info：轻量，失败静默重试
    probe('app_info', null, 2500, (info) => {
      if (info && info.version) {
        $('brandVer').textContent = 'v' + info.version;
      }
    });

    // engine_status：只查文件存在，不 spawn。启动期**不做** engine_actions ——
    // 那次调用要 spawn 一个 Python 子进程，只会拖慢启动，且其唯一作用
    // （核对配置里的动作名是否引擎都提供）属于开发期自检。
    // 若确实需要，可用 --verbose 思路在开发时手动触发（见 checkEngineActions）。
    probe('engine_status', null, 2500, (st) => {
      const foot = $('navFoot');
      engineInfo = st || null;
      if (st && st.exists) {
        foot.classList.add('ok');
        $('footText').textContent = '就绪 · 转换引擎可用';
        S.engineOk = true;
      } else {
        foot.classList.add('bad');
        $('footText').textContent = '未检测到转换引擎';
        S.engineOk = false;
        log('未检测到 workaid-cli.exe，转换功能不可用', 'err');
        openEngineHelp(st);   // 关键：别让用户只看到一行小字
      }
    }, () => {
      $('navFoot').classList.add('bad');
      $('footText').textContent = '引擎检测失败';
      S.engineOk = false;
      log('引擎状态检测失败（IPC 持续未响应）', 'err');
      // IPC 超时不等于引擎缺失，不弹引导窗（否则会误导用户去搬文件）
    });
  }

  /* 单次探针 + 指数退避重试（1.5s 起，上限 8s，总时长约 3 分钟）。
     只为受限环境兜底；真实桌面毫秒级就绪，首次即成功。 */
  function probe(cmd, args, ms, onOk, onGiveUp) {
    let delay = 1500;
    const dead = Date.now() + 180000;
    let tries = 0;

    const attempt = () => {
      tries++;
      invokeT(cmd, args, ms).then(onOk).catch(() => {
        if (Date.now() > dead) {
          if (onGiveUp) onGiveUp();
          return;
        }
        setTimeout(attempt, delay);
        delay = Math.min(delay * 1.6, 8000);
      });
    };
    attempt();
  }

  /* 深度检查：spawn 一次 CLI 做动作自描述核对。**只允许调用一次**。 */
  let actionsChecked = false;
  function checkEngineActions() {
    if (actionsChecked) return;
    actionsChecked = true;
    invokeT('engine_actions', null, 20000).then((a) => {
      if (a && a.available && Array.isArray(a.actions)) {
        const engineSet = new Set(a.actions.map((x) => x.name));
        const missing = PAGES.filter((p) => p.action && !engineSet.has(p.action));
        if (missing.length) log('配置中有引擎未提供的动作：' + missing.map((m) => m.action).join(', '), 'warn');
      }
    }).catch(() => {});
  }

  boot();
})();
