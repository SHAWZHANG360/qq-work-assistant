# QQ 工作助手 · DeepSeek 云端版

把重要通知私聊发给自己的 QQ 机器人，收到最多三项重点、时间和本条模型用量。支持文字、PNG/JPEG/WebP 图片，以及 PDF/DOCX/XLSX/PPTX/TXT/CSV 中能提取的正文。

**第一次搭建，请从 [完整安装教程](安装教程.md) 开始。** 教程包含 QQ 创建、DeepSeek 密钥、服务器购买、安装、本人绑定、SSH 管理页、测试和排错。无需先用 AI 生成代码，也无需安装 OpenClaw 或保持电脑上的 Codex 在线。

这是供个人使用的源码项目，包含安装脚本，不是腾讯或 DeepSeek 的官方客户端。普通私聊接入能力以你的 QQ 后台权限为准。当前版本支持 Ubuntu 24.04，x86_64/ARM64，建议至少 2GB 内存。请在一台**没有安装过本助手的服务器**上首次安装。

## 已准备好账号和服务器的用户

下载仓库 ZIP，上传服务器，解压后进入能看到 `install.sh` 的目录，再运行：

```bash
sudo bash install.sh
sudo python3 /opt/qq-work-assistant/configure.py
sudo systemctl enable --now qq-work-assistant
sudo systemctl status qq-work-assistant --no-pager
```

向导会要求你填写自己的 AppID、QQ AppSecret、DeepSeek API Key。密钥不回显；姓名、单位和部门可以留空。不要把真实配置写进下载的源码文件，不要提交到 GitHub。

在自己电脑建立 SSH 隧道，打开管理页，复制临时绑定指令，发给自己创建的机器人，收到“本人绑定成功”后再发虚构测试通知。具体 SSH 命令和成功标志见教程。

## 数据和权限

- 只处理绑定者主动发送的私聊，不读取工作群或其他会话。身份绑定使用 QQ 事件中的用户标识，姓名关键词不能绕过授权。
- 文字、图片或文档提取文字会提交 DeepSeek，费用计入你自己的 API 账号；原文、附件和分析结果保存在你的服务器。
- 管理服务仅监听服务器的 `127.0.0.1:18080`，通过 SSH 隧道访问。不要改成公网监听，不要在云防火墙开放该端口。
- 密钥文件在 `/etc/qq-work-assistant/config.json`，权限 600、root 持有，由 systemd 凭据机制交给进程。**这不是磁盘加密**，服务器管理员仍可读取；请保护服务器账号和备份。
- 不自动写入外部日历，不自动定时推送。`/today` 只从当天完成的分析中选最多三项，不额外调用模型，也不做跨消息语义合并。
- QQ 转发卡片未必包含可读正文；文件没有传到机器人时，可通过管理页上传原文件。扫描 PDF、Office 内嵌图片不做自动 OCR，请改发清晰截图。

## 文件导航

| 文件 | 用途 |
|---|---|
| `安装教程.md` | 面向初学者的安装、使用和维护步骤，也可作为知乎图文正文 |
| `install.sh` | 安装 Node.js、Python 环境和 systemd 服务，不自动填写凭据 |
| `configure.py` / `config.example.json` | 交互配置向导 / 空字段说明模板 |
| `main.mjs` / `application.mjs` | 程序入口、本人授权、任务队列、分析和回复 |
| `qq-client.mjs` | 腾讯官方鉴权、WebSocket 私聊事件和回复 |
| `deepseek.mjs` / `deepseek-settings.mjs` | DeepSeek 请求、模型选择 |
| `attachments.mjs` / `documents.mjs` / `document-extract.py` | 图片下载验证、附件正文提取 |
| `store.mjs` / `usage-store.mjs` | 身份绑定、消息记录、用量统计 |
| `server.mjs` / `dashboard.html` | 通过 SSH 访问的管理页 |
| `*.test.mjs` / `test_configure.py` | 使用虚构数据的自动测试，不需要真实 API 密钥 |
| `PRIVACY.md` | 发布前检查范围、排除内容及后续分享注意事项 |

测试命令（在服务器安装后的目录运行；没有真实模型调用）：

```bash
cd /opt/qq-work-assistant
QQ_ASSISTANT_PYTHON=/opt/qq-work-assistant/.venv/bin/python ./node/bin/node --test *.test.mjs
python3 -m unittest test_configure.py
```

运行凭据、私人日志和数据库均不在仓库内。仓库里的通知、用户标识和 `test-only` 密钥字样都是测试样例，不能用于实际登录。
