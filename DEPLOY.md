# Deployment Guide

## Architecture
- Frontend: Vercel (static Vite build)
- Backend: Render (Node/Express API)

## 1) Deploy Backend on Render
1. Create a new **Web Service** from this repo.
2. Build Command: `npm ci`
3. Start Command: `npm run server:render`
4. Add env vars:
   - `PORT=5050`
   - `DATA_ROOT=/opt/render/project/src/runtime_data`
   - `ROUTES_FILE=/opt/render/project/src/runtime_data/datameet_routes.jsonl`
   - `FRONTEND_ORIGIN=https://<your-vercel-domain>`
   - `DATASET_URL=https://<public-file-host>/datameet_routes.jsonl.gz`

### Dataset requirement
The matcher needs `datameet_routes.jsonl` available at `ROUTES_FILE`.
- Size is large, so keep it out of git.
- Host the file publicly (S3/R2/GitHub Release) and set `DATASET_URL`.
- On each boot, backend auto-downloads file into `ROUTES_FILE` (supports `.jsonl` and `.jsonl.gz`).
- If file is missing or URL is invalid, startup fails with a clear error.

### Health check
- `GET /api/health`

## 2) Deploy Frontend on Vercel
1. Import this repo into Vercel.
2. Framework preset: **Vite**
3. Build command: `npm run build`
4. Output directory: `dist`
5. Add env var:
   - `VITE_API_BASE_URL=https://<your-render-service>.onrender.com`

## 3) Local Dev
- Frontend: `npm run dev`
- Backend: `npm run server`
- Vite proxy already forwards `/api` to `http://localhost:5050`.
