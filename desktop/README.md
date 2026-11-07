# nanyang3Dcuit 桌面版

深蓝科技风的本地对话客户端，界面参考 Kimi 电脑版：左侧会话列表，右侧聊天区。
**本机不加载任何大模型权重**，所有回答都来自你在设置里填的云端 OpenAI 兼容接口（DeepSeek / Kimi / OpenAI / 任意自定义服务）。

## 功能

- **会话管理**：新建、切换、右键删除；首条消息自动命名；关闭程序后自动恢复。
- **流式对话**：SSE 增量输出，逐字刷新气泡；可随时「停止」中断请求。
- **Markdown 子集**：标题、有序 / 无序列表、代码块（等宽字体）、粗体与行内代码。
- **一键入口**：顶栏「网页版」「GitHub」「产物目录」，其中产物目录指向项目下的 `out\`。
- **完全离线启动**：不联网也能打开界面，只有发送消息时才访问你配置的地址。

## 数据存放

| 内容 | 位置 |
| --- | --- |
| 会话记录 | `%APPDATA%\Nanyang3Dcuit\sessions.json` |
| 接口配置（含 Key） | `%APPDATA%\Nanyang3Dcuit\config.json` |

Key 只写在本机这个 json 里，不写进项目目录，也不会随仓库分发。

## 第一次运行：填 API Key

1. 双击 `dist\Nanyang3Dcuit.exe`（或 `python desktop\app.py` 直接运行源码）。
2. 点左下角「设置与模型」。
3. 供应商选 **DeepSeek**，默认已是 `https://api.deepseek.com/v1` + `deepseek-chat`；
   粘贴你的 API Key（[platform.deepseek.com](https://platform.deepseek.com) 申请）。
4. 点「测试连接」，看到「连接成功」后点「保存」。

预设对应关系：

| 供应商 | Base URL | 默认模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat`（也可填 `deepseek-reasoner`） |
| Kimi 月之暗面 | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 自定义 | 任意 OpenAI 兼容地址 | 任意模型名 |

## 打包

```powershell
# 在项目根目录执行
powershell -ExecutionPolicy Bypass -File desktop\build.ps1
```

等价命令：

```powershell
pyinstaller --noconfirm --onefile --windowed --name Nanyang3Dcuit desktop\app.py
```

产物在 `dist\Nanyang3Dcuit.exe`，单文件，首次启动解包会慢几秒属正常现象。

## 无界面自检

```powershell
$env:QT_QPA_PLATFORM="offscreen"; python desktop\app.py --selftest
```

打印 `OK` 且进程退出码为 0，说明界面构造与渲染流程正常，可用于 CI / 打包前验证。

## 常见错误

| 提示 | 原因 | 处理 |
| --- | --- | --- |
| `401 认证失败` | Key 写错、失效或没带上 | 重新粘贴 Key，注意不要带空格 / 引号；确认用的是对应供应商的 Key |
| `402 余额不足` | 账户额度用完 | 去供应商控制台充值或换 Key |
| `404 找不到接口` | Base URL 或模型名不对 | Base URL 一般以 `/v1` 结尾；模型名照预设填 |
| `429 请求太频繁` | 触发限流 | 等 1~2 分钟再发；不要连点发送 |
| `连接失败` | 域名解析不了 / 端口不通 | 检查网络；国内直连 OpenAI 通常需要代理 |
| `代理连接失败` | 系统代理不可用 | 代理软件没开，或 `HTTP_PROXY` / `HTTPS_PROXY` 指向了失效地址 |
| `证书校验失败` | 代理替换了 HTTPS 证书 | 安装代理软件根证书到系统，或临时关闭抓包 |

程序里的 Key 是明文存在本机配置文件的，请不要在共享电脑上填写；怀疑泄露就立刻去控制台吊销重建。

## 目录

```
desktop/
├── app.py      # 全部界面与逻辑（单文件）
├── build.ps1   # 打包脚本
└── README.md
```
