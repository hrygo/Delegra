# 内部计费方案二次审查：Provider 与部署通用性

> 保存范围：仅本地 fork。2026-10-26 用户决定撤回 PR #17 并恢复 r6；完整计费模块暂不实施，先向上游提交范围协调 issue，确认维护者方向后再推进。下文对 r7 的诊断和文件落点保留为历史设计依据，不表示 r6 已有这些接口。

日期：2026-10-26。对象：[设计方案](2026-10-26-internal-billing-module-design.md)与[实施计划](2026-10-26-internal-billing-module-implementation.md)。本轮为文档和契约审查，不是产品实现验收。

## 1. 结论

原稿存在 9 项需要修订的通用性缺口，不能直接据此声称适用于其他公司、Provider 和部署方式。已在两份方案中逐项修订：核心计费规则、当前公司政策和部署适配分别定义，实施计划增加替换环境的反例及真实并发门槛。

修订后的设计没有要求特定公司、CLIProxyAPI/oMLX/Luna、macOS、固定端口、操作者 HOME 或单进程状态才能完成计费。USD/UTC、支持的 token-rate 与 recorded_amount 是明确的 V1 能力范围；未覆盖的收费维度保持可见，未验证的部署不承诺兼容或容灾。

“文档内的环境依赖已移除”不等于“所有环境已运行通过”。实现后必须执行反例矩阵和数据库/传输故障验证，才能接受实际产品交付。

## 2. 范围与证据

本轮没有读取或修改操作者的本机 Provider 配置、密钥、运行数据库、服务启动项或模型目录，也没有通过访问本机服务来证明通用性。依据为：

- 当前两份方案、相关领域规则和用户已确认 Q1–Q8。
- 当前 worktree 的接口/持久化边界只读核查：`packages/adapter-utils/src/types.ts`、`packages/db/src/schema/accounting.ts`、`packages/shared/src/ai-provider-routing.ts`、`server/src/services/usage-receipts.ts`、`server/src/services/accounting-transaction.ts`。
- 代码图谱 generation 为 2026-10-24T15:52:33Z，来源另一 checkout，仅作定位。已对上述 5 个路径执行 coverage 检查；usage-receipts 标记 changed，已直接读取当前相关源码；其他依赖边界也直接读回确认。未重建索引，未把图谱无缺口当成完备证明。
- 2026-10-26 核验的 Azure/OpenRouter/Gemini 官方资料，用于构造非本地反例；没有把这些 Provider 当作已经新增或实测接入。

> 🧠 **From Hindsight memory (Provider 与模型公价费率配置及用量估算)** — 历史记录把费率定义为公司范围的参考估价，独立于订阅、预算和原始收据。本轮只用它核对既有边界；不采用记忆里的部署状态、费率数量或价格快照作为当前运行事实。

## 3. 问题与修订

P1 表示实施前必须明确，否则会错计、漏计、误阻断或污染其他公司配置；P2 表示验证范围不足。这是方案问题的等级，不是声称线上已发生这些故障。以下“已修订”仅指文档。

### R1 / P1：公司政策可能变成产品默认

**原稿位置：** 设计 §5.2、实施 T2，直接要求“创建公司政策 oMLX 按 Luna 折算”，未明确种子配置的作用域与空白安装行为。

**反例：** 另一公司也接入 oMLX，但需要硬件成本或自行定价；新安装没有任何这类模型。若 migration/startup 自动创建政策，用户私有估值决定会影响所有安装。

**已修订：** 通用核心不识别厂商名；仅为明确 companyId 预览/应用配置清单，迁移/启动不注入私有政策。新公司缺价诚实待估。用户的当前 oMLX/Luna 要求保留。

**落实/验收：** 设计 §1.1/5.2，实施 T0/T2；空白安装、第二公司同名模型、政策停用与改名测试。

### R2 / P1：供应商解析与有限协议清单进入共享域

**原稿位置：** 实施 T1 把 normalizeProviderUsage 的厂商语义放在 shared；设计 §3.2 以有限协议 enum 描述计费身份，并把 Bedrock 平台与线协议混列。

