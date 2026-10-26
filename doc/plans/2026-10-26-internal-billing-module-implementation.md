# 内部计费模块实施计划

> 保存范围：仅本地 fork。2026-10-26 用户决定撤回 PR #17 并恢复 r6；完整计费模块暂不实施，先向上游提交范围协调 issue，确认维护者方向后再推进。下文对 r7 的诊断和文件落点保留为历史设计依据，不表示 r6 已有这些接口。

日期：2026-10-26。状态：待整体评审；已纳入第二轮通用性审查修订，以下任务尚未实施。

**Goal：** 为所有现有用量提供统一、可解释的估算成本，正确区分服务渠道/上游/协议；保留原账本与预算，增加可选估算预算，完成全产品接入、历史治理及回退。

**Architecture：** 复用 cost_events、finance_events 与现有结算事务；在用量事件下增加版本化组件、计费身份、费率、估值和 publication sequence。公共 CostQueryService 服务所有正式费用显示；预算按 metric 分离、统一 gate 执行。

**Tech stack：** 现有 TypeScript、Zod、Drizzle/PostgreSQL/PGlite、Express、React Query、Vitest 与共享 money/token 层；无新增收费服务或基础设施依赖。

**Spec：** [完整设计与已确认 Q1–Q8](2026-10-26-internal-billing-module-design.md)、[第二轮通用性审查](2026-10-26-internal-billing-module-portability-review.md)。本计划及设计替代旧参考价方案在“当前价重算历史”“仅 Providers 显示”“provider 等于兼容协议”方面的范围；原账本、预算与订阅分离的决定继续有效。

**Global constraints：** company 隔离；原始数据/未提交改动保留；未知不当 0；不修改实际账本来填估算；厂商解析归 adapter/provider owner；oMLX/Luna 等仅为明确目标公司的配置；通用路径不依赖操作者 HOME、本机服务或单进程状态；不重构无关模块；重大运行变更通过单独预览与发布；本阶段不执行生产写入。

**Review focus（五类高风险失败）：**

1. 缓存读取/写入/reasoning 或重试/最终回执重复计量。
2. 把协议、执行器或最后一次模型误当渠道/全部用量的归属。
3. 调价、历史重估或页面口径切换意外触发旧/新预算停机、越权恢复。
4. 各页面范围、版本、责任用户或空归属不同，造成合计漂移。
5. 多进程、远程断线、迟到回执、调整、跨月或大批历史使金额重复、原账本损坏、持锁过长或半批发布。

执行时使用现有 executing-plans 工作方式：每个任务先确认相关规则与原行为，以可观察契约编写最小必要测试，再实施、验证并记录证据。每个任务可形成独立可审查提交；最终功能验收必须覆盖全部消费者。

## 1. 阶段、依赖和投入估算

| 任务 | 交付与依赖 | 独立验收门槛 |
| --- | --- | --- |
| T0 | 固化原行为与环境无关的合成数据，先于所有改动 | 原基线可复现；空白公司、替换厂商与无 run 来源反例明确 |
| T1 | 共享契约、规范化与纯估价；依赖 T0 | token 与 money 金标准、未知语义通过 |
| T2 | schema、费率/渠道配置、发布序列；依赖 T1 | 数据库迁移、权限、版本与冲突通过 |
| T3 | 各来源 V2 组件/身份与持久化能力；依赖 T1–T2 | 无 run 服务、远程重发、重试/恢复不重复，不丢写入量 |
| T4 | 统一估值/查询/兼容 DTO；依赖 T2–T3 | 所有维度对同一数据集可加总，旧 API 兼容 |
| T5 | 历史归属、费率导入、重估；依赖 T4 | 分块目标校验、guard、lease、常数规模发布与回退通过 |
| T6 | 全界面/CLI 接入；依赖 T4–T5 | 所有现有费用入口使用统一口径，配置可用 |
| T7 | 可选估算预算；依赖 T3–T4，硬停在 T6 验收后开放 | 双预算、实时/跨月/恢复通过 |
| T8 | 隔离演练、完整检查、发布材料 | 全矩阵通过，明确生产预览与回退证据 |

投入为工程估算而非承诺：熟悉仓库的单名开发者约 22–32 个有效工作日，其中 T0/T1 2–3，T2 3–4，T3 4–6，T4 4–5，T5/T6 4–6，T7 3–5，T8 2–3。先完成 T0/T1 后用实际差异和本轮通用性门槛重新校准；不把多入口改动压成一张 Providers 价表即宣称完整。待确认历史的人工证据时间不计入开发时间，也不以“100% 自动补齐”承诺。

## 2. 文件落点约定

