# survey-registry

纵向调查目录中复用变量定义的定向采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

能从某一轮发布的入口收集实际引用的变量、题项、适用人群、代码表及其复用关系，把每个对象的机构、标识、版本和依据一起保存；单个 DDI 对象仍可单独领取。

`src/reader.mjs` 提供单件读取契约（变量三类引用、非变量对象的 Label 与进一步引用）；`src/waves.mjs` 负责按注册表解析引用并组装可继续补采的快照；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果和轮次快照。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，再从发布入口收集一轮引用并展示变量依据，切到来源阶段 1 后展示缺依据时的变量留缺记录，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /waves，JSON 为 {} 或 {"path":"/release"}：从该轮发布入口（缺省用来源 /catalog 的入口）收集引用对象，逐件保存原件并生成轮次快照；只接受来源内的 path 和该字段。
- GET /waves：已保存的轮次快照摘要（入口身份、状态、计数、缺口摘要）。
- GET /waves/{id}：完整快照，含 objects、variables、relationships、gaps 与解析依据。

前四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录中的单件 raw 对象本身不代表关联资料完整；完整性以对应轮次快照的 `status`/`counts` 为准。

## 轮次快照语义

- 对象只用机构 + 标识 + 版本三元身份引用；版本必须精确匹配。引用省略版本时，仅当同一机构、同一标识在注册表中只有一个版本才解析，并记录 `basis: "single_registry_match"`；有多个版本时记为 `ambiguous_version` 并列出候选，不按字符串或“最新”挑选。
- 不同机构的同号对象永不互相补齐；同标签不等于同变量，变量按所属 scheme 身份与 `Variable/@id` 区分。
- 变量记录保留题项、适用人群、代码表三层引用及各自 `kind`/`label`/`digest`，并区分 `complete` 与 `incomplete`。缺失、取回失败、身份或类型不符、地址冲突或版本含糊时，变量仍保留在 `variables` 中，`gaps` 指明所缺层级、请求身份、原因和受影响变量；不输出看似完整的代码本。
- `relationships` 记录每条复用边（从哪个对象、哪类引用、请求什么身份、解析依据、结果）；`objects` 只收录身份与类型核验通过且原件已保存的对象。
- 快照引用的原件可用 `recordId`/`digest` 在 /records 与 /objects 中追溯。
- 补采时重新 POST /waves 会生成新快照，旧快照原样保留，便于对照“当时缺的是哪一层依据”。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；轮次收集的解析规则、缺口保留和持久快照在 test/domain.test.mjs 与 test/integration.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t survey-registry:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
