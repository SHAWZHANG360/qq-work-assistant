#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ${EUID} -ne 0 ]]; then echo '请运行 sudo bash install.sh'; exit 1; fi
source /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
  echo '此安装脚本仅支持 Ubuntu 24.04。请勿在其他系统强行运行。'; exit 1
fi
case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) echo '不支持的 CPU 架构'; exit 1;; esac
dest=/opt/qq-work-assistant
for existing in "$dest" /etc/qq-work-assistant /var/lib/qq-work-assistant /etc/systemd/system/qq-work-assistant.service; do
  if [[ -e "$existing" ]]; then echo "检测到已有安装或数据：$existing。为保护数据，停止安装。请阅读维护说明。"; exit 1; fi
done
command -v systemctl >/dev/null || { echo '缺少 systemd'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils python3 python3-venv
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
# Use a supported Node 24 release and verify the official archive checksum.
version=v24.22.0
archive="node-${version}-linux-${arch}.tar.xz"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 \
  "https://nodejs.org/dist/${version}/${archive}" -o "$scratch/$archive"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 120 \
  "https://nodejs.org/dist/${version}/SHASUMS256.txt" -o "$scratch/SHASUMS256.txt"
(cd "$scratch"; grep "  ${archive}$" SHASUMS256.txt | sha256sum --check --strict -)
mkdir "$scratch/app"
# Copy only the release allowlist, never user-added JSON or credential files.
while IFS= read -r file || [[ -n "$file" ]]; do
  [[ "$file" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]+$ ]] || { echo '安装文件清单无效'; exit 1; }
  [[ -f "$file" && ! -L "$file" ]] || { echo "缺少发布文件：$file"; exit 1; }
  install -m 644 "$file" "$scratch/app/"
done < runtime-files.txt
mkdir "$scratch/app/node"
tar -xJf "$scratch/$archive" -C "$scratch/app/node" --strip-components=1
python3 -m venv "$scratch/app/.venv"
"$scratch/app/.venv/bin/python" -m pip install --disable-pip-version-check -r requirements.txt
if ! id qqassistant >/dev/null 2>&1; then useradd --system --home-dir /var/lib/qq-work-assistant --shell /usr/sbin/nologin qqassistant; fi
mv "$scratch/app" "$dest"
# Recreate the venv at its final path (pip script shebangs must not point into /tmp).
python3 -m venv "$dest/.venv"
chown -R root:root "$dest"
chmod -R go-w "$dest"
chmod -R a+rX "$dest"
chmod 755 "$dest" "$dest/node" "$dest/node/bin" "$dest/.venv" "$dest/.venv/bin"
install -d -m 700 /etc/qq-work-assistant
install -d -o qqassistant -g qqassistant -m 700 /var/lib/qq-work-assistant
install -m 644 qq-work-assistant.service /etc/systemd/system/qq-work-assistant.service
systemctl daemon-reload
echo '安装完成，尚未启动。下一步：sudo python3 /opt/qq-work-assistant/configure.py'
echo '配置成功后运行：sudo systemctl enable --now qq-work-assistant'
