import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { auditContextFrom } from "./audit";
import {
  internalClientHeader,
  internalSourceHeader,
  resolveCallClientId,
  resolveCallSource,
} from "./call-source";
import type { RequestContext } from "./request-context";

function fakeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: "user_1",
    user: { id: "user_1", email: "a@example.com", name: null },
    organizationId: "org_1",
    role: "member",
    membershipId: "mem_1",
    sessionId: "sess_1",
    sessionKind: "cookie",
    principalKind: null,
    tokenScope: null,
    credential: null,
    scopeMode: "resource",
    clientIp: "127.0.0.1",
    userAgent: "test",
    traceId: "trace_1",
    ...overrides,
  } as RequestContext;
}

const patCtx = () =>
  fakeCtx({
    sessionId: "pat:tok_123",
    sessionKind: "bearer",
    principalKind: "pat",
  });

function probeApp(ctx: RequestContext) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ctx" as never, ctx);
    await next();
  });
  app.get("/probe", (c) =>
    c.json({
      clientId: resolveCallClientId(c),
      source: resolveCallSource(c),
      audit: auditContextFrom(c, "org_1", ctx.userId),
    }),
  );
  return app;
}

async function probe(
  ctx: RequestContext,
  headers: Record<string, string> = {},
) {
  const res = await probeApp(ctx).request("/probe", { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    clientId: string | null;
    source: string;
    audit: { sourceClientId: string | null; source: string | null };
  };
}

describe("resolveCallClientId", () => {
  it("attributes a PAT-authenticated REST call to its token when no dispatcher claim exists", async () => {
    const body = await probe(patCtx());
    expect(body.clientId).toBe("pat:tok_123");
  });

  it("a forged client header cannot suppress PAT attribution", async () => {
    const body = await probe(patCtx(), {
      "x-openship-call-client": "pat:tok_999.deadbeefdeadbeefdeadbeefdeadbeef",
    });
    expect(body.clientId).toBe("pat:tok_123");
  });

  it("a nonce-signed dispatcher claim still wins over the credential", async () => {
    const body = await probe(patCtx(), {
      ...internalClientHeader("oauth:client9"),
    });
    expect(body.clientId).toBe("oauth:client9");
  });

  it("stays null for a browser session with no dispatcher claim", async () => {
    const body = await probe(fakeCtx());
    expect(body.clientId).toBeNull();
  });

  it("stays null for an OAuth principal with no dispatcher claim", async () => {
    const body = await probe(
      fakeCtx({
        sessionId: "oauth:client1",
        sessionKind: "bearer",
        principalKind: "oauth",
      }),
    );
    expect(body.clientId).toBeNull();
  });

  it("stays null when the PAT session id is not a well-formed principal id", async () => {
    const body = await probe(
      fakeCtx({
        sessionId: "not-a-principal-id",
        sessionKind: "bearer",
        principalKind: "pat",
      }),
    );
    expect(body.clientId).toBeNull();
  });
});

describe("auditContextFrom", () => {
  it("carries the PAT id on the audit row for a REST call", async () => {
    const body = await probe(patCtx());
    expect(body.audit.sourceClientId).toBe("pat:tok_123");
  });

  it("leaves the audit row unattributed for a browser session", async () => {
    const body = await probe(fakeCtx());
    expect(body.audit.sourceClientId).toBeNull();
  });
});

describe("resolveCallSource", () => {
  it("still derives api for a PAT call and cli for the CLI user agent", async () => {
    expect((await probe(patCtx())).source).toBe("api");
    const cli = await probeApp(patCtx()).request("/probe", {
      headers: { "user-agent": "openship-cli/1.0" },
    });
    expect(((await cli.json()) as { source: string }).source).toBe("cli");
  });

  it("still trusts the nonce-signed MCP claim over the credential", async () => {
    const body = await probe(patCtx(), {
      ...internalSourceHeader("mcp"),
      ...internalClientHeader("pat:tok_123"),
    });
    expect(body.source).toBe("mcp");
    expect(body.clientId).toBe("pat:tok_123");
  });
});