**反例：** 新增 Gemini 或私有 API 后必须修改共享收费分支，或回执因协议值不在白名单被拒收。协议替换会改变计费域，违反 module-boundaries 的所有权规则。

**已修订：** adapter/provider owner 负责 raw payload/SDK/缓存语义；shared 只保留中性类型、校验与纯公式。protocolId、providerDialect、normalizerVersion 分开；有界未知协议可记录为 unsupported，而不伪称免费或自动支持执行。

**落实/验收：** 设计 §3.2/4.1，实施文件落点/T1/T3；替换协议和 unknown 协议记录不需要通用引擎厂商特判。

### R3 / P1：用量组件和实时预算强制依赖 run

**原稿位置：** 设计原 §4.3 用 runId 构造所有组件键，§8.2 用 run 描述全部预留；服务费用虽然列入报表，身份/准入契约没有覆盖。

**代码证据：** 现有 run_usage_receipts/envelope 要求 runId；但 budget_reservations 已支持 run、decisionInvocation、fastResponseRequest、promptInjectionInvocation 四类互斥来源。不能让统一化反而退化为仅支持 heartbeat。

**已修订：** 中性 ProducerRef 与跨控制器稳定的逻辑组件键标识来源，source epoch 只控制写入权威，heartbeatRunId 仅可空关联；复用既有服务调用 ID/owner/持久化记录与预留，禁止虚构 heartbeat。各来源的 metric 进入唯一键和暴露计算。

**落实/验收：** 设计 §4.4/8.2/10.1，实施 T2/T3/T7；三类无 run 服务的重复回执、DB 失败、预留/结算和公司预算测试。

### R4 / P1：单跳上游和请求 model 不足以表达通用路由

**原稿位置：** 设计 §3.2/5，requested/resolved 与单 upstream 可以覆盖当前两级路径，但未定义部署别名、多级网关、模型发布者与推理服务方。

