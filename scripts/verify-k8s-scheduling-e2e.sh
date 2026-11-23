#!/usr/bin/env bash
# Delegra Kubernetes 智能调度真集群端到端验收脚本
# 默认只读安全检查；仅在显式传入 --run-claim-smoke 时创建并清理一次性 v1beta1 SandboxClaim。

set -euo pipefail

NAMESPACE="${DELEGRA_E2E_NAMESPACE:-paperclip-smoke}"
CONTROL_PLANE_URL="${DELEGRA_CONTROL_PLANE_URL:-}"
PROXY_URL="${DELEGRA_GATEWAY_PROXY_URL:-}"
WARM_POOL_NAME="${DELEGRA_WARM_POOL_NAME:-expert-light-pool}"
KUBE_CONTEXT="${DELEGRA_KUBE_CONTEXT:-}"
RUN_CLAIM_SMOKE=0

usage() {
  cat <<'EOF'
Usage: verify-k8s-scheduling-e2e.sh [options]

Options:
  --namespace <ns>            Target tenant namespace (default: paperclip-smoke)
  --context <kube-context>    Optional kubectl context
  --control-plane-url <url>   Delegra server base URL (e.g. http://127.0.0.1:3100)
  --proxy-url <url>           delegra-gateway-proxy base URL (e.g. http://127.0.0.1:8080)
  --warm-pool-name <name>     SandboxWarmPool name for --run-claim-smoke (default: expert-light-pool)
  --run-claim-smoke           Create and one-way destroy a live v1beta1 SandboxClaim
  -h, --help                  Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --context) KUBE_CONTEXT="$2"; shift 2 ;;
    --control-plane-url) CONTROL_PLANE_URL="${2%/}"; shift 2 ;;
    --proxy-url) PROXY_URL="${2%/}"; shift 2 ;;
    --warm-pool-name) WARM_POOL_NAME="$2"; shift 2 ;;
    --run-claim-smoke) RUN_CLAIM_SMOKE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

KCTL=(kubectl)
if [[ -n "$KUBE_CONTEXT" ]]; then
  KCTL+=(--context "$KUBE_CONTEXT")
fi

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() { echo "[PASS] $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "[FAIL] $*" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }
warn() { echo "[WARN] $*"; WARN_COUNT=$((WARN_COUNT + 1)); }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
    exit 1
  fi
}

require_cmd kubectl
require_cmd curl

echo "=== 1. Cluster & CRD Prerequisites ==="
if "${KCTL[@]}" cluster-info >/dev/null 2>&1; then
  pass "Kubernetes cluster reachable"
else
  fail "Kubernetes cluster unreachable"
  exit 1
fi

for crd in \
  "sandboxes.agents.x-k8s.io" \
  "sandboxclaims.extensions.agents.x-k8s.io" \
  "sandboxtemplates.extensions.agents.x-k8s.io" \
  "sandboxwarmpools.extensions.agents.x-k8s.io"; do
  if "${KCTL[@]}" get crd "$crd" >/dev/null 2>&1; then
    pass "CRD installed: $crd"
  else
    fail "Missing required CRD: $crd"
  fi
done

if "${KCTL[@]}" get crd ciliumnetworkpolicies.cilium.io >/dev/null 2>&1; then
  pass "Cilium CRD installed: ciliumnetworkpolicies.cilium.io"
else
  warn "Cilium CRD not installed (only standard NetworkPolicy mode available)"
fi

if "${KCTL[@]}" get runtimeclass kata-fc >/dev/null 2>&1; then
  pass "RuntimeClass kata-fc present (C3/C4 isolation ready)"
else
  warn "RuntimeClass kata-fc not found (C3/C4 workloads will fail-closed as designed)"
fi

echo "=== 2. PriorityClasses & Cluster Proxy Workload ==="
for pc in paperclip-expert-interactive paperclip-expert-batch paperclip-warm-pool; do
  if "${KCTL[@]}" get priorityclass "$pc" >/dev/null 2>&1; then
    pass "PriorityClass present: $pc"
  else
    warn "PriorityClass missing: $pc (apply manifests/priority-classes.yaml)"
  fi
