import { afterEach, describe, expect, it, vi } from "vitest";

// Isolate the client from on-disk config: fixed base URL + token.
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok-123",
}));

import { deployCommand } from "../../src/commands/deploy";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

const GATE_BODY = {
  error:
    "The Compose configuration has changed. Review the latest services in Configure before deploying.",
  code: "COMPOSE_REVIEW_REQUIRED",
  projectId: "project-1",
  composeChanges: { added: ["worker"], changed: ["db"], removed: ["old-worker"] },
};

describe("openship deploy --accept-compose-changes", () => {
  it("sends acceptComposeChanges with the deployment request", async () => {
    fetchStub = stubFetch((req) => {
      expect(req.url).toBe("http://api.test/api/deployments");
      return {
        status: 202,
        json: { data: { deployment_id: "dep-1", project_id: "project-1" } },
      };
    });
    const result = await runCommand(deployCommand, [
      "--project",
      "project-1",
      "--accept-compose-changes",
    ]);
    expect(result.code).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].body).toMatchObject({
      projectId: "project-1",
      acceptComposeChanges: true,
    });
  });

  it("omits the flag by default, keeping the gate for ordinary deploys", async () => {
    fetchStub = stubFetch(() => ({
      status: 202,
      json: { data: { deployment_id: "dep-1", project_id: "project-1" } },
    }));
    const result = await runCommand(deployCommand, ["--project", "project-1"]);
    expect(result.code).toBe(0);
    expect(fetchStub.calls[0].body).not.toHaveProperty("acceptComposeChanges");
  });

  it("prints the pending Compose changes and the approval flag when the gate refuses", async () => {
    fetchStub = stubFetch(() => ({ status: 409, json: GATE_BODY }));
    const result = await runCommand(deployCommand, ["--project", "project-1"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("added: worker");
    expect(result.err).toContain("changed: db");
    expect(result.err).toContain("removed: old-worker");
    expect(result.err).toContain("--accept-compose-changes");
  });
});
