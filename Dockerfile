# =============================================================================
# BIOS Multi-level Platform — Combined Docker Image
# All three services (dashboard, prediction, blockchain) share one image.
# The Helm values select which CMD runs via the workers.*.command override.
#
# Deno must match the libc of the Node base: the musl binary from
# denoland/deno:alpine cannot execute on node:22-alpine (shows as "deno: not
# found"). Use Debian (glibc) for both: copy /usr/bin/deno from denoland/deno.
# =============================================================================
FROM denoland/deno AS deno

FROM node:22-bookworm-slim AS base

# Clear the Node image entrypoint so we exec the command in CMD/Helm.
ENTRYPOINT []

COPY --from=deno /usr/bin/deno /usr/local/bin/deno
RUN /usr/local/bin/deno --version

# Install BARRAGE internal CA so Node, Deno and curl trust *.barrage.net hosts
# BARRAGE-internal HTTPS (*.barrage.net) uses BIPA; public Stealth hostnames may use Lets Encrypt.
COPY certs/bipa_ca.crt /usr/local/share/ca-certificates/bipa_ca.crt
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV DENO_CERT=/usr/local/share/ca-certificates/bipa_ca.crt
ENV DENO_TLS_CA_STORE=system

WORKDIR /app

# Blockchain service has npm dependencies
COPY bios-multilevel-platform-services/blockchain/package.json ./blockchain/package.json
RUN cd blockchain && npm install --omit=dev

# Copy all service code
COPY bios-multilevel-platform-services/prediction ./prediction
COPY bios-multilevel-platform-services/blockchain ./blockchain
COPY bios-multilevel-platform-services/database ./database

# Install pg driver for PostgreSQL support
RUN cd database && npm init -y > /dev/null 2>&1 && npm install pg@8 --omit=dev

COPY bios-multilevel-platform-services/dashboard ./dashboard

# Default: run the dashboard (the main app entrypoint).
# Workers override CMD via Helm values.
ENV DASHBOARD_EVENT_POLL_SECONDS=3

EXPOSE 8000 8091 8092

ENV PATH="/usr/local/bin:$PATH"
CMD ["/usr/local/bin/deno", "run", "--allow-net", "--allow-read", "--allow-env", "dashboard/main.ts"]
