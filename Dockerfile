FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080 EPPIC_DB_PATH=/var/lib/eppic/eppic.db EPPIC_MEDIA_DIR=/var/lib/eppic/media
WORKDIR /app/whatsapp-agent
COPY whatsapp-agent/package.json whatsapp-agent/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY docs/ /app/docs/
COPY whatsapp-agent/src/ ./src/
RUN mkdir -p /var/lib/eppic/media && chown -R node:node /var/lib/eppic
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
