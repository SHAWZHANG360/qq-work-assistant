#!/usr/bin/env python3
"""Interactive credential setup. Never prints credentials or API response bodies."""
import getpass
import argparse
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path('/etc/qq-work-assistant/config.json')
DATA = Path('/var/lib/qq-work-assistant')


class SetupError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SetupError('接口返回了跳转，已停止发送凭据。')


def request_json(url, *, body=None, headers=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=25) as response:
            raw = response.read(262145)
            if len(raw) > 262144:
                raise SetupError('接口响应过大。')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        raise SetupError(f'接口验证失败（HTTP {error.code}）。检查密钥、账号状态或网络。') from None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        raise SetupError('接口验证失败：网络超时、证书错误或响应格式不正确。') from None


def validate(config):
    allowed = {'appId', 'qqAppSecret', 'deepseekApiKey', 'name', 'organization', 'department'}
    if not isinstance(config, dict) or not allowed.issubset(config) or set(config)-allowed-{'sharingEnabled'}:
        raise SetupError('配置字段不完整或有未知字段。')
    if 'sharingEnabled' in config and type(config['sharingEnabled']) is not bool:
        raise SetupError('共享开关必须为布尔值。')
    if not re.fullmatch(r'[0-9]{5,20}', config['appId']):
        raise SetupError('AppID 应为 5–20 位数字。')
    for key in ('qqAppSecret', 'deepseekApiKey'):
        value = config[key]
        if not isinstance(value, str) or not 16 <= len(value) <= 512 or re.search(r'\s|[\x00-\x1f\x7f]', value):
            raise SetupError('密钥格式不正确：请复制完整内容，不要加引号或空格。')
    for key in ('name', 'organization', 'department'):
        value = config[key]
        if not isinstance(value, str) or len(value) > 100 or re.search(r'[\x00-\x1f\x7f]', value):
            raise SetupError('个人关键词过长或包含控制字符。')
    return config


def verify(config, request=request_json):
    result = request('https://api.bot.qq.com/app/getAppAccessToken',
                     body={'appId': config['appId'], 'clientSecret': config['qqAppSecret']})
    token = result.get('access_token') if isinstance(result, dict) else None
    if not isinstance(token, str) or not token:
        raise SetupError('腾讯未返回有效凭据：AppID 与 AppSecret 可能不匹配。')
    gateway = request('https://api.bot.qq.com/gateway', headers={'Authorization': f'QQBot {token}'})
    if not isinstance(gateway, dict) or not str(gateway.get('url', '')).startswith('wss://'):
        raise SetupError('QQ 网关验证失败，请检查机器人配置及账号状态。')
    models = request('https://api.deepseek.com/models', headers={'Authorization': f'Bearer {config["deepseekApiKey"]}'})
    if not isinstance(models, dict) or not any(m.get('id') == 'deepseek-flash' for m in models.get('data', []) if isinstance(m, dict)):
        raise SetupError('此账号未列出 deepseek-flash。请核对当前模型支持情况，不要盲目替换模型名称。')


def save_atomic(config, file=CONFIG):
    validate(config)
    file = Path(file)
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.config-', dir=file.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            os.chmod(temp, 0o600)
            json.dump(config, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, file)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def update_sharing(enabled, file=CONFIG):
    """Change only the nonsecret switch; preserve credentials and make a private backup."""
    file=Path(file)
    if type(enabled) is not bool or not file.is_file() or file.is_symlink():
        raise SetupError('请先完成配置；不接受符号链接配置。')
    raw=file.read_bytes()
    config=validate(json.loads(raw))
    fd, backup=tempfile.mkstemp(prefix='config-before-sharing-',suffix='.json.bak',dir=file.parent)
    with os.fdopen(fd,'wb') as stream:
        os.chmod(backup,0o600)
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    config={**config,'sharingEnabled':enabled}
    save_atomic(config,file)
    return Path(backup)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sharing',choices=['on','off'],help='仅修改家人/好友共享开关；保留已有密钥，不调用 API')
    args=parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise SetupError('请在服务器交互终端运行 sudo python3 /opt/qq-work-assistant/configure.py')
    if not args.sharing and not sys.stdin.isatty():
        raise SetupError('需要交互终端，不接受管道输入密钥。')
    import fcntl
    CONFIG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(CONFIG.parent / '.configure.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.sharing:
            backup=update_sharing(args.sharing=='on')
            print('共享开关已保存；原配置备份在同一 root 专用目录，包含密钥，勿分享。')
            print('请在没有分析任务运行时执行：sudo systemctl restart qq-work-assistant')
            return
        old = json.loads(CONFIG.read_text('utf-8')) if CONFIG.exists() else {}
        print('凭据只保存在本服务器。输入密钥时屏幕不显示字符，这是正常现象。')
        print('已有配置时，留空保留原值；个人关键词填写 - 可清空。不要把凭据发到聊天或 GitHub。')
        config = {}
        config['appId'] = input('机器人 AppID：').strip() or old.get('appId', '')
        for key, label in [('qqAppSecret', 'QQ AppSecret'), ('deepseekApiKey', 'DeepSeek API Key')]:
            config[key] = getpass.getpass(f'{label}（不回显）：') or old.get(key, '')
        for key, label in [('name', '你的姓名（选填）'), ('organization', '单位（选填）'), ('department', '部门（选填）')]:
            value = input(f'{label}：').strip()
            config[key] = '' if value == '-' else value or old.get(key, '')
        default=old.get('sharingEnabled',False)
        while True:
            choice=input('允许最多 3 位家人/好友共用？需逐人邀请批准，费用由你支付（y/n，回车保留'+('开启' if default else '关闭')+'）：').strip().lower()
            if choice in ('','y','yes','n','no'):
                config['sharingEnabled']=default if not choice else choice in ('y','yes')
                break
            print('请输入 y 或 n。')
        validate(config)
        connection = DATA / 'connection.json'
        if connection.exists() and json.loads(connection.read_text('utf-8')).get('appId') != config['appId']:
            raise SetupError('已有数据属于另一个 AppID。禁止混用绑定身份；请使用独立服务器安装。')
        print('正在向腾讯、DeepSeek 官方接口验证；不会输出返回的令牌。')
        verify(config)
        save_atomic(config)
        print('配置已验证并保存（root 专用，权限 600）。模型列表验证不代表余额充足。')
        print('首次启动：sudo systemctl enable --now qq-work-assistant')
        print('修改配置后：sudo systemctl restart qq-work-assistant')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n已取消，没有提交本次配置。')
        sys.exit(1)
    except SetupError as error:
        print(f'未完成：{error}', file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('未完成：请检查配置文件、权限或网络；错误详情不回显，避免泄露凭据。', file=sys.stderr)
        sys.exit(1)
