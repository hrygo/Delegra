import { generateKeyPairSync, sign as cryptoSign, type JsonWebKey, type KeyObject } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { employeeExpertsRoutes } from "../routes/employee-experts.js";
import {
  createEmployeeExpertsService,
  type EmployeeExpertRecord,
} from "../services/employee-experts.js";
import {
  ACCESS_TOKEN_TYPE,
  createEmployeeTokenExchangeService,
  EMPLOYEE_TOKEN_EXCHANGE_PATH,
  MAX_EXCHANGED_TOKEN_TTL_SECONDS,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from "../services/employee-token-exchange.js";

function b64url(value: string | Buffer): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

function signAsymmetricJwt(input: {
  alg: "RS256" | "ES256";
  kid: string;
  privateKey: KeyObject;
  claims: Record<string, unknown>;
}): string {
  const header = { alg: input.alg, typ: "JWT", kid: input.kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(input.claims))}`;
  const sig =
    input.alg === "RS256"
      ? cryptoSign("sha256", Buffer.from(signingInput, "utf8"), input.privateKey)
      : cryptoSign(
          "sha256",
          Buffer.from(signingInput, "utf8"),
          { key: input.privateKey, dsaEncoding: "ieee-p1363" },
        );
  return `${signingInput}.${b64url(sig)}`;
}

const SAMPLE_EXPERT: EmployeeExpertRecord = {
  expertId: "exp_fin_01",
  displayName: "经营分析专家",
  disambiguation: "财务经营分析组",
  summary: {
    disclosureState: "available",
    responsibility: "整理与解释获准访问的月度经营报表",
    capabilities: ["经营指标拆解"],
    toolScope: ["bi-report:read"],
    updatedAt: "2026-11-24T00:00:00Z",
  },
  access: {
    readable: true,
    callableInOrg: true,
    callableReason: "granted",
    authContinuityDigest: "sha256:9f86d081",
  },
  availability: {
    acceptingTasks: "accepting",
    reason: null,
  },
};

describe("RFC 8693 employee token exchange & production verifyCredential (CORP-DSH-EXPERT-001 §2.1–§2.3)", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsaJwk: JsonWebKey = { ...(rsa.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "iam-rsa-1" };
  const ecJwk: JsonWebKey = { ...(ec.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "iam-ec-1" };

  const ISSUER = "https://iam.corp.example";
  const IAM_AUDIENCE = "heluo-forge-iam";
  const INSTANCE_ID = "delegra-prod-cn-01";
  const RESOURCE_URL = "https://delegra.corp.example/api/v1/employee";

  function buildHarness(overrides?: {
    nowMs?: () => number;
    revokedSet?: Set<string>;
    memberships?: Record<string, string[]>;
  }) {
    let currentNow = overrides?.nowMs ? overrides.nowMs() : Date.parse("2026-11-25T08:00:00Z");
    const getNow = overrides?.nowMs ?? (() => currentNow);
    const revokedSet = overrides?.revokedSet ?? new Set<string>();
    const memberships = overrides?.memberships ?? { emp_10086: ["org_01", "org_02"] };

    const tokenExchange = createEmployeeTokenExchangeService({
      instanceId: INSTANCE_ID,
      signingSecret: "test-delegra-employee-master-secret-32-bytes",
      allowedIssuers: [ISSUER],
      expectedIamAudience: IAM_AUDIENCE,
      expectedTargetAudience: INSTANCE_ID,
      expectedResourceRoot: "/api/v1/employee",
      resolveJwks: async () => [rsaJwk, ecJwk],
      resolveEmployeeMembership: async ({ subject }) => ({
        activeOrgIds: memberships[subject] ?? [],
      }),
      isPrincipalRevoked: ({ subject }) => revokedSet.has(subject),
      now: getNow,
    });

    const employeeExperts = createEmployeeExpertsService({
      verifyCredential: tokenExchange.verifyCredential,
      listOrgExperts: async () => ({
        catalogVersion: "cv_20261125_01",
        completeness: "complete",
        items: [SAMPLE_EXPERT],
      }),
      now: getNow,
    });

    const app = express();
    app.use(express.json());
    app.use(employeeExpertsRoutes({ service: employeeExperts, tokenExchange }));

    return {
      app,
      tokenExchange,
      employeeExperts,
      revokedSet,
      memberships,
      advanceMs: (deltaMs: number) => {
        currentNow += deltaMs;
      },
      nowSec: () => Math.floor(getNow() / 1000),
    };
  }

  it("exchanges an RS256 IAM token via application/x-www-form-urlencoded and authenticates /api/v1/employee/experts", async () => {
    const h = buildHarness();
    const iamToken = signAsymmetricJwt({
      alg: "RS256",
      kid: "iam-rsa-1",
      privateKey: rsa.privateKey,
      claims: {
        iss: ISSUER,
        sub: "emp_10086",
        aud: IAM_AUDIENCE,
        org_id: "org_01",
        iat: h.nowSec() - 10,
        exp: h.nowSec() + 3600,
      },
    });

    const exchangeRes = await request(h.app)
      .post(EMPLOYEE_TOKEN_EXCHANGE_PATH)
      .type("form")
      .send({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: iamToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience: INSTANCE_ID,
        resource: RESOURCE_URL,
        scope: "employee:experts org:org_01",
      });

    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.headers["cache-control"]).toBe("no-store");
    expect(exchangeRes.body.token_type).toBe("Bearer");
    expect(exchangeRes.body.issued_token_type).toBe(ACCESS_TOKEN_TYPE);
    expect(exchangeRes.body.expires_in).toBe(MAX_EXCHANGED_TOKEN_TTL_SECONDS);
    expect(typeof exchangeRes.body.access_token).toBe("string");

    const catalogRes = await request(h.app)
      .get("/api/v1/employee/experts?orgId=org_01&view=directory")
      .set("Authorization", `Bearer ${exchangeRes.body.access_token}`);

    expect(catalogRes.status).toBe(200);
    expect(catalogRes.body.scope).toMatchObject({
      instanceId: INSTANCE_ID,
      orgId: "org_01",
      issuer: ISSUER,
      subject: "emp_10086",
    });
    expect(catalogRes.body.items).toHaveLength(1);
    expect(catalogRes.body.items[0].expertId).toBe("exp_fin_01");
  });

  it("caps expires_in to remaining IAM token TTL when shorter than 300s (ES256)", async () => {
    const h = buildHarness();
    const iamToken = signAsymmetricJwt({
      alg: "ES256",
      kid: "iam-ec-1",
      privateKey: ec.privateKey,
      claims: {
        iss: ISSUER,
        sub: "emp_10086",
        aud: IAM_AUDIENCE,
        org_id: "org_01",
        iat: h.nowSec() - 500,
        exp: h.nowSec() + 45,
      },
    });

    const exchangeRes = await request(h.app)
      .post(EMPLOYEE_TOKEN_EXCHANGE_PATH)
      .type("form")
      .send({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: iamToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience: INSTANCE_ID,
        resource: RESOURCE_URL,
      });

    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.body.expires_in).toBe(45);
    expect(exchangeRes.body.issued_token_type).toBe(ACCESS_TOKEN_TYPE);
  });

  it("enforces §2.1 error precedence: invalid signature -> revoked -> org forbidden -> scope mismatch", async () => {
    const h = buildHarness();
    const otherRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

    // 1. Invalid signature -> 401 EXPERT_AUTH_INVALID (and zero token leakage)
    const forgedIamToken = signAsymmetricJwt({
      alg: "RS256",
      kid: "iam-rsa-1",
      privateKey: otherRsa.privateKey,
      claims: {
        iss: ISSUER,
        sub: "emp_10086",
        aud: IAM_AUDIENCE,
        org_id: "org_01",
        iat: h.nowSec() - 10,
        exp: h.nowSec() + 600,
      },
    });
    const invalidSigRes = await request(h.app)
      .post(EMPLOYEE_TOKEN_EXCHANGE_PATH)
      .type("form")
      .send({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: forgedIamToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience: INSTANCE_ID,
        resource: RESOURCE_URL,
      });
    expect(invalidSigRes.status).toBe(401);
    expect(invalidSigRes.body.error.code).toBe("EXPERT_AUTH_INVALID");
    expect(JSON.stringify(invalidSigRes.body)).not.toContain(forgedIamToken);

    // 2. Non-member orgId -> 403 EXPERT_ORG_FORBIDDEN
    const validIamToken = signAsymmetricJwt({
      alg: "RS256",
      kid: "iam-rsa-1",
      privateKey: rsa.privateKey,
      claims: {
        iss: ISSUER,
        sub: "emp_10086",
        aud: IAM_AUDIENCE,
        org_id: "org_999",
        iat: h.nowSec() - 10,
        exp: h.nowSec() + 600,
      },
    });
    const nonMemberRes = await request(h.app)
      .post(EMPLOYEE_TOKEN_EXCHANGE_PATH)
      .type("form")
      .send({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: validIamToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience: INSTANCE_ID,
        resource: RESOURCE_URL,
      });
    expect(nonMemberRes.status).toBe(403);
    expect(nonMemberRes.body.error.code).toBe("EXPERT_ORG_FORBIDDEN");

    // 3. Valid exchange for org_01, then call API with org_02 (member of both) -> 403 EXPERT_SCOPE_MISMATCH
    const org01IamToken = signAsymmetricJwt({
      alg: "RS256",
      kid: "iam-rsa-1",
      privateKey: rsa.privateKey,
      claims: {
        iss: ISSUER,
        sub: "emp_10086",
        aud: IAM_AUDIENCE,
        org_id: "org_01",
        iat: h.nowSec() - 10,
        exp: h.nowSec() + 600,
      },
    });
    const okExchange = await request(h.app)
      .post(EMPLOYEE_TOKEN_EXCHANGE_PATH)
      .type("form")
      .send({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: org01IamToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience: INSTANCE_ID,
        resource: RESOURCE_URL,
      });
    expect(okExchange.status).toBe(200);
    const exchangedBearer = okExchange.body.access_token as string;

    const mismatchRes = await request(h.app)
      .get("/api/v1/employee/experts?orgId=org_02&view=directory")
      .set("Authorization", `Bearer ${exchangedBearer}`);
    expect(mismatchRes.status).toBe(403);
    expect(mismatchRes.body.error.code).toBe("EXPERT_SCOPE_MISMATCH");

    // 4. Call API with org_999 (not a member) -> 403 EXPERT_ORG_FORBIDDEN takes precedence over SCOPE_MISMATCH
    const forbiddenOrgRes = await request(h.app)
      .get("/api/v1/employee/experts?orgId=org_999&view=directory")
      .set("Authorization", `Bearer ${exchangedBearer}`);
    expect(forbiddenOrgRes.status).toBe(403);
    expect(forbiddenOrgRes.body.error.code).toBe("EXPERT_ORG_FORBIDDEN");
  });

  it("immediately rejects revoked IAM users on both new exchange and previously issued tokens, and expires after TTL", async () => {
    const h = buildHarness();
    const iamToken = signAsymmetricJwt({
      alg: "RS256",
      kid: "iam-rsa-1",
      privateKey: rsa.privateKey,
      claims: {
        iss: ISSUER,
        sub: "emp_10086",
        aud: IAM_AUDIENCE,
        org_id: "org_01",
        iat: h.nowSec() - 10,
        exp: h.nowSec() + 600,
      },
    });

    const okExchange = await request(h.app)
      .post(EMPLOYEE_TOKEN_EXCHANGE_PATH)
      .type("form")
      .send({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: iamToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience: INSTANCE_ID,
        resource: RESOURCE_URL,
      });
    expect(okExchange.status).toBe(200);
    const exchangedBearer = okExchange.body.access_token as string;

    // Revoke user
    h.revokedSet.add("emp_10086");

    const revokedExchangeRes = await request(h.app)
      .post(EMPLOYEE_TOKEN_EXCHANGE_PATH)
      .type("form")
      .send({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: iamToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience: INSTANCE_ID,
        resource: RESOURCE_URL,
      });
    expect(revokedExchangeRes.status).toBe(401);
    expect(revokedExchangeRes.body.error.code).toBe("EXPERT_AUTH_REVOKED");

    const revokedApiRes = await request(h.app)
      .get("/api/v1/employee/experts?orgId=org_01&view=directory")
      .set("Authorization", `Bearer ${exchangedBearer}`);
    expect(revokedApiRes.status).toBe(401);
    expect(revokedApiRes.body.error.code).toBe("EXPERT_AUTH_REVOKED");

    // Unrevoke and advance clock past 300s TTL -> expired token returns 401 EXPERT_AUTH_REVOKED
    h.revokedSet.delete("emp_10086");
    h.advanceMs(301_000);
    const expiredApiRes = await request(h.app)
      .get("/api/v1/employee/experts?orgId=org_01&view=directory")
      .set("Authorization", `Bearer ${exchangedBearer}`);
    expect(expiredApiRes.status).toBe(401);
    expect(expiredApiRes.body.error.code).toBe("EXPERT_AUTH_REVOKED");
  });
});
