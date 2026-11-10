import { afterEach, describe, expect, it } from "vitest";

import {
  MAIL_CONTAINER_MOUNTS,
  MAIL_HOST_STATE_DIR,
  MAIL_DB_DEFAULT_PORT,
  MAIL_DB_FALLBACK_PORT,
  MAIL_DB_PORT_RANGE_MAX,
  MAIL_DB_INTERNAL_PORT,
  resolveMailDbPort,
} from "./mail-container";

const originalEnv = process.env.OPENSHIP_MAIL_DB_PORT;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.OPENSHIP_MAIL_DB_PORT;
  } else {
    process.env.OPENSHIP_MAIL_DB_PORT = originalEnv;
  }
});

describe("resolveMailDbPort", () => {
  it("defaults to 5432 when no argument or env var is present", () => {
    delete process.env.OPENSHIP_MAIL_DB_PORT;
    expect(resolveMailDbPort()).toBe(5432);
    expect(resolveMailDbPort(undefined)).toBe(5432);
    expect(resolveMailDbPort("")).toBe(5432);
  });

  it("reads from OPENSHIP_MAIL_DB_PORT environment variable", () => {
    process.env.OPENSHIP_MAIL_DB_PORT = "5433";
    expect(resolveMailDbPort()).toBe(5433);
  });

  it("parses valid port numbers and strings", () => {
    expect(resolveMailDbPort("5433")).toBe(5433);
    expect(resolveMailDbPort(" 5434 ")).toBe(5434);
    expect(resolveMailDbPort(5435)).toBe(5435);
    expect(resolveMailDbPort(1)).toBe(1);
    expect(resolveMailDbPort(65535)).toBe(65535);
  });

  it.each(["0", "-1", "65536", "not-a-port", "5432.5", "0x1538", "5e3", " "])(
    "refuses an invalid explicit port %s",
    (value) => expect(() => resolveMailDbPort(value)).toThrow(/between 1 and 65535/),
  );

  it("exports matching internal and default port constants", () => {
    expect(MAIL_DB_DEFAULT_PORT).toBe(5432);
    expect(MAIL_DB_INTERNAL_PORT).toBe(5432);
    expect(MAIL_DB_FALLBACK_PORT).toBe(5433);
    expect(MAIL_DB_PORT_RANGE_MAX).toBe(5460);
  });
});

/**
 * Mail state survives an engine recreate (issue #1701). An update runs
 * `docker rm -f` + `docker run`, so only bind mounts survive — and the
 * Dockerfile's claim that "all mutable state is on host bind mounts" was
 * false for the mail logs, fail2ban's own ban database, and operator
 * fail2ban customisations (ignoreip). Each of those gets a mount here.
 */
describe("mail state survives an engine recreate", () => {
  const byContainer = new Map(MAIL_CONTAINER_MOUNTS.map((m) => [m.container, m]));

  it("bind-mounts /var/log on the host so an update keeps the mail logs", () => {
    const mount = byContainer.get("/var/log");
    expect(mount).toBeDefined();
    expect(mount?.host.startsWith(`${MAIL_HOST_STATE_DIR}/`)).toBe(true);
    expect(mount?.readonly).not.toBe(true);
    // Pure data — rsyslog creates the files; nothing to seed from the image.
    expect(mount?.seed).not.toBe(true);
  });

  it("bind-mounts /var/lib/fail2ban on the host so the ban database survives", () => {
    const mount = byContainer.get("/var/lib/fail2ban");
    expect(mount).toBeDefined();
    expect(mount?.host.startsWith(`${MAIL_HOST_STATE_DIR}/`)).toBe(true);
    expect(mount?.readonly).not.toBe(true);
    // Pure data — fail2ban creates its sqlite database on first start.
    expect(mount?.seed).not.toBe(true);
  });

  it("bind-mounts an operator fail2ban overrides dir the entrypoint copies in", () => {
    const mount = byContainer.get("/var/lib/openship/fail2ban-custom");
    expect(mount).toBeDefined();
    expect(mount?.host).toBe(`${MAIL_HOST_STATE_DIR}/config/fail2ban`);
    expect(mount?.readonly).not.toBe(true);
    // Deliberately unseeded: it starts empty by design (no operator
    // customisations yet) and must never be seeded from the image.
    expect(mount?.seed).not.toBe(true);
  });

  it("never bind-mounts /etc/fail2ban itself", () => {
    // The entrypoint rewrites /etc/fail2ban on every boot; a seed-once mount
    // would hide later image changes — the same trap as master.cf (#392).
    // Operator customisations live in the staging mount above instead.
    expect(byContainer.has("/etc/fail2ban")).toBe(false);
  });

  it("keeps every mount's host side under the mail state dir, except the shared cert store", () => {
    for (const m of MAIL_CONTAINER_MOUNTS) {
      if (m.container === "/etc/letsencrypt") continue; // shared, read-only
      expect(m.host.startsWith(`${MAIL_HOST_STATE_DIR}/`)).toBe(true);
    }
  });

  it("mounts each container path at most once", () => {
    const paths = MAIL_CONTAINER_MOUNTS.map((m) => m.container);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
