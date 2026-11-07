/* 页面装配：标签页、上传、调用管线、对话代理、打包下载 */
(function () {
  const state = {
    files: { front: null, back: null, side: null, model: null, ref: null },
    sheetCanvas: null,
    sheetBlob: null,
    sheetConfig: null,
    glbBlob: null,
    glbUrl: null,
    assets: [],          // { filename, blob, kind }
    history: [],         // 发给模型的对话历史
    busy: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------- 标签页 ---------- */
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab.dataset.panel));
    });
  });

  /* ---------- 日志 ---------- */
  function setLog(el, text) {
    el.innerHTML = NY.util.paintLog(text);
  }

  /* ---------- 上传 ---------- */
  function setFile(file, kind, dropEl) {
    state.files[kind] = file;
    const thumb = dropEl.querySelector('.thumb');
    if (thumb.dataset.url) URL.revokeObjectURL(thumb.dataset.url);
    const url = URL.createObjectURL(file);
    thumb.src = url;
    thumb.dataset.url = url;
    dropEl.classList.add('filled');
  }

  $$('[data-drop]').forEach((el) => {
    const kind = el.dataset.drop;
    const input = el.querySelector('input[type="file"]');
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) setFile(input.files[0], kind, el);
    });
    ['dragenter', 'dragover'].forEach((ev) =>
      el.addEventListener(ev, (e) => {
        e.preventDefault();
        el.classList.add('dragover');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      el.addEventListener(ev, (e) => {
        e.preventDefault();
        el.classList.remove('dragover');
      })
    );
    el.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) setFile(file, kind, el);
    });
  });

  // 优先用专用上传位，其次用对话里的参考图
  function pickImage(...kinds) {
    for (const kind of kinds) {
      if (state.files[kind]) return state.files[kind];
    }
    return null;
  }

  /* ---------- 产物 ---------- */
  function renderAssets() {
    const list = $('#asset-list');
    if (!state.assets.length) {
      list.innerHTML = '<span class="muted small">还没有生成文件</span>';
      return;
    }
    list.innerHTML = state.assets
      .map(
        (a, i) =>
          `<span class="asset" data-idx="${i}" title="点击下载">${NY.util.escapeHtml(a.filename)}` +
          `<span class="size">${NY.util.formatBytes(a.blob.size)}</span></span>`
      )
      .join('');
    list.querySelectorAll('.asset').forEach((chip) => {
      chip.addEventListener('click', () => {
        const a = state.assets[Number(chip.dataset.idx)];
        NY.util.downloadBlob(a.blob, a.filename);
      });
    });
  }

  function addAsset(filename, blob, kind) {
    // 同名覆盖，避免重复生成时产物越堆越多
    state.assets = state.assets.filter((a) => a.filename !== filename);
    state.assets.push({ filename, blob, kind });
    renderAssets();
    $('#model-zip').disabled = false;
  }

  function clearAssets() {
    state.assets = [];
    state.sheetBlob = null;
    state.sheetCanvas = null;
    state.glbBlob = null;
    if (state.glbUrl) { URL.revokeObjectURL(state.glbUrl); state.glbUrl = null; }
    $('#viewer').removeAttribute('src');
    $('#sprite-download').disabled = true;
    $('#model-download').disabled = true;
    $('#model-zip').disabled = true;
    renderAssets();
  }

  /* ---------- 2D 行走图 ---------- */
  async function buildSprite(overrides) {
    const frontFile = pickImage('front', 'ref');
    if (!frontFile) {
      setLog($('#sprite-log'), '[失败] 请先上传正面图');
      return null;
    }
    const frameSel = $('#sprite-frame').value;
    const frame = frameSel.split('x').map(Number);
    const opts = Object.assign(
      {
        frame,
        heightRatio: Number($('#sprite-ratio').value),
        colors: Number($('#sprite-colors').value) || 0,
        keepCorner: $('#sprite-keep-corner').checked,
        tol: 26,
      },
      overrides || {}
    );
    if (overrides && overrides.frame && typeof overrides.frame === 'string') {
      opts.frame = overrides.frame.split('x').map(Number);
    }
    if (overrides && overrides.height_ratio) opts.heightRatio = Number(overrides.height_ratio);

    setLog($('#sprite-log'), '[提示] 正在处理图片…');
    const imgs = {};
    try {
      for (const key of ['front', 'back', 'side']) {
        const file = state.files[key] || (key === 'front' ? state.files.ref : null);
        if (file) imgs[key] = await NY.util.loadImage(file);
      }
      const res = await NY.sprite.build(Object.assign({}, opts, imgs));

      const canvas = $('#sprite-preview');
      canvas.width = res.preview.width;
      canvas.height = res.preview.height;
      canvas.getContext('2d').drawImage(res.preview, 0, 0);

      state.sheetCanvas = res.sheet;
      state.sheetConfig = res.config;
      state.sheetBlob = await NY.sprite.toBlob(res.sheet);

      const filename = `hero_walk_${res.sheet.width}x${res.sheet.height}.png`;
      addAsset(filename, state.sheetBlob, 'sprite');
      $('#sprite-download').disabled = false;
      setLog($('#sprite-log'), res.log.concat(`[完成] ${filename} 已生成（${res.sheet.width}×${res.sheet.height}）`).join('\n'));
      return filename;
    } catch (err) {
      setLog($('#sprite-log'), '[失败] ' + err.message);
      return null;
    }
  }

  $('#sprite-build').addEventListener('click', () => { buildSprite(); });
  $('#sprite-ratio').addEventListener('input', (e) => {
    $('#lbl-ratio').textContent = Number(e.target.value).toFixed(2);
  });
  $('#sprite-download').addEventListener('click', () => {
    if (state.sheetBlob) {
      NY.util.downloadBlob(state.sheetBlob, `hero_walk_${state.sheetCanvas.width}x${state.sheetCanvas.height}.png`);
    }
  });

  /* ---------- 3D 角色 ---------- */
  function syncProviderFields() {
    const provider = $('#model-provider').value;
    $$('[data-provider]').forEach((el) => {
      el.style.display = el.dataset.provider === provider ? '' : 'none';
    });
  }
  $('#model-provider').addEventListener('change', syncProviderFields);

  async function run3D(overrides) {
    const file = pickImage('model', 'ref', 'front');
    if (!file) {
      setLog($('#model-log'), '[失败] 请先上传人物图片');
      return null;
    }
    const o = Object.assign({}, overrides || {});
    const provider = o.provider || $('#model-provider').value;
    const opts = {
      file,
      provider,
      space: $('#model-space').value.trim() || NY.config.data.space,
      apiName: $('#model-api').value.trim() || '/generation_all',
      url: $('#model-url').value.trim() || NY.config.data.restUrl,
      field: $('#model-field').value.trim() || 'image',
      apiKey: $('#model-key').value.trim(),
      timeout: 300,
      onLog: (text) => setLog($('#model-log'), text),
    };
    if (provider === 'rest' && !opts.url) {
      setLog($('#model-log'), '[失败] REST 后端需要填接口地址');
      return null;
    }

    setLog($('#model-log'), '[提示] 正在请求远端服务…');
    try {
      const res = await NY.model3d.run(opts);
      state.glbBlob = res.blob;
      if (state.glbUrl) URL.revokeObjectURL(state.glbUrl);
      state.glbUrl = URL.createObjectURL(res.blob);
      const viewer = $('#viewer');
      if (viewer.setAttribute) viewer.setAttribute('src', state.glbUrl);

      addAsset(res.filename, res.blob, 'model');
      $('#model-download').disabled = false;
      setLog($('#model-log'), res.log.concat(`[完成] ${res.filename}（${NY.util.formatBytes(res.blob.size)}）`).join('\n'));
      return res.filename;
    } catch (err) {
      setLog($('#model-log'), typeof err.message === 'string' ? err.message : '[失败] ' + err);
      return null;
    }
  }

  $('#model-run').addEventListener('click', () => { run3D(); });
  $('#model-download').addEventListener('click', () => {
    if (state.glbBlob) NY.util.downloadBlob(state.glbBlob, 'character.glb');
  });
  $('#model-zip').addEventListener('click', () => { zipAll(); });

  /* ---------- 打包下载 ---------- */
  async function zipAll() {
    if (!state.assets.length) {
      setLog($('#model-log'), '[提示] 还没有可打包的产物');
      return;
    }
    const manifest = {
      name: 'nanyang3Dcuit',
      generated_at: new Date().toISOString(),
      assets: state.assets.map((a) => ({ filename: a.filename, kind: a.kind, size: a.blob.size, type: a.blob.type })),
      sprite: state.sheetConfig || null,
      note: '2D 行走图按 RPG Maker 图集规则：3 帧 x 4 方向；3D 为远端服务重建结果。',
    };
    const readme = [
      'nanyang3Dcuit 导出包',
      '',
      '2D 行走图（png）：',
      '  RPG Maker VX / VX Ace：放进 img/characters/，在数据库-角色-行走图选对应图。',
      '  MV / MZ：放进 img/characters/，图集规格为 3 帧 x 4 方向。',
      '',
      '3D 模型（glb）：',
      '  可直接拖进 Blender / Unity / three.js 查看器。',
      '  浏览器预览：把 glb 放在同目录，用任意 glTF 查看器打开。',
      '',
      '注意：3D 结果由远端服务生成，本机不加载模型权重。',
    ].join('\n');

    if (!window.JSZip) {
      // CDN 没加载成功时退化为逐个下载
      state.assets.forEach((a) => NY.util.downloadBlob(a.blob, a.filename));
      return;
    }
    const zip = new window.JSZip();
    const folder = zip.folder('nanyang3dcuit');
    state.assets.forEach((a) => folder.file(a.filename, a.blob));
    folder.file('manifest.json', JSON.stringify(manifest, null, 2));
    folder.file('导入说明.txt', readme);
    const blob = await zip.generateAsync({ type: 'blob' });
    NY.util.downloadBlob(blob, 'nanyang3dcuit_export.zip');
  }

  $('#dock-zip').addEventListener('click', zipAll);
  $('#dock-clear').addEventListener('click', clearAssets);

  /* ---------- 对话代理 ---------- */
  const chatLog = $('#chat-log');

  function addMessage(role, text, extraClass) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-' + role + (extraClass ? ' ' + extraClass : '');
    const name = role === 'user' ? '你' : role === 'sys' ? '系统' : '代理';
    wrap.innerHTML = `<div class="msg-role">${name}</div><div class="msg-body">${NY.util.textToHtml(text)}</div>`;
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
    return wrap;
  }

  function setBusy(flag) {
    state.busy = flag;
    $('#chat-send').disabled = flag;
  }

  async function executePlan(plan) {
    if (!plan || plan.action === 'none') return null;
    if (plan.action === 'sprite_sheet') {
      const name = await buildSprite({
        frame: plan.frame,
        height_ratio: plan.height_ratio,
        colors: plan.colors,
      });
      return name ? `已生成行走图 ${name}` : '行走图没有生成成功，详情看「2D 行走图」里的日志。';
    }
    if (plan.action === 'model_3d') {
      const name = await run3D({
        provider: plan.provider,
        space: plan.space,
        api_name: plan.api_name,
      });
      return name ? `已生成 3D 模型 ${name}` : '3D 生成失败，详情看「3D 角色」里的日志。';
    }
    if (plan.action === 'download') {
      await zipAll();
      return '已打包，浏览器应该已开始下载 ZIP。';
    }
    return null;
  }

  async function send() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = '';
    addMessage('user', text);

    const hasRef = Boolean(pickImage('ref', 'front', 'model'));
    const pending = addMessage('bot', '…');

    setBusy(true);
    try {
      let reply, plan;
      if (NY.config.hasAgent()) {
        state.history.push({ role: 'user', content: text + `\n[当前参考图：${hasRef ? '已上传' : '未上传'}]` });
        try {
          const raw = await NY.agent.chat(state.history.slice(-8));
          const parsed = NY.agent.parse(raw);
          reply = parsed.display || '好的。';
          plan = parsed.plan;
          state.history.push({ role: 'assistant', content: raw });
        } catch (err) {
          const fallback = NY.agent.offline(text, hasRef);
          reply = `模型接口不可用（${err.message}），改用本地规则。\n` + fallback.display;
          plan = fallback.plan;
        }
      } else {
        const fallback = NY.agent.offline(text, hasRef);
        reply = fallback.display;
        plan = fallback.plan;
      }

      pending.querySelector('.msg-body').innerHTML = NY.util.textToHtml(reply);

      if (plan && plan.action !== 'none') {
        const result = await executePlan(plan);
        if (result) addMessage('sys', result, 'msg-sys');
      }
    } catch (err) {
      pending.querySelector('.msg-body').innerHTML = NY.util.textToHtml('[失败] ' + err.message);
    } finally {
      setBusy(false);
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  }

  $('#chat-send').addEventListener('click', send);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $$('#quick-actions button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#chat-input').value = btn.dataset.say;
      send();
    });
  });

  /* ---------- 仓库拉取 ---------- */
  function repoBase() {
    return (NY.config.data.repoUrl || '').trim().replace(/\/+$/, '');
  }

  function updateRepoLinks() {
    const base = repoBase();
    if (!base) return;
    $('#repo-zip').href = base + '/archive/refs/heads/main.zip';
    $('#repo-open').href = base;
    $('#repo-inline').href = base;
    $('#repo-inline').textContent = 'GitHub 仓库';
  }

  $('#repo-copy').addEventListener('click', async () => {
    const cmd = 'git clone ' + repoBase() + '.git';
    try {
      await navigator.clipboard.writeText(cmd);
      setLog($('#cfg-log'), '[完成] 已复制：' + cmd);
    } catch (err) {
      // 非 https / 本地 file 打开时剪贴板不可用，给出可手动复制的原文
      setLog($('#cfg-log'), '[提示] 剪贴板不可用，请手动复制：\n' + cmd);
    }
  });

  /* ---------- 设置 ---------- */
  function fillSettings() {
    const c = NY.config.data;
    $('#cfg-base').value = c.baseUrl || '';
    $('#cfg-key').value = c.apiKey || '';
    $('#cfg-model').value = c.model || '';
    $('#cfg-space').value = c.space || '';
    $('#cfg-rest').value = c.restUrl || '';
    $('#cfg-repo').value = c.repoUrl || '';
    $('#model-space').value = c.space || '';
    $('#model-url').value = c.restUrl || '';
    updateRepoLinks();
    updateAgentChip();
  }

  function updateAgentChip() {
    const chip = $('#chip-agent');
    if (NY.config.hasAgent()) {
      chip.textContent = '代理：云端模型';
      chip.classList.add('chip-on');
    } else {
      chip.textContent = '代理：本地规则';
      chip.classList.remove('chip-on');
    }
  }

  $('#cfg-save').addEventListener('click', () => {
    const ok = NY.config.save({
      baseUrl: $('#cfg-base').value.trim(),
      apiKey: $('#cfg-key').value.trim(),
      model: $('#cfg-model').value.trim() || 'gpt-4o-mini',
      space: $('#cfg-space').value.trim() || 'tencent/Hunyuan3D-2',
      restUrl: $('#cfg-rest').value.trim(),
      repoUrl: $('#cfg-repo').value.trim() || NY.config.data.repoUrl,
    });
    $('#model-space').value = NY.config.data.space;
    $('#model-url').value = NY.config.data.restUrl;
    updateRepoLinks();
    updateAgentChip();
    setLog($('#cfg-log'), ok ? '[完成] 设置已保存到本机浏览器' : '[失败] 保存失败（可能是禁用 localStorage）');
  });

  $('#cfg-clear').addEventListener('click', () => {
    NY.config.clear();
    fillSettings();
    setLog($('#cfg-log'), '[提示] 已清除本机数据，刷新后代理回到本地规则');
  });

  /* ---------- 初始化 ---------- */
  syncProviderFields();
  fillSettings();
  renderAssets();
})();
