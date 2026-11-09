#!/bin/sh
# Runs a heavy command (tsc, eslint, vitest, the build) under `capped` when
# that memory guard is installed, and plainly everywhere else (CI, machines
# without it). `capped` is any command that runs its arguments under a memory
# limit, so a run that outgrows it dies alone instead of the kernel's OOM
# killer taking the editor with it.
if command -v capped >/dev/null 2>&1; then exec capped "$@"; fi
exec "$@"
