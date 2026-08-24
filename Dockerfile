FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Cache buster - change this value to force rebuild
ENV CACHE_BUST=2026-08-24-v1.0

# Replace YourUsername/YourRepoName with your fork of the ReplayTV-Stremio-JS repository.
RUN git clone https://github.com/unsuns06/ReplayTV-Stremio-JS.git .

# npm ci installs exactly what package-lock.json pins. The addon has no dev
# dependencies, so this is Express and nothing else.
RUN npm ci --omit=dev

# The server binds to 127.0.0.1 unless told otherwise, which inside a container
# means nothing outside it can connect. This line is what makes the Space work.
ENV HOST=0.0.0.0
ENV PORT=7860
ENV NODE_ENV=production

# Credentials come from the cloned credentials.json. To keep them out of the
# repository instead, set CREDENTIALS_JSON as a Space secret to the full JSON
# document and it wins over the file.

EXPOSE 7860

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7860/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
