# WatchRSS CLI

让 agent 管理 WatchRSS 的订阅、收藏、稍后看、阅读进度和书籍。Node.js 22+，无需运行时 npm 依赖。默认输出一行 JSON；失败返回退出码 1，成功返回 0。

## 安装与登录

```sh
git clone https://github.com/LightningLion-Studio/watchrss-cli.git
cd watchrss-cli
npm install --global .
watchrss config --url https://sly-data-plane.watchrss.cn --anon-key YOUR_PUBLIC_ANON_KEY
watchrss --login
watchrss keys recover
watchrss sync
```

也可直接执行 `./bin/watchrss.cjs --help`，无需全局安装。`anon-key` 是后端公开的 Supabase anon key，不能填 service-role/admin key。环境变量 `WATCHRSS_URL`、`WATCHRSS_ANON_KEY` 优先于配置。不同后端请使用不同的 `WATCHRSS_HOME`。

`--login` 在终端交互输入手机号，再选 `sms` / `password` / `totp`；双因素账户必须完成后端要求的全部因素。密码、验证码、恢复词隐藏输入。agent 不应保存或传递这些信息，初次登录由用户在终端完成。登录结果 JSON 只包含用户 ID 和脱敏手机号。

已有云资料库需 `keys recover` 输入原来的 24 个恢复词。首次建钥须在已授权手机或小程序完成；生产后端明确拒绝 CLI 的 key commit/rotate。`keys init` 返回 `key_migration_phone_required`，不会尝试换用其他身份。CLI 不会给已有资料库生成替代密钥。云密钥不随登录成功自动可用，这是端到端加密要求。

**后端前置条件：** 服务端须提供 CLI access 接口。`anon-key` 需配置为目标环境对应的公开值。

## 两种工作模式

| | `hybrid`（默认） | `cloud` |
| --- | --- | --- |
| 权威数据 | 云索引与本地修改合并 | 云资料库 |
| 本地保存 | 元数据、读取/刷新后的正文、待提交操作 | 元数据投影、待提交操作、登录与解密密钥 |
| 正文 | 读取时缓存；RSS 刷新保存正文 | 分页按需读取，正文不落盘 |
| 修改 | 默认即时提交；可 `--defer` | 即时提交，失败返回错误并保留恢复所需状态 |
| 离线 | `--offline` 读取已缓存正文、调整已有条目状态 | 不支持 |

```sh
watchrss mode hybrid
watchrss --mode cloud articles list
watchrss mode cloud
```

两种模式的资料投影、记录游标、上传计划和操作队列隔离；切换后按云数据重新读取，不能直接看到另一模式未提交的操作。登录身份和密钥共用。切换前在原模式运行 `sync` 提交待处理操作。纯云模式不会删除混合模式已有的缓存。

所有联网资料命令检查当前有效云同步会员，后端也逐请求强制检查。过期后的只读宽限账户不获得 CLI 访问。离线会员凭据与当前账户及登录会话绑定，最长 24 小时，并受会员到期时间和会话到期时间限制；被服务器明确拒绝后本地凭据清除。过期需重新联网验证。离线状态不会访问网络，也不能添加新订阅、导入文件或获取未缓存正文。服务器停用账户等变更在下一次联网检查或本地凭据到期时生效。

## 常用命令

```sh
watchrss status
watchrss sources add https://example.com/feed.xml
watchrss sources refresh
watchrss sources list
watchrss sources pin https://example.com/feed.xml true
watchrss articles list --query 科学 --limit 50
watchrss articles list --favorite
watchrss articles get ARTICLE_ID --page 0
watchrss articles favorite ARTICLE_ID true
watchrss articles later ARTICLE_ID false
watchrss articles read ARTICLE_ID true
watchrss articles progress ARTICLE_ID 0.5
watchrss articles remove ARTICLE_ID
watchrss books list
watchrss books remove BOOK_SOURCE_URL
watchrss import ./book.epub
watchrss import ./book.txt
watchrss export ./library.json
watchrss snapshots list
watchrss devices list
watchrss --offline articles list
watchrss --offline articles get CACHED_ARTICLE_ID
watchrss --defer articles favorite ARTICLE_ID true
watchrss sync
watchrss logout
```

`sync` 只同步个人云元数据与私有内容。公共 RSS 频道文章通过 `sources refresh [URL]` 显式刷新；新实例拉到订阅后先运行 `sources refresh`，再列出频道文章。

`--defer` 更新已有条目时复用与当前账号/会话绑定的有效会员缓存，连续进度只保留同键最新操作；无有效缓存时联网检查一次，最后用 `sync` 提交。

TXT/EPUB 最多导入 10000 章（含前言），EPUB 最多包含 20000 个 ZIP 条目。流式导入服从服务端 `streamImport` 开关；关闭时恢复旧解析路径与 8 MiB 文件上限。流式暂存位于 `WATCHRSS_HOME/tmp/stream-import`，目录权限为 0700，操作结束后清理。书包最多 32 MiB；其他文件、正文与云端配额限制仍适用。

TXT/EPUB 使用现有加密上传和分章协议；导入的正文在云端按章节/分页加密读取。RSS 订阅使用后端 resolve/entries 代理，不自行绕过服务端抓取策略。删除为可同步的软删除。`export` 导出当前本地投影，不会主动下载所有书籍正文，也不覆盖已有输出文件。混合模式导出可能包含已缓存正文。

