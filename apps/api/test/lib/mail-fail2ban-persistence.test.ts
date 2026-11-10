import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MAIL_CONTAINER_MOUNTS } from "../../../../packages/adapters/src/infra/mail-container";

/**
 * The two artifacts behind issue #1701 have to agree: the mount table
 * (TypeScript) and the entrypoint that runs inside the engine on every boot.
 * The /var/log mount hides the /var/log/clamav dir the Dockerfile created at
 * build time, so the entrypoint must recreate it; and the operator fail2ban
 * overrides mount is only a staging dir — the entrypoint has to copy its
 * *.local files into /etc/fail2ban/jail.d/ for fail2ban to read them.
 *
 * The mount table is imported by relative path (not @repo/adapters) on
 * purpose: this pins the contract between the two artifacts without dragging
 * in the whole adapters package graph.
 */

const EMAIL_DIR = join(import.meta.dirname, "../../../../apps/email");
const read = (p: string) => readFileSync(join(EMAIL_DIR, p), "utf8");

const ENTRYPOINT = read("docker/entrypoint.sh");

/** The staging dir the entrypoint copies operator overrides from. */
function stagingDir(): string {
  const mount = MAIL_CONTAINER_MOUNTS.find((m) => m.host.endsWith("/config/fail2ban"));
  if (!mount) throw new Error("no fail2ban overrides mount in MAIL_CONTAINER_MOUNTS");
  return mount.container;
}

describe("fail2ban operator overrides survive an engine recreate (#1701)", () => {
  it("copies *.local overrides from the persisted staging dir into jail.d on every boot", () => {
    const dir = stagingDir();
    expect(ENTRYPOINT).toContain(`${dir}/*.local`);
    expect(ENTRYPOINT).toContain("/etc/fail2ban/jail.d/");
  });

  it("recreates /var/log/clamav on the logs mount (the mount hides the image's)", () => {
    // clamd logs to /var/log/clamav (CLAMD_LOG_DIR); the Dockerfile creates
    // it at build, but the /var/log bind mount hides it on a fresh host dir.
    expect(ENTRYPOINT).toMatch(/mkdir -p[^\n]*\/var\/log\/clamav/);
    expect(ENTRYPOINT).toMatch(/chown[^#\n]*clamav:clamav \/var\/log\/clamav/);
  });

  it("never references a host path — the entrypoint only ever sees container paths", () => {
    expect(ENTRYPOINT).not.toContain("/var/lib/openship/mail");
  });
});
