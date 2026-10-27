#!/bin/bash
# BV2MP3 · 双击启动
# 首次使用若提示「无法打开」，在终端执行一次：
#   chmod +x start.command
cd "$(dirname "$0")" || exit 1

# 双击启动时 PATH 往往很短，补上常见安装位置
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/anaconda3/bin:$HOME/miniconda3/bin:$PATH"

pause_exit() {
  echo
  read -r -p "按回车退出…" _
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org"
  pause_exit
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 版本过低（当前 $(node -v)），需要 20 或更高。"
  pause_exit
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "未找到 ffmpeg，转换功能不可用。"
  echo "安装方式：brew install ffmpeg"
  echo "（服务仍会启动，但无法转码。）"
fi

if [ ! -d node_modules/bv2mp3 ]; then
  echo "首次运行，正在安装依赖…"
  npm install --no-audit --no-fund || pause_exit
fi

exec node server.mjs --open
