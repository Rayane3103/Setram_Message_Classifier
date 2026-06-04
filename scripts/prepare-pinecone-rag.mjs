import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const CATEGORY_COLUMN = "Catégorie";
const SUB_CATEGORY_COLUMN = "Sous catégorie";
const RESPONSE_COLUMN = "Réponse client";
const DEFAULT_OUTPUT_DIR = path.resolve("data", "pinecone");
const DEFAULT_SOURCE_CANDIDATES = [
  process.env.SOURCE_CSV_PATH,
  process.env.RAG_SOURCE_CSV_PATH,
  String.raw`C:\Users\rayan\Desktop\Soutenance\train_augmented.csv`,
  path.resolve("..", "..", "Soutenance", "train_augmented.csv"),
].filter(Boolean);

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

const pickSourcePath = () => {
  const sourceArg = args.get("source");
  if (sourceArg) return path.resolve(sourceArg);

  const source = DEFAULT_SOURCE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!source) {
    throw new Error(
      "CSV source not found. Pass --source <path> or set SOURCE_CSV_PATH."
    );
  }

  return path.resolve(source);
};

const readInteger = (value, fallback) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseCsv = (content) => {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);

  const [headers = [], ...dataRows] = rows;

  return dataRows.map((dataRow) =>
    headers.reduce((record, header, index) => {
      record[header.trim()] = (dataRow[index] || "").trim();
      return record;
    }, {})
  );
};

const normalizeWhitespace = (value) =>
  value
    .replace(/\uFEFF/g, "")
    .replace(/\s+/g, " ")
    .trim();

const redactPii = (value) =>
  normalizeWhitespace(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/(?:\+?\d[\s.-]?){8,}/g, "[NUMERO]")
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "[DATE]")
    .replace(/\b\d{1,2}\s*h\s*\d{0,2}\b/gi, "[HEURE]")
    .replace(/\b((?:au\s+nom\s+de|nom\s+de|sous\s+le\s+nom\s+de)\s+)([A-ZÀ-ÖØ-Þ' -]{3,})/g, "$1[NOM_CLIENT] ");

const truncate = (value, maxLength) => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trim()}...`;
};

const csvEscape = (value) => {
  const stringValue = String(value ?? "");
  return /[",\n\r]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
};

const toRecord = (row, sourceRow, redactionEnabled) => {
  const rawDescription = normalizeWhitespace(row.Description || "");
  const rawResponse = normalizeWhitespace(row[RESPONSE_COLUMN] || "");

  if (!rawDescription || !rawResponse) return null;

  const description = redactionEnabled ? redactPii(rawDescription) : rawDescription;
  const response = redactionEnabled ? redactPii(rawResponse) : rawResponse;

  if (!description || !response) return null;

  const category = normalizeWhitespace(row[CATEGORY_COLUMN] || "Non classé");
  const subCategory = normalizeWhitespace(row[SUB_CATEGORY_COLUMN] || "");
  const type = normalizeWhitespace(row.Type || "Non classé");
  const chunkText = truncate(
    [
      `Description client: ${description}`,
      `Réponse historique SETRAM: ${response}`,
      `Classification: ${category}${subCategory ? ` / ${subCategory}` : ""} / ${type}`,
    ].join("\n"),
    6000
  );

  return {
    _id: `setram-response-${String(sourceRow).padStart(6, "0")}`,
    chunk_text: chunkText,
    description: truncate(description, 1800),
    response: truncate(response, 2800),
    category,
    sub_category: subCategory,
    type,
    is_synthetic: String(row.is_synthetic || "").toLowerCase() === "true",
    source_row: sourceRow,
    source_file: "train_augmented.csv",
  };
};

const main = async () => {
  const sourcePath = pickSourcePath();
  const outDir = path.resolve(args.get("out-dir") || process.env.PINECONE_DATA_DIR || DEFAULT_OUTPUT_DIR);
  const limit = readInteger(args.get("limit") || process.env.PINECONE_RECORD_LIMIT, 0);
  const redactionEnabled = String(args.get("redact-pii") || process.env.PINECONE_REDACT_PII || "true") !== "false";

  const content = await readFile(sourcePath, "utf-8");
  const parsedRows = parseCsv(content);
  const records = [];
  const seen = new Set();

  for (const [index, row] of parsedRows.entries()) {
    const record = toRecord(row, index + 2, redactionEnabled);
    if (!record) continue;

    const dedupeKey = `${record.description}\n${record.response}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    records.push(record);

    if (limit > 0 && records.length >= limit) break;
  }

  await mkdir(outDir, { recursive: true });

  const csvPath = path.join(outDir, "client-response-records.csv");
  const ndjsonPath = path.join(outDir, "client-response-records.ndjson");
  const previewPath = path.join(outDir, "client-response-records.preview.json");
  const manifestPath = path.join(outDir, "manifest.json");

  const csvHeaders = [
    "_id",
    "chunk_text",
    "description",
    "response",
    "category",
    "sub_category",
    "type",
    "is_synthetic",
    "source_row",
    "source_file",
  ];
  const csv = [
    csvHeaders.join(","),
    ...records.map((record) => csvHeaders.map((header) => csvEscape(record[header])).join(",")),
  ].join("\n");

  await writeFile(csvPath, `${csv}\n`, "utf-8");
  await writeFile(
    ndjsonPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf-8"
  );
  await writeFile(previewPath, JSON.stringify(records.slice(0, 5), null, 2), "utf-8");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourcePath,
        totalInputRows: parsedRows.length,
        exportedRecords: records.length,
        redactionEnabled,
        pinecone: {
          indexType: "dense integrated embedding",
          fieldMap: { text: "chunk_text" },
          namespaceDefault: "setram-client-responses",
          upsertFormat: "application/x-ndjson",
        },
        files: {
          csv: csvPath,
          ndjson: ndjsonPath,
          preview: previewPath,
        },
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`Prepared ${records.length} Pinecone records.`);
  console.log(`CSV: ${csvPath}`);
  console.log(`NDJSON: ${ndjsonPath}`);
  console.log(`Preview: ${previewPath}`);
  console.log(`Manifest: ${manifestPath}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