以下“新增”均为计划文件，尚未创建；现有文件按当前名称定位。新增模块可按体量合并，但保持领域所有权，不把估价/财务策略塞进 heartbeat.ts；shared 不包含厂商 payload/SDK 或针对厂商名称的规范化分支。

| 责任 | 文件 |
| --- | --- |
| 共享身份、V2 用量、查询与质量 DTO | 新增 `packages/shared/src/billing.ts`；同步 `types/cost.ts`、`validators/cost.ts`、`types/budget.ts`、`validators/budget.ts`、`ai-connections.ts` 及 shared exports |
| 纯费率匹配/估价 | 新增 `packages/shared/src/billing-pricing.ts` 与其 test；复用 `money.ts`；旧 `model-reference-rates.ts` 改为兼容适配 |
| schema | 新增 `packages/db/src/schema/billing.ts`、`cost_valuations.ts`；扩展 `accounting.ts`、`budget_policies.ts`、`cost_events.ts` 所需发布/计量字段；同步 schema exports |
| 身份与费率管理 | 新增 `server/src/services/billing-configuration.ts`、`server/src/routes/billing.ts` |
| 组件入账/估值 | 扩展 `usage-receipts.ts`、`run-cost-accounting.ts` 及既有服务调用 owner；新增 `server/src/services/cost-valuation.ts`，以 ProducerRef 接收规范化事实 |
| 原始用量规范化 | 各 `packages/adapters/*` 自有 parser/execute 和 `server/src/services/*-provider.ts`；不向 shared 泄露供应商形状 |
| 正式成本查询 | 新增 `server/src/services/cost-reporting.ts`；现有 `costs.ts` 及 routes 作兼容适配 |
| 归属/历史批次 | 新增 `server/src/services/cost-revaluation.ts`；复用 activity、后台任务/持久化恢复机制 |
| 预算 | 扩展 `budgets.ts`、`budget-live-usage.ts`、`budget-exposure.ts`、`budget-reservations.ts`、`budget-enforcement-worker.ts` 和 heartbeat 预算取消模块 |
| UI 数据访问 | 扩展 `ui/src/api/costs.ts`、`queryKeys.ts`；新增 `ui/src/api/billing.ts`；复用 `CostAmount.tsx`，新增公共质量/来源详情组件 |
| UI 管理 | 在 Costs 下新增费率/归属页面组件，复用 AI connection 配置组件；`ui/src/api/model-reference-rates.ts` 引导兼容 |

## 3. T0：固化原行为与验收数据

- [ ] 读取适用规则；复用已读的 GOAL/PRODUCT/SPEC-implementation/DEVELOPING/DATABASE，确认期间无相关变更。记录分支基点与当前变更，保留未知/已有内容。
- [ ] 在隔离数据库建立可重复合成 fixture，禁止用真实密钥或发起付费请求。先用中性 Channel A/B、Deployment X、Model Y、空白公司与第二公司，再补 CLIProxyAPI/oMLX 当前公司场景；不能从本机连接列表、端口或现有记录数量生成唯一测试数据。
- [ ] 计费最小测试在临时 HOME/工作目录与可注入 UTC 时钟下运行；拦截意外公网/loopback 网络调用，不访问实际 Keychain、oMLX、CLIProxyAPI 或本机部署配置。保留项目所需的临时 DB/测试传输边界，不通过禁用真实事务来获得通过。
- [ ] 固化旧接口语义：默认 UTC 月、显式 inclusive 边界、cost_cents/reported_cost_cents/调整、现有预算预留/实时/暂停、subscription 当前月费。
- [ ] 原 SQL decimal 值/hash/事件数作为迁移不变校验；不用 JS number 序列化后的值当精度基线。
- [ ] 仅对行为缺口补必要特征测试，复用现有测试文件，不镜像实现或重复写 UI 快照。

优先复用：`server/src/__tests__/costs-service.test.ts`、`heartbeat-cost-accounting.test.ts`、`budget-live-attempts.test.ts`、`budgets-service.test.ts`、`subscriptions.test.ts`、`provider-billing-import`/reconciliation 现有测试所在位置。

验证：对当前实现运行相关已有测试，记录实际通过数和未通过原因；后续每阶段都核对这份基线。基线失败属于需解释的问题，不能修改预期掩盖。

## 4. T1：共享契约和纯计算

