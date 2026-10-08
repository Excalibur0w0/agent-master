# A stand-in for a typical Linux server you ssh into: Ubuntu, bash login shell,
# GNU userland, key-only sshd. Nothing from agent-master is installed here.
FROM ubuntu:24.04

# Set APT_MIRROR (e.g. http://mirrors.aliyun.com) when archive.ubuntu.com is slow.
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s#http://ports.ubuntu.com#$APT_MIRROR#g; s#http://archive.ubuntu.com#$APT_MIRROR#g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash dev \
 && mkdir -p /run/sshd \
 && printf '%s\n' 'PasswordAuthentication no' 'PermitRootLogin no' > /etc/ssh/sshd_config.d/remote-sim.conf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