done

echo "=== 3. Tenant Namespace Baseline & Zero-Credential Secret Audit ($NAMESPACE) ==="
if "${KCTL[@]}" get namespace "$NAMESPACE" >/dev/null 2>&1; then
  pss_enforce="$("${KCTL[@]}" get namespace "$NAMESPACE" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null || true)"
  if [[ "$pss_enforce" == "restricted" ]]; then
    pass "Namespace $NAMESPACE enforces PSS restricted"
  else
    fail "Namespace $NAMESPACE missing pod-security.kubernetes.io/enforce=restricted (got: '${pss_enforce:-<empty>}')"
  fi

  if "${KCTL[@]}" get resourcequota paperclip-quota -n "$NAMESPACE" >/dev/null 2>&1; then
    pass "ResourceQuota paperclip-quota present in $NAMESPACE"
  else
    warn "ResourceQuota paperclip-quota not found in $NAMESPACE"
  fi

  secret_names="$("${KCTL[@]}" get secrets -n "$NAMESPACE" -l paperclip.io/secret-scope=agent-session -o name 2>/dev/null || true)"
  if [[ -n "$secret_names" ]]; then
    bad_found=0
    while IFS= read -r sname; do
      [[ -z "$sname" ]] && continue
      keys="$("${KCTL[@]}" get "$sname" -n "$NAMESPACE" -o jsonpath='{range $k,$v := .data}{$k}{"\n"}{end}' 2>/dev/null || true)"
      if echo "$keys" | grep -Eiq '(^ANTHROPIC_API_KEY$|^OPENAI_API_KEY$|^GOOGLE_API_KEY$|^GEMINI_API_KEY$|^OPENROUTER_API_KEY$|^AWS_ACCESS_KEY_ID$|^AWS_SECRET_ACCESS_KEY$|^AWS_SESSION_TOKEN$|_API_KEY$|_ACCESS_TOKEN$|_SECRET_KEY$|^PROXY_SESSION_TOKEN$)'; then
        fail "Forbidden credential key detected in $NAMESPACE/$sname"
        bad_found=1
      fi
    done <<< "$secret_names"
    if [[ "$bad_found" -eq 0 ]]; then
      pass "Zero-credential audit passed for agent-session Secrets in $NAMESPACE"
    fi
  else
    warn "No active agent-session Secrets in $NAMESPACE to audit right now"
  fi
else
  warn "Tenant namespace $NAMESPACE does not exist yet (will be provisioned on first acquireLease)"
fi

echo "=== 4. Control-Plane Internal Gateway AuthZ Checks ==="
if [[ -n "$CONTROL_PLANE_URL" ]]; then
  unauth_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -d '{"runId":"smoke","runGeneration":1,"agentId":"a1","requestedModel":"gpt-5.4","wireApi":"responses","clientRequestId":"c1"}' \
    "${CONTROL_PLANE_URL}/internal/runner/v1/gateway-authorize" || echo "000")"
  if [[ "$unauth_code" == "401" || "$unauth_code" == "503" ]]; then
    pass "Control-plane gateway-authorize fails closed without valid internal token (HTTP $unauth_code)"
  else
    fail "Expected 401 or 503 on unauthenticated gateway-authorize, got HTTP $unauth_code"
  fi

  if [[ -n "${DELEGRA_GATEWAY_INTERNAL_TOKEN:-}" ]]; then
    rec_code="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${DELEGRA_GATEWAY_INTERNAL_TOKEN}" \
      "${CONTROL_PLANE_URL}/internal/runner/v1/gateway-reconcile" || echo "000")"
    if [[ "$rec_code" == "200" ]]; then
      pass "Control-plane gateway-reconcile authenticated successfully (HTTP 200)"
    else
      fail "Control-plane gateway-reconcile failed with HTTP $rec_code"
    fi
  else
    warn "DELEGRA_GATEWAY_INTERNAL_TOKEN unset; skipping authenticated reconcile check"
  fi
