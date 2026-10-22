# 只拿到一个链接，从这里开始

本页是给第一次使用的人和协助安装的 Agent 的共同入口。目标是：把助手部署到使用者自己的 Ubuntu 24.04 服务器，接自己的 QQ 机器人和 DeepSeek API，默认只接受本人消息，也可选择开启最多 3 位家人/好友的邀请制共享。

**链接不会自动授予权限。** Agent 需要能读取文件、运行终端、访问网络，并获准连接目标服务器。只读问答、计划模式或不支持终端的任务只能提供指导。不要为安装关闭全部安全确认；按当前步骤批准必要权限即可。

## 1. 把这段话一起发给 Agent

```text
请实际帮我搭建 https://github.com/SHAWZHANG360/qq-work-assistant 。
先把仓库下载到一个新的工作目录，阅读 START_HERE.md、AGENTS.md、AGENT_SETUP.md 和 PRIVACY.md。
先告诉我你能否读文件、运行终端和连接服务器；随后检查我的现有环境。
复用我已有的账号和服务器，不重复购买；只给我本人使用，接我自己的 DeepSeek API。
可以自动完成的下载、安装、服务配置和验证请执行，不要停在给命令清单。
需要我登录、实名、购买、充值、授权、输入密钥或发 QQ 消息时，
每次给出：在哪里操作、做什么、成功标志、完成后回你什么。等我完成再继续。
密钥只在我自己的服务器交互终端输入，不进聊天、源码或截图。
不要公开管理端口，不覆盖已有数据，已有部署先检查和备份。
无法执行时说清缺少什么，给出可操作的替代办法，不要假装完成。
```

