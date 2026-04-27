FROM node:22-alpine

WORKDIR /app

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
