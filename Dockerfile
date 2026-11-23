# Ein Abbild, das API und PWA zusammen ausliefert.
#
# Zwei Stufen: Die erste baut mit allen Werkzeugen, die zweite enthält nur das
# Ergebnis und die Laufzeit-Abhängigkeiten.

FROM node:22-alpine AS build
WORKDIR /app

# Erst nur die Manifeste: Solange sich die Abhängigkeiten nicht ändern, bleibt
# diese Schicht im Cache.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY web/ web/

# Railway setzt diese Variable beim Bauen; sie landet als Kurz-Commit in der Versionsanzeige.
ARG RAILWAY_GIT_COMMIT_SHA
RUN npm run build -w shared \
 && npm run build -w web \
 && npm run build -w server

RUN npm prune --omit=dev


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules node_modules/
COPY --from=build --chown=node:node /app/package.json package.json
COPY --from=build --chown=node:node /app/shared/package.json shared/package.json
COPY --from=build --chown=node:node /app/shared/dist shared/dist/
COPY --from=build --chown=node:node /app/server/package.json server/package.json
COPY --from=build --chown=node:node /app/server/dist server/dist/
COPY --from=build --chown=node:node /app/web/dist web/dist/

USER node
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