- [ ] 定义 `BillingIdentitySnapshot`、`ProducerRef`、`BillingMeterCapabilities`、`NormalizedUsageV2`、`UsageComponentV2`、`ValuationResult`、`CostQuery`、`CostReportEnvelope`；新增字段为可协商 V2，V1 读取不破坏。protocolId 是有界中性标识，不强制依赖执行层的有限协议枚举。
- [ ] 数量状态区分 observed/derived/not_applicable/unknown/unsupported，模型区分 requested/deployment/resolved/pricingModel 与映射版本；三类质量及计费维度覆盖独立，不能因归属缺失直接认定无价。
- [ ] shared 仅写 `validateNormalizedUsage`、`resolveRateVersion`、`estimateUsage` 等纯函数；normalizeProviderUsage 的实际厂商语义由各 adapter/provider owner 实现，不在 shared 按厂商名分派。
- [ ] 额外模态、缓存 token-hour、搜索/工具等未实现维度返回 unsupportedMeters/unmodeledCharges，不能标完整。非 token recorded_amount 必须限定使用单元、覆盖范围与 USD 来源，替代同范围 token 价；非 USD 账单保原币，不自动进入 USD 预算。
- [ ] rate selector 支持已确定字段与 `*`；区分 match/no_match/insufficient_evidence，未知字段可能命中更高优先级规则时不冒充确定结果。版本有效区间、优先级、冲突和缺档有明确结果。
- [ ] 公开价格映射为互斥 bucket 的完整单价；附加费式报价在发布时显式合成并保留推导，不能漏/重复基础价。
- [ ] 计算全程整数；bucket 乘价后组成完整公式，再在组件边界半远离零舍入到 nanodollars。拒绝负数、无穷、越界和不一致子项；保留原始异常回执。
- [ ] 新 V2 token 计数采用安全 integer/decimal-string 契约，旧接口在边界验证范围，不静默截断。
- [ ] 先跑失败测试，再实现并确认通过。失败信息要证明契约出错，而非仅缺文件。

金标准：

| 输入 | 预期 |
| --- | --- |
| 规范化 I8000/W2000/R2000/O1000，费率 .10/.01/.125/.50 | 0.1370000 cents |
| OpenAI raw input 含 read/write，Claude raw input 排除 read/write | 规范化同样用量得到同金额 |
| 写入多个 TTL 桶与 aggregate 同时出现 | 只用分项一次，桶和校验；不再加 aggregate |
| W 未知但 I/R/O 已知 | 输入部分是假设或待估，已知小计不得包含伪确定输入 |
| adapter 证明不适用写入 / 未实现收费维度 / 外币 actual | 不适用不误标未知；未实现不能宣称完整；无 FX 不混加 |
| 未知上游但渠道模型定价确定 / 缺失字段影响更高政策 | 前者不因标签阻断；后者带假设或待估，不随机选择 |
| reasoning 已在 output | 不再加 reasoning；有子项但不改总量 |
| 费率为 0 / 缺失 / 极小数 / 极大数 | 明确免费、待估、精度正确、越界可解释 |
| 旧政策未来生效、相同优先级重叠、长上下文证据缺失 | 时点选价、拒绝冲突、假设/待估 |

首批命令：`pnpm exec vitest run packages/shared/src/billing-pricing.test.ts packages/shared/src/model-reference-rates.test.ts`。路径新增后执行；不把本计划写成已经运行。

## 5. T2：持久化、费率政策和权限 API

- [ ] 按设计新增 10 张领域表（含有索引的 cost_revaluation_targets），及必要已有表列/关联；发布后的价格、组件、估值和 override append-only，草稿可乐观锁编辑。
- [ ] 实现公司单调 publication sequence 与现 head。普通回执/调整提交时分配序号；批次行通过 batch 的一个 published sequence 统一可见。旧 report revision 始终能重现。
- [ ] 从 SQL 精确值记录旧事件账本金额基线和 adjustment 水位；未来 `billing-reconciliation.ts` 与相关调整路径在原事务内登记发布序号。不能直接读 mutable cost_cents 来伪装旧快照。
- [ ] 数据库保证公司归属、组件键/版本/hash 幂等、非负 token 与金额范围。providerRequestId 保持非唯一索引。
- [ ] `billing-configuration.ts` 提供身份、草稿/发布政策、连接映射和匹配预览；校验重叠规则与生效日期；发布不追改既有估值。
- [ ] 当前公司配置清单中，oMLX `model=*` Luna benchmark 的优先级高于普通渠道规则；新增模型无需改代码。迁移/启动不自动向所有公司种入身份或费率，新安装无配置时诚实待估；同名渠道的第二公司不继承此政策。
- [ ] 官方预设、自定义来源、benchmark 区分，保留核验日期/notes；部署别名的 price-model 映射作为有作用域/生效时间的发布配置留存，不能把推断的模型写成 observed resolvedModel。
- [ ] 旧 `model_reference_rates` 保留可读，写入入口转到新草稿/发布，避免两套独立编辑；导入数据不自动发布历史基准。
- [ ] routes 使用 company access、cost-read、connection-manage 权限，Agent/viewer 拒绝写入；活动日志与发布原子提交，409 冲突可重载，422 返回具体无效字段。

