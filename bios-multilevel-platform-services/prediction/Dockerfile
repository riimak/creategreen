FROM node:22-alpine

WORKDIR /app

# Build context must be Git / compose repo root; paths are root-relative.
COPY bios-multilevel-platform-services/prediction ./prediction
COPY bios-multilevel-platform-services/database ./database

# pg is optional; install only if DATABASE_URL will be used
RUN cd database && npm init -y > /dev/null 2>&1 && npm install pg@8 --omit=dev 2>/dev/null || true

ENV PREDICTION_PORT=8091
ENV BIOS_OUTPUT_DIR=/app/output
ENV PREDICTION_DB_PATH=/data/prediction-store.json

EXPOSE 8091

CMD ["node", "prediction/server.js"]
