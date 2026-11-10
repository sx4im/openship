#!/usr/bin/env bash
# Start Dovecot in the foreground under supervisord, dropping a stale
# master.pid first — but only when it cannot belong to a live Dovecot.
#
# `docker restart` keeps /run in the container's writable layer, so a pid
# file from the previous life can now name another daemon: a fresh PID
# namespace hands out small PIDs again. Dovecot refuses to start when
# master.pid names a live process — "Fatal: Dovecot is already running" —
# and supervisord marks it FATAL, taking IMAPS/POP3S down for the life of
# the container (issue #1700). The entrypoint already handles the mirror
# image of this for Amavis; nothing did it for Dovecot.
#
# This runs on every dovecot start, not just container boot, so a
# per-daemon restart (`supervisorctl restart dovecot`, the panel's restart)
# recovers the state too. It never touches the pid file of a live Dovecot:
# if the recorded PID is a dovecot process, the file is left alone and
# dovecot fails the way it would without this wrapper. A dead PID, a
# malformed file, or a PID belonging to another daemon is stale by
# definition, so the file is removed and dovecot starts cleanly.
#
# Arguments are forwarded to dovecot, so the usual invocation is just
# `dovecot-start.sh` (the image's default config) and a test can pass
# `-c /path/to/dovecot.conf`.
set -euo pipefail

PID_FILE=/run/dovecot/master.pid

if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  case "$pid" in
    "" | *[!0-9]*)
      # Empty or malformed: cannot name a live Dovecot master.
      rm -f "$PID_FILE"
      ;;
    *)
      if [ -d "/proc/$pid" ]; then
        # A process holds this PID. Only a Dovecot master may keep the file:
        # argv[0] is the executable, so a supervisorctl or sleep that merely
        # mentions dovecot in its arguments does not count.
        exe=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | head -n 1 || true)
        case "$exe" in
          */dovecot | dovecot)
            # Live Dovecot: leave the pid file alone.
            ;;
          *)
            rm -f "$PID_FILE"
            ;;
        esac
      else
        # No such process: stale.
        rm -f "$PID_FILE"
      fi
      ;;
  esac
fi

exec /usr/sbin/dovecot -F "$@"
