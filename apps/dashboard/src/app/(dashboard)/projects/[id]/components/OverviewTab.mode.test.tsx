// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { OverviewTab } from "./OverviewTab";

const h = vi.hoisted(() => ({
  project: {} as Record<string, unknown>,
  servicesLoading: false,
}));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    projectData: h.project,
    buildData: {},
    id: "project-one",
    setActiveTab: vi.fn(),
    servicesData: { isLoading: h.servicesLoading, services: [] },
    selectedDomain: "",
    domain: "",
    domainsData: { domains: [] },
  }),
}));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  useProjectInfo: () => ({ isLoading: false }),
  useAnalyticsData: () => ({ data: null, isLoadingSummary: false, isLoadingPeriods: false }),
}));
vi.mock("@/lib/api/apps", () => ({ appsApi: { getConnection: vi.fn() } }));
vi.mock("@/hooks/useLocalhostForward", () => ({
  useLocalhostForward: () => ({ canForward: false }),
}));
vi.mock("./ConnectedServicesCard", () => ({ ConnectedServicesCard: () => null }));
vi.mock("./UsedByCard", () => ({ UsedByCard: () => null }));

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <OverviewTab />
      </I18nProvider>,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  // The record from #1670: a Compose import (11 services, runtimeMode docker)
  // whose workload resolves to static — no workloadType, framework unknown,
  // productionMode saved as static.
  h.project = {
    id: "project-one",
    name: "Compose stack",
    slug: "compose-stack",
    isApp: false,
    framework: "unknown",
    projectType: "services",
    serviceCount: 11,
    hasServer: false,
    productionMode: "static",
    deployTarget: "server",
    serverId: "server-one",
  };
  h.servicesLoading = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("overview mode label", () => {
  it("labels a Compose services project as a Compose stack, not a Static Site", async () => {
    await render();
    expect(container.textContent).toContain("Compose stack");
    expect(container.textContent).toContain("11 services");
    expect(container.textContent).not.toContain("Static Site");
  });

  it("uses the singular form for a one-service Compose stack", async () => {
    h.project.serviceCount = 1;
    await render();
    expect(container.textContent).toContain("Compose stack");
    expect(container.textContent).toContain("1 service");
    expect(container.textContent).not.toContain("1 services");
  });

  it("keeps the Static Site label for a plain static project", async () => {
    h.project.projectType = "app";
    h.project.serviceCount = 0;
    await render();
    expect(container.textContent).toContain("Static Site");
    expect(container.textContent).not.toContain("Compose stack");
  });
});
