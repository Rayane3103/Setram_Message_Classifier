export type ClientResponseExample = {
  id: string;
  category: string;
  subCategory: string;
  type: string;
  description: string;
  response: string;
  synthetic: boolean;
};

export type RankedClientResponseExample = ClientResponseExample & {
  score: number;
};

export type ClientResponseSearchResult = {
  matches: RankedClientResponseExample[];
  stats: {
    indexName: string;
    namespace: string;
    usedExamples: number;
    sourceColumn: string;
    mode: string;
    usage?: unknown;
  };
};

const PINECONE_API_VERSION = "2025-10";
const PINECONE_CONTROL_PLANE_URL = "https://api.pinecone.io";
const DEFAULT_INDEX_NAME = "setram-client-responses";
const DEFAULT_NAMESPACE = "setram-client-responses";

let indexHostPromise: Promise<string> | null = null;

const readEnv = (name: string, fallback = "") => {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const normalizeHost = (host: string) =>
  host.replace(/^https?:\/\//, "").replace(/\/$/, "");

const readString = (value: unknown, fallback = "") =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const readNumber = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const pineconeHeaders = (apiKey: string) => ({
  Accept: "application/json",
  "Api-Key": apiKey,
  "Content-Type": "application/json",
  "X-Pinecone-Api-Version": PINECONE_API_VERSION,
});

const getPineconeConfig = () => {
  const apiKey = readEnv("PINECONE_API_KEY");
  const indexName = readEnv("PINECONE_INDEX_NAME", DEFAULT_INDEX_NAME);
  const indexHost = readEnv("PINECONE_INDEX_HOST");
  const namespace = readEnv("PINECONE_NAMESPACE", DEFAULT_NAMESPACE);

  if (!apiKey) {
    throw new Error("PINECONE_API_KEY manquant dans les variables d'environnement.");
  }

  return {
    apiKey,
    indexName,
    indexHost,
    namespace,
  };
};

const parseJsonResponse = (text: string) => {
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
};

const describeIndexHost = async (apiKey: string, indexName: string) => {
  const response = await fetch(
    `${PINECONE_CONTROL_PLANE_URL}/indexes/${encodeURIComponent(indexName)}`,
    { headers: pineconeHeaders(apiKey) }
  );
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Impossible de trouver l'index Pinecone "${indexName}": ${text || response.statusText}`);
  }

  const data = toRecord(parseJsonResponse(text));
  const host = readString(data.host);

  if (!host) {
    throw new Error(`L'index Pinecone "${indexName}" n'a pas encore de host disponible.`);
  }

  return normalizeHost(host);
};

const getIndexHost = async () => {
  const { apiKey, indexName, indexHost } = getPineconeConfig();

  if (indexHost) {
    return normalizeHost(indexHost);
  }

  indexHostPromise ??= describeIndexHost(apiKey, indexName);
  return indexHostPromise;
};

const toMatch = (hit: unknown): RankedClientResponseExample => {
  const hitData = toRecord(hit);
  const fields = toRecord(hitData.fields);

  return {
    id: readString(hitData._id ?? hitData.id),
    score: readNumber(hitData._score ?? hitData.score),
    category: readString(fields.category, "Non classé"),
    subCategory: readString(fields.sub_category),
    type: readString(fields.type, "Non classé"),
    description: readString(fields.description),
    response: readString(fields.response),
    synthetic: fields.is_synthetic === true,
  };
};

export const searchClientResponseExamples = async (
  queryText: string,
  limit = 5
): Promise<ClientResponseSearchResult> => {
  const { apiKey, indexName, namespace } = getPineconeConfig();
  const host = await getIndexHost();

  const response = await fetch(
    `https://${host}/records/namespaces/${encodeURIComponent(namespace)}/search`,
    {
      method: "POST",
      headers: pineconeHeaders(apiKey),
      body: JSON.stringify({
        query: {
          inputs: { text: queryText },
          top_k: limit,
        },
        fields: [
          "description",
          "response",
          "category",
          "sub_category",
          "type",
          "is_synthetic",
          "source_row",
        ],
      }),
    }
  );
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Recherche Pinecone échouée (${response.status}): ${text || response.statusText}`);
  }

  const data = toRecord(parseJsonResponse(text));
  const result = toRecord(data.result);
  const hits = Array.isArray(result.hits) ? result.hits : [];
  const matches = hits
    .map(toMatch)
    .filter((match) => match.id && match.description && match.response);

  return {
    matches,
    stats: {
      indexName,
      namespace,
      usedExamples: matches.length,
      sourceColumn: "Réponse client",
      mode: "pinecone-integrated-embedding",
      usage: data.usage,
    },
  };
};

