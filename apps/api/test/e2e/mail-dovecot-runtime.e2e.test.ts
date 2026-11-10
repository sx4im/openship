import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { shellQuote as sq } from "@repo/core";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUNNER = `openship-e2e-dovecot-${process.pid.toString(36)}`;
const WRAPPER = "bash /dovecot-start.sh -c /dovecot-test.conf";
// The production mail image uses Debian 12's Dovecot. Install those real
// collaborators without a full iRedMail build or a published Openship image.
// Plain auth without TLS keeps the fixture loopback-only (see below); the
// test asserts the IMAP greeting, not a login.
const CONFIG = `protocols = imap
listen = 127.0.0.1
base_dir = /var/run/dovecot
mail_location = maildir:/tmp/dovecot-test-mail
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain
passdb {
  driver = static
  args = password=test
}
userdb {
  driver = static
  args = uid=nobody gid=nogroup home=/tmp/dovecot-test-home
}
`;

async function docker(args: string[], allowFail = false) {
  try {
    const { stdout, stderr } = await exec("docker", args, {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (!allowFail) throw error;
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const run = (script: string, allowFail = false) =>
  docker(["exec", RUNNER, "bash", "-euo", "pipefail", "-c", script], allowFail);

describeDockerE2E("Dovecot startup after container restart (issue #1700)", () => {
  beforeAll(async () => {
    await requireDocker();
    await docker(["pull", "debian:12-slim"]);
    await docker(["run", "-d", "--name", RUNNER, "debian:12-slim", "sleep", "1800"]);
    await docker(["exec", RUNNER, "apt-get", "update"]);
    await docker([
      "exec",
      "--env",
      "DEBIAN_FRONTEND=noninteractive",
      RUNNER,
      "apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      "dovecot-core",
      "dovecot-imapd",
      "netcat-openbsd",
    ]);
    // From here, the daemon has only loopback. No mail is delivered or exposed.
    await docker(["network", "disconnect", "bridge", RUNNER]);
    await docker([
      "cp",
      join(ROOT, "apps/email/docker/dovecot-start.sh"),
      `${RUNNER}:/dovecot-start.sh`,
    ]);
    await run(`printf %s ${sq(CONFIG)} > /dovecot-test.conf
      install -d -m 0755 /var/run/dovecot /tmp/dovecot-test-home /tmp/dovecot-test-mail`);
  });
  afterAll(async () => {
    await docker(["rm", "-f", RUNNER], true);
  });

  it("removes a stale PID naming another live process and restores IMAP", async () => {
    await run(`sh -c 'echo $$ > /var/run/dovecot/master.pid; exec sleep 120' >/unrelated.log 2>&1 &
      for attempt in $(seq 1 30); do
        if [ -s /var/run/dovecot/master.pid ]; then break; fi
        sleep 0.1
      done
      cp /var/run/dovecot/master.pid /unrelated.pid
      kill -0 "$(cat /unrelated.pid)"`);
    const stale = await run("timeout 5 dovecot -c /dovecot-test.conf -F", true);
    expect(stale.code).not.toBe(0);
    expect(stale.code).not.toBe(124);
    expect(stale.stdout + stale.stderr).toMatch(/already running/i);

    await run(`${WRAPPER} >/dovecot.log 2>&1 &
      daemon_pid=$!
      trap 'kill "$daemon_pid" "$(cat /unrelated.pid)" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' EXIT
      for attempt in $(seq 1 50); do
        if nc -z -w 1 127.0.0.1 143; then break; fi
        sleep 0.1
      done
      printf 'a001 LOGOUT\\r\\n' | nc -w 3 127.0.0.1 143 > /imap.log
      grep -q '^\\* OK' /imap.log
      kill -0 "$(cat /unrelated.pid)"
      test "$(cat /var/run/dovecot/master.pid)" != "$(cat /unrelated.pid)"`);
  });

  it("leaves the pid file of a live Dovecot alone", async () => {
    await run(`${WRAPPER} >/dovecot.log 2>&1 &
      daemon_pid=$!
      trap 'kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' EXIT
      for attempt in $(seq 1 50); do
        if nc -z -w 1 127.0.0.1 143; then break; fi
        sleep 0.1
      done
      master_pid="$(cat /var/run/dovecot/master.pid)"
      kill -0 "$master_pid"
      refused=$(timeout 5 ${WRAPPER} 2>&1 || true)
      echo "$refused" | grep -qi 'already running'
      test "$(cat /var/run/dovecot/master.pid)" = "$master_pid"
      kill -0 "$master_pid"`);
  });

  it("removes a dead or malformed pid file and starts", async () => {
    await run(`dead_pid=$(sh -c 'echo $$')
      kill -0 "$dead_pid" 2>/dev/null && exit 1 || true
      echo "$dead_pid" > /var/run/dovecot/master.pid
      ${WRAPPER} >/dovecot.log 2>&1 &
      daemon_pid=$!
      trap 'kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' EXIT
      for attempt in $(seq 1 50); do
        if nc -z -w 1 127.0.0.1 143; then break; fi
        sleep 0.1
      done
      printf 'a001 LOGOUT\\r\\n' | nc -w 3 127.0.0.1 143 > /imap.log
      grep -q '^\\* OK' /imap.log
      kill "$daemon_pid"
      wait "$daemon_pid" 2>/dev/null || true
      printf not-a-pid > /var/run/dovecot/master.pid
      ${WRAPPER} >/dovecot2.log 2>&1 &
      daemon_pid=$!
      for attempt in $(seq 1 50); do
        if nc -z -w 1 127.0.0.1 143; then break; fi
        sleep 0.1
      done
      printf 'a001 LOGOUT\\r\\n' | nc -w 3 127.0.0.1 143 > /imap2.log
      grep -q '^\\* OK' /imap2.log`);
  });
});
