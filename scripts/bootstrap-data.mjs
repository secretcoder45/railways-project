import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const dataRoot = process.env.DATA_ROOT || path.join(process.cwd(), "runtime_data");

const rawTrainsFile = process.env.RAW_TRAINS_FILE || path.join(dataRoot, "trains.json");
const rawStationsFile = process.env.RAW_STATIONS_FILE || path.join(dataRoot, "stations.json");
const rawSchedulesFile = process.env.RAW_SCHEDULES_FILE || path.join(dataRoot, "schedules.json");

const rawTrainsUrl = process.env.RAW_TRAINS_URL || "https://raw.githubusercontent.com/datameet/railways/master/trains.json";
const rawStationsUrl = process.env.RAW_STATIONS_URL || "https://raw.githubusercontent.com/datameet/railways/master/stations.json";
const rawSchedulesUrl = process.env.RAW_SCHEDULES_URL || "https://raw.githubusercontent.com/datameet/railways/master/schedules.json";

async function existsWithData(filePath, minBytes = 1024) {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size > minBytes;
  } catch {
    return false;
  }
}

async function downloadToFile(url, targetFile) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url} (${res.status} ${res.statusText})`);
  }

  const bodyStream = Readable.fromWeb(res.body);
  await pipeline(bodyStream, createWriteStream(targetFile));
}

async function ensureFile(filePath, url, label) {
  const minSize = label === "schedules" ? 10 * 1024 * 1024 : 100 * 1024;
  if (await existsWithData(filePath, minSize)) {
    console.log(`[bootstrap] ${label} already present: ${filePath}`);
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.download`;

  console.log(`[bootstrap] downloading ${label} from ${url}`);
  await downloadToFile(url, tmp);
  await fs.rename(tmp, filePath);
  console.log(`[bootstrap] ${label} ready: ${filePath}`);
}

async function main() {
  await ensureFile(rawTrainsFile, rawTrainsUrl, "trains");
  await ensureFile(rawStationsFile, rawStationsUrl, "stations");
  await ensureFile(rawSchedulesFile, rawSchedulesUrl, "schedules");
}

main().catch((err) => {
  console.error(`[bootstrap] ${err.message}`);
  process.exit(1);
});
