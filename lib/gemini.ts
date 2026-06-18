import { GoogleGenerativeAI, type Part } from "@google/generative-ai";

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_GEMINI_FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
];

const unique = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

export const readGeminiApiKey = () =>
  process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";

export const readGeminiModelNames = () =>
  unique([
    process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    ...(process.env.GEMINI_FALLBACK_MODELS || DEFAULT_GEMINI_FALLBACK_MODELS.join(","))
      .split(","),
  ]);

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const errorStatus = (error: unknown) =>
  error && typeof error === "object" && "status" in error
    ? Number(error.status)
    : undefined;

export const isTransientGeminiError = (error: unknown) => {
  const message = errorText(error).toLowerCase();
  const status = errorStatus(error);

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes("high demand") ||
    message.includes("overloaded") ||
    message.includes("service unavailable") ||
    message.includes("rate limit") ||
    message.includes("quota")
  );
};

type GenerateGeminiTextOptions = {
  apiKey: string;
  prompt: string | (string | Part)[];
  generationConfig: Record<string, unknown>;
  maxAttemptsPerModel?: number;
};

export const generateGeminiText = async ({
  apiKey,
  prompt,
  generationConfig,
  maxAttemptsPerModel = 2,
}: GenerateGeminiTextOptions) => {
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelNames = readGeminiModelNames();
  let lastError: unknown;

  for (const modelName of modelNames) {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig,
    });

    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;

        return {
          text: response.text(),
          modelName,
          attempt,
        };
      } catch (error) {
        lastError = error;

        if (!isTransientGeminiError(error)) {
          throw error;
        }

        if (attempt < maxAttemptsPerModel) {
          await sleep(500 * attempt);
        }
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Gemini request failed for all configured models");
};
