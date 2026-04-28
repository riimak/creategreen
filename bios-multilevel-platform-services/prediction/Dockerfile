FROM node:22-alpine

WORKDIR /app

# Install BARRAGE internal CA so Node and curl trust *.barrage.net hosts
# (api-gateway-mainnet.prod.stealth.barrage.net is signed by BIPA, not a public CA).
COPY certs/bipa_ca.crt /usr/local/share/ca-certificates/bipa_ca.crt
RUN apk add --no-cache ca-certificates \
 && update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Build context must be Git / compose repo root; paths are root-relative.
COPY bios-multilevel-platform-services/prediction ./prediction
COPY bios-multilevel-platform-services/database ./database
COPY bios-multilevel-platform-services/scripts ./scripts

RUN cd database && npm install --omit=dev

ENV PREDICTION_PORT=8091
ENV BIOS_OUTPUT_DIR=/app/output
ENV PREDICTION_DB_PATH=/data/prediction-store.json

EXPOSE 8091

CMD ["node", "prediction/server.js"]
