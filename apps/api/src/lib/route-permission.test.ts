import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { internalClientHeader, internalSourceHeader } from "./call-source";
import type { RequestContext } from "./request-context";

const h = vi.hoisted(() => ({ recordAsync: vi.fn() }));

vi.mock("./permission", () => ({
  permission: {
    assert: vi.fn(async () => {}),
    resolveRequestScopeOrg: vi.fn(() => "org_1"),
  },
  ORG_SINGLETON_RESOURCES: new Set<string>(),
  // Tag validity is the real permission module's job, not this suite's;
  // accept every resource so requirePermission reaches the emitter.
  isCheckedResourceType: () => true,
}));

vi.mock("./audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit")>();
  return { ...actual, audit: { ...actual.audit, recordAsync: h.recordAsync } };
});

import { requirePermission } from "./route-permission";

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
    sessionId: "pat:tok_1",
    sessionKind: "bearer",
    principalKind: "pat",
  });

function buildApp(ctx: RequestContext) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ctx" as never, ctx);
    await next();
  });
  app.get("/projects/:id", requirePermission({ tag: "project:read" }), (c) =>
    c.req.query("fail") ? c.json({ error: "nope" }, 400) : c.json({ ok: true }),
  );
  app.patch("/projects/:id", requirePermission({ tag: "project:write" }), (c) =>
    c.json({ ok: true }),
  );
  return app;
}

describe("route auto-emitter: PAT reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("audits a successful PAT read, attributed to the token", async () => {
    const res = await buildApp(patCtx()).request("/projects/proj_1");
    expect(res.status).toBe(200);
    expect(h.recordAsync).toHaveBeenCalledTimes(1);
    const [ctx, event] = h.recordAsync.mock.calls[0] as [
      { sourceClientId: string | null; source: string | null },
      {
        eventType: string;
        resourceType: string | null;
        resourceId: string | null;
      },
    ];
    expect(ctx.sourceClientId).toBe("pat:tok_1");
    expect(ctx.source).toBe("api");
    expect(event.eventType).toBe("project:read");
    expect(event.resourceType).toBe("project");
    expect(event.resourceId).toBe("proj_1");
  });

  it("does not audit a browser read", async () => {
    const res = await buildApp(fakeCtx()).request("/projects/proj_1");
    expect(res.status).toBe(200);
    expect(h.recordAsync).not.toHaveBeenCalled();
  });

  it("does not audit a failed PAT read", async () => {
    const res = await buildApp(patCtx()).request("/projects/proj_1?fail=1");
    expect(res.status).toBe(400);
    expect(h.recordAsync).not.toHaveBeenCalled();
  });

  it("does not double-audit an MCP-dispatched read (mcp-audit owns it)", async () => {
    const res = await buildApp(patCtx()).request("/projects/proj_1", {
      headers: {
        ...internalSourceHeader("mcp"),
        ...internalClientHeader("pat:tok_1"),
      },
    });
    expect(res.status).toBe(200);
    expect(h.recordAsync).not.toHaveBeenCalled();
  });

  it("still audits a PAT write exactly once", async () => {
    const res = await buildApp(patCtx()).request("/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(h.recordAsync).toHaveBeenCalledTimes(1);
    const [ctx] = h.recordAsync.mock.calls[0] as [
      { sourceClientId: string | null },
      unknown,
    ];
    expect(ctx.sourceClientId).toBe("pat:tok_1");
  });
});
