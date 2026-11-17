# 来源约定

## 产品交换范围

本地来源保留 DDI Lifecycle 的 maintainable 身份与引用语义；XML 只使用项目展示的 VariableScheme、Variable、QuestionReference、UniverseReference、CodeSchemeReference、Label 子集，不要求所有 DDI 结构。/release 给出机构/标识/版本与入口；/registry 枚举对象三元身份及 URL。对象根 agencyID、id、version 是引用依据；只有引用省略版本且注册表恰有一个匹配版本时允许解析，并须保留解析依据，不允许按字符串最大版本挑选。不同机构的同号对象不互补。变量的三类引用都是其可解释资料的一部分，非变量对象允许 Label 及进一步 Reference 子项。阶段 1 暂时缺少 universe，对象取回后检查响应身份与请求身份一致。

## 整轮领取的读取次序

`POST /waves` 使用来源 `/catalog` 声明的 `entry`（请求可显式覆盖 `path`）作为唯一入口：

1. 读取发布清单，保留其机构/标识/版本与所列引用；发布清单里的 `url` 只在引用写明版本时作为该身份的位置，取回后仍按根身份校验。
2. 读取 `/catalog` 声明的 `registry`。它的作用是解析引用，不是枚举资料来源：产品只领取发布与变量实际引用到的对象，不按注册表把同号的其他版本或同机构其他对象一并领取。
3. 对发布引用的 `VariableScheme`，逐变量处理 `QuestionReference`、`UniverseReference`、`CodeSchemeReference`。写明了版本就只接受同机构/同标识/同版本；没写版本时，只有注册表中该机构/标识恰有一个版本才可使用，并记录 `basis` 与候选证据。
4. 依据对象（以及发布直接引用的非变量对象）自身的 Reference 子项递归解析，最多 16 层；形成环时不伪造对象，只记录环的引用身份。
5. 取回的对象根身份与请求身份不一致、HTTP 取回失败、注册表不可用、版本缺失/歧义、引用根本没写，都会保留为受影响的层，变量与轮次标为不完整，并记录层名（question / universe / codeScheme）、请求身份、位置和原因。

上述各层互不替代：缺 universe 不会从同名的更新版本或他机构对象补齐，也不会因为题项和代码表齐全就把变量当作完整。补齐来源后重新领取会新增一份快照，旧快照保留当时的不完整状态。

## 当前来源路由

- `/primary`：application/xml
- `/release`：application/json
- `/objects/q1`：application/xml
- `/objects/u1`：application/xml
- `/objects/codes-1`：application/xml
- `/objects/codes-2`：application/xml
- `/objects/other`：application/xml
- `/registry`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://ddialliance.org/Specification/DDI-Lifecycle/3.3/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；通用收件接口成功只表示该单件已保存。整轮领取的 `complete` 只在发布可读、所有变量三层依据都取回且根身份一致时为真；它不表示标准层面的 DDI 校验通过，也不表示轮次快照之间可以互相替代。
