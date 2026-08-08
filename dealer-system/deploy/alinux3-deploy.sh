#!/usr/bin/env bash
# 经销商业绩查询系统 — Alibaba Cloud Linux 3 一键部署脚本
# 适用：阿里云 ECS，Alibaba Cloud Linux 3.2104 LTS 64位
# 角色：root
#
# 用法（登录到 ECS 后，整个脚本复制粘贴跑）：
#   bash alinux3-deploy.sh
#
# 中途需要输入一次：
#   - 你的域名（无域名就回车，会用 IP 访问）
#   - certbot 申请证书时的邮箱
#
# 跑完会输出：
#   ✓ systemd 服务 dealer 已启动
#   ✓ Nginx 反代已配
#   ✓ HTTPS 已签发（或仅 HTTP，用 IP 也能访问）
#   经销商入口: https://你的域名/  或  http://你的IP/
#   管理员后台: https://你的域名/admin  或  http://你的IP/admin

set -euo pipefail

# ---------- 1. 装基础依赖 ----------
echo "==> [1/8] 装基础依赖 (git, nginx, certbot) ..."
dnf install -y git nginx python3 python3-pip
# certbot 在 EPEL；ACL3 默认源可能没有，启用 EPEL 备用
dnf install -y epel-release || true

# ---------- 2. 装 Node.js 22 LTS（NodeSource 官方源）----------
echo "==> [2/8] 装 Node.js 22 LTS ..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
fi
node -v
npm -v

# ---------- 3. 拉代码 ----------
echo "==> [3/8] 拉代码到 /opt/dealer ..."
mkdir -p /opt/dealer
cd /opt/dealer
if [[ ! -d dealer-system ]]; then
  # 仓库在大目录，dealer-system 是子目录；只取它就行
  git clone --depth 1 https://github.com/voodoohui-lei/wendao.git .
fi
ls -la dealer-system/ | head -10

# ---------- 4. 数据目录准备（数据由你预先 scp 上来）----------
echo "==> [4/8] 检查数据目录 ..."
mkdir -p /opt/dealer/dealer-system/data
if [[ ! -f /opt/dealer/dealer-system/data/app.db ]]; then
  echo "    ⚠️ /opt/dealer/dealer-system/data/app.db 不存在！"
  echo "    请先从本地 scp 上传 app.db（或现在用 Ctrl+C 中断，上传完再跑）"
  exit 1
fi
ls -la /opt/dealer/dealer-system/data/

# ---------- 5. systemd 服务 ----------
echo "==> [5/8] 注册 systemd 服务 ..."
cat > /etc/systemd/system/dealer.service <<'EOF'
[Unit]
Description=Dealer Performance System
After=network.target

[Service]
WorkingDirectory=/opt/dealer/dealer-system
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Environment=HOST=127.0.0.1
Restart=always
RestartSec=5
User=root
StandardOutput=append:/var/log/dealer.log
StandardError=append:/var/log/dealer.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now dealer
sleep 2
systemctl status dealer --no-pager -l | head -15

# 验证 Node 起起来了
curl -sS http://127.0.0.1:8080/api/dealer/me | head -3
echo ""

# ---------- 6. Nginx 反代 ----------
echo "==> [6/8] 配置 Nginx 反代 ..."
read -rp "请输入你的域名（无域名直接回车，将用 _ 监听 80/443）: " DOMAIN
DOMAIN=${DOMAIN:-_}

cat > /etc/nginx/conf.d/dealer.conf <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    client_max_body_size 30M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 60s;
    }
}
EOF

nginx -t
systemctl enable --now nginx
systemctl reload nginx
echo "    ✓ Nginx 已配，监听 80"

# ---------- 7. HTTPS（certbot） ----------
if [[ "${DOMAIN}" != "_" ]]; then
  echo "==> [7/8] 申请 HTTPS 证书 (Let's Encrypt) ..."
  read -rp "请输入证书通知邮箱: " EMAIL
  # 安装 certbot nginx 插件（dnf 或 pip 路径都可能）
  (dnf install -y certbot python3-certbot-nginx || pip3 install certbot certbot-nginx) || true
  certbot --nginx --non-interactive --agree-tos -m "${EMAIL}" -d "${DOMAIN}" || {
    echo "    ⚠️ certbot 自动签发失败（通常是域名没解析或 80 端口未通），先用 HTTP 跑：https://${DOMAIN}/"
  }
  echo "    ✓ HTTPS 配置完成（或提示手动排查）"
else
  echo "==> [7/8] 跳过 HTTPS（无域名，IP 模式）"
fi

# ---------- 8. 验证 ----------
echo ""
echo "================================================================"
echo "  部署完成"
echo "================================================================"
if [[ "${DOMAIN}" != "_" ]]; then
  echo "  经销商入口:   https://${DOMAIN}/"
  echo "  管理员后台:   https://${DOMAIN}/admin"
else
  IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  echo "  经销商入口:   http://${IP}/"
  echo "  管理员后台:   http://${IP}/admin"
  echo "  （HTTPS 需要有域名后才能签证书）"
fi
echo ""
echo "  常用命令："
echo "    systemctl status dealer    # 看运行状态"
echo "    systemctl restart dealer   # 重启"
echo "    tail -f /var/log/dealer.log # 看实时日志"
echo "    less /var/log/nginx/access.log"
echo ""
echo "  数据备份（每天凌晨跑）："
echo "    cp /opt/dealer/dealer-system/data/app.db /backup/app_\$(date +\\%F).db"
echo ""
echo "================================================================"