// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DEFAULT_CONFIG } from "@/context/deployment/types";
import DeployRepository from "./page";

const h = vi.hoisted(() => ({
    initialize: vi.fn(),
    rescanBranch: vi.fn(),
    toast: vi.fn(),
    selection: null as any,
}));
vi.mock("next/navigation", () => ({
    useParams: () => ({ slug: "repository" }),
    useSearchParams: () => new URLSearchParams("branch=feature&projectId=draft"),
    useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/utils/repoSlug", () => ({
    decodeSlug: () => ({ kind: "repo", owner: "acme", repo: "private", branch: "main" }),
}));
vi.mock("@/context/DeploymentContext", () => ({
    useDeployment: () => {
        const [config, setConfig] = useState({ ...DEFAULT_CONFIG, owner: "acme", repo: "private", branch: "feature" });
        return {
            config,
            state: {},
            isRescanning: false,
            updateConfig: (next: object) => setConfig((previous) => ({ ...previous, ...next })),
            initializeFromRepo: h.initialize,
            rescanWithBranch: async (branch: string) => {
                h.rescanBranch(branch);
                setConfig((previous) => ({ ...previous, branch }));
                return { success: true };
            },
        };
    },
}));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/DeployTargetStep", () => ({
    default: () => null,
    DeployTargetSummary: () => null,
}));
vi.mock("./components/ServerRuntimePicker", () => ({ useServerRuntimeSelection: () => ({}) }));
vi.mock("./components/SkeletonLoader", () => ({ default: () => <div>Loading</div> }));
vi.mock("@/components/import-project/ProjectSettings", () => ({
    default: () => <div>Project configuration</div>,
}));
vi.mock("@/components/import-project/BuildSettings", () => ({ default: () => null }));
vi.mock("@/components/import-project/DockerSettings", () => ({ default: () => null }));
vi.mock("@/components/import-project/ComposeServices", () => ({ default: () => null }));
vi.mock("@/components/github/RepositoryBranchSelect", () => ({
    RepositoryBranchSelect: ({ value, onChange }: any) => (
        <button onClick={() => onChange("other-branch")}>Pick branch (current {value})</button>
    ),
}));
vi.mock("@/components/import-project/ComposePathField", () => ({
    ComposePathField: ({ onSuccess }: any) => (
        <button onClick={() => onSuccess?.()}>Apply compose path</button>
    ),
}));
vi.mock("@/components/import-project/ConfigDiagnostics", () => ({
    ConfigDiagnostics: () => <div>Diagnostics</div>,
}));
vi.mock("@/components/import-project/EnvironmentVariables", () => ({ default: () => null }));
vi.mock("@/components/import-project/MonorepoApps", () => ({ default: () => null }));
vi.mock("@/components/import-project/RoutingSection", () => ({ default: () => null }));
vi.mock("@/components/project-settings/ReadinessSection", () => ({ default: () => null }));
vi.mock("@/components/actions/DeployActions", () => ({ DeployActions: () => null }));
vi.mock("@/components/import-project/DeployGitHubChecks", () => ({
    DeployGitHubChecks: () => null,
}));
vi.mock("@/components/shared/ServerSelector", () => ({
    useServerSelection: (props: any) => {
        h.selection = props;
        return {
            ready: !!props.value,
            select: () => props.onSelect({ id: "working-server", name: "Working server", raw: {} }),
        };
    },
    ServerSelectorView: () => null,
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    h.initialize.mockResolvedValue({
        success: false,
        error: "Repository could not be read",
        errorType: "api_error",
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

it("shows the steering controls inline instead of a full-page error when the first scan fails", async () => {
    await act(async () => root.render(<DeployRepository />));
    // The scan failed, but the wizard can still be steered: the branch picker,
    // compose-path field and diagnostics render next to the error, and the
    // wizard itself stays hidden until a rescan succeeds.
    expect(host.textContent).toContain("Repository could not be read");
    expect(host.textContent).toContain("Pick branch (current feature)");
    expect(host.textContent).toContain("Apply compose path");
    expect(host.textContent).toContain("Diagnostics");
    expect(host.textContent).not.toContain("Project configuration");
});

it("a branch rescan success clears the error and shows the wizard", async () => {
    await act(async () => root.render(<DeployRepository />));
    await act(async () => {
        [...host.querySelectorAll("button")]
            .find((button) => button.textContent?.startsWith("Pick branch"))!
            .click();
        // The branch change re-scans asynchronously; let it finish inside act.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.rescanBranch).toHaveBeenCalledWith("other-branch");
    expect(host.textContent).toContain("Project configuration");
});

it("a compose-path apply success clears the error and shows the wizard", async () => {
    await act(async () => root.render(<DeployRepository />));
    await act(async () =>
        [...host.querySelectorAll("button")]
            .find((button) => button.textContent === "Apply compose path")!
            .click(),
    );
    expect(host.textContent).toContain("Project configuration");
});

it("retry re-runs the first scan and shows the wizard on success", async () => {
    await act(async () => root.render(<DeployRepository />));
    h.initialize.mockResolvedValueOnce({ success: true });
    const retry = () =>
        [...host.querySelectorAll("button")].find(
            (button) => button.textContent === baseDictionary.billing.plansRoute.tryAgain,
        )!;
    await act(async () => retry().click());
    expect(h.initialize).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Project configuration");
});
