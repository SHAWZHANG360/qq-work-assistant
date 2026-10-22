#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ ${EUID} -eq 0 ]] || { echo '请运行 sudo bash upgrade.sh'; exit 1; }
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || { echo '仅支持 Ubuntu 24.04'; exit 1; }
case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) exit 1;; esac
dest=/opt/qq-work-assistant
[[ -f "$dest/package.json" && -f /etc/qq-work-assistant/config.json && -d /var/lib/qq-work-assistant ]] || {
  echo '没有找到完整的通用版安装；请先检查 doctor.py。此脚本不适用于定制私人部署。'; exit 1;
}
[[ "$(readlink -f -- .)" != "$dest" ]] || { echo '请从单独下载的新版本目录运行，不要先覆盖已安装目录。'; exit 1; }
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
version=v24.22.1
archive="node-${version}-linux-${arch}.tar.xz"
curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 "https://nodejs.org/dist/${version}/${archive}" -o "$scratch/$archive"
curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 120 "https://nodejs.org/dist/${version}/SHASUMS256.txt" -o "$scratch/SHASUMS256.txt"
(cd "$scratch"; grep "  ${archive}$" SHASUMS256.txt | sha256sum --check --strict -)
mkdir "$scratch/app"
while IFS= read -r file || [[ -n "$file" ]]; do
  [[ "$file" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]+$ && -f "$file" && ! -L "$file" ]] || { echo '发布清单无效或缺少文件'; exit 1; }
  install -m 644 "$file" "$scratch/app/"
done < runtime-files.txt
mkdir "$scratch/app/node"
tar -xJf "$scratch/$archive" -C "$scratch/app/node" --strip-components=1
python3 -m venv "$scratch/app/.venv"
"$scratch/app/.venv/bin/python" -m pip install --disable-pip-version-check -r requirements.txt
(cd "$scratch/app"; QQ_ASSISTANT_PYTHON="$scratch/app/.venv/bin/python" ./node/bin/node --test *.test.mjs; python3 -B -m unittest test_configure.py test_doctor.py)
backup=$(mktemp -d /var/backups/qq-work-assistant-upgrade-XXXXXXXX)
echo "备份及回滚目录：$backup"
systemctl stop qq-work-assistant
restore_old() {
  echo '升级未完成，恢复旧程序和服务。'
  systemctl stop qq-work-assistant || true
  if [[ -d "$backup/previous-app" ]]; then
    [[ ! -e "$dest" ]] || mv -- "$dest" "$backup/failed-app"
    mv -- "$backup/previous-app" "$dest"
  fi
  [[ ! -f "$backup/previous.service" ]] || install -m 644 "$backup/previous.service" /etc/systemd/system/qq-work-assistant.service
  systemctl daemon-reload
  systemctl start qq-work-assistant || true
}
trap 'restore_old; exit 1' ERR
tar -czf "$backup/state-before.tar.gz" -C / etc/qq-work-assistant var/lib/qq-work-assistant
cp /etc/systemd/system/qq-work-assistant.service "$backup/previous.service"
mv -- "$dest" "$backup/previous-app"
mv -- "$scratch/app" "$dest"
python3 -m venv "$dest/.venv"
chown -R root:root "$dest"
chmod -R go-w "$dest"
chmod -R a+rX "$dest"
install -m 644 qq-work-assistant.service /etc/systemd/system/qq-work-assistant.service
systemctl daemon-reload
systemctl start qq-work-assistant
ready=false
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:18080/health >/dev/null; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
systemctl is-active --quiet qq-work-assistant
trap - ERR
echo '程序已更新；配置、绑定和历史数据已保留。继续运行 doctor.py 并用 QQ 实测。备份包含密钥，勿上传分享。'
