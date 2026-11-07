/* 2D 行走图：浏览器端复刻 pipeline/sprite2d.py 的处理流程（纯 Canvas，不上传图片） */
(function () {
  // 与 Python 版一致：在接近原始分辨率上抠图，最后才把裁剪区缩到 32x48。
  // 若先缩小再抠图，缩放开销会在大反差边缘产生色环，被当成前景，包围盒会被撑宽。
  const MAX_SIDE = 1600;
  const DIRECTIONS = ['down', 'left', 'right', 'up'];
  const LABELS = { down: 'down 朝下', left: 'left 朝左', right: 'right 朝右', up: 'up 朝上' };

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function ctx2d(canvas, willReadFrequently) {
    return canvas.getContext('2d', { willReadFrequently: Boolean(willReadFrequently) });
  }

  /* ---------- 颜色空间 ---------- */
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let hue = 0;
    if (d !== 0) {
      if (max === r) hue = ((g - b) / d) % 6;
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return { h: hue, s: max === 0 ? 0 : d / max, v: max };
  }

  function hueDistance(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* ---------- 抠图 ---------- */
  // 从上方和左边采样，判断是不是洋红 / 绿幕；返回实测色相角，而不是标准 300°
  function detectScreenHue(data, w, h) {
    const samples = [];
    const stepX = Math.max(1, Math.floor(w / 40));
    for (let x = 0; x < w; x += stepX) {
      const i = (x * 4);                     // 第 0 行
      samples.push([data[i], data[i + 1], data[i + 2]]);
    }
    const stepY = Math.max(1, Math.floor(h / 40));
    for (let y = 0; y < h; y += stepY) {
      const i = (y * w) * 4;                 // 第 0 列
      samples.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (!samples.length) return null;
    let r = 0, g = 0, b = 0;
    for (const s of samples) { r += s[0]; g += s[1]; b += s[2]; }
    r /= samples.length; g /= samples.length; b /= samples.length;
    const hsv = rgbToHsv(r, g, b);
    if (hsv.s < 0.35 || hsv.v < 0.25) return null;   // 低饱和 / 太暗，不像幕布
    for (const target of [300, 120]) {
      if (hueDistance(hsv.h, target) <= 30) return hsv.h;
    }
    return null;
  }

  function clearCorner(imgData, fracW, fracH) {
    const { width: w, height: h, data } = imgData;
    const x0 = Math.max(0, Math.round(w * (1 - fracW)));
    const y0 = Math.max(0, Math.round(h * (1 - fracH)));
    for (let y = y0; y < h; y++) {
      for (let x = x0; x < w; x++) {
        data[(y * w + x) * 4 + 3] = 0;
      }
    }
  }

  // 返回 { note }，直接修改 imgData 的 alpha
  function stripBackground(imgData, tol, keepCorner) {
    const { width: w, height: h, data } = imgData;
    const note = [];

    // 原图已带透明通道就跳过抠图
    let hasAlpha = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) { hasAlpha = true; break; }
    }
    if (hasAlpha) return { note: '原图已带透明通道，跳过抠图', skipped: true };

    if (!keepCorner) {
      clearCorner(imgData, 0.28, 0.12);
      note.push('已清除右下角水印区');
    }

    const screen = detectScreenHue(data, w, h);
    if (screen !== null) {
      const tolDeg = 20;
      const mask = new Uint8Array(w * h);
      for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        const a = data[i + 3];
        if (a === 0) { mask[p] = 0; continue; }
        const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        // 色相接近幕布 + 足够艳 + 足够亮，才算背景候选，避免误删黑发和白衣
        const hit = hueDistance(hsv.h, screen) <= tolDeg && hsv.s >= 85 / 255 && hsv.v >= 55 / 255;
        mask[p] = hit ? 255 : 0;
      }

      // 3x3 均值只在边界产生中间值，等价于 Python 的轻度高斯软化
      const blurred = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0, cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              sum += mask[yy * w + xx];
              cnt++;
            }
          }
          blurred[y * w + x] = sum / cnt;
        }
      }

      for (let p = 0, i = 0; p < blurred.length; p++, i += 4) {
        data[i + 3] = Math.round(data[i + 3] * (1 - blurred[p] / 255));
      }
      note.unshift('已按色相 ' + Math.round(screen) + '° 抠幕布（可抗背景渐变）');
      return { note: note.join('，'), screen };
    }

    // 兜底：非标准幕布，按左上角颜色做色差抠图
    const bg = [data[0], data[1], data[2]];
    const hi = Math.max(tol + 1, Math.round(tol * 2.2));
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const dr = Math.abs(data[i] - bg[0]);
      const dg = Math.abs(data[i + 1] - bg[1]);
      const db = Math.abs(data[i + 2] - bg[2]);
      const diff = Math.max(dr, dg, db);
      let k;
      if (diff <= tol) k = 0;
      else if (diff >= hi) k = 1;
      else k = (diff - tol) / (hi - tol);
      data[i + 3] = Math.round(data[i + 3] * k);
    }
    note.unshift('已按背景色色差抠图（背景有渐变时边缘可能不干净）');
    return { note: note.join('，'), screen: null };
  }

  /* ---------- 包围盒 ---------- */
  // 用连通区域求包围盒：只要最大的几块（角色本体），滤掉水印、JPEG 噪点和背景残留。
  // 纯行列投影会被水印这类稀疏结构撑坏，导致角色被缩得很小、脚还悬空。
  function components(mask, w, h) {
    const visited = new Uint8Array(w * h);
    const boxes = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || visited[start]) continue;
      let x0 = start % w, x1 = x0;
      let y0 = Math.floor(start / w), y1 = y0;
      let area = 0;
      const queue = [start];
      visited[start] = 1;
      while (queue.length) {
        const p = queue.pop();
        const y = Math.floor(p / w);
        const x = p - y * w;
        area++;
        if (x < x0) x0 = x; else if (x > x1) x1 = x;
        if (y < y0) y0 = y; else if (y > y1) y1 = y;
        if (x > 0 && mask[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; queue.push(p - 1); }
        if (x < w - 1 && mask[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; queue.push(p + 1); }
        if (y > 0 && mask[p - w] && !visited[p - w]) { visited[p - w] = 1; queue.push(p - w); }
        if (y < h - 1 && mask[p + w] && !visited[p + w]) { visited[p + w] = 1; queue.push(p + w); }
      }
      boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
    }
    return boxes;
  }

  function contentBBox(imgData, alphaThr) {
    const { width: w, height: h, data } = imgData;
    const mask = new Uint8Array(w * h);
    for (let p = 0, i = 3; p < mask.length; p++, i += 4) {
      mask[p] = data[i] >= alphaThr ? 1 : 0;
    }
    const boxes = components(mask, w, h);
    if (!boxes.length) return null;

    let maxArea = 0;
    for (const b of boxes) if (b.area > maxArea) maxArea = b.area;
    // 面积不足最大块 6% 的碎片直接丢掉（水印、噪点、尘点）
    const kept = boxes.filter((b) => b.area >= maxArea * 0.06);

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of kept) {
      if (b.x < x0) x0 = b.x;
      if (b.y < y0) y0 = b.y;
      if (b.x + b.w > x1) x1 = b.x + b.w;
      if (b.y + b.h > y1) y1 = b.y + b.h;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* ---------- 缩放与拼图 ---------- */
  function normalize(img) {
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = makeCanvas(w, h);
    const ctx = ctx2d(canvas, true);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }

  function fitIntoFrame(srcCanvas, bbox, fw, fh, heightRatio) {
    const frame = makeCanvas(fw, fh);
    const ctx = ctx2d(frame);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const scale = Math.min((fh * heightRatio) / bbox.h, (fw * 0.98) / bbox.w);
    const nw = Math.max(1, Math.round(bbox.w * scale));
    const nh = Math.max(1, Math.round(bbox.h * scale));
    ctx.drawImage(srcCanvas, bbox.x, bbox.y, bbox.w, bbox.h,
      Math.round((fw - nw) / 2), fh - nh, nw, nh);
    return frame;
  }

  // 以脚底为锚点垂直压扁 / 拉伸，做 3 帧走路的身体起伏，脚不离地
  function bobFrame(frame, squash) {
    const w = frame.width, h = frame.height;
    if (Math.abs(squash - 1) < 0.005) {
      const copy = makeCanvas(w, h);
      ctx2d(copy).drawImage(frame, 0, 0);
      return copy;
    }
    const nh = Math.max(1, Math.round(h * squash));
    const canvas = makeCanvas(w, h);
    const ctx = ctx2d(canvas);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, 0, 0, w, nh, 0, h - nh, w, nh);
    return canvas;
  }

  function flip(frame) {
    const canvas = makeCanvas(frame.width, frame.height);
    const ctx = ctx2d(canvas);
    ctx.translate(frame.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(frame, 0, 0);
    return canvas;
  }

  // 等价 Pillow ImageEnhance.Brightness：RGB 整体乘系数，alpha 不动
  function darken(frame, factor) {
    const canvas = makeCanvas(frame.width, frame.height);
    const ctx = ctx2d(canvas, true);
    ctx.drawImage(frame, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i] = Math.min(255, Math.round(d[i] * factor));
      d[i + 1] = Math.min(255, Math.round(d[i + 1] * factor));
      d[i + 2] = Math.min(255, Math.round(d[i + 2] * factor));
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* ---------- 压色板（median cut） ---------- */
  function quantize(frame, maxColors) {
    const ctx = ctx2d(frame, true);
    const img = ctx.getImageData(0, 0, frame.width, frame.height);
    const data = img.data;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= 8) pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (!pixels.length || maxColors < 2) return frame;

    function widestChannel(box) {
      const min = [255, 255, 255];
      const max = [0, 0, 0];
      for (const p of box) {
        for (let c = 0; c < 3; c++) {
          if (p[c] < min[c]) min[c] = p[c];
          if (p[c] > max[c]) max[c] = p[c];
        }
      }
      let ch = 0, range = max[0] - min[0];
      for (let c = 1; c < 3; c++) {
        if (max[c] - min[c] > range) { range = max[c] - min[c]; ch = c; }
      }
      return { ch, range };
    }

    const boxes = [pixels];
    while (boxes.length < maxColors) {
      let pick = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        const r = widestChannel(boxes[i]).range;
        if (r > best) { best = r; pick = i; }
      }
      if (pick < 0 || best === 0) break;
      const box = boxes[pick];
      const ch = widestChannel(box).ch;
      box.sort((a, b) => a[ch] - b[ch]);
      const mid = Math.floor(box.length / 2);
      boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid));
    }

    const palette = boxes.filter((b) => b.length).map((b) => {
      let r = 0, g = 0, bl = 0;
      for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
      return [Math.round(r / b.length), Math.round(g / b.length), Math.round(bl / b.length)];
    });

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      let bestD = Infinity, bestColor = palette[0];
      for (const c of palette) {
        const dr = c[0] - data[i];
        const dg = c[1] - data[i + 1];
        const db = c[2] - data[i + 2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestD) { bestD = dist; bestColor = c; }
      }
      data[i] = bestColor[0];
      data[i + 1] = bestColor[1];
      data[i + 2] = bestColor[2];
    }
    ctx.putImageData(img, 0, 0);
    return frame;
  }

  /* ---------- 主流程 ---------- */
  async function build(opts) {
    const log = [];
    const fw = opts.frame[0];
    const fh = opts.frame[1];
    const heightRatio = opts.heightRatio || 0.92;
    const tol = opts.tol == null ? 26 : opts.tol;
    const colors = opts.colors || 0;
    const keepCorner = Boolean(opts.keepCorner);

    if (!opts.front) throw new Error('请至少提供正面图（正面是必填）');

    const prepared = {};
    for (const key of ['front', 'back', 'side']) {
      const img = opts[key];
      if (!img) continue;
      const canvas = normalize(img);
      const ctx = ctx2d(canvas, true);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = stripBackground(imgData, tol, keepCorner);
      ctx.putImageData(imgData, 0, 0);
      log.push(`[${key}] ${res.note}`);

      const bbox = contentBBox(imgData, 40);
      if (!bbox) {
        log.push(`[${key}] 未检测到角色内容，已跳过（检查背景是否干净）`);
        continue;
      }
      let frame = fitIntoFrame(canvas, bbox, fw, fh, heightRatio);
      if (colors > 0) frame = quantize(frame, colors);
      prepared[key] = frame;
    }

    const front = prepared.front;
    if (!front) throw new Error('正面图里没有识别到角色，请换一张背景更干净的图片');

    let right, left, back;
    if (prepared.side) {
      right = prepared.side;
      left = flip(right);
    } else {
      right = flip(front);
      left = front;
      log.push('[side] 未提供侧面图，已用正面 / 镜像占位');
    }
    if (prepared.back) {
      back = prepared.back;
    } else {
      back = darken(flip(front), 0.82);
      log.push('[back] 未提供背面图，已用镜像 + 压暗占位');
    }

    const bases = { down: front, left, right, up: back };
    const sheet = makeCanvas(fw * 3, fh * 4);
    const sheetCtx = ctx2d(sheet);
    DIRECTIONS.forEach((name, row) => {
      const base = bases[name];
      [1.0, 0.955, 1.02].forEach((squash, col) => {
        sheetCtx.drawImage(bobFrame(base, squash), col * fw, row * fh);
      });
    });

    validate(sheet, fw, fh, log);
    const preview = makePreview(sheet, fw, fh, 4);

    return {
      sheet,
      preview,
      log,
      config: { frame: [fw, fh], heightRatio, colors, keepCorner },
    };
  }

  // 与 Python 版一致：整图尺寸 + 每行内容高 + 脚底是否贴底
  function validate(sheet, fw, fh, log) {
    const expectW = fw * 3, expectH = fh * 4;
    const sizeOk = sheet.width === expectW && sheet.height === expectH;
    log.push(`[校验] 图集尺寸 ${sheet.width}x${sheet.height}，期望 ${expectW}x${expectH} ${sizeOk ? '✔' : '✘'}`);

    const ctx = ctx2d(sheet, true);
    DIRECTIONS.forEach((name, row) => {
      const rowData = ctx.getImageData(0, row * fh, fw * 3, fh);
      const bbox = contentBBox(rowData, 40);
      if (!bbox) {
        log.push(`[校验] ${name}: 空行 ✘`);
        return;
      }
      const contentH = bbox.h;
      const aligned = bbox.y + bbox.h >= fh - 2;
      log.push(`[校验] ${name}: 内容高 ${contentH}px，脚底对齐 ${aligned ? '✔' : '✘ 悬浮'}`);
    });
  }

  function makePreview(sheet, fw, fh, scale) {
    const margin = 8, labelW = 62;
    const w = fw * 3 * scale, h = fh * 4 * scale;
    const canvas = makeCanvas(w + labelW + margin, h + margin * 2);
    const ctx = ctx2d(canvas);

    // 棋盘格背景
    const step = 8;
    const checker = makeCanvas(w, h);
    const cctx = ctx2d(checker);
    cctx.fillStyle = '#262e3c';
    cctx.fillRect(0, 0, w, h);
    cctx.fillStyle = '#323a48';
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if ((Math.floor(x / step) + Math.floor(y / step)) % 2) {
          cctx.fillRect(x, y, step, step);
        }
      }
    }
    ctx.drawImage(checker, labelW, margin);

    ctx.imageSmoothingEnabled = false;   // 预览保持像素硬边
    ctx.drawImage(sheet, labelW, margin, w, h);

    ctx.font = '12px "Cascadia Code", Consolas, monospace';
    ctx.fillStyle = '#78d2ff';
    ctx.textBaseline = 'middle';
    DIRECTIONS.forEach((name, row) => {
      ctx.fillText(LABELS[name], 8, margin + row * fh * scale + (fh * scale) / 2 - 5);
    });
    return canvas;
  }

  function toBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  NY.sprite = { build, toBlob };
})();