新增 API 的目标形状（均在 `/api/companies/:companyId` 下，具体路由注册需同步 shared paths）：

| API | 行为 |
| --- | --- |
| `GET/POST /billing/identities`，`PATCH /billing/identities/:id` | 公司渠道/上游目录，稳定 ID、审计、停用保历史 |
| `GET/POST /billing/rate-policies`，`PATCH /billing/rate-policies/:id/draft` | 查询政策、保存草稿，expectedRevision 必填 |
| `POST /billing/rate-policies/:id/preview`、`/publish` | 同一草稿 hash 的规则覆盖预览与版本发布；过期则 409 |
| 现有 connection 配置接口加 `billing` 字段 | 同权限服务端验证身份并保存，鉴权 provider 不改义 |

迁移命令：`pnpm db:generate`，`pnpm --filter @paperclipai/db check:migrations`；复核仅保留最新 5 份 snapshot，所有 SQL/journal 保留。迁移编号以当前分支生成结果为准。

验证：空白安装与从旧版升级的 PGlite/PostgreSQL；第二公司没有被注入第一公司的 benchmark。真实 PostgreSQL 两条独立连接并发发布相同 revision 只能一次成功；跨公司 FK/查询拒绝；旧费率/回执/hash/金额精确不变；同一 preview 不能发布不同价格。首次索引基于实际范围查询 EXPLAIN，不盲目加所有组合。

## 6. T3：前向采集与可靠入账

### 6.1 身份快照

- [ ] `ai-connections.ts` → `ai-connection-runtime.ts` → `heartbeat/execution-configuration.ts` 传递最小计费快照；`heartbeat/runtime-execution.ts` 及 adapter 不再从协议或执行器推导渠道。
- [ ] 管理连接、unmanaged、API key、subscription 各有独立可信度规则。区分 configured mapping 与 observed resolved model；serviceChannel/upstream/modelPublisher/biller 不混同，多级 routeHops 仅是有证据的路径信息，不逐跳计费。
- [ ] 连接改名、重配、停用后历史事件仍显示原快照。API key 不能自动将渠道改成 OpenAI 或将费用当公开价实扣。

### 6.2 用量组件

- [ ] 扩展 `packages/adapter-utils/src/types.ts` 与 `usage-checkpoint.ts`：V2 捕获 ProducerRef、跨控制器稳定的 logicalAttemptId/logicalComponentId、独立 source authority epoch/sequence 和写入子项；换 epoch 不更换同一物理用量的逻辑键。heartbeatRunId 可空，复用现有服务调用 ID，不为 Decision/FastResponse/PromptInjection 构造伪 run；同 attempt 累计覆盖，不重复相加。
- [ ] 对 `packages/adapters/{claude-local,opencode-local,pi-local,codex-local,gemini-local}/src/server/parse.ts` 及相应 execute 传输链补齐能获取的 read/write/reasoning 子项。供应商本身不提供的量保持 unknown。
- [ ] `native-runtime/native-session-executor.ts` 保留原 sourceInstanceId/sourceSeq 去重和恢复模型；捕获真实 turn/route，不能只标最后一次尝试。
- [ ] `provider-usage.ts`、`decision-model-provider.ts`、`fast-response-provider.ts`、`prompt-injection-provider.ts` 规范化后统一写入；`decision-models.ts`、`fast-responses.ts`、`prompt-injection-prevention.ts` 的 settle 路径不再丢 cached/write 量。
- [ ] `usage-receipts.ts`、`run-cost-accounting.ts` 在现有会计事务中写 usage set/组件及待估或已估状态；原事件互斥 final/model 规则保持。
- [ ] 原 ledger 成功但估值暂不可用时留下可恢复 pending 工作；禁止因估价故障丢 spool 或把原结算失败吞掉。
- [ ] 接收/重放 owner 实现 durability/ack 契约：run 继续旧 journal，服务调用用自己的持久化记录和最小回执快照；远程来源只有持久化接受确认后删除本地回执。确认丢失使用相同 ID 重发，不重新调用模型。
- [ ] 明确本地 spool 只保护其已声明的持久卷范围；服务不要求多个节点共享 HOME。worker/批次所有权使用数据库 lease，unsupported/临时存储拓扑不宣称节点丢失可恢复。
- [ ] 已结算后的受信用量修正生成新 receipt/usage-set revision，原事件/旧组件保留；替换同一稳定组件当前值，估值/预算只应用差额，不重复记录新累计量。hash/序号无法证明权威性则待核对。
- [ ] 写入 normalized 数量/组件 checksum；无法拆分的 V1 保留聚合，不以最后一次身份冒充完整归属。

