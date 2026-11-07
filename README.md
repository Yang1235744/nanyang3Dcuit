# nanyang3Dcuit

一个**低显存消耗**的角色创作系统，主打三件事：

| 能力 | 输入 | 输出 | 算力 |
| --- | --- | --- | --- |
| 2D 行走图 | 角色立绘（正面 / 背面 / 侧面） | RPG Maker VX 可用的 96×192 行走图 | 纯 CPU，零显存 |
| 3D 角色 | 单张人物图片 | `.glb` 模型 | 浏览器本地生成（默认）/ 远端重建（可选） |
| 网页 AI 代理 | 一句自然语言需求 | 生成素材 + 打包下载 | 走 OpenAI 兼容接口（可选 LLM）|

设计原则很明确：**本机不跑大模型**。3D 默认在浏览器本地把像素构造成带内嵌贴图的 GLB 网格，不联网、不载权重；需要照片级重建时再切到 Hugging Face Space 或自己的服务端。2D 只用 Pillow 做像素级处理，所以核显、老笔记本都能用。

## 目录结构

```
nanyang-3dcuit/
├── pipeline/
│   ├── sprite2d.py           # 图片 -> RPG Maker 行走图（纯 Pillow）
│   ├── img23d.py             # 图片 -> .glb（gradio / rest / none 三种后端）
│   ├── requirements.txt
│   └── config.example.json   # 复制为 config.json 后填自己的服务地址
├── website/                  # GitHub Pages 静态站（浏览器内跑同一套逻辑）
│   ├── index.html
│   ├── css/style.css
│   └── js/
├── assets/samples/           # 示例三视图（洋红幕布）
└── .github/workflows/pages.yml
```

## 一、2D：图片转行走图

```bash
pip install -r pipeline/requirements.txt

python pipeline/sprite2d.py \
  --front assets/samples/hero_front.jpg \
  --back  assets/samples/hero_back.jpg \
  --side  assets/samples/hero_side.jpg \
  --out   out/hero_walk.png \
  --preview out/hero_walk_preview.png
```

常用参数：

- `--frame vx`（默认 32×48）／`vxmv`（48×48）／`32x32` 任意自定义
- `--height-ratio 0.92` 人物占帧高比例
- `--colors 16` 压色板（更像手绘像素风）
- `--keep-corner` 保留右下角（默认会清掉 AI 出图水印区）

**出图提示词模板**（用任意生图模型出素材时照抄）：

```
RPG Maker 角色参考图：<角色描述>，正面全身站立，像素风，粗描边，
纯洋红背景 #FF00FF，无阴影、无文字，人物居中，便于抠图后缩成 32x48 行走图。
```

管线做了这几件事：按实测色相抠幕布（可抗背景渐变）→ 清右下角水印 → 行列投影求包围盒（抗噪点）→ 缩放并脚底贴齐 → 以脚底为锚点做 3 帧起伏 → 拼成 3 帧 × 4 方向。缺背面 / 侧面会用镜像占位，并在终端明确标注，不假装有真数据。

## 二、3D：图片转角色模型

本机不推理，只做转发。先看远端有哪些接口：

```bash
pip install gradio_client
python pipeline/img23d.py --list-apis --space tencent/Hunyuan3D-2
```

再转换：

```bash
python pipeline/img23d.py --image assets/samples/hero_front.jpg --out out/hero.glb \
  --provider gradio --space tencent/Hunyuan3D-2 --api-name /generation_all
```

或接到自己的 HTTP 服务（返回 glb 二进制，或 `{"url": "..."}`）：

```bash
python pipeline/img23d.py --image hero.png --out hero.glb \
  --provider rest --url http://127.0.0.1:8000/reconstruct --field image --api-key <key>
```

`--provider none` 只打印可用方案，不联网，适合先确认环境。

## 三、网页版：对话即创作

`website/` 是纯静态站，不需要后端：

- **对话创作**：填 OpenAI 兼容的 baseURL / apiKey / model（存 localStorage），AI 会输出结构化指令，前端解析后自动调用 2D 或 3D 管线；
- **2D 行走图**：在 Canvas 里完整复刻 `sprite2d.py` 的抠图、包围盒、拼图逻辑，浏览器本地完成，图片不上传；
- **3D 角色**：默认本地生成 GLB（不联网、无需服务器）；也可切到 Gradio Space 或 REST 地址走远端重建；
- **打包下载**：JSZip 打包 PNG / GLB / manifest.json / 导入说明。

部署到 GitHub Pages：仓库推送后 workflow 自动发布 `website` 目录。

## 四、桌面版（Windows EXE）

直接下载：[Nanyang3Dcuit.exe](https://github.com/Yang1235744/nanyang3Dcuit/releases/latest)（48.6 MB，免安装）

- 深色界面，左侧会话列表 + 右侧对话，SSE 流式输出，可随时停止；
- 设置里选供应商（DeepSeek / Kimi / OpenAI / 自定义），填自己的 API Key，点「测试连接」；
- Key 存在 `%APPDATA%\Nanyang3Dcuit\config.json`，不随仓库分发；
- 从源码自己打包：`powershell -ExecutionPolicy Bypass -File desktop/build.ps1`

第一次打开先填 Key，否则只能看到界面。

## 五、建仓库并拉取

```bash
cd nanyang-3dcuit
git init
git add .
git commit -m "init: nanyang3Dcuit pipelines + web"
git branch -M main
git remote add origin https://github.com/<你的用户名>/nanyang3Dcuit.git
git push -u origin main
```

仓库建好后（网页建库也行，勾选 Public），到 **Settings → Pages**，Source 选 `GitHub Actions`，站点地址就是 `https://<用户名>.github.io/nanyang3Dcuit/`。

别人拉取：

```bash
git clone https://github.com/<你的用户名>/nanyang3Dcuit.git
```

## 注意

- 3D 默认本地生成，本机不下载 1.5TB 级权重；远端重建为可选项；
- 生成的 `.glb` 已加入 `.gitignore`，产物走网页下载或 Release，不塞进仓库历史；
- API Key 只存浏览器 localStorage，不会提交到仓库。
