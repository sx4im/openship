// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DEFAULT_CONFIG } from "@/context/deployment/types";
import { ComposePathField } from "./ComposePathField";

const h = vi.hoisted(() => ({ rescan: vi.fn(), onSuccess: vi.fn() }));
vi.mock("@/context/DeploymentContext", () => ({
    useOptionalDeployment: () => ({
        config: { ...DEFAULT_CONFIG, composePath: "", projectType: "app" },
        isRescanning: false,
        rescanWithComposePath: h.rescan,
    }),
}));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    h.rescan.mockResolvedValue({ success: true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

async function applyPath(path: string) {
    await act(async () => root.render(<ComposePathField onSuccess={h.onSuccess} />));
    // The field starts collapsed when no path is pinned; open it first.
    await act(async () => {
        host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click();
    });
    await act(async () => {
        const input = host.querySelector<HTMLInputElement>("#deploy-compose-path")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, path);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
        [...host.querySelectorAll("button")]
            .find(
                (button) =>
                    button.textContent?.trim() ===
                    baseDictionary.importProject.buildSettings.composePath.apply,
            )!
            .click();
        // The apply re-scans asynchronously; let it finish inside act.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

it("calls onSuccess after a successful compose-path rescan", async () => {
    await applyPath("deploy/docker-compose.yml");
    expect(h.rescan).toHaveBeenCalledWith("deploy/docker-compose.yml");
    expect(h.onSuccess).toHaveBeenCalledTimes(1);
});

it("does not call onSuccess when the rescan fails", async () => {
    h.rescan.mockResolvedValue({ success: false, error: "Compose file not found" });
    await applyPath("deploy/missing.yml");
    expect(h.rescan).toHaveBeenCalledWith("deploy/missing.yml");
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Compose file not found");
});