关键验证：A 模型失败尝试＋B 模型成功尝试均计入且各自归属；无 run 服务有相同幂等保障；远程接受成功但 ack 丢失重发不重复；重复 checkpoint/最终回执/重启重放无重复；同 run 分模型事件和 aggregate 互斥；响应缺 usage、数据库失败、持久卷 spool 恢复、worker lease 转移/控制器 epoch 更换不重计、旧控制器迟到均保留原权威约束。完成测试应走组装后的 heartbeat 公开路径，不能只断言 helper 被调用。

主要命令：`pnpm exec vitest run server/src/services/run-cost-accounting.test.ts server/src/__tests__/heartbeat-cost-accounting.test.ts server/src/__tests__/budget-live-attempts.test.ts server/src/services/native-runtime/native-session-executor.test.ts packages/adapter-utils/src/usage-checkpoint.test.ts`，再按实际修改补适配器最小测试集。

## 7. T4：估值、统一查询与兼容契约

- [ ] `cost-valuation.ts` 对稳定组件按固定费率/计算器版本估值，已知/假设/待估分开，hash 幂等；与报告发布序号关联。
- [ ] `cost-reporting.ts` 在一个数据库快照内固定 basis/range/revision/权限/scope，再分组；SQL 精确 decimal 字符串读取，避免 Drizzle 旧 mode:number 导致精度损失。
- [ ] 新 `/costs/v2/report` 支持 `groupBy=summary|agent|agent_model|service_channel|upstream|model|project|responsible_user|biller|day`；`/costs/v2/events`、`/costs/v2/events/:id`、`/costs/v2/issue-tree/:issueId` 和导出沿同一 envelope。
- [ ] 时间字段显式区分：estimated 按组件有证据的发生时间，ledger 保留原事件 occurredAt，未知时间标假设；跨月聚合不按时长拆 token。价格按请求开始时点固定。
- [ ] 行/明细返回 estimated/ledger 及来源、质量、revision；旧接口默认 ledger，不悄悄把 costCents 字段从账本改成估算。新 UI 显式使用 V2。
- [ ] 统一 Task 闭包、无归属桶、服务 usageKind、责任用户过滤；真正实现 scopedAgentId 服务端过滤。
- [ ] token_rate 与 recorded_amount 是同一覆盖范围互斥策略；额外独立费用有 charge identity，关联 finance 只引用一次。非 USD 无 FX 版本不得进 USD 小计；显式免费量、订阅零账本、未支持收费维度也保留。
- [ ] 多组件 JOIN 不重复放大父账本金额；ledgerAllocations 缺证据则全额进入混合桶。分组基于 recorded ledgerScope/有版本修正，任务换项目不重归历史；旧 revision 仍执行当前授权。金额可加总，run/event distinct 计数不装成可加总指标。
- [ ] `dashboard.ts`、`companies.ts`、`routes/user-profiles.ts`、`decision-models.ts`、`fast-responses.ts`、`company-skills.ts`、`status-cards.ts` 同步新 DTO 或按事件引用读公共服务；原 billing reconciliation/subscription/report/import 语义保持。
- [ ] React Query key/API 请求/分页游标包括 company、basis、所有 scope、range、revision；串行刷新获得新 head，分组不得各取不同 now。

契约测试新增 `server/src/__tests__/cost-reporting.test.ts`、`cost-reporting-routes.test.ts`，复用旧 costs 测试：同一合成集所有分区精确金额相等；未归属项不丢；同 run 多模型不翻倍；账本调整后旧 revision 不变；新事件并发发布不改变旧分页；UTC 边界与旧 inclusive API 均正确。

性能验证使用 10k/100k 合成事件并记录环境、查询计划、p50/p95 与写入代价；目标常用月报单组查询 p95 < 500ms、合成页面数据请求 < 1s 为待实测目标，不先宣称达标。若未达到，先优化实际热点或增量投影，缓存必须带 revision，不增加新数据库/队列依赖来掩盖错误。

## 8. T5：历史归属与重估批次

