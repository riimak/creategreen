FROM node:22-alpine

WORKDIR /app

COPY certs/bipa_ca.crt /usr/local/share/ca-certificates/bipa_ca.crt
RUN apk add --no-cache ca-certificates \
 && update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

COPY bios-multilevel-platform-services/fusionsolar ./fusionsolar
COPY bios-multilevel-platform-services/database ./database

RUN cd database && npm install --omit=dev

ENV FUSIONSOLAR_PORT=8093

EXPOSE 8093

CMD ["node", "fusionsolar/server.js"]
