export type PredictionConfidence = {
  categorie?: number;
  sous_categorie?: number;
  type?: number;
};

export type PredictionBestGuess = {
  categorie: string;
  sous_categorie: string | null;
  type: string;
};

export type PredictionResult = {
  category: string;
  subCategory: string | null;
  type: string;
  outOfContext: boolean;
  threshold?: number;
  overallConfidence?: number;
  confidence: PredictionConfidence;
  bestGuess?: PredictionBestGuess;
  note?: string;
};

export const OUT_OF_CONTEXT_NOTE = "La demande semble hors contexte.";

const toRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const readString = (value: unknown, fallback = "Inconnu") => {
  return typeof value === "string" && value.trim() ? value : fallback;
};

const readNullableString = (value: unknown) => {
  return typeof value === "string" && value.trim() ? value : null;
};

const readNumber = (value: unknown) => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const formatConfidence = (value: number) => `${Math.round(value * 100)}%`;

export const normalizePredictionResponse = (payload: unknown): PredictionResult => {
  const data = toRecord(payload);
  const confidenceData = toRecord(data.confidence);
  const bestGuessData = toRecord(data.best_guess ?? data.bestGuess);
  const outOfContext = data.out_of_context === true || data.outOfContext === true;

  const confidence: PredictionConfidence = {
    categorie: readNumber(confidenceData.categorie),
    sous_categorie: readNumber(confidenceData.sous_categorie),
    type: readNumber(confidenceData.type),
  };

  const result: PredictionResult = {
    category: outOfContext ? "Autres" : readString(data["catégorie"] ?? data.category),
    subCategory: outOfContext ? "Autres" : readNullableString(data["sous_catégorie"] ?? data.subCategory),
    type: outOfContext ? "Autres" : readString(data.type),
    outOfContext,
    confidence,
  };

  const threshold = readNumber(data.threshold);
  if (threshold !== undefined) {
    result.threshold = threshold;
  }

  const overallConfidence = readNumber(data.overall_confidence ?? data.overallConfidence);
  if (overallConfidence !== undefined) {
    result.overallConfidence = overallConfidence;
  }

  const bestGuessCategory = readNullableString(bestGuessData.categorie);
  const bestGuessType = readNullableString(bestGuessData.type);
  if (bestGuessCategory && bestGuessType) {
    result.bestGuess = {
      categorie: bestGuessCategory,
      sous_categorie: readNullableString(bestGuessData.sous_categorie),
      type: bestGuessType,
    };
  }

  if (outOfContext) {
    result.note = OUT_OF_CONTEXT_NOTE;
  }

  return result;
};