- [ ] `cost-revaluation.ts` 使用持久化状态机：draft/previewing/previewed/approved/running/ready/published，支持 failed/cancelled/stale；各阶段使用 idempotency key 与预期 revision。每公司一个有发布权的活动批次，其余草稿/排队，使用 DB 唯一约束与租期。
- [ ] 归属预览只用原运行连接快照、原回执或管理员提交的时间证据；协议、模型名、当前连接不足时维持 pending。
- [ ] 旧参考价与 notes 全量导入草稿，映射重复 oMLX 别名到统一政策；不删除旧记录或覆盖旧审计。
- [ ] 首次历史基准必须展示范围/来源/日期/假设，不能把今天的公开价标成过去真实价。无版本/无证据的行仍待估或待确认。
- [ ] 预览含目标事件集合/hash、原/新归属、旧/新金额、缺项、是否涉及活跃预算。确认只授权该集合，不能加入之后出现的新事件。
- [ ] 目标事件/hash/版本写入有索引的 cost_revaluation_targets；后台分块登记和校验，未 published 的 batch 无查询可见序号。每个目标输入变更在原会计事务内以索引将活动 batch 置 stale/增加 guardVersion，登记前变化由分块版本检查发现。
- [ ] 发布锁内只检查 ready、lease、预期 guardVersion 和批准 hash，再赋单一 publication sequence；禁止全量扫 targets/重算 hash/导出。无关新事件保留，目标变化重新预览。不能仅以“检查在事务里”声称 100k 目标发布很短。
- [ ] 取消/失败/重试不动原事实。回退通过新审计发布选择旧版本，不能 DELETE 记录；所有变更均可追踪 actor/reason/source。
- [ ] 报表重估默认不修改预算计量版本。应用当前窗口预算另列独立操作和权限，过期影响预览拒绝执行。

API：`POST /billing/batches/preview` → 返回批次/manifest hash/影响；`POST /billing/batches/:id/approve`、`/start`、`/publish`、`/cancel`；`GET /billing/batches/:id` 与受权限控制的详情/导出。影响活跃预算另用 `POST /billing/batches/:id/apply-budget`，要求匹配预算影响预览与 policy revisions，不能复用报表 approve 的授权。

测试新增 `cost-revaluation.test.ts` 与 routes：断点续跑、发布前异常、两个进程抢 lease/发布、目标在登记前/校验后/发布前分别变化、目标 stale、新事件不被吞、他公司数据不可见、原回执/金额/hash 不变、只改报表不取消运行、回退保留审计。大目标批次下验证另一条连接仍能正常入账，测锁等待，不能用进程内 mutex/mocked DB 代替。

## 9. T6：界面和 CLI 全面接入

- [ ] `ui/src/pages/Costs.tsx` 将 Overview/Agent/Provider/Model/Project/User/Biller、趋势和滚动窗口统一数据来源；Provider 按渠道命名，增加上游筛选。
- [ ] 在 Activity → Costs 提供“费率与归属”页签：渠道目录、连接计费身份、政策版本、匹配预览、待确认项、历史批次。保存草稿与发布明确区分，409 可重载而不丢用户草稿。
- [ ] 旧 Providers 编辑卡只做新入口适配。顶栏 USD/UTC/basis，质量和来源展开；金额 < $0.01 也有可辨识精度/提示，未知显示待定。
- [ ] `ui/src/pages/Dashboard.tsx`、`Companies.tsx`、`AgentDetail.tsx`、`IssueDetail.tsx`、`UserProfile.tsx`、实际运行详情页读取 V2 DTO。当前 Agent 路由以 `App.tsx → AgentDetailPage → AgentDetail.tsx` 为准，不仅修改旧 production 文件。
- [ ] Decision/FastResponse history、PromptInjection 相关金额、状态卡、Skill Studio 和聊天正式费用使用同一公共金额/质量组件，缓存显示带 revision。
- [ ] Task 本身与子树均用服务端结果；UserProfile 财务使用唯一责任用户，参与统计单独保留含义。
- [ ] `cli/src/commands/client/cost.ts`、相关 UI API、shared response types 同步 basis/range/scope/revision 与 Exact 输出。
- [ ] `ui/src/api/subscriptions.ts` 等账户报告继续独立，标“当前标准月费”；非付款记录不显示“已支付”。人民币不隐式换算。
- [ ] 同步 `doc/SPEC-implementation.md`、`doc/PRODUCT.md`（仅相关增量）、新费用说明文档、`maps/feature-map/budgets-costs.md` 及对应 agent-access map；如果新增/修改 stories，再遵守 Storybook catalog 工作流。

测试以关键行为为主：金额切换不修改预算；同页面所有分组继承筛选/revision；agentId 深链接真实过滤；未知与极小金额；权限控制；批次预览/冲突/失败；Provider 与上游显示正确。复用 Costs、AgentDetail accounting、DecisionHistory、UserProfile 等现有组件测试，新增费率管理测试仅覆盖用户操作。

命令：`pnpm check:token-gates`、`node scripts/check-maps.mjs`；story 变更时再运行 `node scripts/storybook-catalog.mjs`。浏览器在一次性隔离实例中用合成数据走配置→用量→各维度→明细→批次，不发起外部付费调用。

## 10. T7：双口径预算，先预警后可选硬停

