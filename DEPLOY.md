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
   - `RAW_TRAINS_FILE=/opt/render/project/src/runtime_data/trains.json`
   - `RAW_STATIONS_FILE=/opt/render/project/src/runtime_data/stations.json`
   - `RAW_SCHEDULES_FILE=/opt/render/project/src/runtime_data/schedules.json`
   - `RAW_TRAINS_URL=https://raw.githubusercontent.com/datameet/railways/master/trains.json`
   - `RAW_STATIONS_URL=https://raw.githubusercontent.com/datameet/railways/master/stations.json`
   - `RAW_SCHEDULES_URL=https://raw.githubusercontent.com/datameet/railways/master/schedules.json`
   - `PREBUILT_ROUTES_FILE=/opt/render/project/src/runtime_data/prebuilt_routes.json`
   - `FRONTEND_ORIGIN=https://<your-vercel-domain>`

### Dataset requirement
The matcher uses the normal/raw Datameet database files:
- `trains.json`
- `stations.json`
- `schedules.json`

On startup, the backend (`scripts/bootstrap-data.mjs`):
1. Auto-downloads these raw files using `RAW_*_URL` into `DATA_ROOT`.
2. Runs a memory-efficient streaming parser to compile the raw files into a compact `prebuilt_routes.json`.
3. The Express server then loads *only* the compact prebuilt file to stay well within the Render free tier's 512 MB memory limit.

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
