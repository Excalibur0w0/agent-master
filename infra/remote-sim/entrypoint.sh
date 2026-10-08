#!/bin/sh
set -eu

# The public key arrives via the environment so file ownership and modes are
# right regardless of how the host shares volumes with the Docker VM.
: "${AUTHORIZED_KEY:?AUTHORIZED_KEY must be set}"
install -d -m 700 -o dev -g dev /home/dev/.ssh
printf '%s\n' "$AUTHORIZED_KEY" > /home/dev/.ssh/authorized_keys
chown dev:dev /home/dev/.ssh/authorized_keys
chmod 600 /home/dev/.ssh/authorized_keys

ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e
