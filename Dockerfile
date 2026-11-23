FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY package.json server.js segment_grapes.py ./
COPY index.html styles.css app.js manifest.webmanifest icon.svg ./

ENV PORT=4173
EXPOSE 4173
CMD ["node", "server.js"]
