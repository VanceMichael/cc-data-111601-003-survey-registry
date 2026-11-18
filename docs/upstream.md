# 来源约定

## 产品交换范围

本地来源保留 DDI Lifecycle 的 maintainable 身份与引用语义；XML 只使用项目展示的 VariableScheme、Variable、QuestionReference、UniverseReference、CodeSchemeReference、Label 子集，不要求所有 DDI 结构。/release 给出机构/标识/版本与入口；/registry 枚举对象三元身份及 URL。对象根 agencyID、id、version 是引用依据；只有引用省略版本且注册表恰有一个匹配版本时允许解析，并须保留解析依据，不允许按字符串最大版本挑选。不同机构的同号对象不互补。变量的三类引用都是其可解释资料的一部分，非变量对象允许 Label 及进一步 Reference 子项。阶段 1 暂时缺少 universe，对象取回后检查响应身份与请求身份一致。

## 轮次收集约定

产品从 /catalog 读取入口和注册表位置，再取 /release 与 /registry。发布入口的 references 可直接给出对象 URL；注册表条目给出同一三元身份的 URL。二者都用三元身份校验后取回，声明 URL 与注册表 URL 不一致时记为 `url_conflict`，不合并、不猜测。

每个可解释对象按 DDI 引用子项继续展开：Variable 的 QuestionReference/UniverseReference/CodeSchemeReference 是变量依据，非变量对象上的 Label 与 Reference 属于该对象自身的解释层。对象若引用已展开的对象，保留边而不重复登记；形成环时记 `cycle` 缺口。

解析状态与含义：

- `resolved`：身份与对象类型匹配且原件已保存；`basis` 为 `exact_version`、`single_registry_match` 或 `declared_url`。
- `missing`（`not_in_registry` / `incomplete_reference`）：注册表无该身份或引用缺机构/标识。
- `ambiguous_version` / `ambiguous_registry`：省略版本但存在多个版本，或同一身份多条记录；`candidates` 仅作补采用，不自动选一。
- `url_conflict`：显式声明地址与注册表地址不同；`candidates` 分别标注 `declared`、`registry` 两方证据。
- `unavailable` / `unreadable` / `not_stored`：HTTP 取回失败、XML 不可解释、原件未保存。
- `identity_mismatch`：响应对象的机构/标识/版本与请求不符；`actualIdentity` 记录实际身份。
- `kind_mismatch`：响应对象的 DDI 类型与引用角色不符（如 UniverseReference 取回 QuestionItem）；`expectedKind`/`actualKind` 记录两者。
- `not_in_registry` 只凭显式地址取回的例外仅限发布入口本身；变量及其嵌套引用必须由注册表解析，避免把未被引用的对象拉进快照。

以上非 `resolved` 状态都会进入快照 `gaps`；受影响的变量保持 `complete: false`、`status: "incomplete"`，并通过 `variableKeys` 关联到缺口。同一缺口被多个变量共用时只保留一条并列出全部 `variableKeys`。快照的顶层 `status` 只在所有层都取回时为 `complete`，不会用空占位符伪装成完整代码本。

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

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
