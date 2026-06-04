import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PINECONE_API_VERSION = "2025-10";
const CONTROL_PLANE_URL = "https://api.pinecone.io";
const DEFAULT_RECORDS_PATH = path.resolve("data", "pinecone", "client-response-records.ndjson");
const MAX_TEXT_BATCH_SIZE = 96;

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;

  const key = arg.slice(2);
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "true");
  } else {
    args.set(key, next);
    index += 1;
  }
}

const loadEnvFile = async (fileName) => {
  const filePath = path.resolve(fileName);
  if (!existsSync(filePath)) return;

  const content = await readFile(filePath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    const rawValue = trimmed.slice(equalIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
};

const readInteger = (value, fallback) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const config = () => {
  const batchSize = Math.min(
    readInteger(args.get("batch-size") || process.env.PINECONE_BATCH_SIZE, MAX_TEXT_BATCH_SIZE),
    MAX_TEXT_BATCH_SIZE
  );

  return {
    apiKey: process.env.PINECONE_API_KEY || "",
    indexName: args.get("index") || process.env.PINECONE_INDEX_NAME || "setram-client-responses",
    indexHost: args.get("host") || process.env.PINECONE_INDEX_HOST || "",
    namespace: args.get("namespace") || process.env.PINECONE_NAMESPACE || "setram-client-responses",
    cloud: process.env.PINECONE_CLOUD || "aws",
    region: process.env.PINECONE_REGION || "us-east-1",
    embedModel: process.env.PINECONE_EMBED_MODEL || "multilingual-e5-large",
    recordsPath: path.resolve(args.get("file") || process.env.PINECONE_RECORDS_PATH || DEFAULT_RECORDS_PATH),
    batchSize,
    batchDelayMs: readInteger(process.env.PINECONE_BATCH_DELAY_MS, 250),
    dryRun: args.has("dry-run") || process.env.PINECONE_DRY_RUN === "true",
    createIndex: args.get("create-index") !== "false" && process.env.PINECONE_CREATE_INDEX !== "false",
  };
};

const parseNdjson = async (filePath) => {
  const content = await readFile(filePath, "utf-8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const pineconeHeaders = (apiKey, contentType = "application/json") => ({
  "Api-Key": apiKey,
  "Content-Type": contentType,
  "X-Pinecone-Api-Version": PINECONE_API_VERSION,
});

const request = async (url, options, retries = 3) => {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();
    const payload = text ? safeJson(text) : null;

    if (response.ok) {
      return payload ?? text;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retries) {
      const delayMs = 750 * 2 ** attempt;
      console.warn(`Retrying ${response.status} from Pinecone in ${delayMs}ms...`);
      await sleep(delayMs);
      continue;
    }

    throw new Error(
      `Pinecone request failed (${response.status}): ${text || response.statusText}`
    );
  }
};

const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const normalizeHost = (host) => host.replace(/^https?:\/\//, "").replace(/\/$/, "");

const describeIndex = async ({ apiKey, indexName }) => {
  const response = await fetch(`${CONTROL_PLANE_URL}/indexes/${encodeURIComponent(indexName)}`, {
    headers: pineconeHeaders(apiKey),
  });

  if (response.status === 404) return null;

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Could not describe index (${response.status}): ${text}`);
  }

  return safeJson(text);
};

const createIndex = async ({ apiKey, indexName, cloud, region, embedModel }) => {
  console.log(`Creating Pinecone index "${indexName}" (${cloud}/${region}, ${embedModel})...`);

  return request(`${CONTROL_PLANE_URL}/indexes/create-for-model`, {
    method: "POST",
    headers: pineconeHeaders(apiKey),
    body: JSON.stringify({
      name: indexName,
      cloud,
      region,
      embed: {
        model: embedModel,
        metric: "cosine",
        field_map: { text: "chunk_text" },
        write_parameters: {
          input_type: "passage",
          truncate: "END",
        },
        read_parameters: {
          input_type: "query",
          truncate: "END",
        },
      },
    }),
  });
};

const waitForIndex = async (settings) => {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const index = await describeIndex(settings);
    if (index?.status?.ready && index?.host) return index;

    console.log(`Waiting for index readiness (${attempt}/40)...`);
    await sleep(3000);
  }

  throw new Error("Index was not ready after waiting. Try running upload again.");
};

const ensureIndex = async (settings) => {
  if (settings.indexHost) {
    return { host: normalizeHost(settings.indexHost) };
  }

  const existing = await describeIndex(settings);
  if (existing?.host) {
    console.log(`Using existing Pinecone index "${settings.indexName}".`);
    return { ...existing, host: normalizeHost(existing.host) };
  }

  if (!settings.createIndex) {
    throw new Error(
      `Pinecone index "${settings.indexName}" does not exist and create-index is disabled.`
    );
  }

  await createIndex(settings);
  const readyIndex = await waitForIndex(settings);
  return { ...readyIndex, host: normalizeHost(readyIndex.host) };
};

const chunks = function* (items, size) {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
};

const upsertBatch = async ({ apiKey, host, namespace }, records) => {
  const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

  return request(`https://${host}/records/namespaces/${encodeURIComponent(namespace)}/upsert`, {
    method: "POST",
    headers: pineconeHeaders(apiKey, "application/x-ndjson"),
    body,
  });
};

const main = async () => {
  await loadEnvFile(".env.local");
  await loadEnvFile(".env");

  const settings = config();
  const records = await parseNdjson(settings.recordsPath);

  console.log(`Loaded ${records.length} records from ${settings.recordsPath}`);
  console.log(`Index: ${settings.indexName}`);
  console.log(`Namespace: ${settings.namespace}`);
  console.log(`Text field mapped for embedding: chunk_text`);
  console.log(`Batch size: ${settings.batchSize}`);

  if (settings.dryRun) {
    console.log("Dry run enabled. No data will be sent to Pinecone.");
    console.log(JSON.stringify(records.slice(0, 2), null, 2));
    return;
  }

  if (!settings.apiKey) {
    throw new Error("Missing PINECONE_API_KEY. Add it to .env.local or your shell environment.");
  }

  const index = await ensureIndex(settings);
  let uploaded = 0;

  for (const batch of chunks(records, settings.batchSize)) {
    await upsertBatch({ ...settings, host: index.host }, batch);
    uploaded += batch.length;
    console.log(`Uploaded ${uploaded}/${records.length} records...`);
    if (settings.batchDelayMs > 0) await sleep(settings.batchDelayMs);
  }

  console.log("Pinecone upload complete.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

