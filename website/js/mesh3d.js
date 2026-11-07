/* 本地 3D 管线：从一张图片直接生成可下载的 GLB（浮雕网格），不联网、不加载权重 */
(function () {
  const MAX_TEX = 1024;   // 贴图最大边长
  const GRID_MAX = 104;   // 网格最大行数
  const MODEL_H = 1.6;    // 模型世界高度

  console.log('[mesh3d] 本地管线已载入');

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function makeCtx(canvas) {
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    return g;
  }

  // 找不透明内容的包围盒；整张图都有内容时返回原尺寸
  function cropBox(data, w, h) {
    let minX = w, minY = h, maxX = -1, maxY = -1, any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 24) {
          any = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!any) return { x: 0, y: 0, w: w, h: h };
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw * bh > w * h * 0.92) return { x: 0, y: 0, w: w, h: h };
    const padX = Math.round(w * 0.02);
    const padY = Math.round(h * 0.02);
    const x0 = Math.max(0, minX - padX);
    const y0 = Math.max(0, minY - padY);
    const x1 = Math.min(w - 1, maxX + padX);
    const y1 = Math.min(h - 1, maxY + padY);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /* ---------- GLB 打包 ---------- */
  function buildGlb({ positions, normals, uvs, indices, png }) {
    const idxBytes = indices.BYTES_PER_ELEMENT;
    let offset = 0;
    const views = [];
    const parts = [];

    function addView(typedArray, target) {
      const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
      const view = { byteOffset: offset, byteLength: typedArray.byteLength };
      if (target) view.target = target;
      views.push(view);
      parts.push(bytes);
      offset += typedArray.byteLength;
      // 4 字节对齐
      const pad = (4 - (offset % 4)) % 4;
      if (pad) {
        parts.push(new Uint8Array(pad));
        offset += pad;
      }
      return views.length - 1;
    }

    const pngBytes = new Uint8Array(png);
    const vPos = addView(positions, 34962);
    const vNrm = addView(normals, 34962);
    const vUv = addView(uvs, 34962);
    const vIdx = addView(indices, 34963);
    const vImg = addView(pngBytes);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const val = positions[i + k];
        if (val < min[k]) min[k] = val;
        if (val > max[k]) max[k] = val;
      }
    }

    const json = {
      asset: { version: '2.0', generator: 'nanyang3Dcuit local mesh' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: 'character' }],
      meshes: [{
        primitives: [{
          attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
          indices: 3,
          material: 0,
        }],
      }],
      materials: [{
        name: 'character',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
        alphaMode: 'BLEND',
        doubleSided: true,
      }],
      textures: [{ source: 0, sampler: 0 }],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
      images: [{ bufferView: vImg, mimeType: 'image/png' }],
      accessors: [
        {
          bufferView: vPos,
          componentType: 5126,
          count: positions.length / 3,
          type: 'VEC3',
          min,
          max,
        },
        { bufferView: vNrm, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
        { bufferView: vUv, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
        { bufferView: vIdx, componentType: idxBytes === 2 ? 5123 : 5125, count: indices.length, type: 'SCALAR' },
      ],
      bufferViews: views,
      buffers: [{ byteLength: offset }],
    };

    const jsonText = JSON.stringify(json);
    let jsonBytes = new TextEncoder().encode(jsonText);
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    if (jsonPad) {
      const padded = new Uint8Array(jsonBytes.length + jsonPad);
      padded.set(jsonBytes);
      padded.fill(0x20, jsonBytes.length); // JSON 块用空格补齐
      jsonBytes = padded;
    }

    // 拼 BIN 块
    let binLen = 0;
    parts.forEach((p) => { binLen += p.length; });
    const binPad = (4 - (binLen % 4)) % 4;
    const bin = new Uint8Array(binLen + binPad);
    let at = 0;
    parts.forEach((p) => { bin.set(p, at); at += p.length; });

    const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); // 'glTF'
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true);
    dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
    out.set(jsonBytes, 20);
    const binStart = 20 + jsonBytes.length;
    dv.setUint32(binStart, bin.length, true);
    dv.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'
    out.set(bin, binStart + 8);
    return out;
  }

  function canvasPng(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('贴图编码失败'));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
      }, 'image/png');
    });
  }

  /* ---------- 主流程 ---------- */
  async function build(file, opts) {
    const log = [];
    const say = (m) => {
      log.push(m);
      if (opts && opts.onLog) opts.onLog(log.join('\n'));
    };

    say('[3D] 本地管线：只读图片像素，不联网、不加载权重');
    const img = await NY.util.loadImage(file);

    const scale = Math.min(1, MAX_TEX / Math.max(img.width, img.height));
    const tw = Math.max(2, Math.round(img.width * scale));
    const th = Math.max(2, Math.round(img.height * scale));
    const canvas = makeCanvas(tw, th);
    const g = makeCtx(canvas);
    g.drawImage(img, 0, 0, tw, th);
    const data = g.getImageData(0, 0, tw, th).data;

    const box = cropBox(data, tw, th);
    say(`[3D] 贴图 ${tw}×${th}，人物区域 ${box.w}×${box.h}`);

    // 网格密度：竖边最多 GRID_MAX 行
    let rows = Math.min(GRID_MAX, Math.max(12, box.h));
    let cols = Math.max(6, Math.round(rows * (box.w / box.h)));
    if (cols > GRID_MAX) {
      cols = GRID_MAX;
      rows = Math.max(8, Math.round(cols * (box.h / box.w)));
    }
    if (cols < 2) cols = 2;
    if (rows < 2) rows = 2;

    const modelW = MODEL_H * (box.w / box.h);
    const stepX = modelW / (cols - 1);
    const stepY = MODEL_H / (rows - 1);
    const depthScale = 0.18 * MODEL_H;

    const nv = cols * rows;
    const positions = new Float32Array(nv * 3);
    const normals = new Float32Array(nv * 3);
    const uvs = new Float32Array(nv * 2);
    const zArr = new Float32Array(nv);
    const aArr = new Float32Array(nv);

    const rx = Math.max(1, Math.round(box.w / (cols * 3)));
    const ry = Math.max(1, Math.round(box.h / (rows * 3)));

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const fx = box.x + (i / (cols - 1)) * (box.w - 1);
        const fy = box.y + (j / (rows - 1)) * (box.h - 1);
        let aSum = 0;
        let lSum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const px = Math.min(tw - 1, Math.max(0, Math.round(fx + dx * rx)));
            const py = Math.min(th - 1, Math.max(0, Math.round(fy + dy * ry)));
            const o = (py * tw + px) * 4;
            const a = data[o + 3] / 255;
            const lum = (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
            aSum += a;
            lSum += lum * a;
            n++;
          }
        }
        const aAvg = aSum / n;
        const lum = aAvg > 0.004 ? lSum / n / aAvg : 0.5;
        const k = j * cols + i;
        aArr[k] = aAvg;
        zArr[k] = depthScale * (0.25 + 0.75 * Math.min(1, lum)) * aAvg;

        positions[k * 3] = (i / (cols - 1) - 0.5) * modelW;
        positions[k * 3 + 1] = (0.5 - j / (rows - 1)) * MODEL_H;
        positions[k * 3 + 2] = zArr[k];

        uvs[k * 2] = fx / tw;
        uvs[k * 2 + 1] = fy / th;
      }
    }

    // 三角面：四个角至少 3 个不透明才保留，避免碎边
    const idx = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const k00 = j * cols + i;
        const k10 = k00 + 1;
        const k01 = k00 + cols;
        const k11 = k01 + 1;
        const inside = [k00, k10, k01, k11].filter((k) => aArr[k] >= 0.18).length;
        if (inside < 3) continue;
        idx.push(k00, k01, k10);
        if (inside === 4) idx.push(k10, k01, k11);
      }
    }

    if (!idx.length) throw new Error('这张图没有可用的不透明区域，先换成带透明背景的人物立绘');

    const UseU16 = nv <= 65535;
    const indices = UseU16 ? new Uint16Array(idx) : new Uint32Array(idx);

    // 法线：逐面累加，统一朝 +Z
    const p1 = [0, 0, 0], p2 = [0, 0, 0], p3 = [0, 0, 0];
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3;
      const b = indices[t + 1] * 3;
      const c = indices[t + 2] * 3;
      for (let k = 0; k < 3; k++) {
        p1[k] = positions[a + k];
        p2[k] = positions[b + k];
        p3[k] = positions[c + k];
      }
      const e1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
      const e2 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1];
      let ny = e1[2] * e2[0] - e1[0] * e2[2];
      let nz = e1[0] * e2[1] - e1[1] * e2[0];
      if (nz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      for (const k of [a, b, c]) {
        normals[k] += nx;
        normals[k + 1] += ny;
        normals[k + 2] += nz;
      }
    }
    for (let i = 0; i < normals.length; i += 3) {
      const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
    if (!isFinite(normals[0])) normals.fill(0);

    say(`[3D] 网格 ${cols}×${rows} 顶点，${indices.length / 3} 个三角面`);

    const png = await canvasPng(canvas);
    const glb = buildGlb({ positions, normals, uvs, indices, png });
    const blob = new Blob([glb], { type: 'model/gltf-binary' });
    say(`[完成] 本地生成完毕，GLB ${(blob.size / 1024).toFixed(1)} KB（贴图内嵌，可直接导入 Blender / Unity）`);
    return { blob, filename: 'character_local.glb', log };
  }

  NY.mesh3d = { build };
})();
