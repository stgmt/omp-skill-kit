FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-stage

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
    gzip \
 && rm -rf /var/lib/apt/lists/*

COPY --from=bun-stage /usr/local/bin/bun /usr/local/bin/omp

# Unprivileged user with clean home
RUN useradd -m -u 1000 -s /bin/sh testuser
USER testuser
ENV HOME=/home/testuser
WORKDIR /home/testuser

# Check that forbidden dev tools are absent
RUN which python >/dev/null 2>&1 && exit 1 || true
RUN which python3 >/dev/null 2>&1 && exit 1 || true
RUN which uv >/dev/null 2>&1 && exit 1 || true
RUN which node >/dev/null 2>&1 && exit 1 || true
RUN which npm >/dev/null 2>&1 && exit 1 || true
RUN which pnpm >/dev/null 2>&1 && exit 1 || true
RUN which bun >/dev/null 2>&1 && exit 1 || true
RUN which git >/dev/null 2>&1 && exit 1 || true

COPY --chown=testuser:testuser .tmp/staging/candidate /home/testuser/candidate
COPY --chown=testuser:testuser tests/e2e/docker/entrypoint.sh /home/testuser/entrypoint.sh

ENTRYPOINT ["/bin/sh", "/home/testuser/entrypoint.sh"]
