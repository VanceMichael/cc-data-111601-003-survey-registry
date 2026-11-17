# survey-registry

纵向调查目录中复用变量定义的定向采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

除既有的单件接收外，现在可以按发布入口领取一整轮调查实际引用的资料：

- 从来源 `/catalog` 的 `entry`（或请求中显式给出的 `path`）读取发布清单，只沿发布声明的引用继续领取，不枚举来源里的其他对象。
- 按 `VariableScheme` 中的每个 `Variable` 分别记录题项、适用人群（Universe）和代码表三层依据，并把依据对象自身的进一步引用（非变量对象上的 `Reference`）递归领取。
- 变量记录以“机构 + 方案标识 + 方案版本 + 变量 id”为键，不以标签或变量名合并；同标签的不同变量保持独立记录。
- 保留 DDI 对象的机构、标识、版本、原件摘要、来源 URL，以及对象被哪些发布、变量、上层对象引用的复用关系。
- 引用没有写明版本时，只有来源注册表中该机构/标识恰好只有一个版本才解析，并记录 `basis` 与候选证据；存在多个版本、版本不存在或指向他机构同号对象时都不推断，也不取“最新版本”。
- 暂时取不到或无法唯一确定的层，会把受影响的变量标为 `incomplete`，在变量的 `missing` 以及整轮的 `missing`、`missingLayers` 中写明缺的是哪一层依据（question / universe / codeScheme）、请求身份和原因，而不是生成看似完整的代码本。补齐来源后再次领取会产生新的快照，并通过 `previous` 串起同一发布的历次结果。

`src/wave.mjs` 承载上述领取规则；`src/reader.mjs` 提供单件 DDI 解释（含非变量对象的 Label 和进一步引用）；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果和不可变的轮次快照。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品，先把来源切到暂时缺少 universe 的阶段做一次整轮领取，展示受影响变量如何保留为可补采记录，再恢复来源并重新领取，展示同一发布的两份快照，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节；加 `?view=usages` 返回该原件在各轮次中的引用位置。

这四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录只包含单件 raw 对象，不代表关联资料已完整；整轮领取的对象按摘要保存、可经 `/objects/{digest}` 读取，但不会混入单件收件目录。

新增的整轮入口：

- POST /waves，JSON 可为 `{}`（使用来源 /catalog 的 entry）或 `{"path":"/release"}`：领取该发布实际引用的变量、题项、适用人群与代码表并保存快照；返回 201，包含 `status`、`variables`、`objects`、`missing` 等。发布清单本身无法读取时返回 422 且不保存。
- GET /waves：列出快照元数据；`?key=` 按发布键筛选。
- GET /waves/{id}：读取某份快照；`GET /waves/latest?key=` 读取该发布最新一份。
- GET /waves/missing：列出各快照中仍需补采的层；`?key=` 按发布键筛选。

轮次键包含来源 origin 与发布的机构/标识/版本；同一来源的同一发布重领且内容不变时返回原快照 id，内容变化（例如补齐了缺失层）时新增快照并保留旧快照原样可查。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，整轮引用解析、版本歧义、机构隔离和缺失层保留在 test/wave.test.mjs，端到端快照与补采在 test/integration.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t survey-registry:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
