# QQ 工作助手 · DeepSeek 云端版

把重要通知私聊发给自己的 QQ 机器人，收到最多三项重点、时间和本条模型用量。支持文字、PNG/JPEG/WebP 图片，以及 PDF/DOCX/XLSX/PPTX/TXT/CSV 中能提取的正文。

**第一次搭建，请从 [完整安装教程](安装教程.md) 开始。** 教程包含 QQ 创建、DeepSeek 密钥、服务器购买、安装、本人绑定、SSH 管理页、测试和排错。无需先用 AI 生成代码，也无需安装 OpenClaw 或保持电脑上的 Codex 在线。

这是供个人使用的源码项目，包含安装脚本，不是腾讯或 DeepSeek 的官方客户端。普通私聊接入能力以你的 QQ 后台权限为准。当前版本支持 Ubuntu 24.04，x86_64/ARM64，建议至少 2GB 内存。请在一台**没有安装过本助手的服务器**上首次安装。

## 想让 Agent 帮你搭建

**只拿到链接的新用户，先看 [START_HERE.md](START_HERE.md)。** 已补上 Claude Code、TRAE、WorkBuddy 的项目入口、人工交接、网络失败和终端权限排错。想给朋友使用，看 [分享给好友](FRIEND_SHARING.md)。

把仓库链接交给 Codex、Claude Code、TRAE、WorkBuddy 或其他有终端权限的 Agent，并加一句：

> 请下载这个仓库，读取 START_HERE.md、AGENTS.md 和 AGENT_SETUP.md，检查我的环境后，实际帮我安装并验证。只有必须本人登录、购买、填写密钥、绑定和确认权限的步骤才交给我，并给出具体指引。只用我自己的账号，不要把密钥放进聊天或 GitHub。

仓库入口：[Agent 部署流程](AGENT_SETUP.md) · [Agent 约定](AGENTS.md) · [手动安装教程](安装教程.md)。提供链接本身不授予工具权限；Agent 需要能执行终端命令，并连接你授权的服务器。只有聊天能力的助手可以指导，但无法替你执行安装。

