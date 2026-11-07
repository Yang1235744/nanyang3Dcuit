/* 创作代理：走 OpenAI 兼容 /chat/completions；没配 Key 时退化为本地关键词规则 */
(function () {
  const SYSTEM_PROMPT = [
    '你是 nanyang3Dcuit 的创作代理，负责把用户的一句需求变成实际文件。',
    '规则：',
    '1. 用中文回答，简短，先给结论，不要长篇解释。',
    '2. 需要执行动作时，在回复最后追加一个 ```json 代码块，里面只有一个 JSON 对象，action 取值：',
    '   - "sprite_sheet"：把当前参考图做成 RPG Maker 行走图，可选 frame("32x48"|"48x48"|"32x32")、height_ratio(0.5-1)、colors(0-48)',
    '   - "model_3d"：把当前参考图转成 GLB 3D 角色，可选 provider("local"|"gradio"|"rest")、space、api_name',
    '   - "download"：把已生成的产物打包成 ZIP',
    '   - "none"：纯对话，不执行',
    '3. 不要谎称文件已经生成，只输出指令，前端会真正执行并把结果回给你。',
    '4. 用户没上传参考图时，提醒他先在对话里上传一张人物图片，不要输出 sprite_sheet / model_3d。',
    '5. 一次最多给一个动作，需要两步就先做第一步，等结果再说第二步。',
  ].join('\n');

  const ACTIONS = ['sprite_sheet', 'model_3d', 'download', 'none'];

  function normalizeBase(baseUrl) {
    const base = baseUrl.trim().replace(/\/+$/, '');
    return base.endsWith('/chat/completions') ? base : base + '/chat/completions';
  }

  // 调用模型；失败时抛出可读中文错误，由上层决定是否退回本地规则
  async function chat(messages) {
    const cfg = NY.config.data;
    if (!NY.config.hasAgent()) throw new Error('未配置 API，使用本地规则');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let resp;
    try {
      resp = await fetch(normalizeBase(cfg.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(messages),
          temperature: 0.6,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error('请求模型失败：' + (err.name === 'AbortError' ? '超时' : err.message));
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 200); } catch (e) { /* 忽略 */ }
      throw new Error(`模型接口 HTTP ${resp.status}${detail ? '：' + detail : ''}`);
    }
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    if (!content) throw new Error('模型返回空内容');
    return content;
  }

  // 从回复里摘出最后一个 ```json 块，返回 {display, plan}
  function parse(text) {
    const re = /```json\s*([\s\S]*?)```/gi;
    let match, last = null;
    while ((match = re.exec(text))) last = match;
    if (!last) return { display: text.trim(), plan: null };

    let plan = null;
    try {
      const obj = JSON.parse(last[1]);
      if (obj && ACTIONS.includes(obj.action)) plan = obj;
    } catch (err) {
      plan = null;
    }
    const display = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
    return { display, plan };
  }

  // 没有 API 时的兜底：按关键词路由，保证页面始终可用
  function offline(text, hasRef) {
    if (!hasRef) {
      return {
        display: '还没看到参考图。先在下面「参考图」处上传一张人物图片，我就能开工。',
        plan: { action: 'none' },
      };
    }
    if (/行走图|2d|精灵|sprite|像素|rpg\s*maker/i.test(text)) {
      return {
        display: '收到，按 RPG Maker 规格出图：32×48 帧尺寸，正面抠图后拼成 3 帧 × 4 方向。',
        plan: { action: 'sprite_sheet', frame: '32x48', height_ratio: 0.92 },
      };
    }
    if (/3d|三维|建模|模型|glb|立体/i.test(text)) {
      return {
        display: '收到，走本地 3D 管线：直接从这张图生成 GLB 浮雕模型，不联网、不加载权重。',
        plan: { action: 'model_3d' },
      };
    }
    if (/打包|下载|zip|压缩/i.test(text)) {
      return {
        display: '好，把当前产物打成 ZIP，里面带 manifest 和导入说明。',
        plan: { action: 'download' },
      };
    }
    return {
      display: '我可以把这你的参考图做成行走图，或生成 3D 角色，也可以把结果打包下载。你想要哪个？',
      plan: { action: 'none' },
    };
  }

  NY.agent = { chat, parse, offline, SYSTEM_PROMPT };
})();
