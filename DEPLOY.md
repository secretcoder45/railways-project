# Deployment Guide

## Architecture
- Frontend: Vercel (static Vite build)
- Backend: Render (Node/Express API)

## 1) Deploy Backend on Render
1. Create a new **Web Service** from this repo.
2. Build Command: `npm ci`
3. Start Command: `npm run server`
4. Add env vars:
   - `PORT=5050`
   - `DATA_ROOT=/opt/render/project/src/runtime_data`
   - `ROUTES_FILE=/opt/render/project/src/runtime_data/datameet_routes.jsonl`
   - `FRONTEND_ORIGIN=https://<your-vercel-domain>`

### Dataset requirement
The matcher needs `datameet_routes.jsonl` available at `ROUTES_FILE`.
- Size is large, so keep it out of git.
- Upload it to Render instance path: `/opt/render/project/src/runtime_data/datameet_routes.jsonl`
- If file is missing, API will return a clear error.

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
