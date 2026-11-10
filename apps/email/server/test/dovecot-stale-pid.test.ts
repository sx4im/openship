import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Issue #1700: after `docker restart openship-mail`, /run/dovecot/master.pid
// still names a PID from the previous life, and that PID now belongs to
// another daemon. Dovecot refuses to start ("already running") and
// supervisord marks it FATAL. The [program:dovecot] command must clear the
// stale pid file before starting dovecot, so both a container restart and a
// panel `supervisorctl restart dovecot` recover without anyone removing the
// file by hand.
//
// These tests execute the real command from supervisord.conf against a
// stand-in dovecot that reproduces the refusal, so reverting the command to
// a bare `dovecot -F` fails them.

const supervisordConf = await readFile(
  new URL('../../docker/supervisord.conf', import.meta.url),
  'utf8',
);

function dovecotCommand(): string {
  const section = supervisordConf.split('[program:dovecot]')[1];
  if (!section) throw new Error('no [program:dovecot] section in supervisord.conf');
  const match = section.split(/^\[/m)[0].match(/^command=(.+)$/m);
  if (!match) throw new Error('no command= line in [program:dovecot]');
  return match[1].trim();
}

// Stand-in for /usr/sbin/dovecot: refuses to start when the pid file names a
// live process, exactly like real Dovecot. Otherwise records the invocation
// and takes over the pid file.
const DOVECOT_STUB = `#!/bin/sh
pid_file="$DOVECOT_PID_FILE"
if [ -f "$pid_file" ]; then
  pid="$(cat "$pid_file")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Fatal: Dovecot is already running with PID $pid" >&2
    exit 1
  fi
fi
touch "$DOVECOT_INVOKED"
echo "$$" > "$pid_file"
exit 0
`;

interface Fixture {
  directory: string;
  pidFile: string;
  invoked: string;
  sleeper: ReturnType<typeof spawn>;
  command: string;
}

async function fixture(stalePid: boolean): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'openship-dovecot-stale-pid-'));
  const pidFile = join(directory, 'run', 'dovecot', 'master.pid');
  const invoked = join(directory, 'dovecot-invoked');
  const stub = join(directory, 'bin', 'dovecot');
  await mkdir(join(directory, 'run', 'dovecot'), { recursive: true });
  await mkdir(join(directory, 'bin'), { recursive: true });
  await writeFile(stub, DOVECOT_STUB);
  await chmod(stub, 0o755);
  // The "other daemon" that inherited Dovecot's previous PID in the new
  // container: any live process will do.
  const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
  if (stalePid) await writeFile(pidFile, `${sleeper.pid}\n`);
  // Run the real command with its absolute paths pointed at the fixture.
  const command = dovecotCommand()
    .replaceAll('/run/dovecot/master.pid', pidFile)
    .replaceAll('/usr/sbin/dovecot', stub);
  return { directory, pidFile, invoked, sleeper, command };
}

async function run(command: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('a stale master.pid naming a live process does not stop dovecot starting', async () => {
  const f = await fixture(true);
  try {
    const { code, stderr } = await run(f.command, {
      ...process.env,
      DOVECOT_PID_FILE: f.pidFile,
      DOVECOT_INVOKED: f.invoked,
    });
    expect(stderr).not.toContain('already running');
    expect(code).toBe(0);
    await expect(readFile(f.invoked)).resolves.toBeDefined();
    // The stale PID is gone: the file now names the dovecot that started.
    const pid = (await readFile(f.pidFile, 'utf8')).trim();
    expect(pid).not.toBe(`${f.sleeper.pid}`);
  } finally {
    f.sleeper.kill();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('dovecot still starts when no pid file exists', async () => {
  const f = await fixture(false);
  try {
    const { code } = await run(f.command, {
      ...process.env,
      DOVECOT_PID_FILE: f.pidFile,
      DOVECOT_INVOKED: f.invoked,
    });
    expect(code).toBe(0);
    await expect(readFile(f.invoked)).resolves.toBeDefined();
  } finally {
    f.sleeper.kill();
    await rm(f.directory, { recursive: true, force: true });
  }
});
