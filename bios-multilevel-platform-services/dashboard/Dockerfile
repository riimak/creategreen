FROM denoland/deno:alpine

WORKDIR /app

# Install BARRAGE internal CA so Deno and curl trust *.barrage.net hosts
# (api-gateway-mainnet.prod.stealth.barrage.net is signed by BIPA, not a public CA).
COPY certs/bipa_ca.crt /usr/local/share/ca-certificates/bipa_ca.crt
RUN apk add --no-cache ca-certificates \
 && update-ca-certificates
ENV DENO_CERT=/usr/local/share/ca-certificates/bipa_ca.crt
ENV DENO_TLS_CA_STORE=system

# Build context must be Git / compose repo root; paths are root-relative.
COPY bios-multilevel-platform-services/dashboard ./dashboard

WORKDIR /app/dashboard

ENV PREDICTION_SERVICE_URL=http://prediction:8091
ENV BLOCKCHAIN_SERVICE_URL=http://blockchain:8092

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "main.ts"]