**反例与来源：** [Azure 文档](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/switching-endpoints)说明 model 参数可以是部署名。[OpenRouter 文档](https://openrouter.ai/docs/guides/routing/provider-selection)提供 Provider 选择和 fallback；入口与实际推理方不能仅凭模型名等同。

**已修订：** 区分 requested/deployment/resolved/pricingModel 与版本化作用域映射；配置映射不冒充观察到的真实模型。定义实际管理入口、推理上游、可选 publisher 和带证据 routeHops。路径多跳不多次计量，不可见的内部重试不捏造 token。

**落实/验收：** 设计 §3.2/5.1，实施 T1/T2/T3；部署别名重新映射、渠道入口 fallback、上游未知、多跳路径测试。

### R5 / P1：三类 token 齐价可能被误标完整，recorded_amount 可能混币或重复

**原稿位置：** 设计 §4/7.2 以 token 为主，Browser Use 等统一兜底到已录金额，缺少收费能力/覆盖范围和币种的严格边界。

**反例与来源：** [Gemini 官方价格](https://ai.google.dev/gemini-api/docs/pricing)存在模态差异、缓存存储和搜索等维度。没有这些计量仍可能得到“token 价格齐全”。另一个调用的实际回执可能不是 USD，或总价已经包含 token 费用。

**已修订：** BillingMeterCapabilities、数量状态、unsupportedMeters/unmodeledCharges 明确表达范围；not_applicable、unknown、unsupported 不混同。recorded_amount 只覆盖有来源的使用单元，与同范围 token 估值互斥；无 FX 的外币实际金额不进入 USD 小计/预算。

**落实/验收：** 设计 §4.3/5.3，实施 T1/T4/T7；不适用写入、额外收费、不同模态、外币与重复覆盖反例。当前版本不因此扩成全厂商收费 DSL。

### R6 / P1：归属缺失会误触发硬停

**原稿位置：** 设计 §8.2 与实施 T7 将“未估/缺身份”一起列为阻止准入的条件。

**反例：** 聚合渠道不披露上游，但渠道+模型公价已确定，可以可靠估值。缺上游标签不是缺价格。相反，未知字段若可能命中更高优先级规则，也不能随意套低价兜底。

**已修订：** 归属、计量、估值三轴独立；匹配区分命中、不命中、证据不足。只有缺项影响估值或未覆盖收费时才按缺项预算策略；未知上游但价格确定不误阻断。

**落实/验收：** 设计 §5.1/5.3/8.2，实施 T1/T7；分别测试可定价的未知上游与会改变优先规则的未知字段，两类预算 AND 不变。

### R7 / P1：本地 spool 和单进程恢复不足以证明远程/多进程可靠性

**原稿位置：** 设计 §4.4/10 保留 spool/journal，但未说明可靠接受的故障范围、远程 ack 和多个 worker 的权威来源。

**代码证据：** spoolUsageReceipt 使用节点文件系统，persistUsageReceipt 使用数据库公司锁；两者解决不同故障。相同 HOME、本地目录或进程内标记都不能证明另一节点能恢复文件。

**已修订：** 明确 producer/receipt/source epoch/hash/ack 契约；远程持久化确认丢失以相同身份重发，不能重新执行模型。现有本地 spool 需要声明持久卷与恢复 owner。跨连接/worker 依赖 DB 锁、唯一约束、lease 与 DB 时间；不承诺未验证的临时容器或完整多副本 HA，也不强制新增外部存储服务。

**落实/验收：** 设计 §10.1，实施 T2/T3/T8；真实 PostgreSQL 独立连接、worker lease 迁移、断线重发、节点目录隔离和持久卷重启测试。

### R8 / P1：小历史量掩盖发布锁内的无界目标校验

**原稿位置：** 设计 §7.1、实施 T5 要求发布事务内校验全部目标输入 hash，同时声称是短事务。目标为 100k 时这两个要求无法直接同时成立。

**已修订：** 增加 cost_revaluation_targets 与索引；分块登记/校验。目标输入变更在原会计事务中使活动批次 stale/增加 guardVersion；每公司一个有发布权活动批次，其余排队或草稿。发布只检查 ready/lease/guard/批准 hash 并赋序号，不在公司锁内全表校验、估价或导出。

**落实/验收：** 设计 §6/7.1/9，实施 T2/T5/T8；登记前与校验后变更、跨进程竞争、100k 目标同时新进账以及锁等待实测。必要 schema 从原 9 表调整为 10 表，避免把目标清单塞入无限 JSON。

### R9 / P2：验收集合仍以当前公司的接入场景为中心

**原稿位置：** 实施 T0/T8。虽然列出许多案例，仍可能全部在同一环境、少量记录和相同厂商命名下通过。

**已修订：** 先建立中性 fixture 与空白/第二公司，再加当前公司配置。新增部署别名、真实 Anthropic、未知/多跳上游、无 run 服务、计量能力与外币、独立 DB 客户端、Linux/临时 HOME/假时钟等反例。更换名称/主机/目录不应改变金额，显式政策变化除外。

**落实/验收：** 设计 §11.2，实施 T0/T8 反例矩阵。fixture 可证明契约替换性，不能冒充真实厂商接入或生产容灾验收。

## 4. 本轮验证结果和限制

已执行：当前相关源码只读核查、图谱 coverage 与 changed 源码回读、官方资料核验、两份方案交叉检查、文档链接/围栏/空白及互相冲突旧条款检查。

已改动：两份方案文档；新增本审查记录。无产品代码、测试代码、依赖、数据库、运行配置、服务重启、部署、模型下载或付费调用。

未执行：产品测试、跨平台运行、PostgreSQL 竞争/锁延迟实验、节点丢失容灾演练和真实厂商资格验证。这些已成为实施验收门槛，不能用文档审查替代。

用户确认的 Q1–Q8 和当前公司 oMLX/Luna 政策保留。没有新增必须由用户选择的业务分歧；以上均为已授权方案范围的工程契约修订。