`records-enable` 显式同意启用账户范围的逐条加密记录格式；普通读取不会自动升级。未启用时继续使用兼容快照，并保留不消费的笔记、私有库等对象。遇到旧备份需要全文转换时，CLI 返回 `reader_migration_consent_required`，须先在 Android/小程序授权转换。

## Agent 契约

```json
{"ok":true,"data":{"items":[],"total":0}}
```

```json
{"ok":false,"error":{"code":"cloud_membership_required","message":"需要有效的云同步会员"}}
```

`--json` 可显式声明，但 JSON 本身就是默认格式。`--help` 输出文本。`articles list` 返回 `items` 和过滤后的 `total`；默认最多 100 条，`--limit` 最多 10000，`articles get` 的 `--page` 从 0 开始。`articles get` 在读取后返回 `knownPages`、`hasMore` 和 `eof`。`knownPages` 是已知分页偏移的下界。索引未到结尾时，`totalPages` 为 `null`；索引完成后才返回精确总页数。自动分页必须继续递增 `--page`，直到 `eof: true`（或 `hasMore: false`），不得用已知页数判断结束。

状态布尔值必须明确是 `true` / `false`，省略时为 `true`。命令行不接受密码或恢复词参数。需要用户介入的错误包括 `login_required`、`NEEDS_RECOVERY`、`tty_required`、`membership_check_required`。

提交失败不会报告成功；待提交修改保存在原模式的队列中，修复连接后运行 `sync`。默认一次仅允许同一 `WATCHRSS_HOME` 下一个进程运行，避免不同 agent 写坏游标。进程异常退出可能残留 `process.lock`，确认其中的 PID 已退出后手动移除。网络请求超时、上传失败均有退出路径。

默认状态目录为 `$XDG_DATA_HOME/watchrss` 或 `~/.local/share/watchrss`，可用 `WATCHRSS_HOME` 覆盖。目录权限 0700、文件 0600；凭证、解密密钥及混合模式正文存储在此目录，依赖操作系统账户和磁盘保护。不要提交该目录。`logout` 撤销当前服务端登录并清理登录/CLI 凭证、本地会员凭据，保留已有资料与解密密钥，供同一账户再次登录。登录过期时可重新 `--login`，CLI 不推测 refresh token 语义。

独立 `wrc_` 凭证通过单次挑战和 P-256 持有证明签发，绑定当前 MFA 会话、账户和安装身份；不占用或释放手机授权席位。重新签发使本安装旧凭证失效，最长一小时；每个请求仍校验账户封禁、MFA 策略、登录撤销及会员状态。

## 开发与验证

```sh
npm test
```

包含真实子进程 CLI + 模拟 HTTP 服务的加密记录同步/失败恢复测试、登录双因素状态机、账号与模式隔离、离线会员凭据、Node crypto 互通，以及复用的载荷、合并与快照测试。

加密/载荷/合并/阅读模块从当前 `WatchRSS_WeChat` 源码移植，原文件及 SHA-256 见 `protocol-source.json`；Node 平台适配文件独立维护。修改的移植模块及理由见 `PORTING.md`。验证不代表生产、真实登录短信或跨客户端人工验收。

## 当前云协议

协议实现从小程序源码移植，钉住的源码提交见 `protocol-port.json`。支持 epoch/密钥承诺、R45 content generation 与 v3 内容布局、R44 按书包与稀疏阅读记录、R48 Phase A 旧新混合读取和原始未知 JSON token 保留。`format-capabilities` 查询服务端能力；R48 Write/Migration 永远为 false。CLI 没有 BLE，不声明 R46/R47 快路径能力。

`uploads status` 返回可恢复的加密上传计划；下一次 `sync` 先刷新 reservation 证明并续传，再合并新内容。`WATCHRSS_PROGRESS=1` 把已上传字节/对象数作为 JSON 写到 stderr。账号/epoch/generation 变化会废弃旧计划；404/过期后从本机保留的资料重新 reserve，旧 PUT 标记不再可信。纯云模式只在进程内保存读取到的书包和正文，重启会重新按需读取；上传计划仅持久化密文。

开发命令：`npm test`、`npm run build`、`npm run ci:check`。`python scripts/sync-protocol.py` 从固定源提交重新移植并更新原始及输出两套哈希；不从当前脏文件隐式更新。生产测试脚本只允许三个人工测试号，必须显式指定私有 `WATCHRSS_TEST_RUN`；它们不参与单元测试，不会被普通 CLI 命令调用。

### CLI 文件占用与预算

存储诊断按整个 `WATCHRSS_HOME` 中的文件逻辑字节统计，包含各模式目录、凭证和 pending 数据。RAM 缓存不计入磁盘占用；目录内的符号链接不跟随。诊断只返回固定分类和数值，不返回路径、账号、正文或令牌。CLI 不支持微信 KV/saveFile 统计，也不使用微信 200 MiB 配额。

默认预算使用 `WATCHRSS_HOME` 所在文件系统的可用空间，并保留 2 MiB。可设置正整数字节数 `WATCHRSS_STORAGE_LIMIT_BYTES`，为导入准入和缓存回收设置整个目录的预算；可用磁盘空间仍是另一项限制。该预算不替代操作系统硬配额，也不会通过删除本地资料来满足上限。hybrid 的书包、saved-bodies、资料库、阅读状态、凭证、上传计划和未知旧文件均保护。仅当前模式下明确可再生的阅读缓存允许回收；有 pending 工作或无法读取的队列时，缓存也保留。空间不足返回 `local_storage_full`。
