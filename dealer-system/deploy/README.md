# 经销商业绩系统 — Alibaba Cloud Linux 3 部署手册

> 适用：阿里云 ECS（不是轻量），Alibaba Cloud Linux 3.2104 LTS 64 位
> 时间：2026-08-08
> 作者：温道商学院 IT（WorkBuddy 协助）

## 0. 前置条件

- 阿里云 ECS 实例已开通（**2 核 2G / Alibaba Cloud Linux 3 / 广州**）
- 安全组已放行端口：**22 (SSH) / 80 (HTTP) / 443 (HTTPS)**
- 准备好 SSH 登录方式（**root 密码** 或 **SSH 密钥**）

## 1. 数据准备（本地 → 服务器）

本地 `dealer-system/data/app.db` 含经销商/管理员账号和 605 行业绩。要把数据带到服务器：

### 1.1 本地打包（WAL 必须先合并）

**先关本地服务**（避免迁移时丢数据）：

```powershell
# Windows 关闭本地服务
# 如果"启动系统.bat"还在跑，关掉那个 cmd 窗口
# 或运行端口占用查杀
netstat -ano | findstr ":8123"
taskkill /F /PID <上面查到的PID>
```

**打包数据目录**（只打包 db，**不带 wal/shm**）：

```powershell
# 在仓库根目录
mkdir D:\dealer-data-export
copy D:\温道\workbuddy\经销商业绩统计表\dealer-system\data\app.db D:\dealer-data-export\
```

### 1.2 上传到服务器

需要一台装了 SSH 的客户端（**Windows 自带 OpenSSH**）。

```powershell
# Windows PowerShell（推荐）
scp D:\dealer-data-export\app.db root@你的公网IP:/opt/dealer/dealer-system/data/

# 或者用 ssh + 手动拷贝（不推荐，容易出错）
```

输入 root 密码后完成上传。

### 1.3 验证上传

服务器端：

```bash
ls -la /opt/dealer/dealer-system/data/app.db
# 应该显示 350KB 左右
sqlite3 /opt/dealer/dealer-system/data/app.db "SELECT COUNT(*) FROM performance"
# 应该返回 605
```

## 2. 服务器部署

### 2.1 SSH 登录

```bash
# Windows PowerShell / cmd / macOS / Linux
ssh root@你的公网IP
# 输入密码
```

### 2.2 跑部署脚本

整个 `alinux3-deploy.sh` 复制到服务器上跑，或者用 scp 传上去：

```bash
# 本地（Windows）
scp D:\温道\workbuddy\经销商业绩统计表\dealer-system\deploy\alinux3-deploy.sh root@你的公网IP:/tmp/

# 服务器上
chmod +x /tmp/alinux3-deploy.sh
bash /tmp/alinux3-deploy.sh
```

脚本会自动：
1. 装 git / nginx / certbot
2. 装 Node.js 22 LTS
3. 拉代码到 `/opt/dealer`
4. 启动 systemd 服务 `dealer`
5. 配 Nginx 反代到 8080
6. （如果有域名）自动申请 HTTPS 证书

跑完后访问：
- **无域名**：`http://你的IP/`
- **有域名**：`https://你的域名/`

### 2.3 验证

```bash
# 服务状态
systemctl status dealer

# 日志
tail -f /var/log/dealer.log

# 接口健康
curl http://127.0.0.1:8080/api/dealer/me
```

## 3. 防火墙与备案

阿里云 ECS **默认不开 80/443**，必须：
- **安全组放行**（控制台 → ECS → 安全组 → 入方向）
- **公网带宽 ≥ 3Mbps**（你的配置已满足）
- **域名备案**（如果用域名访问，**境内必须备案**才能解析到境内服务器）

## 4. 日常运维

### 数据备份

```bash
# 加到 crontab 每天凌晨 3 点跑
echo "0 3 * * * cp /opt/dealer/dealer-system/data/app.db /backup/app_\$(date +\%F).db" >> /var/spool/cron/root

# 立即备份
cp /opt/dealer/dealer-system/data/app.db /backup/app_manual_$(date +%F).db
```

### 服务管理

```bash
systemctl status dealer      # 状态
systemctl restart dealer     # 重启
systemctl stop dealer        # 停
systemctl start dealer       # 启动
journalctl -u dealer -f      # 实时日志
```

### 代码更新

```bash
cd /opt/dealer
git pull
systemctl restart dealer
```

## 5. 常见问题

| 现象 | 排查 |
|---|---|
| `http://IP/` 访问不到 | 安全组没放行 80；检查 `systemctl status nginx` |
| HTTPS 签发失败 | 域名没解析；或 80 端口被占；查看 `certbot --nginx -d 域名` 输出 |
| 服务启动但 `/api/dealer/me` 500 | 检查 `/var/log/dealer.log`，通常是数据目录权限或 db 文件损坏 |
| `systemctl status dealer` 失败 | 看 `journalctl -xe`，常见是 Node 版本过低（要 ≥ 18） |
| 经销商登录后看到"未登录" | 检查 Nginx 配置里 `proxy_set_header Host $host;` 是否在 |

---

**应急联系**：WorkBuddy / 雷师兄