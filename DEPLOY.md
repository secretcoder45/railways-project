# Deployment Guide

## Architecture
- Frontend: Vercel (static Vite build)
- Backend: Render (Node/Express API + MCP Server)

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
   - `MCP_AUTH_TOKEN=<optional-secret-token>` (leave empty for open access)

### Dataset requirement
The matcher uses the normal/raw Datameet database files:
- `trains.json`
- `stations.json`
- `schedules.json`

On startup, the backend (`scripts/bootstrap-data.mjs`):
1. Auto-downloads these raw files using `RAW_*_URL` into `DATA_ROOT`.
2. Runs a memory-efficient streaming parser to compile the raw files into a compact `prebuilt_routes.json`.
3. The Express server then loads *only* the compact prebuilt file to stay well within the Render free tier's 512 MB memory limit.
4. The spatial index (R-tree) is built from the shared route data — no duplicate loading.

### Health check
- `GET /api/health` — Returns service status and spatial index readiness

---

## 2) Deploy Frontend on Vercel
1. Import this repo into Vercel.
2. Framework preset: **Vite**
3. Build command: `npm run build`
4. Output directory: `dist`
5. Add env var:
   - `VITE_API_BASE_URL=https://<your-render-service>.onrender.com`

---

## 3) Connect Claude Desktop to Remote MCP Server

Update `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "railways-validation-engine": {
      "type": "streamableHttp",
      "url": "https://<your-render-service>.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

> **Note:** If `MCP_AUTH_TOKEN` is not set on Render, omit the `headers` field.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_nearby_rail_segments` | Find trains near a coordinate (R-tree + Haversine) |
| `verify_track_alignment` | Check GPS coords against a reference route (Fréchet Distance) |
| `search_trains` | Search trains by name, number, or type |
| `get_route_details` | Get full route info with stations and geometry |
| `get_saved_annotation` | Read the user's last drawn annotation from the server |

---

## 4) New REST API Endpoints

These endpoints are available alongside the existing `/api/match` etc:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/nearby-segments?lat=28.61&lon=77.20&radius=0.5&max=30` | Find trains near a point |
| `POST` | `/api/verify-alignment` | Verify alignment (body: `route_id`, `inspection_coordinates`) |
| `GET` | `/api/routes/:trainNo` | Get route details (`?geometry=true` for coords) |
| `GET` | `/api/search-trains?q=rajdhani&max=10` | Search trains by name/number/type |

---

## 5) Local Dev
- Frontend: `npm run dev`
- Backend: `npm run server`
- Vite proxy already forwards `/api` to `http://localhost:5050`.
- MCP endpoint: `http://localhost:5050/mcp`
