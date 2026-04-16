import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import zlib from "zlib";

const dataRoot = process.env.DATA_ROOT || path.join(process.cwd(), "data");
const routesFile = process.env.ROUTES_FILE || path.join(dataRoot, "processed", "datameet_routes.jsonl");
const datasetUrl = process.env.DATASET_URL;

async function existsWithData(filePath) {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size > 1024;
  } catch {
    return false;
  }
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

  if (!datasetUrl) {
    throw new Error(
      `Dataset not found at ${routesFile}. Set DATASET_URL to a hosted datameet_routes.jsonl (or .gz).`
    );
  }

  await fs.mkdir(path.dirname(routesFile), { recursive: true });
  const tmp = `${routesFile}.download`;

  console.log(`[bootstrap] downloading dataset from ${datasetUrl}`);
  await downloadToFile(datasetUrl, tmp);
  await fs.rename(tmp, routesFile);
  console.log(`[bootstrap] dataset ready: ${routesFile}`);
}

main().catch((err) => {
  console.error(`[bootstrap] ${err.message}`);
  process.exit(1);
});
