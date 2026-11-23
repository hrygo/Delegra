# Delegra Kubernetes 智能调度真集群端到端联调与验收清单

> **适用基线**：`hrygo/Delegra:deploy`（已合入 `#77`–`#85`，含生产主链路接线 `bbe2aebaa906`）  
> **关联追踪**：`hrygo/heluo-forge#420`（待真集群实测证据补齐后解除 `status: blocked`）

## 0. 前置条件与清单部署

确认目标集群已具备以下组件：
- Kubernetes `>= 1.29`（支持 Server-Side Apply、Pod Security Standards `restricted`）
- `kubernetes-sigs/agent-sandbox` `>= v1.0.12`（已安装 `agents.x-k8s.io/v1beta1` 与 `extensions.agents.x-k8s.io/v1beta1` CRD）
- Cilium CNI（若启用 `egressMode: "cilium"` 精确 FQDN 放行）
- Kata Containers（`kata-fc` RuntimeClass，若验证 C3/C4 强隔离节点池）
- KEDA / Karpenter v1（若验证潮汐暖池与双池弹性扩缩容）

按顺序应用仓库内静态清单（位于 `packages/plugins/sandbox-providers/kubernetes/manifests/`）：

```bash
MANIFEST_DIR="packages/plugins/sandbox-providers/kubernetes/manifests"
kubectl apply -f "${MANIFEST_DIR}/operator-prerequisites.yaml"
kubectl apply -f "${MANIFEST_DIR}/priority-classes.yaml"
kubectl apply -f "${MANIFEST_DIR}/arm64-image-prepuller-daemonset.yaml"
kubectl apply -f "${MANIFEST_DIR}/delegra-gateway-proxy.yaml"
kubectl apply -f "${MANIFEST_DIR}/warm-pool-v1beta1.yaml"
# 若集群已部署 Karpenter v1：
kubectl apply -f "${MANIFEST_DIR}/karpenter-dual-nodepool-overprovisioning.yaml"
```

## 1. 一键自动化巡检脚本

仓库内提供默认只读、安全可重复执行的验收脚本 `scripts/verify-k8s-scheduling-e2e.sh`：

```bash
# 基础只读检查（CRD、PriorityClass、控制面 fail-closed、Proxy 探针、租户零凭证校验）
bash scripts/verify-k8s-scheduling-e2e.sh \
  --namespace paperclip-smoke \
  --control-plane-url http://127.0.0.1:3100 \
  --proxy-url http://127.0.0.1:8080

# 带内部凭证测试控制面 reconcile 接口，并执行一次 v1beta1 SandboxClaim 认领+单向销毁冒烟
DELEGRA_GATEWAY_INTERNAL_TOKEN="<your-internal-token>" \
bash scripts/verify-k8s-scheduling-e2e.sh \
  --namespace paperclip-smoke \
  --control-plane-url http://127.0.0.1:3100 \
  --proxy-url http://127.0.0.1:8080 \
  --warm-pool-name expert-light-pool \
  --run-claim-smoke
```

## 2. 分模块验收用例与通过标准

### 模块 A：控制面与 `delegra-gateway-proxy` 零信任逐请求鉴权（`#80` / `#81` / `#85`）

| 编号 | 验证项 | 操作与观测命令 | 通过标准 |
| :--- | :--- | :--- | :--- |
| A-1 | 控制面未配置内部 Token 时 fail-closed | 未设 `DELEGRA_GATEWAY_INTERNAL_TOKEN` 时 `POST /internal/runner/v1/gateway-authorize` | 返回 `503` 且 `Cache-Control: no-store`，不经过 `actorMiddleware` 误报 |
| A-2 | 控制面错误内部 Bearer 拒绝 | 携带错误 Bearer 调用 `/internal/runner/v1/gateway-authorize` 与 `/internal/runner/v1/gateway-reconcile` | 返回 `401` 且 `Cache-Control: no-store` |
| A-3 | Proxy 路径白名单与鉴权 | `GET /healthz`、`GET /v1/models`、无 Bearer `POST /v1/responses` | `/healthz` 为 `200`；非 `/v1/responses` 为 `404`；缺 Bearer 为 `401` |
| A-4 | 5 类拒绝码零上游穿透 | 依次验证 `RUN_GENERATION_STALE`(409)、`MODEL_NOT_ALLOWED`(403)、`USER_AUTH_REVOKED`(401)、`BUDGET_EXHAUSTED`(429)、`TASK_CANCELLED`(403) | 上游网关请求计数为 `0`，SSE 在撤销后 `<100ms` 中断 |
| A-5 | 零凭证 Secret 与 tmpfs Token | `kubectl get secret -n <ns> -l paperclip.io/secret-scope=agent-session -o json`；容器内 `stat -c '%a' /run/delegra-auth/lease-token` | Secret 中不含任何 `*_API_KEY`/`*_ACCESS_TOKEN`/`PROXY_SESSION_TOKEN`；tmpfs 文件权限为 `600` |