else
  warn "--control-plane-url not provided; skipping control-plane HTTP checks"
fi

echo "=== 5. Cluster delegra-gateway-proxy Checks ==="
if [[ -n "$PROXY_URL" ]]; then
  hz_code="$(curl -sS -o /dev/null -w '%{http_code}' "${PROXY_URL}/healthz" || echo "000")"
  if [[ "$hz_code" == "200" ]]; then
    pass "delegra-gateway-proxy /healthz healthy (HTTP 200)"
  else
    fail "delegra-gateway-proxy /healthz returned HTTP $hz_code"
  fi

  disallowed_code="$(curl -sS -o /dev/null -w '%{http_code}' "${PROXY_URL}/v1/models" || echo "000")"
  if [[ "$disallowed_code" == "404" ]]; then
    pass "delegra-gateway-proxy rejects non-allowlisted path /v1/models (HTTP 404)"
  else
    fail "delegra-gateway-proxy expected 404 for /v1/models, got HTTP $disallowed_code"
  fi

  unauth_proxy_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -d '{"model":"gpt-5.4"}' \
    "${PROXY_URL}/v1/responses" || echo "000")"
  if [[ "$unauth_proxy_code" == "401" ]]; then
    pass "delegra-gateway-proxy rejects unauthenticated POST /v1/responses (HTTP 401)"
  else
    fail "delegra-gateway-proxy expected 401 on unauthenticated POST /v1/responses, got HTTP $unauth_proxy_code"
  fi
else
  warn "--proxy-url not provided; skipping delegra-gateway-proxy HTTP checks"
fi

echo "=== 6. v1beta1 SandboxClaim One-Way Lifecycle Smoke ==="
if [[ "$RUN_CLAIM_SMOKE" -eq 1 ]]; then
  claim_name="pc-e2e-smoke-$(date +%s)"
  shutdown_time="$(date -u -v+5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)"
  cat <<EOF | "${KCTL[@]}" apply -f -
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: ${claim_name}
  namespace: ${NAMESPACE}
  labels:
    paperclip.io/managed-by: paperclip-k8s-plugin
    paperclip.io/run-id: ${claim_name}
    paperclip.io/run-generation: "1"
spec:
  warmPoolRef:
    name: ${WARM_POOL_NAME}
  lifecycle:
    shutdownTime: "${shutdown_time}"
    shutdownPolicy: DeleteForeground
EOF
  if "${KCTL[@]}" wait --for=condition=Ready "sandboxclaim.extensions.agents.x-k8s.io/${claim_name}" -n "$NAMESPACE" --timeout=30s; then
    sandbox_name="$("${KCTL[@]}" get "sandboxclaim.extensions.agents.x-k8s.io/${claim_name}" -n "$NAMESPACE" -o jsonpath='{.status.sandbox.name}')"
    pass "SandboxClaim ${claim_name} bound to Sandbox ${sandbox_name}"
    "${KCTL[@]}" delete "sandboxclaim.extensions.agents.x-k8s.io/${claim_name}" -n "$NAMESPACE" --wait=true --timeout=30s
    pass "One-way teardown deleted SandboxClaim ${claim_name}"
  else
    fail "SandboxClaim ${claim_name} did not become Ready within 30s"
    "${KCTL[@]}" delete "sandboxclaim.extensions.agents.x-k8s.io/${claim_name}" -n "$NAMESPACE" --ignore-not-found=true >/dev/null 2>&1 || true
  fi
else
  warn "Skipped live SandboxClaim creation (pass --run-claim-smoke to execute)"
fi

echo "=== Summary: PASS=${PASS_COUNT} WARN=${WARN_COUNT} FAIL=${FAIL_COUNT} ==="
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
