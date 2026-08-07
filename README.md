# ProxySQL Admin WebUI（定制版）

<p align="center">
  <strong>现代化的 ProxySQL 图形化管理界面</strong><br/>
  <sub>Fork 自 <a href="https://github.com/JacksonJiangxh/proxysql-admin-webui">JacksonJiangxh/proxysql-admin-webui</a>，针对茶颜悦色跨云代理运维场景二次开发</sub>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/python-3.10+-blue.svg" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/node-24+-green.svg" alt="Node.js 24+">
  <img src="https://img.shields.io/badge/docker-24.0+-2496ED.svg" alt="Docker 24.0+">
</p>

<p align="center">
  <a href="https://github.com/liking2354/proxysql-admin-webui"><strong>📦 代码仓库</strong></a>
  &nbsp;·&nbsp;
  <a href="#快速开始">🚀 快速开始</a>
  &nbsp;·&nbsp;
  <a href="#本-fork-的定制内容">🛠️ 定制内容</a>
  &nbsp;·&nbsp;
  <a href="#文档">📖 文档</a>
</p>

---

## 简介

**ProxySQL Admin WebUI** 是一个现代化的 Web 图形化管理界面，通过 ProxySQL 的 MySQL 协议管理端口（默认 6032）提供配置可视化、实时监控和运维操作。

