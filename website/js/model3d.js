/* 3D 管线：浏览器端把请求转到远端推理服务（Gradio Space 或 REST），本机不加载权重 */
(function () {
  const MODEL_SUFFIXES = ['.glb', '.gltf', '.zip', '.obj', '.ply', '.stl'];

  function spaceToBase(space) {
    // "tencent/Hunyuan3D-2" -> "https://tencent-hunyuan3d-2.hf.space"
    const slug = space.trim().replace(/\//g, '-').replace(/\./g, '-').toLowerCase();
    return 'https://' + slug + '.hf.space';
  }

  function withTimeout(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
  }

  function isModelPath(s) {
    const low = s.toLowerCase();
    return MODEL_SUFFIXES.some((suffix) => low.endsWith(suffix));
  }

  // Gradio 的返回值可能是 path / dict / 嵌套数组，递归捞出模型地址
  function findModelRef(value, out) {
    if (typeof value === 'string') {
      if (isModelPath(value)) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => findModelRef(item, out));
      return;
    }
    if (value && typeof value === 'object') {
      if (typeof value.url === 'string' && isModelPath(value.url)) out.push(value.url);
      if (typeof value.path === 'string' && isModelPath(value.path)) out.push(value.path);
      Object.values(value).forEach((item) => findModelRef(item, out));
    }
  }

  async function fetchOk(url, init) {
    const resp = await fetch(url, init);
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 240); } catch (e) { /* 忽略 */ }
      throw new Error(`HTTP ${resp.status} ${resp.statusText}${detail ? '：' + detail : ''}`);
    }
    return resp;
  }

  /* ---------- Gradio ---------- */
  async function gradioRun({ file, space, apiName, log, timeout }) {
    const base = spaceToBase(space);
    const api = apiName.startsWith('/') ? apiName : '/' + apiName;
    log(`[3D] Space：${space} -> ${base}`);
    log(`[3D] 接口：call${api}`);

    // 1) 上传文件
    const form = new FormData();
    form.append('files', file, file.name);
    let upload;
    let uploadPath;
    try {
      upload = await fetchOk(base + '/gradio_api/upload', { method: 'POST', body: form });
      const arr = await upload.json();
      uploadPath = Array.isArray(arr) ? arr[0] : arr;
    } catch (err) {
      throw new Error('上传到 Space 失败（可能是 CORS 或该 Space 已休眠）：' + err.message);
    }
    if (!uploadPath) throw new Error('Space 没有返回上传路径');
    log(`[3D] 已上传：${uploadPath}`);

    // 2) 发起调用，拿到 event_id
    const t = withTimeout(timeout);
    let eventId;
    try {
      const resp = await fetchOk(base + '/gradio_api/call' + api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [{ path: uploadPath, meta: { _type: 'gradio.FileData' } }] }),
        signal: t.signal,
      });
      const payload = await resp.json();
      eventId = payload.event_id;
    } catch (err) {
      t.done();
      throw new Error('调用接口失败（接口名 / 参数可能不匹配）：' + err.message);
    }
    if (!eventId) { t.done(); throw new Error('没有拿到 event_id'); }

    // 3) SSE 等待结果
    log('[3D] 排队中，3D 重建通常需要几十秒…');
    let resultData = null;
    let sseError = null;
    try {
      const resp = await fetchOk(base + '/gradio_api/call' + api + '/' + eventId, { signal: t.signal });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\n\n/);
        buffer = chunks.pop();
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          let event = 'message';
          const dataLines = [];
          chunk.split(/\n/).forEach((line) => {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          });
          if (!dataLines.length) continue;
          let data;
          try { data = JSON.parse(dataLines.join('\n')); } catch (e) { continue; }
          if (event === 'error') {
            sseError = new Error(String(data && (data.error || data.message) || 'Space 返回 error 事件'));
          } else if (event === 'complete') {
            resultData = data;
          }
        }
      }
    } catch (err) {
      throw new Error('等待结果失败：' + err.message);
    } finally {
      t.done();
    }

    if (sseError) throw sseError;
    if (resultData == null) throw new Error('Space 没有返回 complete 事件');

    const refs = [];
    findModelRef(resultData, refs);
    if (!refs.length) {
      throw new Error('Space 返回了结果，但里面没有 .glb / .gltf 文件：' + JSON.stringify(resultData).slice(0, 160));
    }
    log(`[3D] 服务返回文件引用：${refs[0]}`);

    // 4) 下载模型
    const ref = refs[0];
    const candidates = ref.startsWith('http')
      ? [ref]
      : [base + '/gradio_api/file=' + ref, base + '/file=' + ref, base + '/gradio_api/file=' + encodeURIComponent(ref)];
    let lastErr = null;
    for (const url of candidates) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(String(resp.status));
        const blob = await resp.blob();
        log(`[完成] 已下载模型（${(blob.size / 1024).toFixed(1)} KB）`);
        return { blob, filename: pickFilename(ref, blob) };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error('下载模型失败：' + (lastErr ? lastErr.message : '未知错误'));
  }

  /* ---------- REST ---------- */
  async function restRun({ file, url, field, apiKey, log, timeout }) {
    log(`[3D] POST ${url}`);
    const form = new FormData();
    form.append(field || 'image', file, file.name);

    const headers = {};
    if (apiKey) headers.Authorization = apiKey.startsWith('Bearer') ? apiKey : 'Bearer ' + apiKey;

    const t = withTimeout(timeout);
    let resp;
    try {
      resp = await fetchOk(url, { method: 'POST', body: form, headers, signal: t.signal });
    } catch (err) {
      t.done();
      throw new Error('请求失败（检查地址、CORS、Key 是否正确）：' + err.message);
    }
    t.done();

    const type = (resp.headers.get('Content-Type') || '').toLowerCase();
    let blob;
    if (type.includes('json')) {
      const data = await resp.json();
      const link = data.url || data.model_url || data.glb;
      if (!link) throw new Error('JSON 里找不到 url / model_url / glb 字段：' + JSON.stringify(data).slice(0, 160));
      log(`[3D] 下载模型：${link}`);
      const dl = await fetchOk(link);
      blob = await dl.blob();
    } else {
      blob = await resp.blob();
    }
    if (!blob || blob.size === 0) throw new Error('服务返回空内容');
    log(`[完成] 已下载模型（${(blob.size / 1024).toFixed(1)} KB）`);
    return { blob, filename: pickFilename(url, blob) };
  }

  function pickFilename(ref, blob) {
    const hit = MODEL_SUFFIXES.find((suffix) => ref.toLowerCase().includes(suffix));
    if (hit) return 'character' + hit;
    if (blob.type.includes('gltf')) return 'character.glb';
    return 'character.bin';
  }

  async function run(opts) {
    const log = [];
    const say = (msg) => { log.push(msg); opts.onLog && opts.onLog(log.join('\n')); };
    const timeout = (opts.timeout || 300) * 1000;
    const file = opts.file;
    if (!file) throw new Error('请先上传一张人物图片');
    if (file.size > 12 * 1024 * 1024) throw new Error('图片超过 12MB，先压缩一下');

    try {
      const result = opts.provider === 'rest'
        ? await restRun({ file, url: opts.url, field: opts.field, apiKey: opts.apiKey, log: say, timeout })
        : await gradioRun({ file, space: opts.space, apiName: opts.apiName, log: say, timeout });
      return Object.assign(result, { log });
    } catch (err) {
      say('[失败] ' + err.message);
      say('[提示] 浏览器直连常被 CORS 拦；可改用 --provider rest 指向自己的服务端转发。');
      throw new Error(log.join('\n'));
    }
  }

  NY.model3d = { run, spaceToBase };
})();