- [ ] shared budget metric 增加 `estimated_cents`；原 `billed_cents` 枚举/API/策略不改义。新策略默认 hardStopEnabled=false，旧策略默认值不重置。
- [ ] reservation/observed/settlement/incident 都按 metric 与计量版本区分。现有唯一键如不含 metric，按 schema 生成迁移补齐；不得以一个 run 的释放同时解除两套预留。
- [ ] 同一 metric/work-unit（run 或已有服务调用）取公司/Agent/Project 适用预留的最大值，不叠加不同作用域预留；每个政策在自己作用域核算，无 Agent/Project 不伪造作用域。
- [ ] 复用原会计事务和锁顺序，实时 V2 累计值替换；`settled + max(reserved, observed)` 的 run 只计一次，unreserved 单列。
- [ ] gate 汇总全部适用政策的 decisions，所有硬政策 AND；warn-only 不产生阻断。单个政策不可绕过其他政策或人工暂停。
- [ ] 预算暂停保留多个 incident 原因；解除只移除自身原因。`heartbeat/budget-cancellation.ts` 与 enforcement worker 共同遵守当前 authority，不能竞争所有权。
- [ ] 硬停对导致无法估值的缺项保留占额并阻止新准入；未知上游但价格已确定时不误阻断，缺失字段可能改变更高政策时走缺项策略。未实现收费维度不可标完整；显式预警策略不能放宽旧预算，估值服务失败不降级成免费。
- [ ] 跨月运行沿用现有 held 逻辑，组件按发生时间结算；迟到回执修正所属月与相应暴露，新月不重复计入旧月实际量。
- [ ] 历史重估的 report revision 与预算计量 revision 分离；apply-budget 独立预览/确认后替换当前 settled 基准，活跃 run 的 pinned 价格/预留仍保留且不重复。
- [ ] UI 预算卡显示 metric、是否硬停、UTC 窗口、预算计量版本及与报表差异。启用前显示影响与缺项，已有策略不迁移成 estimated。

新增 `server/src/__tests__/estimated-budgets.test.ts`、`dual-budget-enforcement.test.ts`，复用 `budget-enforcement-worker.test.ts`、`budget-enforcement-scoping.test.ts`、`budget-live-attempts.test.ts`、`services/budget-live-usage.test.ts`、`heartbeat/budget-cancellation.test.ts`。

必须覆盖：旧阻断/新放行、新阻断/旧放行、双阻断、先解除其一、人工暂停后解除、并发改政策、无 run 服务的预留/观测/结算、未知上游但可估值、关键映射不足、最后回执落地、预留大于/小于观测、无预留 live、UTC 月界、旧控制器迟到、运行中调价、重估不 apply、显式 apply 超额、缺项与估值故障。

## 11. T8：隔离演练、完整验证与交付

### 11.1 总体验收矩阵

| 场景 | 观察与断言 |
| --- | --- |
| CLIProxyAPI Messages + Responses | 两者均归 CLIProxyAPI，不产生协议冒充的 OpenAI/Anthropic 渠道 |
| CLIProxyAPI → oMLX 旧/新模型 | 统一 Luna benchmark、原模型名保留、一次用量；上游未知的历史不强命中 |
| OpenAI 真直连 | 有直连快照才归 OpenAI，与网关分开 |
| 同 run 多 attempt/模型/路由 | token 与金额无遗漏/重复，历史不可拆时显示混合 |
| cache read/write/TTL/reasoning | 金标准正确，缺项有假设和已知小计，绝不补零 |
| 订阅包含量 | 账本可为 0，估算为正，月费另列不相加 |
| Decision/Fast Response/Prompt Injection/无 task 服务 | 公司总量纳入，无 Agent/Project 进入未归属桶 |
| Browser Use 与关联 finance | 录得的使用费用只计一次，原币分列 |
| 多维度总计 | 同范围/basis/revision 分区精确相等，Task inclusive、distinct run 等非可加指标标明 |
| 动态重命名/连接变更 | 历史快照不变，缺证据待确认 |
| 调价与历史批次 | 时点选价、未来价不改旧值、preview hash、防 stale、单批原子发布 |
| 双预算与人工暂停 | AND gate、单原因解除不越权恢复、warn-only 不停机 |
| DB/进程故障、迟到/重放 | 原回执不丢、账本一次、估值可恢复、旧 revision 稳定 |
| 隔离与权限 | 另一公司、viewer、Agent 无写入口；导出/详情不绕过 task/cost 权限 |
| 回退 | 关闭新功能保原预算；费率/归属可审计回退；旧版本兼容资格经实测 |

### 11.2 不依赖当前环境的反例矩阵

