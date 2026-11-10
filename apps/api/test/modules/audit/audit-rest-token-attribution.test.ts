/**
 * REST audit attribution for personal access tokens (#1703).
 *
 * Reproduces the issue end to end through the real auth + permission chain:
 * two tokens belonging to one user make the same write, then one of them makes
 * a read. Before the fix the two write rows are indistinguishable
 * (`sourceClientId` null on both) and the read leaves no row at all; after
 * the fix each row carries the `pat:<id>` of the token that made it.
 *
 * The probe routes are declared with secureRouter — the same wiring production
 * routes get (authMiddleware, then requirePermission, then the audit emitter)
 * — with stub handlers, so the only thing under test is the attribution and
 * emission, not any controller logic.
 */
import "./_env";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { repos } from "@repo/db";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { secureRouter } from "../../../src/lib/secure-router";
import { handleApiError } from "../../../src/middleware/error-handler";
import { listRaw, seedOwner, seedProject, type SeededOwner } from "./_harness";

const app = new Hono();
app.onError(handleApiError);
const probe = secureRouter(new Hono(), { module: "probe" });
probe.patch("/:id", { tag: "project:write" }, (c) => c.json({ ok: true }));
probe.get("/:id", { tag: "project:read" }, (c) => c.json({ ok: true }));
app.route("/api/projects", probe.hono);

interface MintedPat {
  token: string;
  auth: Record<string, string>;
  clientId: string;
}

async function mintPat(owner: SeededOwner, name: string): Promise<MintedPat> {
  const pat = mintPatToken();
  const row = await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: owner.orgId,
    name,
    tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash,
    readOnly: false,
    scoped: false,
    expiresAt: null,
  });
  return {
    token: pat.token,
    auth: { Authorization: `Bearer ${pat.token}` },
    clientId: `pat:${row.id}`,
  };
}

let owner: SeededOwner;
let projectId: string;
let tokenA: MintedPat;
let tokenB: MintedPat;

beforeAll(async () => {
  owner = await seedOwner("Ada Owner");
  projectId = await seedProject(owner.orgId, "api-gateway");
  tokenA = await mintPat(owner, "backup script");
  tokenB = await mintPat(owner, "deploy job");
});

describe("a PAT-authenticated REST call is attributed to its token", () => {
  it("two tokens' writes are distinguishable in the audit log", async () => {
    const first = await app.request(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: tokenA.auth,
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: tokenB.auth,
    });
    expect(second.status).toBe(200);

    await flushAudit();
    const writes = (await listRaw(owner.orgId)).filter((r) => r.eventType === "project:write");
    expect(writes).toHaveLength(2);
    expect(writes.map((r) => r.sourceClientId).sort()).toEqual(
      [tokenA.clientId, tokenB.clientId].sort(),
    );
    for (const row of writes) {
      expect(row.actorUserId).toBe(owner.userId);
      expect(row.source).toBe("api");
    }
  });

  it("a token's successful read leaves an audit row", async () => {
    const res = await app.request(`/api/projects/${projectId}`, {
      method: "GET",
      headers: tokenA.auth,
    });
    expect(res.status).toBe(200);

    await flushAudit();
    const reads = (await listRaw(owner.orgId)).filter((r) => r.eventType === "project:read");
    expect(reads).toHaveLength(1);
    expect(reads[0].sourceClientId).toBe(tokenA.clientId);
    expect(reads[0].actorUserId).toBe(owner.userId);
    expect(reads[0].source).toBe("api");
    expect(reads[0].resourceId).toBe(projectId);
  });
});
