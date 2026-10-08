#!/bin/sh
# Builds and starts the simulated remote server, then writes an ssh config so
#   ssh -F infra/remote-sim/.state/ssh_config remote-sim
# logs in as `dev`. Idempotent: reuses the key and a running container.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
state="$root/.state"
name="${REMOTE_SIM_NAME:-am-remote-sim}"
port="${REMOTE_SIM_PORT:-2222}"
image="agent-master/remote-sim"

mkdir -p "$state"
[ -f "$state/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C remote-sim -f "$state/id_ed25519"

docker build -q --build-arg APT_MIRROR="${APT_MIRROR:-}" -t "$image" "$root" >/dev/null

if [ -z "$(docker ps -q --filter "name=^${name}$")" ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "127.0.0.1:${port}:22" \
    -e AUTHORIZED_KEY="$(cat "$state/id_ed25519.pub")" "$image" >/dev/null
fi

cat > "$state/ssh_config" <<EOF
Host remote-sim
  HostName 127.0.0.1
  Port ${port}
  User dev
  IdentityFile ${state}/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF

i=0
until ssh -F "$state/ssh_config" -o BatchMode=yes -o ConnectTimeout=2 remote-sim true 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "remote-sim: sshd did not come up; see: docker logs $name" >&2
    exit 1
  fi
  sleep 0.5
done
echo "remote-sim ready: ssh -F $state/ssh_config remote-sim"
