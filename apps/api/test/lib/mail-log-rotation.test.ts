import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persisting the mail logs on a host bind mount (issue #1701) trades one failure
 * for another if nothing ever rotates them: before, a recreate wiped the logs
 * (accidentally bounding their growth); after, they grow on the host until the
 * disk fills. The rotation half of the fix is three artifacts that have to agree:
 *
 *   - the image installs the `logrotate` binary (the iRedMail installer lays down
 *     /etc/logrotate.d configs for dovecot, iredapd, fail2ban, and the maillog, but
 *     nothing in the image runs them);
 *   - supervisord runs `cron -f`, so the logrotate package's /etc/cron.daily job
 *     actually fires (cron is installed in the image but no daemon ever ran it);
 *   - the entrypoint pre-creates every log directory the daemons write to, because
 *     the new /var/log bind mount hides the ones the Dockerfile created at build
 *     time (notably /var/log/clamav, freshclam's log dir).
 */

const EMAIL_DIR = join(import.meta.dirname, "../../../../apps/email");
const read = (p: string) => readFileSync(join(EMAIL_DIR, p), "utf8");

const ENTRYPOINT = read("docker/entrypoint.sh");
const SUPERVISORD = read("docker/supervisord.conf");
const DOCKERFILE = read("Dockerfile");

/** One `[program:x]` block, up to the next section. */
function programBlock(name: string): string {
  const block = SUPERVISORD.split(/^\[/m).find((b) => b.startsWith(`program:${name}]`));
  if (!block) throw new Error(`no [program:${name}] in supervisord.conf`);
  return block;
}

describe("mail log rotation", () => {
  it("runs cron so the installed logrotate configs actually fire", () => {
    const cron = programBlock("cron");
    expect(cron).toContain("command=/usr/sbin/cron -f");
    // A dead cron must come back on its own — nothing else restarts it.
    expect(cron).toMatch(/^autorestart=true$/m);
  });

  it("installs the logrotate binary and gates the build on it being there", () => {
    // The installer writes /etc/logrotate.d configs, not the binary: without this
    // the cron job above is a silent no-op and the persisted logs grow forever.
    expect(DOCKERFILE).toMatch(/apt-get install -y --no-install-recommends[\s\S]*?logrotate/m);
    expect(DOCKERFILE).toContain("command -v logrotate");
  });

  it("pre-creates freshclam's log directory on the mounted /var/log", () => {
    // The Dockerfile creates /var/log/clamav at build; the /var/log bind mount
    // hides it at runtime, and freshclam has nowhere to write its log. The mkdir
    // shares one line with the other log dirs, so match the command, not the path
    // alone (the comment above it mentions the path too).
    expect(ENTRYPOINT).toMatch(/^mkdir -p .*\/var\/log\/clamav$/m);
  });

  it("hands freshclam's log directory to the clamav user", () => {
    // freshclam drops to the clamav user (freshclam.conf DatabaseOwner) and
    // writes its update log to /var/log/clamav/freshclam.log. The /var/log
    // bind mount hides the clamav-owned dir the installer created at build,
    // and the mkdir above only recreates it root-owned — on a fresh host logs
    // dir freshclam could not write its log. The entrypoint already chowns
    // /var/lib/clamav on every boot for the same reason; the log dir needs
    // the same treatment.
    expect(ENTRYPOINT).toMatch(/^ *chown clamav:clamav \/var\/log\/clamav/m);
  });
});