如果 Agent 打不开 GitHub 网页，先让它读取 [本页纯文本](https://raw.githubusercontent.com/SHAWZHANG360/qq-work-assistant/main/START_HERE.md) 和 [部署指南纯文本](https://raw.githubusercontent.com/SHAWZHANG360/qq-work-assistant/main/AGENT_SETUP.md)。这两个地址也打不开时，自己从 [发布页](https://github.com/SHAWZHANG360/qq-work-assistant/releases/latest) 下载源码 ZIP，解压后把目录交给 Agent。不要只上传 ZIP 后默认它已经解压、读过说明。

希望共用时，把提示词里的“只给我本人使用”改为“我本人和最多 3 位家人/好友共用，请开启邀请制共享，记录、提醒和用量分开，带我逐人邀请和批准”。未明确选择共享时保持关闭；先验收管理员本人，再添加成员。

## 2. 在不同软件中怎么交给它

| 软件 | 具体做法 | 如果它只解释、不执行 |
| --- | --- | --- |
| Claude Code | 下载并解压仓库，在能看到 `CLAUDE.md` 的目录启动 Claude Code，或在其界面打开该项目，再发上面的提示词。仓库的 `CLAUDE.md` 会指向完整指南。 | 明确让它读取文件并使用终端；检查当前是否只有计划/只读权限。按软件提示批准所需操作，不启用跳过全部权限的参数。 |
| TRAE | 打开解压后的项目目录，选择能编辑文件和使用终端的智能体，再发提示词。可用 `#File` 引用 `START_HERE.md` 和 `AGENT_SETUP.md`。 | 检查任务是否为只读对话，文件是否在当前项目；显式要求读取上述文件。不同版本、地区的模式名称可能不同。 |
| WorkBuddy | 创建任务时选择解压后的文件夹作为工作目录；引用这两份文件并发提示词。确认当前任务可以运行终端及访问网络。 | 若当前任务没有终端入口，换用支持终端的本地任务，或让它指导你在自己的 SSH/厂商终端执行。不把“可读文档”当成“可部署服务器”。 |

不依赖每款产品都自动识别同一种规则文件，**显式要求读文件是共同的备用办法**。软件登录和额度按各自平台处理；Agent 的费用与部署后机器人使用的 DeepSeek API 费用是两回事。运行中的 QQ 助手不要求这些客户端一直开着。

这些操作依据官方说明整理：[Claude Code 项目说明](https://code.claude.com/docs/en/memory)、[TRAE 规则](https://docs.trae.cn/ide_rules)、[TRAE 引用文件](https://docs.trae.cn/ide_number-sign)、[WorkBuddy 创建任务](https://www.codebuddy.cn/docs/workbuddy/Create-Task)、[WorkBuddy 终端入口](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Right-Sidebar)。界面可能更新，请以当前软件实际工具和权限为准。

## 3. Agent 先检查什么

请 Agent 逐项检查，不要求用户先学会全部命令：

1. **工作目录**：能读到 `install.sh`、`configure.py`、`AGENT_SETUP.md`。源码目录与服务器安装目录是两回事。
2. **操作端**：Windows 使用 PowerShell；macOS/Linux 使用终端。确认 SSH 客户端可用。不要在 Windows 本机运行 `sudo bash install.sh`。
3. **账号**：QQ 机器人可私聊，DeepSeek API 有可用余额。没有就按 [部署指南第 1–2 步](AGENT_SETUP.md) 逐项引导，不要先买完服务器才发现 QQ 账号不支持。
4. **服务器**：确认 Ubuntu 24.04、支持的架构、有 systemd、磁盘空间及管理员权限；优先使用专用的新实例。已有业务不重装系统。
5. **连接**：先在厂商终端执行 `whoami` 确认真实登录用户名，再准备 SSH。公网 IP、用户名、密钥路径应在本机配置，不写进公开教程或 issue。完整公钥配置见 [安装教程第 11 节](安装教程.md#111-在-windows-准备-ssh-密钥)。
6. **权限交接**：如果 sudo 需要密码，由用户在自己的交互终端输入；如果 Agent 的 SSH 没有 TTY，不能在那里运行密钥向导。用户应另开自己的 SSH 窗口或厂商终端执行向导。

第一次 SSH 连接要核对服务器指纹。不能使用 `StrictHostKeyChecking=no` 绕过，也不要删除所有已保存的主机指纹。连接成功只证明可以登录；还需检查外网下载和服务状态。

## 4. 下载有两条路，选一条

**路线 A：服务器能访问 GitHub。** 在服务器终端执行；已有 `source` 目录时换一个新的空目录，不删除旧文件：

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates
mkdir -p ~/qq-assistant-setup
cd ~/qq-assistant-setup
git clone https://github.com/SHAWZHANG360/qq-work-assistant.git source
cd source
git rev-parse HEAD
python3 doctor.py --json
```

**路线 B：服务器访问不了 GitHub，但自己的电脑能下载。** 本机从发布页下载打包好的 ZIP，使用厂商文件上传功能或已有 SSH 的 `scp` 上传到服务器用户主目录。Workbench 没有上传入口时用 `scp`；也可在本机先解压再传目录。不要购买额外 GitHub 服务或提供 GitHub Token，公开仓库下载不需要 Token。

Windows PowerShell 的上传示例，先把所有大写占位符替换成自己的值；文件路径用引号包住：

```powershell
scp -i "YOUR_PRIVATE_KEY_PATH" "YOUR_DOWNLOADED_ZIP_PATH" YOUR_SSH_USER@YOUR_SERVER:~/
```

服务器终端解压示例：

```bash
sudo apt-get update
sudo apt-get install -y unzip
mkdir -p ~/qq-assistant-setup
cd ~/qq-assistant-setup
unzip ~/qq-work-assistant-v1.2.0.zip
cd qq-work-assistant
python3 doctor.py --json
```

上面的包名对应本次发布。若从绿色 Code → Download ZIP 下载主分支，文件通常叫 `qq-work-assistant-main.zip`，解压目录通常为 `qq-work-assistant-main`，请用 `ls` 确认，不能照抄另一种包的目录。

发布 ZIP 的校验值见 [SHA256SUMS.txt](https://github.com/SHAWZHANG360/qq-work-assistant/blob/main/SHA256SUMS.txt)。Windows 可用 `Get-FileHash "文件路径" -Algorithm SHA256`，Linux 可用 `sha256sum 文件名.zip`，与所下载版本对应的一行比较。自行从 main 下载的 GitHub 源码快照与发布 ZIP 不是同一个文件，不能用发布包哈希校验它。

**上传源码只能解决 GitHub 下载问题。** 安装还要访问 Ubuntu 软件源、nodejs.org 和 Python 包源，运行还要访问腾讯及 DeepSeek。遇到 DNS、超时或证书错误应定位具体域名；不关闭 TLS 校验，不把密钥交给来历不明的中转接口。公司网络无法放行时改用符合条件的服务器网络。

## 5. 安装过程不要在人工步骤断掉

下载后，继续按 [AGENT_SETUP.md 第 4–9 步](AGENT_SETUP.md) 执行。每次需要用户接手时，Agent 用这样的格式：

> 现在需要你在自己的服务器终端运行 `sudo python3 /opt/qq-work-assistant/configure.py`。按提示输入两个平台的密钥，密钥输入不回显。出现“配置已验证并保存”后，只回复我这句话；不要把密钥或完整配置发来。我随后会启动服务并检查连接。

| 卡住的现象 | 下一步，不需要从头重做 |
| --- | --- |
| Agent 说读不了链接 | 本机下载解压，选择该文件夹；让它直接读取指南文件 |
| 没有 git、unzip 或 SSH | 使用上面的下载替代路线，或安装官方系统组件；Windows SSH 入口见安装教程 |
| SSH 超时 | 检查实例运行状态、公网 IP、TCP 22 来源规则和本机网络；保留现有可用连接 |
| `Permission denied (publickey)` | 检查实际用户名、私钥路径及对应用户的 `authorized_keys`，不是填 API 密钥 |
| 安装中断，再运行提示已有安装 | 先运行 doctor 并检查 `/opt`、`/etc`、`/var/lib` 及服务状态。部分安装不能假装成全新安装，也不能直接删数据；由 Agent 判断补全步骤还是恢复备份 |
| `sudo` 要密码或向导说需要交互终端 | 本人在自己的 SSH/厂商终端执行；不要把密码放进 Agent 聊天或命令参数 |
| 已保存配置，QQ 仍未连接 | 启动或重启服务，检查 AppID 与 AppSecret 对应关系；开发平台“在线”不等于本程序已连接 |
| QQ 已连接但没回复 | 检查本人测试权限和绑定；未绑定先发送管理页的临时指令；非绑定账号会被忽略 |
| 管理页打不开或 403 | 确认隧道保持运行，浏览器用 `http://127.0.0.1:18080/`；不要用 `localhost`、服务器公网 IP 或随便换端口 |
| 本地 18080 被占用 | 查明占用者，只处理已确认属于本助手的旧隧道；不能为了绕过占用把管理服务公开 |
| 模型列表通过，但分析失败 | 继续检查 API 余额、所选模型和实际请求；列表验证不代表真实分析已成功 |
| 换网络或 Agent 重启了 | 读取不含密钥的阶段记录，重新检查实际状态，继续未完成步骤，不重新付款、不重绑本人 |

## 6. 什么才叫完成

代码测试通过、服务 active、QQ 已连接、本人已绑定、真实分析成功是不同的检查。最后需分别验收文字、图片、附件，以及三种时间规则。无时间的真实提醒需要等三小时；不能改生产时间来假装通过。

`sudo python3 /opt/qq-work-assistant/doctor.py --json --require-ready` 的成功仅表示可以开始消息测试。`analysisReady=false` 在首次分析前是正常的；真实模型调用成功需要另做测试。管理页及 QQ 的“提醒”命令用于查看待发和失败状态。

如果 Agent 无法自动回查，留下实际到期时刻，并让用户到时在 QQ 发送“提醒”查看状态，同时确认是否收到主动提醒。不要承诺 Agent 会自行醒来。所有验收完成后才交接；平台拒绝主动发送时，应明确“分析可用，主动提醒未通过”，继续排查账号权限。

## 验证范围

已按新用户路线检查公开下载、解压目录、文件入口、安装指引和人工交接，并有 Ubuntu 自动化安装及升级验证。本次没有登录三个产品的独立新账号逐一操作，因此不能宣称 Claude Code、TRAE、WorkBuddy 都已完成真人端到端实测。官方文档说明它们具备的能力，最终能执行到哪一步仍取决于具体客户端、版本、权限、网络和账号条件。

想分享给朋友，先看 [FRIEND_SHARING.md](FRIEND_SHARING.md)。管理员本人绑定一次，其他人通过邀请和批准加入。默认共享关闭。
