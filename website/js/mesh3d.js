/* 本地 3D 管线 v2：真正的“有厚度实体”，不再是一张纸片
   流程：自动抠背景 → 剪影体素雕刻（visual hull）→ Surface Nets 提面 → 封闭网格 + 三视图贴图
   1) 正面图必需；背面 / 侧面可选，给了就按真实剪影雕刻，没给就用正面充气
   2) 单视图时用距离变换“充气”：躯干、四肢按自身宽度长出厚度，剪影边缘厚度收为 0
   3) 全部在本机跑，不联网、不加载任何权重 */
(function () {
  const MAX_TEX = 900;       // 单张输入贴图最大边
  const MODEL_H = 1.6;       // 模型世界高度
  const GRID_Y = 120;        // 竖向体素格数
  const DEPTH_RATIO = 0.42;  // 最大厚度 / 高度
  const BG_TOL = 34;         // 背景色容差（RGB 欧氏距离）
  const ALPHA_CUT = 0.45;    // 剪影判定阈值

  console.log('[mesh3d] 实体雕刻管线 v2 已载入');

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

  /* ---------- 抠背景 ---------- */
  // 从四边泛洪，把与边框同色的连通区域判为背景；边缘做一次 3×3 柔化
  function floodBackground(px, alpha, w, h) {
    const n = w * h;
    for (let i = 0; i < n; i++) alpha[i] = 1;

    // 背景参考色：四边像素的中位数，抗噪点
    const rs = [], gs = [], bs = [];
    const push = (x, y) => {
      const o = (y * w + x) * 4;
      rs.push(px[o]); gs.push(px[o + 1]); bs.push(px[o + 2]);
    };
    for (let x = 0; x < w; x += 2) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y += 2) { push(0, y); push(w - 1, y); }
    rs.sort((a, b) => a - b);
    gs.sort((a, b) => a - b);
    bs.sort((a, b) => a - b);
    const mid = Math.floor(rs.length / 2);
    const br = rs[mid], bg = gs[mid], bb = bs[mid];

    const near = (p) => {
      const o = p * 4;
      const dr = px[o] - br, dg = px[o + 1] - bg, db = px[o + 2] - bb;
      return dr * dr + dg * dg + db * db <= BG_TOL * BG_TOL;
    };

    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    let sp = 0;
    const seed = (p) => {
      if (!seen[p] && near(p)) { seen[p] = 1; stack[sp++] = p; }
    };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }

    let count = 0;
    while (sp > 0) {
      const p = stack[--sp];
      alpha[p] = 0;
      count++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) seed(p - 1);
      if (x < w - 1) seed(p + 1);
      if (y > 0) seed(p - w);
      if (y < h - 1) seed(p + w);
    }
    return count / n;
  }

  // 干掉零碎小岛（水印、边缘噪点），只保留主体连通块
  function keepMainComponents(alpha, w, h) {
    const n = w * h;
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const comps = [];
    for (let s = 0; s < n; s++) {
      if (seen[s] || alpha[s] <= 0.5) continue;
      let sp = 0;
      stack[sp++] = s;
      seen[s] = 1;
      const members = [];
      while (sp > 0) {
        const p = stack[--sp];
        members.push(p);
        const x = p % w;
        const y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (!seen[q] && alpha[q] > 0.5) {
              seen[q] = 1;
              stack[sp++] = q;
            }
          }
        }
      }
      comps.push(members);
    }
    if (!comps.length) return;
    let maxArea = 0;
    for (const c of comps) if (c.length > maxArea) maxArea = c.length;
    const minArea = Math.max(maxArea * 0.02, n * 0.002);
    for (const c of comps) {
      if (c.length < minArea) for (const p of c) alpha[p] = 0;
    }
  }

  // 剪影内缩 2 像素，甩掉原图边缘那圈背景反光 / 半透明杂边
  function erodeAlpha(a, w, h, iters) {
    for (let it = 0; it < iters; it++) {
      const t = new Float32Array(a);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (t[p] <= 0.5) continue;
          if (t[p - 1] <= 0.5 || t[p + 1] <= 0.5 || t[p - w] <= 0.5 || t[p + w] <= 0.5) {
            a[p] = 0;
          }
        }
      }
    }
  }

  // 把透明区染成最近的边缘颜色，避免纹理插值把背景色（洋红/白）拖到模型上
  function inpaintEdges(px, alpha, w, h) {
    const n = w * h;
    const queued = new Uint8Array(n);
    const q = new Int32Array(n);
    let head = 0, tail = 0;
    for (let p = 0; p < n; p++) {
      if (alpha[p] <= 0.5) continue;
      const x = p % w;
      const y = (p - x) / w;
      let edge = false;
      if (x > 0 && alpha[p - 1] <= 0.5) edge = true;
      if (!edge && x < w - 1 && alpha[p + 1] <= 0.5) edge = true;
      if (!edge && y > 0 && alpha[p - w] <= 0.5) edge = true;
      if (!edge && y < h - 1 && alpha[p + w] <= 0.5) edge = true;
      if (edge) { queued[p] = 1; q[tail++] = p; }
    }
    while (head < tail) {
      const p = q[head++];
      const x = p % w;
      const y = (p - x) / w;
      const so = p * 4;
      const fill = (t) => {
        if (queued[t] || alpha[t] > 0.5) return;
        const to = t * 4;
        px[to] = px[so];
        px[to + 1] = px[so + 1];
        px[to + 2] = px[so + 2];
        px[to + 3] = 255;
        queued[t] = 1;
        q[tail++] = t;
      };
      if (x > 0) fill(p - 1);
      if (x < w - 1) fill(p + 1);
      if (y > 0) fill(p - w);
      if (y < h - 1) fill(p + w);
    }
  }

  function softAlpha(a, w, h) {
    const t = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += a[yy * w + xx];
            c++;
          }
        }
        t[y * w + x] = s / c;
      }
    }
    a.set(t);
  }

  function cropBox(alpha, w, h) {
    let minX = w, minY = h, maxX = -1, maxY = -1, any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] > 0.08) {
          any = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!any) return { x: 0, y: 0, w: w, h: h };
    const padX = Math.round(w * 0.02);
    const padY = Math.round(h * 0.02);
    const x0 = Math.max(0, minX - padX);
    const y0 = Math.max(0, minY - padY);
    const x1 = Math.min(w - 1, maxX + padX);
    const y1 = Math.min(h - 1, maxY + padY);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function prepare(file, say, tag) {
    return NY.util.loadImage(file).then((img) => {
      const scale = Math.min(1, MAX_TEX / Math.max(img.width, img.height));
      const w = Math.max(2, Math.round(img.width * scale));
      const h = Math.max(2, Math.round(img.height * scale));
      const canvas = makeCanvas(w, h);
      const g = makeCtx(canvas);
      g.drawImage(img, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data;

      const alpha = new Float32Array(w * h);
      let preAlpha = 0;
      for (let i = 0; i < w * h; i++) if (px[i * 4 + 3] < 235) preAlpha++;

      if (preAlpha > w * h * 0.02) {
        for (let i = 0; i < w * h; i++) alpha[i] = px[i * 4 + 3] / 255;
        say(`[3D] ${tag}：自带透明通道，直接按 alpha 抠图`);
      } else {
        const removed = floodBackground(px, alpha, w, h);
        say(`[3D] ${tag}：自动去背景，抠掉 ${(removed * 100).toFixed(0)}% 像素`);
      }
      keepMainComponents(alpha, w, h);
      erodeAlpha(alpha, w, h, 2);
      softAlpha(alpha, w, h);
      const box = cropBox(alpha, w, h);
      // 透明区补上最近的边缘色，贴图里不留背景色
      const full = g.getImageData(0, 0, w, h);
      inpaintEdges(full.data, alpha, w, h);
      g.putImageData(full, 0, 0);
      say(`[3D] ${tag}：${w}×${h}，角色区域 ${box.w}×${box.h}`);
      return { canvas, alpha, w, h, box };
    });
  }

  // 双线性采样 alpha（u/v 为 0..1，v 从上到下）
  function sampleAlpha(tex, u, v) {
    const x = tex.box.x + u * (tex.box.w - 1);
    const y = tex.box.y + v * (tex.box.h - 1);
    const x0 = Math.max(0, Math.min(tex.w - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(tex.h - 1, Math.floor(y)));
    const x1 = Math.min(tex.w - 1, x0 + 1);
    const y1 = Math.min(tex.h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = tex.alpha;
    const a00 = a[y0 * tex.w + x0], a10 = a[y0 * tex.w + x1];
    const a01 = a[y1 * tex.w + x0], a11 = a[y1 * tex.w + x1];
    return (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
  }

  // 正面 / 背面剪影，镜像时 u 取反（背视图左右相反）
  function maskPlane(tex, nx, ny, mirror) {
    const out = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const v = 1 - j / (ny - 1);
      for (let i = 0; i < nx; i++) {
        let u = i / (nx - 1);
        if (mirror) u = 1 - u;
        out[j * nx + i] = sampleAlpha(tex, u, v) > ALPHA_CUT ? 1 : 0;
      }
    }
    return out;
  }

  // 侧面剪影：k 是深度方向（0=背，nz-1=前），j 是高度
  function maskSide(tex, nz, ny) {
    const out = new Uint8Array(nz * ny);
    for (let j = 0; j < ny; j++) {
      const v = 1 - j / (ny - 1);
      for (let k = 0; k < nz; k++) {
        const u = k / (nz - 1);
        out[j * nz + k] = sampleAlpha(tex, u, v) > ALPHA_CUT ? 1 : 0;
      }
    }
    return out;
  }

  // 剪影内每个点到边界的距离（物理单位），用来给单视图“充气”
  function distanceTransform(mask, nx, ny, vx, vy) {
    const INF = 1e9;
    const d = new Float32Array(nx * ny);
    for (let i = 0; i < nx * ny; i++) d[i] = mask[i] ? INF : 0;
    const w1 = vx, w2 = vy, wd = Math.hypot(vx, vy);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!mask[k]) continue;
        let best = d[k];
        if (i > 0) best = Math.min(best, d[k - 1] + w1);
        if (j > 0) best = Math.min(best, d[k - nx] + w2);
        if (i > 0 && j > 0) best = Math.min(best, d[k - nx - 1] + wd);
        if (i < nx - 1 && j > 0) best = Math.min(best, d[k - nx + 1] + wd);
        d[k] = best;
      }
    }
    for (let j = ny - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i;
        if (!mask[k]) continue;
        let best = d[k];
        if (i < nx - 1) best = Math.min(best, d[k + 1] + w1);
        if (j < ny - 1) best = Math.min(best, d[k + nx] + w2);
        if (i < nx - 1 && j < ny - 1) best = Math.min(best, d[k + nx + 1] + wd);
        if (i > 0 && j < ny - 1) best = Math.min(best, d[k + nx - 1] + wd);
        d[k] = best;
      }
    }
    return d;
  }

  /* ---------- 体素场 → 封闭网格（Surface Nets） ---------- */
  function surfaceNets(field, nx, ny, nz, vx, vy, vz) {
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const cellV = new Int32Array(cx * cy * cz).fill(-1);
    const positions = new Float32Array(cx * cy * cz * 3);
    let vc = 0;

    const EDGES = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const COFF = [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
      [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    ];
    const cv = new Float32Array(8);

    for (let k = 0; k < cz; k++) {
      for (let j = 0; j < cy; j++) {
        for (let i = 0; i < cx; i++) {
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            const o = COFF[c];
            const val = field[(i + o[0]) + nx * ((j + o[1]) + ny * (k + o[2]))];
            cv[c] = val;
            if (val > 0) mask |= 1 << c;
          }
          if (mask === 0 || mask === 255) continue;

          let ax = 0, ay = 0, az = 0, n = 0;
          for (let e = 0; e < 12; e++) {
            const a = EDGES[e][0], b = EDGES[e][1];
            const va = cv[a], vb = cv[b];
            if ((va > 0) === (vb > 0)) continue;
            const t = va / (va - vb);
            const oa = COFF[a], ob = COFF[b];
            ax += oa[0] + (ob[0] - oa[0]) * t;
            ay += oa[1] + (ob[1] - oa[1]) * t;
            az += oa[2] + (ob[2] - oa[2]) * t;
            n++;
          }
          if (!n) continue;
          const id = vc++;
          cellV[i + cx * (j + cy * k)] = id;
          positions[id * 3] = ((i + ax / n) - (cx) / 2) * vx;
          positions[id * 3 + 1] = ((j + ay / n) - (cy) / 2) * vy;
          positions[id * 3 + 2] = ((k + az / n) - (cz) / 2) * vz;
        }
      }
    }

    const getV = (i, j, k) =>
      i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz
        ? -1
        : cellV[i + cx * (j + cy * k)];

    const tris = [];
    const pushQuad = (a, b, c, d) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      tris.push(a, b, c, a, c, d);
    };

    // 每条“变号”网格边 → 四个相邻 cell 顶点组成一个四边形
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const base = i + nx * (j + ny * k);
          if (i < nx - 1) {
            const f0 = field[base], f1 = field[base + 1];
            if ((f0 > 0) !== (f1 > 0)) {
              pushQuad(getV(i, j - 1, k - 1), getV(i, j, k - 1), getV(i, j, k), getV(i, j - 1, k));
            }
          }
          if (j < ny - 1) {
            const f0 = field[base], f1 = field[base + nx];
            if ((f0 > 0) !== (f1 > 0)) {
              pushQuad(getV(i - 1, j, k - 1), getV(i, j, k - 1), getV(i, j, k), getV(i - 1, j, k));
            }
          }
          if (k < nz - 1) {
            const f0 = field[base], f1 = field[base + nx * ny];
            if ((f0 > 0) !== (f1 > 0)) {
              pushQuad(getV(i - 1, j - 1, k), getV(i, j - 1, k), getV(i, j, k), getV(i - 1, j, k));
            }
          }
        }
      }
    }

    return { positions, tris, vc };
  }

  // 用场的梯度给面片定朝向（场内高外低，梯度指向内部）
  function orient(tris, positions, field, nx, ny, nz, vx, vy, vz) {
    const n = tris.length;
    for (let t = 0; t < n; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const e1x = positions[b] - positions[a];
      const e1y = positions[b + 1] - positions[a + 1];
      const e1z = positions[b + 2] - positions[a + 2];
      const e2x = positions[c] - positions[a];
      const e2y = positions[c + 1] - positions[a + 1];
      const e2z = positions[c + 2] - positions[a + 2];
      const nxx = e1y * e2z - e1z * e2y;
      const nyy = e1z * e2x - e1x * e2z;
      const nzz = e1x * e2y - e1y * e2x;

      const gx = (positions[a] + positions[b] + positions[c]) / 3;
      const gy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
      const gz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
      const ci = Math.max(1, Math.min(nx - 2, Math.round((gx) / vx + (nx - 1) / 2)));
      const cj = Math.max(1, Math.min(ny - 2, Math.round((gy) / vy + (ny - 1) / 2)));
      const ck = Math.max(1, Math.min(nz - 2, Math.round((gz) / vz + (nz - 1) / 2)));

      const grad = (di, dj, dk) =>
        field[(ci + di) + nx * ((cj + dj) + ny * (ck + dk))];
      const fx = grad(1, 0, 0) - grad(-1, 0, 0);
      const fy = grad(0, 1, 0) - grad(0, -1, 0);
      const fz = grad(0, 0, 1) - grad(0, 0, -1);

      if (nxx * fx + nyy * fy + nzz * fz > 0) {
        const tmp = tris[t + 1];
        tris[t + 1] = tris[t + 2];
        tris[t + 2] = tmp;
      }
    }
  }

  function blurField(field, nx, ny, nz) {
    const t = new Float32Array(field.length);
    // X
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          const l = i > 0 ? field[idx - 1] : field[idx];
          const r = i < nx - 1 ? field[idx + 1] : field[idx];
          t[idx] = (l + 2 * field[idx] + r) / 4;
        }
      }
    }
    // Y
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          const u = j > 0 ? t[idx - nx] : t[idx];
          const d = j < ny - 1 ? t[idx + nx] : t[idx];
          field[idx] = (u + 2 * t[idx] + d) / 4;
        }
      }
    }
    // Z
    const plane = nx * ny;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          const u = k > 0 ? field[idx - plane] : field[idx];
          const d = k < nz - 1 ? field[idx + plane] : field[idx];
          t[idx] = (u + 2 * field[idx] + d) / 4;
        }
      }
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          field[idx] = t[idx];
        }
      }
    }
  }

  /* ---------- GLB 打包 ---------- */
  function buildGlb({ positions, normals, uvs, indices, png }) {
    let offset = 0;
    const views = [];
    const parts = [];

    function addView(typedArray, target) {
      const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
      const view = { buffer: 0, byteOffset: offset, byteLength: typedArray.byteLength };
      if (target) view.target = target;
      views.push(view);
      parts.push(bytes);
      offset += typedArray.byteLength;
      const pad = (4 - (offset % 4)) % 4;
      if (pad) {
        parts.push(new Uint8Array(pad));
        offset += pad;
      }
      return views.length - 1;
    }

    const vPos = addView(positions, 34962);
    const vNrm = addView(normals, 34962);
    const vUv = addView(uvs, 34962);
    const vIdx = addView(indices, 34963);
    const vImg = addView(new Uint8Array(png));

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
      asset: { version: '2.0', generator: 'nanyang3Dcuit voxel hull' },
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
          roughnessFactor: 0.85,
        },
        doubleSided: false,
      }],
      textures: [{ source: 0, sampler: 0 }],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
      images: [{ bufferView: vImg, mimeType: 'image/png' }],
      accessors: [
        { bufferView: vPos, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
        { bufferView: vNrm, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
        { bufferView: vUv, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
        { bufferView: vIdx, componentType: indices.BYTES_PER_ELEMENT === 2 ? 5123 : 5125, count: indices.length, type: 'SCALAR' },
      ],
      bufferViews: views,
      buffers: [{ byteLength: offset }],
    };

    let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jp = (4 - (jsonBytes.length % 4)) % 4;
    if (jp) {
      const padded = new Uint8Array(jsonBytes.length + jp);
      padded.set(jsonBytes);
      padded.fill(0x20, jsonBytes.length);
      jsonBytes = padded;
    }

    let binLen = 0;
    parts.forEach((p) => { binLen += p.length; });
    const bin = new Uint8Array(binLen + ((4 - (binLen % 4)) % 4));
    let at = 0;
    parts.forEach((p) => { bin.set(p, at); at += p.length; });

    const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    const binStart = 20 + jsonBytes.length;
    dv.setUint32(binStart, bin.length, true);
    dv.setUint32(binStart + 4, 0x004e4942, true);
    out.set(bin, binStart + 8);
    return out;
  }

  function canvasPng(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('贴图编码失败')); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
      }, 'image/png');
    });
  }

  // 图集：正面投影 + 背面投影，上下两段
  function buildAtlas(front, back, side) {
    const bandH = Math.max(220, Math.min(512, front.box.h));
    const bandW = Math.max(120, Math.min(1024, Math.round(bandH * (front.box.w / front.box.h))));
    const canvas = makeCanvas(bandW, bandH * 2);
    const g = makeCtx(canvas);
    g.clearRect(0, 0, canvas.width, canvas.height);

    const drawBand = (tex, band) => {
      const src = tex || front;
      g.drawImage(src.canvas, src.box.x, src.box.y, src.box.w, src.box.h, 0, band * bandH, bandW, bandH);
    };
    drawBand(front, 0);
    if (back) {
      drawBand(back, 1);
    } else {
      // 没有背面图：用正面缩成柔和大色块，避免把脸镜像到后脑勺
      const sw = 20;
      const sh = Math.max(10, Math.round(sw * bandH / bandW));
      const small = makeCanvas(sw, sh);
      const gs = makeCtx(small);
      gs.drawImage(front.canvas, front.box.x, front.box.y, front.box.w, front.box.h, 0, 0, sw, sh);
      g.imageSmoothingEnabled = true;
      g.drawImage(small, 0, 0, sw, sh, 0, bandH, bandW, bandH);
    }
    return canvas;
  }

  /* ---------- 主流程 ---------- */
  async function build(input, opts) {
    const log = [];
    const say = (m) => {
      log.push(m);
      if (opts && opts.onLog) opts.onLog(log.join('\n'));
    };

    const files = input && input.front ? input : { front: input };
    if (!files.front) throw new Error('缺少正面图片');

    say('[3D] 实体雕刻：自动抠图 + 剪影体素 + 封闭网格（本地，不联网、不加载权重）');
    const front = await prepare(files.front, say, '正面');
    const back = files.back ? await prepare(files.back, say, '背面') : null;
    const side = files.side ? await prepare(files.side, say, '侧面') : null;

    // 体积尺寸
    const aspect = front.box.w / front.box.h;
    const W = MODEL_H * aspect;
    const D = MODEL_H * DEPTH_RATIO;
    const nyC = GRID_Y + 1;
    const nxC = Math.max(12, Math.min(180, Math.round(GRID_Y * aspect))) + 1;
    const nzC = Math.max(9, Math.round(GRID_Y * DEPTH_RATIO)) + 1;
    const vx = W / (nxC - 1);
    const vy = MODEL_H / (nyC - 1);
    const vz = D / (nzC - 1);

    const fMask = maskPlane(front, nxC, nyC, false);
    const bMask = back ? maskPlane(back, nxC, nyC, true) : null;
    const sMask = side ? maskSide(side, nzC, nyC) : null;

    let solid = 0;
    for (let i = 0; i < fMask.length; i++) if (fMask[i]) solid++;
    if (!solid) throw new Error('抠图后没有剩下角色，换一张背景更干净的图，或直接用带透明通道的 PNG');

    // 单视图充气：距离变换 → 局部厚度（只有正面图时收窄，避免变成枕头）
    const dist = distanceTransform(fMask, nxC, nyC, vx, vy);
    const tmax = side ? D / 2 : MODEL_H * 0.11;
    const thick = new Float32Array(nxC * nyC);
    for (let i = 0; i < dist.length; i++) {
      thick[i] = Math.max(MODEL_H * 0.012, Math.min(tmax, dist[i] * (side ? 1.2 : 0.9)));
    }

    // 体素场：正=实体，负=空气
    const field = new Float32Array(nxC * nyC * nzC);
    let inside = 0;
    for (let k = 0; k < nzC; k++) {
      const z = -nzC * vz / 2 + k * vz;
      for (let j = 0; j < nyC; j++) {
        for (let i = 0; i < nxC; i++) {
          const p = i + nxC * (j + nyC * k);
          const m = fMask[j * nxC + i];
          const okBack = !bMask || bMask[j * nxC + i];
          const okSide = !sMask || sMask[j * nzC + k];
          const okZ = Math.abs(z) <= thick[j * nxC + i];
          const ok = m && okBack && okSide && okZ;
          field[p] = ok ? 1 : -1;
          if (ok) inside++;
        }
      }
    }
    if (!inside) throw new Error('剪影雕刻后体积为空：正面 / 背面 / 侧面三张图的轮廓对不上，先用同一角色的三视图');

    blurField(field, nxC, nyC, nzC);

    const { positions, tris, vc } = surfaceNets(field, nxC, nyC, nzC, vx, vy, vz);
    if (!tris.length) throw new Error('没提取到表面，换分辨率更高的图再试');
    orient(tris, positions, field, nxC, nyC, nzC, vx, vy, vz);

    // 顶点法线（平滑），再按面拆分
    const vn = new Float32Array(vc * 3);
    const faceN = new Float32Array(tris.length / 3 * 3);
    for (let t = 0; t < tris.length; t += 3) {
      const ia = tris[t] * 3, ib = tris[t + 1] * 3, ic = tris[t + 2] * 3;
      const e1x = positions[ib] - positions[ia];
      const e1y = positions[ib + 1] - positions[ia + 1];
      const e1z = positions[ib + 2] - positions[ia + 2];
      const e2x = positions[ic] - positions[ia];
      const e2y = positions[ic + 1] - positions[ia + 1];
      const e2z = positions[ic + 2] - positions[ia + 2];
      let nxx = e1y * e2z - e1z * e2y;
      let nyy = e1z * e2x - e1x * e2z;
      let nzz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nxx, nyy, nzz) || 1;
      nxx /= len; nyy /= len; nzz /= len;
      const fi = t / 3;
      faceN[fi * 3] = nxx; faceN[fi * 3 + 1] = nyy; faceN[fi * 3 + 2] = nzz;
      for (const a of [ia, ib, ic]) {
        vn[a] += nxx; vn[a + 1] += nyy; vn[a + 2] += nzz;
      }
    }
    for (let i = 0; i < vn.length; i += 3) {
      const len = Math.hypot(vn[i], vn[i + 1], vn[i + 2]) || 1;
      vn[i] /= len; vn[i + 1] /= len; vn[i + 2] /= len;
    }

    // 展开成非索引网格：整体用正 / 背两个方向的平面投影，接缝落在剪影边上，不出现拼块
    const bands = 2;
    const triCount = tris.length / 3;
    const outPos = new Float32Array(triCount * 9);
    const outNrm = new Float32Array(triCount * 9);
    const outUv = new Float32Array(triCount * 6);
    const outIdx = new Uint32Array(triCount * 3);

    // 有背面图时接缝放在正中间；只有正面图时把接缝往后推，侧面也沿用正面颜色，少一道拉链
    const seam = back ? 0 : -0.3;
    for (let f = 0; f < triCount; f++) {
      const nz_ = faceN[f * 3 + 2];
      const band = nz_ >= seam ? 0 : 1;

      for (let c = 0; c < 3; c++) {
        const vi = tris[f * 3 + c];
        const o = f * 9 + c * 3;
        const px = positions[vi * 3], py = positions[vi * 3 + 1], pz = positions[vi * 3 + 2];
        outPos[o] = px;
        outPos[o + 1] = py;
        outPos[o + 2] = pz;
        outNrm[o] = vn[vi * 3];
        outNrm[o + 1] = vn[vi * 3 + 1];
        outNrm[o + 2] = vn[vi * 3 + 2];

        let u = 0.5 + px / W;
        if (band === 1) u = 1 - u;
        const v = 0.5 - py / MODEL_H;
        const uvI = f * 6 + c * 2;
        outUv[uvI] = u;
        outUv[uvI + 1] = (band + Math.min(0.999, Math.max(0, v))) / bands;
      }
      outIdx[f * 3] = f * 3;
      outIdx[f * 3 + 1] = f * 3 + 1;
      outIdx[f * 3 + 2] = f * 3 + 2;
    }

    const atlas = buildAtlas(front, back, side);
    const png = await canvasPng(atlas);
    const glb = buildGlb({ positions: outPos, normals: outNrm, uvs: outUv, indices: outIdx, png });

    say(`[3D] 体素 ${nxC}×${nyC}×${nzC}，闭合表面 ${triCount} 个三角面`);
    if (!back && !side) {
      say('[提示] 只有正面图：身体厚度按剪影宽度估出来，背面是柔化色块；补背面图和侧面图才会得到真实的前后厚度');
    } else if (!back || !side) {
      say('[提示] 缺一张视图，缺失方向仍按充气估算；正面 + 背面 + 侧面三张齐全最准');
    }

    const blob = new Blob([glb], { type: 'model/gltf-binary' });
    say(`[完成] 实体网格生成完毕，GLB ${(blob.size / 1024).toFixed(1)} KB（封闭体积，可任意角度旋转）`);
    return { blob, filename: 'character_local.glb', log };
  }

  NY.mesh3d = { build };
})();
