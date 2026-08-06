# 经销商业绩查询系统

> 温道商学院内部业务系统。管理员上传 Excel 业绩台账，经销商通过手机号注册后查看自己名下门店代理业绩（**行级数据隔离**，无法越权查看他人）。

## 核心特性

- **零外部依赖**：纯 Node.js 内置模块（http / sqlite / crypto / zlib / fs / path），无需 `npm install`，避免供应链风险
- **行级权限隔离**：SQL 层强制 `WHERE phone = Session.phone`，前端传入任何 phone 参数一律忽略
- **零依赖 XLSX 解析**：手写 ZIP + XML 解析，能识别 Excel 的 `#N/A`（无归属手机号）并隔离
- **密码安全**：scrypt 加盐哈希，会话服务端 Session + HttpOnly Cookie（经销商/管理员 Cookie 名分离）
- **首次注册日兼容**：按 IP 限流 50/10min，允许同一公司 NAT 下数十名经销商同时注册

## 目录结构

```
dealer-system/
├── server.js            主服务（http + 路由 + 行级隔离）
├── lib/
│   ├── db.js            SQLite 数据层（6 张表，WAL 模式）
│   ├── auth.js          服务端 Session + Cookie + 限流
│   └── xlsx.js          零依赖 XLSX/CSV 解析器
├── public/
│   ├── index.html       经销商端（注册/登录/查询）
│   └── admin.html       管理员后台（导入/台账/账号/批次/审计）
├── tools/
│   ├── e2e-test.js      端到端验收（46 项，含 9 项越权攻击）
│   ├── import-cli.js    命令行导入
│   └── reset-admin.js   忘记后台密码时重置
├── data/                SQLite 数据库（运行时生成，git 忽略）
│   └── .gitkeep
├── 启动系统.bat         Windows 双击启动
└── 操作手册.md          完整文档（数据口径/部署/运维）
sample-data/
└── sample.xlsx          脱敏样例数据（不含真实手机号）
```

## 快速开始（本地开发）

需要 Node.js 18+（推荐 22+，自带 `node:sqlite` 内置模块）。

```bash
cd dealer-system
node server.js              # 默认监听 :: ，端口 8080
# 或自定义端口：
PORT=8123 node server.js
```

打开浏览器：
- 经销商入口：`http://localhost:8080/`
- 管理员后台：`http://localhost:8080/admin`
- 初始管理员：`admin` / `admin888`（首登强制改密）

## 数据口径（关键，不要改）

Excel 12 个固定字段（顺序固定）：

| # | 字段 | 说明 |
|---|------|------|
| 1 | 用户ID | 门店代理用户ID |
| 2 | 昵称 | 门店代理昵称 |
| 3 | 姓名 | 门店代理人名 |
| 4 | 代理等级 | 门店代理 |
| 5 | 业绩周期 | YYYY-MM-DD（如 `2026-07-01`） |
| 6 | 归属高级ID | 经销商用户ID |
| 7 | 归属高级昵称 | 经销商昵称 |
| 8 | 归属高级姓名 | 经销商人名 |
| 9 | **电话** | **归属高级手机号**（#N/A 表示无归属，仅管理员可见） |
| 10 | 归属高级等级 | 经销商等级 |
| 11 | 金额 | 业绩金额 |
| 12 | 佣金 | 佣金 |

**经销商身份 = 归属高级**。登录后看「自己名下门店代理业绩」（即 phone 匹配的所有门店代理行）。

> **重要**：源 Excel 用 VLOOKUP 拉归属信息，导入前**必须先把公式列转成数值**，否则 `#N/A` 会被重算成真实号码导致数据漂移。

## 部署

详见 `dealer-system/操作手册.md`（云部署章节）：systemd + Nginx 反代 + HTTPS。

## 安全模型

1. 经销商所有数据接口，SQL 强制 `WHERE phone = Session.phone`，前端传入的 phone 参数一律忽略
2. 管理员与经销商使用不同 Cookie（`ds_admin` / `ds_dealer`）与不同路由前缀，权限互不继承
3. 密码 scrypt 加盐哈希，明文不落库、不出网
4. HttpOnly + SameSite=Lax Cookie，HttpOnly 防 XSS 偷会话，SameSite 防 CSRF
5. 按 IP 限流（注册 50/10min、登录 8/10min、查号 30/min、管理员登录 10/10min）

## License

Private & Confidential — 温道商学院内部使用