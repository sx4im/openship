import { beforeEach, describe, expect, it, vi } from "vitest";

const assertPermission = vi.fn(async () => {});
const recordAsync = vi.fn();

vi.mock("../../src/lib/permission", async () => ({
  permission: {
    assert: assertPermission,
    resolveRequestScopeOrg: vi.fn(() => "org-1"),
  },
  ORG_SINGLETON_RESOURCES: new Set<string>(),
  isCheckedResourceType: (await import("@repo/platform")).isCheckedResourceType,
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("../../src/lib/audit", () => ({
  audit: { recordAsync },
  auditContextFrom: vi.fn(() => ({})),
}));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  canUseGitHubRepo: vi.fn(async () => false),
  checkSourceTier: vi.fn(async () => ({ ok: false, readPaths: [] })),
}));

const { requirePermission } = await import("../../src/lib/route-permission");

/**
 * The route emitter decides whether a handled request leaves an audit row.
 * Writes always do; reads do only when the caller is a token principal — for
 * a script holding a PAT, "what did it look at" is the whole question, the
 * same reason MCP tool calls audit their reads (mcp-audit.ts). Browser reads
 * stay unaudited: the dashboard's own activity would drown the log. See #1703.
 */
function context(
  params: Record<string, string | undefined>,
  principalKind: string | null,
  status = 200,
) {
  const values = new Map<string, unknown>([
    ["ctx", { userId: "user-1", principalKind }],
    ["scopedOrganizationId", "org-1"],
  ]);
  return {
    req: {
      param: vi.fn((name: string) => params[name]),
      query: vi.fn(() => undefined),
    },
    get: vi.fn((name: string) => values.get(name)),
    set: vi.fn((name: string, value: unknown) => values.set(name, value)),
    json: vi.fn((body: unknown, s: number) => ({ body, status: s })),
    res: { status },
  };
}

describe("the route audit emitter", () => {
  beforeEach(() => {
    assertPermission.mockClear();
    recordAsync.mockClear();
  });

  it("audits a successful read made with a PAT", async () => {
    const c = context({ id: "project-1" }, "pat");
    await requirePermission({ tag: "project:read" })(c as never, async () => {});
    expect(recordAsync).toHaveBeenCalledOnce();
    expect(recordAsync).toHaveBeenCalledWith(expect.anything(), {
      eventType: "project:read",
      resourceType: "project",
      resourceId: "project-1",
      after: null,
      before: null,
    });
  });

  it("audits a successful list made with an OAuth token", async () => {
    const c = context({}, "oauth");
    await requirePermission({ tag: "project:list" })(c as never, async () => {});
    expect(recordAsync).toHaveBeenCalledOnce();
    expect(recordAsync).toHaveBeenCalledWith(expect.anything(), {
      eventType: "project:list",
      resourceType: "project",
      resourceId: "*",
      after: null,
      before: null,
    });
  });

  it("does not audit a read made from a browser session", async () => {
    const c = context({ id: "project-1" }, null);
    await requirePermission({ tag: "project:read" })(c as never, async () => {});
    expect(recordAsync).not.toHaveBeenCalled();
  });

  it("still audits a write, whatever the caller", async () => {
    const c = context({ id: "project-1" }, null);
    await requirePermission({ tag: "project:write" })(c as never, async () => {});
    expect(recordAsync).toHaveBeenCalledOnce();
    expect(recordAsync).toHaveBeenCalledWith(expect.anything(), {
      eventType: "project:write",
      resourceType: "project",
      resourceId: "project-1",
      after: null,
      before: null,
    });
  });

  it("does not audit a token read that failed", async () => {
    const c = context({ id: "project-1" }, "pat", 404);
    await requirePermission({ tag: "project:read" })(c as never, async () => {});
    expect(recordAsync).not.toHaveBeenCalled();
  });

  it("does not audit a read of the audit log itself", async () => {
    // Reading the log must not write to the log: every listing would add a
    // row the next listing shows. The audit list/facets/settings GETs all
    // carry this tag.
    const c = context({}, "pat");
    await requirePermission({ tag: "audit:read" })(c as never, async () => {});
    expect(recordAsync).not.toHaveBeenCalled();
  });

  it("does not double-emit when the operation recorded the call itself", async () => {
    const c = context({ id: "project-1" }, "pat");
    const next = vi.fn(async () => {
      c.set("operationAuditRecorded", true);
    });
    await requirePermission({ tag: "project:read", auditHandledByOperation: true })(
      c as never,
      next,
    );
    expect(recordAsync).not.toHaveBeenCalled();
  });
});
