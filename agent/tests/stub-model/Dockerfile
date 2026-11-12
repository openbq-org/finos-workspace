# syntax=docker/dockerfile:1

FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

ENV NODE_ENV=production
ENV PORT=11434

WORKDIR /app

COPY server.ts ./

EXPOSE 11434

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD ["node", "--input-type=module", "-e", "const res = await fetch(`http://127.0.0.1:${process.env.PORT || '11434'}/health`); if (!res.ok) process.exit(1);"]

USER node

CMD ["node", "server.ts"]
