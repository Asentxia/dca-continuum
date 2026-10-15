#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
source tools/local-fixture-env.sh
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=localtest
db=${CT_DATABASE:-ct_test}
case "$db" in
  ct_test|ct_console_dev|ct_console_test|ct_console_browser|ct_provider_read_test) ;;
  *) echo 'Refusing non-allowlisted database'; exit 2 ;;
esac
if [ -L .local ]; then echo 'Refusing linked local fixture directory'; exit 2; fi
mkdir -p .local
# Traverse-only for other users so a dropped fixture uid can reach the
# controller socket. The dump itself stays mode 0600; database directories stay 0700.
chmod 711 .local
out=${1:-.local/domain-backup.dump}
mapfile -t paths < <(python3 - "$PWD" "$out" <<'PY'
import os, sys, tempfile
root, out = sys.argv[1], sys.argv[2]
root = os.path.realpath(root)
local = os.path.join(root, ".local")
if os.path.islink(os.path.join(root, ".local")):
    raise SystemExit(2)
if not os.path.isabs(out):
    out = os.path.join(root, out)
rel = os.path.relpath(out, root)
if rel.startswith(".."):
    raise SystemExit(2)
acc = root
for part in rel.split(os.sep):
    if part in ("", ".", ".."):
        raise SystemExit(2)
    acc = os.path.join(acc, part)
    if os.path.islink(acc):
        raise SystemExit(2)
parent = os.path.dirname(acc)
if os.path.realpath(parent) != os.path.realpath(local):
    raise SystemExit(2)
fd, name = tempfile.mkstemp(prefix=".domain-backup.", dir=parent)
os.close(fd)
os.chmod(name, 0o600)
fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW)
os.close(fd)
print(name)
print(acc)
PY
)
tmp=${paths[0]}
final=${paths[1]}
trap 'rm -f "$tmp"' EXIT
actual=$(psql -d "$db" -Atc 'SHOW data_directory')
[ "$(realpath "$actual")" = "$PWD/.local/pgdata" ] || { echo 'Refusing non-owned fixture backup'; exit 2; }
pg_dump -d "$db" --format=custom --schema=ct --exclude-table-data=ct.control --file="$tmp"
mv -f "$tmp" "$final"
trap - EXIT
