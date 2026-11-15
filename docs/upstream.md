# 来源约定

## 产品交换范围

本地来源保留 DDI Lifecycle 的 maintainable 身份与引用语义；XML 只使用项目展示的 VariableScheme、Variable、QuestionReference、UniverseReference、CodeSchemeReference、Label 子集，不要求所有 DDI 结构。/release 给出机构/标识/版本与入口；/registry 枚举对象三元身份及 URL。对象根 agencyID、id、version 是引用依据；只有引用省略版本且注册表恰有一个匹配版本时允许解析，并须保留解析依据，不允许按字符串最大版本挑选。不同机构的同号对象不互补。变量的三类引用都是其可解释资料的一部分，非变量对象允许 Label 及进一步 Reference 子项。阶段 1 暂时缺少 universe，对象取回后检查响应身份与请求身份一致。

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
