# =============================================================================
# BIOS Multi-level Platform — Combined Docker Image
# All three services (dashboard, prediction, blockchain) share one image.
# The Helm values select which CMD runs via the workers.*.command override.
# =============================================================================
FROM node:22-alpine AS base

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

# Dashboard runs on Deno — install it into the same image
RUN apk add --no-cache curl unzip \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && rm -rf /tmp/*

COPY bios-multilevel-platform-services/dashboard ./dashboard

# Default: run the dashboard (the main app entrypoint).
# Workers override CMD via Helm values.
ENV DASHBOARD_EVENT_POLL_SECONDS=3

EXPOSE 8000 8091 8092

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "dashboard/main.ts"]
