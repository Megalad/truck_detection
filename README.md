# truck_detection

Section 35 traffic enforcement dashboard: React + Vite frontend, Express API server, and a Python (YOLO/Ultralytics) inference service backed by MySQL.

## Prerequisites

- Node.js 18+
- Python 3.10+
- MySQL server (local, or via Docker as shown below)

## 1. Clone and install dependencies

```bash
git clone <repo-url>
cd web
npm install

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

- `DB_HOST`, `DB_USER`, `DB_PASSWORD` — MySQL connection
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — violation alert bot (optional for local dev)

## 3. Set up the database

Start MySQL (e.g. `brew services start mysql`, or run it via Docker — see `docker-compose.yml`), then load the schema:

```bash
mysql -u root -p < setup.sql
```

This creates `section35_db` and the `violations` table.

## 4. Get the model weights

`models/*.pt` are gitignored (large binaries, change often). Ask a teammate for the current weights and place them under `models/`:

- `model_v1.pt`, `model_2.pt` ... `model_v6.pt` (server.js currently defaults to `model_v6.pt` via the `model_current` key)

## 5. Run it

```bash
npm run dev
```

This runs the Vite dev client, the Express API server, and the Python live-inference server (`scripts/live_server.py`) together. Individually:

```bash
npm run dev:client   # Vite dev server
npm run dev:server   # Express API only
.venv/bin/python scripts/live_server.py   # Python inference server only
```

Production build/serve:

```bash
npm run build
npm start
```

## Docker

`docker-compose.yml` runs the Node server, Python live server, nginx, and a MySQL container together (`docker-compose up`), auto-loading `setup.sql` on first boot.