本仓库是 [JacksonJiangxh/proxysql-admin-webui](https://github.com/JacksonJiangxh/proxysql-admin-webui) 的二次开发版本，仓库地址：

```
git@github.com:liking2354/proxysql-admin-webui.git
```

在原项目基础上，针对**跨云（阿里云 A 库 / 腾讯云 B 库）ProxySQL 代理路由**的真实运维场景，新增了路由规则可视化、模拟器、健康自检等能力，详见 [本 Fork 的定制内容](#本-fork-的定制内容)。

### 核心架构

```
浏览器 (React SPA) ──HTTP/WebSocket──▶ FastAPI 单进程 (:8080) ──MySQL 协议──▶ ProxySQL Admin (:6032)
                                           │                                     ──▶ MySQL/PostgreSQL 后端
                                           │                                     ──▶ 后端 MySQL 数据库（数据库管理）
                                           └─ 同源托管前端静态文件
```

**单进程部署**：FastAPI 同时提供 REST/WebSocket API 和前端静态文件，无需额外反向代理。支持裸机运行和容器化两种部署方式；生产环境亦可将前端（Vite）与后端（uvicorn）拆分为两个 systemd 服务分别运行（详见下方「裸机运行」）。

---

## 快速开始

### 前置条件

- Python 3.10+ / Node.js 24+（裸机运行）
- Docker 24.0+（容器部署，可选）
- ProxySQL 2.7+ 实例（完整功能需要）

### 裸机运行（推荐，无需 Docker）

```bash
git clone git@github.com:liking2354/proxysql-admin-webui.git
cd proxysql-admin-webui

make install          # 安装前后端依赖
make build-frontend   # 构建前端静态文件
make run              # 启动服务 → http://localhost:8080
```

### 开发模式（热重载，便于本地调测规则/UI）

```bash
make install
make dev-backend      # 终端1：后端 :8080（或按 .env 中 PORT 配置）
make dev-frontend     # 终端2：前端 :5173 → http://localhost:5173
```

> 生产实践：前后端可分别用 systemd 常驻（如 `vite --host 0.0.0.0 --port 5173` + `uvicorn` 监听内部端口），
> 修改源码文件后 Vite 会自动热更新，后端修改需 `systemctl restart` 对应服务生效。

### Docker 部署（可选）

```bash
cp .env.example .env
# 编辑 .env，修改 SECRET_KEY 和 FERNET_KEY（生成方式见 .env.example 注释）

docker compose up -d
# 访问 http://localhost:8080，默认登录：admin / admin123
```

> 本 Fork 未配置独立的镜像发布流水线（无已发布 Tag）。如需 CI 构建多架构镜像，
> 参考 `.github/workflows/release-docker.yml`：推送 `v*` Tag 或手动触发 `workflow_dispatch`，
> 镜像将发布至 `ghcr.io/liking2354/proxysql-admin-webui`。

---

## 功能特性

| 模块 | 说明 |
|------|------|
| 📊 **仪表盘** | 实时监控连接数、QPS（速率而非累计值）、连接池状态、主机组流量分布、Top 耗时查询，WebSocket 推送 |
| 🚦 **路由规则**（Fork 新增） | 规则链可视化、SQL 路由模拟器、主机组拓扑、实时命中统计、规则健康自检（双反斜杠/注释误用/零命中检测）、新建/编辑/删除规则表单 |
| 🧙 **配置向导** | 63 个引导式表单（W01-W63），无需手写 SQL |
| 🚀 **快速部署模板** | 一键配置完整 ProxySQL + MySQL 代理架构，支持 5 种架构模式 |
| 📋 **表浏览器** | 查看/编辑所有 ProxySQL 配置表，分页、搜索、排序、内联编辑、行级详情面板与新增/编辑/删除 |
| 💻 **SQL 控制台** | 专家模式，支持 Admin / MySQL / PostgreSQL 多目标执行 |
| 🗄️ **数据库管理** | 直接浏览和管理 ProxySQL 管控的后端 MySQL 数据库，支持表浏览、Schema 查看、SQL 执行 |
| 🔄 **配置同步** | DISK ↔ MEMORY ↔ RUNTIME 三层管理，按模块同步，统一层间比对逻辑（消除静态表/凭据拆分导致的误报） |
| 🔍 **配置差异** | Memory / Runtime 层差异可视化，行级对比 |
| 💾 **配置备份** | 创建、管理、恢复 ProxySQL 配置快照备份，支持下载；失败操作有明确错误提示与重试入口 |
| 🖥️ **多实例管理** | 管理多个 ProxySQL 服务器，连接测试，一键切换 |
| 🌐 **集群管理** | ProxySQL 原生集群组管理，跨节点配置同步，状态监控 |
| 🔐 **JWT 认证** | 多用户管理，Token 自动刷新 |
| 🌍 **国际化** | 默认中文，内置英文，支持扩展更多语言 |
| 🎨 **暗色主题** | 亮色/暗色模式切换，偏好持久化 |
| 🔎 **全局搜索** | Ctrl+K 快捷键搜索页面、向导和功能（含路由规则页） |
| 📝 **查询历史** | SQL 执行历史记录，支持搜索、过滤和导出 |
| 🎓 **新手引导** | 交互式 Tour 导览，帮助新用户快速上手 |
| 📤 **数据导出** | 支持 CSV / JSON 格式导出查询结果和表数据 |

---

## 本 Fork 的定制内容

相对上游 [JacksonJiangxh/proxysql-admin-webui](https://github.com/JacksonJiangxh/proxysql-admin-webui)，本 Fork 主要围绕**路由规则运维**做了增强，按时间倒序：

### 配置备份模块修复
- 修复 `GET /backup/{server_id}/list` 因响应模型缺失 `created_by`/`table_count`/`row_count` 字段导致的 500 报错（列表页永远显示"暂无备份"，即使备份已创建成功）
- 创建/列表/删除失败时前端补充明确错误提示与重试入口，避免"点击无反应"的静默失败

### 路由规则编辑与健康自检
- 修复行级 DML 接口 422：`update`/`delete` 的 `pk_values` 因 FastAPI 多 dict body 隐式嵌套而绑定失败，改用显式 Pydantic 模型
- 补充安全防护：空 `pk_values`/`data` 会导致 `UPDATE`/`DELETE` 作用于全表（可能清空全部路由规则），现拒绝该请求
- 路由规则页新增规则健康自检横幅：检测正则双反斜杠（`\\s` 被 RE2 解析为字面反斜杠+s，规则永不命中）、`match_digest` 误含注释符（digest 已被 ProxySQL 剥离注释，规则必死）、`active=1` 但 `hits=0`
- 路由规则页支持新建/编辑/删除，表单按 ProxySQL 语义分组，含字段级说明与提交前校验
- 新增 `test-shell/regress_rule_api.py`（24 用例）覆盖规则接口 CRUD、安全防护、正则往返保真

### ProxySQL 运维场景 UI 优化
- 新增**路由规则页**（`/rules`）：规则链可视化 + SQL 路由模拟器 + 主机组拓扑 + 实时命中统计 + 注释路由陷阱提示
- 表浏览器支持行级 CRUD（详情侧拉面板、行内编辑/删除、新增行弹窗）
- 仪表盘补充 Top 耗时查询表、主机组流量分布进度条，修正 QPS 为速率而非累计值
- 侧边栏导航按运维场景分组（监控 / 配置 / 运维 / 系统）
- 修复 WebSocket 无限重连风暴、`HG10` 无可用业务用户误判、配置同步/对比误报（`mysql_collations` 静态表、`mysql_users` frontend/backend 拆分导致永不等价）等多个 Bug

> 完整变更记录见 `git log`；配套的路由规则测试脚本与生产验证记录见 `../test-shell/`、`../test-docs/`。

---

## 文档

| 文档 | 链接 | 说明 |
|------|------|------|
| 🧙 配置向导参考 | [WIZARD_GUIDE.md](docs/WIZARD_GUIDE.md) | 63 个向导完整说明和最佳实践 |
| 🚀 快速入门 | [getting-started.md](docs/getting-started.md) | 5 分钟安装和初始化 |
| 🏗️ 部署指南 | [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker / 裸机 / Kubernetes 生产部署 |
| ⚙️ 配置参考 | [configuration.md](docs/configuration.md) | 环境变量和配置参数详解 |
| 🔧 故障排除 | [troubleshooting.md](docs/troubleshooting.md) | 常见问题及解决方案 |
| 🤝 贡献指南 | [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境设置、编码规范、PR 流程 |
| 📋 变更日志 | [CHANGELOG.md](CHANGELOG.md) | 版本发布历史和变更记录 |

> 上游项目另维护有公开的用户手册站点，本 Fork 未单独部署文档站，文档以仓库内 `docs/` 目录为准。

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源，版权归属原作者 JacksonJiangxh；本 Fork 由 [liking2354](https://github.com/liking2354) 维护，二次开发部分同样遵循 MIT 协议。