### 模块 B：`v1beta1` `SandboxClaim` / `SandboxWarmPool` 单向生命周期（`#82` / `#84` / `#85`）

| 编号 | 验证项 | 操作与观测命令 | 通过标准 |
| :--- | :--- | :--- | :--- |
| B-1 | 暖池就绪与声明式认领 | 触发开启 `warmPool.enabled=true` 的任务，观察 `kubectl get sandboxclaim,sandbox,pod -n <ns>` | `SandboxClaim` 含 `spec.warmPoolRef.name` 与 `spec.lifecycle.shutdownTime` + `DeleteForeground`；租约元数据 `poolHit: true` |
| B-2 | 严格单向销毁（不回池） | 任务完成或取消后执行 `releaseLease` / `destroyLease` | `SandboxClaim`、绑定 `Sandbox`、Pod 全部删除，原 Pod 未被回收到 `SandboxWarmPool` |
| B-3 | 防 CrashLoop / Sidecar 误判 | 注入 sidecar 或模拟 `agent` 容器重启（`restartCount > 0`） | 仅 sidecar 就绪时继续轮询；`agent` `restartCount > 0` 时拒绝认领并触发清理 |

### 模块 C：租户 SSA 协调与 Standard ↔ Cilium 零停机切换（`#79`）

| 编号 | 验证项 | 操作与观测命令 | 通过标准 |
| :--- | :--- | :--- | :--- |
| C-1 | 命名空间归属校验与 SSA | 检查 `kubectl get ns <ns> --show-labels` 及重复调用 `ensureTenant` | 带 `pod-security.kubernetes.io/enforce=restricted` 与 `paperclip.io/company-id`；跨公司复用同命名空间报错拒绝 |
| C-2 | Standard ↔ Cilium 切换 | 从 `standard` 切到 `cilium` 再切回 `standard`，观察进行中的 Pod 连通性 | 遵循 apply-before-delete，切换过程无连接闪断，旧策略自动清理 |

### 模块 D：派发前 `ResourceQuota` 容量反压与 C3/C4 `kata-fc` 强隔离（`#83` / `#85`）

| 编号 | 验证项 | 操作与观测命令 | 通过标准 |
| :--- | :--- | :--- | :--- |
| D-1 | 配额耗尽派发前拦截 | 将租户 `ResourceQuota`（`paperclip-quota`）填满后发起新任务 | `acquireLease` 抛出 `CapacityAdmissionDeferredError`（`state: "queued"`），集群内不新增 Pending Pod |
| D-2 | C3/C4 无 `kata-fc` 时 fail-closed | `dataClassification: "C3"` 且 `kataFcAvailable: false` | 拒绝启动（`KataIsolationRequiredError`），绝不降级到 `runc` |
| D-3 | C3/C4 `kata-fc` 正常调度 | `dataClassification: "C4"` 且 `requests.memory === limits.memory` | Pod 注入 `runtimeClassName: kata-fc`、`nodeSelector: paperclip.io/runtime=kata-fc`、`NoSchedule` toleration 及 `default_memory_offset_mb >= 512` 注解 |

## 3. 真集群实测证据记录模板（用于回填 `heluo-forge#420`）

```markdown
### 真集群端到端验收记录
- **验收日期 / Git SHA**：YYYY-MM-DD / `bbe2aebaa906`
- **集群环境**：Kubernetes v1.xx / agent-sandbox v1.0.xx / Cilium v1.xx / Kata-FC (是/否)
- **自动化脚本结果**：`verify-k8s-scheduling-e2e.sh`（PASS/FAIL 及关键输出）
- **核心指标**：
  - 暖池 `SandboxClaim` 认领耗时 P50 / P95：xx ms / xx ms
  - `delegra-gateway-proxy` 撤销断流延迟：xx ms（目标 <100ms）
  - 零凭证 Secret 审计：通过（0 个用户模型 Key 落地）
  - 配额反压与 C3/C4 `kata-fc` 强隔离：通过
```
