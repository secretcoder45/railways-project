import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import zlib from "zlib";

const dataRoot = process.env.DATA_ROOT || path.join(process.cwd(), "data");
const routesFile = process.env.ROUTES_FILE || path.join(dataRoot, "processed", "datameet_routes.jsonl");
const datasetUrl = process.env.DATASET_URL;
const localSeedGzip = path.join(process.cwd(), "runtime_seed", "datameet_routes.jsonl.gz");
const localSeedJsonl = path.join(process.cwd(), "runtime_seed", "datameet_routes.jsonl");

async function existsWithData(filePath) {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size > 1024;
  } catch {
    return false;
  }
}

async function inflateGzipFile(gzipPath, outFile) {
  await pipeline(createReadStream(gzipPath), zlib.createGunzip(), createWriteStream(outFile));
}

async function copyFile(src, outFile) {
  await pipeline(createReadStream(src), createWriteStream(outFile));
}

async function downloadToFile(url, targetFile) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download dataset (${res.status} ${res.statusText})`);
  }

  const bodyStream = Readable.fromWeb(res.body);
  const out = createWriteStream(targetFile);

  if (url.toLowerCase().endsWith(".gz")) {
    await pipeline(bodyStream, zlib.createGunzip(), out);
  } else {
    await pipeline(bodyStream, out);
  }
}

async function main() {
  if (await existsWithData(routesFile)) {
    console.log(`[bootstrap] dataset already present: ${routesFile}`);
    return;
  }

  await fs.mkdir(path.dirname(routesFile), { recursive: true });
  const tmp = `${routesFile}.download`;

  // 1) Use committed local seed first (most reliable on Render).
  if (await existsWithData(localSeedGzip)) {
    console.log(`[bootstrap] using local seed gzip: ${localSeedGzip}`);
    await inflateGzipFile(localSeedGzip, tmp);
    await fs.rename(tmp, routesFile);
    console.log(`[bootstrap] dataset ready: ${routesFile}`);
    return;
  }

  if (await existsWithData(localSeedJsonl)) {
    console.log(`[bootstrap] using local seed jsonl: ${localSeedJsonl}`);
    await copyFile(localSeedJsonl, tmp);
    await fs.rename(tmp, routesFile);
    console.log(`[bootstrap] dataset ready: ${routesFile}`);
    return;
  }

  // 2) Fallback to URL download.
  if (datasetUrl) {
    console.log(`[bootstrap] downloading dataset from ${datasetUrl}`);
    await downloadToFile(datasetUrl, tmp);
    await fs.rename(tmp, routesFile);
    console.log(`[bootstrap] dataset ready: ${routesFile}`);
    return;
  }

  throw new Error(
    `Dataset not found. Provide runtime_seed/datameet_routes.jsonl(.gz) or set DATASET_URL.`
  );
}

main().catch((err) => {
  console.error(`[bootstrap] ${err.message}`);
  process.exit(1);
});