| 用例 | 必须否定的局部假设 |
| --- | --- |
| 空白公司 / 无旧参考价 / 另一公司同名模型 | 安装依赖当前已接入连接；Luna 政策自动全局生效 |
| Channel A/B、私有别名、替换连接 ID/目录/主机 | 费率或归属通过特定名称、端口、HOME 判断 |
| 合法 Anthropic 直连 | 修当前公司的伪归属变成全局禁用 Anthropic |
| Azure deployment 别名与重新发布映射 | requestedModel 必然是可查公价的模型 ID |
| 聚合入口 + 未知上游 / 多跳 fallback | 上游总可见；每跳都是一笔用量；缺上游必然无价 |
| Gemini/其他 adapter 的模态与额外收费能力 | 所有 token 单价/包含关系相同；三桶齐全等于完整成本 |
| not_applicable 写入 / unknown 写入 / unsupported 维度 | 不支持、不适用、缺计量都可补成 0 |
| 非 USD 实际金额与独立 USD 用量估值 | 所有金额可不经 FX 直接合并 |
| Decision/FastResponse/PromptInjection 无 run | 所有组件/预留必须有 heartbeatRunId |
| PostgreSQL 两连接/两 worker + 断线 ack 丢失 | 单进程锁、本地文件路径、一次调用返回等于可靠接受 |
| 10k/100k 历史目标与并发新事件 | 小量本机数据下短事务即可证明大批发布不阻塞 |
| 临时 HOME、不同 UTC 时间、Linux 容器 | 测试依赖本机模型服务、macOS 工具或测试机当日时钟 |

使用合成回执和受控传输验证不同形状，不为测试安装新 Provider 或购买账号。协议替换 fixture 证明边界可替换，不证明厂商真实生产兼容；后者需要对应 adapter 资格验证。

### 11.3 检查命令与证据

先运行每任务最小相关测试，通过后在最终交付跑：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm check:token-gates
pnpm --filter @paperclipai/db check:migrations
node scripts/check-maps.mjs
```

数据库迁移、故障/并发和关键预算契约分别验证真实 PostgreSQL 与项目默认 PGlite；多连接/worker lease 必须用独立客户端验证。计费核心最小套件另在项目支持的 Linux 容器/CI 环境验证，测试临时目录和假时钟，不要求 oMLX、CLIProxyAPI 或操作者 macOS 环境。自定义浏览器验收对隔离实例操作；默认不跑无关 release-smoke/E2E 全套。若修改已有 runner/E2E 工作流，再读取适用技能并运行对应套件。

证据必须包含：代码 revision、环境、命令/实际结果、精确差异、不变性校验、浏览器关键操作截图或结果、未验证项。性能数字只能来自实际记录，不以退出码或计划代替产品验收。

### 11.4 生产切换与回退手册（本仓库集成）

- [ ] 先生成可评审 PR 材料，遵守 fork deploy 分支/patch registry 及完整 PR 模板；merge/deploy 需要明确范围授权。运行 `node scripts/check-delegra-branch-policy.mjs`。
- [ ] 以不可变 deploy tag 发布兼容 schema/采集版本，先关闭新主报表和新预算 enforcement；备份目标 DB 与启动配置，不在仓库放凭据。
- [ ] 在目标实例生成真实盘点/映射/首批历史基准预览，确认具体集合后执行；本方案批准不替代每个真实历史批次的预览。
- [ ] 影子核对原 ledger/预算不变，待所有消费者同步后公司级切换估算默认。新估算预算创建先仅预警。
- [ ] 明确需要硬停时，以当前影响预览启用；不因发布或调价自动开启。
- [ ] 回退先撤新 enforcement 所有权，重新评估剩余预算/人工暂停，再切回旧显示；不直接 resume 所有 Agent，不删表/回执/审计。
- [ ] 旧二进制必须通过 schema、V2 spool/journal 与在途预算兼容测试才允许降级；未通过则保留新兼容版本关功能或前向修复。恢复备份属于有明确数据损失窗口的独立操作，不作为普通版本回退。

交付不以“费率已配置”结束：只有全入口、历史治理、计量完整性、双预算与回退均有证据，才称模块完成。若还存在无法补证的历史，列出准确未知范围和影响，它是数据质量状态，不伪装为已经精确核算。

## 12. 本轮方案核验记录

2026-10-26：已完成当前实现的只读核查、相关公开资料核验、设计与实施计划交叉检查。fresh builder review 只读评审两份文档，结论为 `nothing important left`：没有必须新增业务问题才能实施的契约缺口；特别复核了多估值、重试去重、版本发布、历史重估与双预算共存。

上述为第一轮可实施性核验。第二轮另审查环境/Provider 通用性，发现并修订 9 项缺口，详见独立审查记录；第一轮结论不代表通用性已经得到运行验证。

本轮检查了本地文档链接、代码围栏、任务状态与空白格式。此记录只证明方案经过一致性评审，不证明模块已实现或测试通过。未执行产品代码修改、数据库迁移、历史回填、生产发布或付费调用；产品测试与性能目标均留待实施阶段实测。