最新版本 **v1.2.0**：[下载源码包](https://github.com/SHAWZHANG360/qq-work-assistant/raw/refs/heads/main/qq-work-assistant-v1.2.0.zip) · [校验和](https://github.com/SHAWZHANG360/qq-work-assistant/blob/main/SHA256SUMS.txt) · [更新说明](CHANGELOG.md)。v1.2.0 新增可选家人/好友邀请制，默认关闭，升级不会自动开放权限。旧版压缩包保留为历史快照。

## 可选：家人或好友共用

仅本人使用无需额外操作。想共用现有机器人与服务器，可在配置向导选择开启，或安装/升级后运行 `sudo python3 /opt/qq-work-assistant/configure.py --sharing on`，再重启服务。管理员在 QQ 发 `/invite 称呼`，对方使用邀请后由管理员 `/approve 编号` 批准。费用仍由管理员支付，用量单独统计；成员无需另买服务器。逐步操作和关闭方法见 [FRIEND_SHARING.md](FRIEND_SHARING.md)。

## 回复和提醒规则

具体要做的事放在第一行，合并同一目标的重复步骤，保留本条 token 用量。不会再附上“还有几个待确认问题”“完整详情见服务器日志”；影响理解的图片模糊、附件未读全等情况保留一句提示。完整依据仍可在管理页查看。

| 原文时间 | 回复与提醒 |
| --- | --- |
| 有明确日期和时刻，尚未过去 | 显示该具体时刻，并在到点后提醒 |
| 没有具体时刻 | 显示收到后 3 小时的具体提醒时间，注明默认安排，不伪造截止时间 |
| 时间已经过去 | 标注“时间已过”，不新建提醒 |

只有日期时，当天尚未结束不判过期；没有时刻则使用三小时默认安排。提醒保存在服务器，重启后保留；历史旧消息不会批量补建提醒。每 30 秒检查到期事项，提醒直接使用已保存的内容，不再次调用模型。

QQ 私聊发送 `提醒`（或 `/reminders`）查看，发送 `取消提醒`（或 `/cancel-reminders`）取消所有尚未发送的提醒。主动发送受 QQ 平台权限和额度限制，失败或结果不明会记录，不能保证无限推送，也不能替代重要事务的可靠闹钟。

2026-10-23 已补充一次真实 QQ 收件实测：明确时刻和收到后三小时的两条主动提醒均经手机确认，过期事项未新建提醒。详见 [验证记录](验证记录.md)；新部署仍须按 [三种时间规则验收](安装教程.md#三种时间规则怎样验收) 检查自己的账号。版本 ZIP 是发布时快照，后续验收说明以仓库最新文档为准。

## 已准备好账号和服务器的用户

下载仓库 ZIP，上传服务器，解压后进入能看到 `install.sh` 的目录，再运行：

```bash
sudo bash install.sh
sudo python3 /opt/qq-work-assistant/configure.py
sudo systemctl enable --now qq-work-assistant
sudo systemctl status qq-work-assistant --no-pager
```

向导会要求你填写自己的 AppID、QQ AppSecret、DeepSeek API Key，并选择是否开启家人/好友共享（默认关闭）。密钥不回显；姓名、单位和部门可以留空。不要把真实配置写进下载的源码文件，不要提交到 GitHub。

在自己电脑建立 SSH 隧道，打开管理页，复制临时绑定指令，发给自己创建的机器人，收到“本人绑定成功”后再发虚构测试通知。具体 SSH 命令和成功标志见教程。

## 数据和权限

- 默认只处理绑定者主动发送的私聊；可选择开启共享，让管理员与最多 3 位经邀请、批准的家人/好友使用，每人记录、提醒、关键词和用量隔离。不读取工作群或其他会话。身份绑定使用 QQ 事件中的用户标识，姓名关键词不能绕过授权。
- 文字、图片或文档提取文字会提交 DeepSeek，费用计入你自己的 API 账号；原文、附件和分析结果保存在你的服务器。
- 管理服务仅监听服务器的 `127.0.0.1:18080`，通过 SSH 隧道访问。不要改成公网监听，不要在云防火墙开放该端口。
- 密钥文件在 `/etc/qq-work-assistant/config.json`，权限 600、root 持有，由 systemd 凭据机制交给进程。**这不是磁盘加密**，服务器管理员仍可读取；请保护服务器账号和备份。
- 支持上述 QQ 定时提醒，不自动写入外部日历。`/today` 只从当天完成的分析中选最多三项，不额外调用模型，也不做跨消息语义合并。
- QQ 转发卡片未必包含可读正文；文件没有传到机器人时，可通过管理页上传原文件。扫描 PDF、Office 内嵌图片不做自动 OCR，请改发清晰截图。

## 文件导航

| 文件 | 用途 |
|---|---|
| `START_HERE.md` / `FRIEND_SHARING.md` | 新用户与各 Agent 客户端起步 / 可选家人好友共享操作 |
| `AGENTS.md` / `AGENT_SETUP.md` / `CLAUDE.md` | Agent 入口、按阶段自动执行与人工操作指引 |
| `doctor.py` / `upgrade.sh` | 只读环境检查 / 备份后升级通用版 |
| `action-brief.mjs` / `reminders.mjs` | 动作优先的回复、持久化提醒与发送状态 |
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
python3 -B -m unittest test_configure.py test_doctor.py
```

运行凭据、私人日志和数据库均不在仓库内。仓库里的通知、用户标识和 `test-only` 密钥字样都是测试样例，不能用于实际登录。

已有通用版用户：从新下载的源码目录运行 `sudo bash upgrade.sh`。脚本保留配置、绑定和历史数据，先备份、测试再切换；不要先覆盖 `/opt/qq-work-assistant`，也不要删除数据重装。完整步骤见 [Agent 部署流程](AGENT_SETUP.md)。
