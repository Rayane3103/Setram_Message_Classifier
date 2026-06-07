import { NextResponse } from "next/server";
import { normalizePredictionResponse } from "@/lib/prediction";
import {
  searchClientResponseExamples,
  type RankedClientResponseExample,
} from "@/lib/client-response-rag";

export const runtime = "nodejs";

const OUT_OF_CONTEXT_ERROR = "MESSAGE_OUT_OF_CONTEXT";
const OUT_OF_CONTEXT_MESSAGE = "Message out of context.";
const CONTEXT_SIMILARITY_THRESHOLD = 0.4;
const CONTEXT_SEARCH_LIMIT = 3;
const CONTEXT_STRONG_KEYWORDS = [
  "tram",
  "tramway",
  "setram",
  "transport",
  "station",
  "ligne",
  "arret",
  "quai",
  "rame",
  "ticket",
  "billet",
  "carte",
  "abonnement",
  "tarif",
  "prix",
  "validation",
  "controle",
  "controleur",
  "agent",
  "chauffeur",
  "conducteur",
  "retard",
  "panne",
  "incident",
  "accident",
  "securite",
  "vol",
  "perdu",
  "perte",
  "trouve",
  "objet",
  "reclamation",
  "plainte",
  "probleme",
  "demande",
  "information",
  "renseignement",
  "question",
  "service",
  "client",
  "passager",
  "voyageur",
  "horaire",
  "emploi",
  "stage",
  "formation",
  "cv",
  "sac",
  "sachet",
  "bagage",
  "agressif",
  "agressive",
  "insulte",
  "menace",
  "comportement",
];
const CONTEXT_STOP_WORDS = new Set([
  "bonjour",
  "merci",
  "salut",
  "svp",
  "stp",
  "dans",
  "avec",
  "sans",
  "pour",
  "que",
  "qui",
  "quoi",
  "comme",
  "cela",
  "cette",
  "cette",
  "etre",
  "etre",
  "avoir",
  "faire",
  "fait",
  "meme",
  "plus",
  "moins",
  "tres",
  "vous",
  "nous",
  "leur",
  "mes",
  "ses",
  "des",
  "les",
  "une",
  "un",
  "du",
  "de",
  "la",
  "le",
  "et",
  "ou",
  "au",
  "aux",
  "en",
  "sur",
  "pas",
  "mon",
  "ma",
  "mes",
  "ton",
  "ta",
  "tes",
  "son",
  "sa",
  "ses",
]);

type ContextMatch = {
  id: string;
  score: number;
  category: string;
  subCategory: string;
  type: string;
  description: string;
};

type ContextDecision = {
  inContext: boolean;
  confidence: number;
  threshold: number;
  reason: string;
  match?: ContextMatch;
};

const getJsonFromModelText = (text: string) => {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  return jsonMatch ? jsonMatch[0] : cleaned;
};

const parseJsonFromText = (text: string) => {
  const jsonText = getJsonFromModelText(text);

  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    const preview = text.trim().slice(0, 80);
    const message = error instanceof Error ? error.message : "invalid JSON";

    throw new Error(`Reponse JSON invalide (${message}). Debut recu: ${preview}`);
  }
};

const parsePredictionPayload = (text: string) => {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  return parseJsonFromText(trimmed);
};

const formatScore = (score: number) => score.toFixed(2);

const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const tokenize = (value: string) =>
  normalizeText(value).match(/[a-z0-9]+/g) ?? [];

const extractMeaningfulTokens = (value: string) =>
  tokenize(value).filter((token) => token.length > 3 && !CONTEXT_STOP_WORDS.has(token));

const hasStrongContextKeyword = (value: string) => {
  const normalized = normalizeText(value);
  return CONTEXT_STRONG_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

const buildMatchCorpus = (match: RankedClientResponseExample) =>
  [
    match.category,
    match.subCategory,
    match.type,
    match.description,
    match.response,
  ].join(" ");

const countTokenOverlap = (queryText: string, match: RankedClientResponseExample) => {
  const queryTokens = new Set(extractMeaningfulTokens(queryText));
  const matchTokens = new Set(extractMeaningfulTokens(buildMatchCorpus(match)));

  let overlap = 0;
  for (const token of queryTokens) {
    if (matchTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
};

const hasContextSignal = (queryText: string, match?: RankedClientResponseExample) => {
  if (hasStrongContextKeyword(queryText)) {
    return true;
  }

  if (!match) {
    return false;
  }

  return countTokenOverlap(queryText, match) >= 2;
};

const summarizeMatchClassification = (match: RankedClientResponseExample) =>
  [match.category, match.subCategory, match.type].filter(Boolean).join(" / ");

const toContextMatch = (match: RankedClientResponseExample): ContextMatch => ({
  id: match.id,
  score: Number(match.score.toFixed(3)),
  category: match.category,
  subCategory: match.subCategory,
  type: match.type,
  description: match.description.slice(0, 220),
});

const buildContextReason = (
  match: RankedClientResponseExample | undefined,
  similarity: number,
  inContext: boolean,
  hasSignal: boolean
) => {
  const threshold = formatScore(CONTEXT_SIMILARITY_THRESHOLD);

  if (!match) {
    return `Aucun message historique similaire trouve dans Pinecone. Seuil requis: ${threshold}.`;
  }

  const matchSummary = summarizeMatchClassification(match) || "exemple historique";
  const score = formatScore(similarity);

  if (inContext) {
    return `Similarite Pinecone ${score}, au-dessus du seuil ${threshold}, avec un message historique SETRAM (${matchSummary}).`;
  }

  if (!hasSignal) {
    return `Similarite Pinecone ${score}, mais aucun signal metier SETRAM detecte dans le message.`;
  }

  return `Similarite Pinecone maximale ${score}, inferieure au seuil ${threshold}. Le message est trop eloigne des messages historiques SETRAM.`;
};

const checkMessageContext = async (text: string): Promise<ContextDecision> => {
  const retrieval = await searchClientResponseExamples(text, CONTEXT_SEARCH_LIMIT);
  const topMatch = retrieval.matches[0];
  const similarity = topMatch?.score ?? 0;
  const hasSignal = hasContextSignal(text, topMatch);
  const inContext = similarity >= CONTEXT_SIMILARITY_THRESHOLD && hasSignal;

  return {
    inContext,
    confidence: similarity,
    threshold: CONTEXT_SIMILARITY_THRESHOLD,
    reason: buildContextReason(topMatch, similarity, inContext, hasSignal),
    ...(topMatch ? { match: toContextMatch(topMatch) } : {}),
  };
};

export async function POST(req: Request) {
  try {
    const body = await req.json() as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";

    if (!text.trim()) {
      return NextResponse.json({ error: "Texte manquant" }, { status: 400 });
    }

    const contextDecision = await checkMessageContext(text);

    if (!contextDecision.inContext) {
      return NextResponse.json(
        {
          error: OUT_OF_CONTEXT_ERROR,
          message: OUT_OF_CONTEXT_MESSAGE,
          outOfContext: true,
          context: contextDecision,
        },
        { status: 422 }
      );
    }

    const apiUrl = process.env.NEXT_PUBLIC_PREDICTION_API_URL;
    if (!apiUrl) {
      return NextResponse.json(
        { error: "URL de l'API de prediction non configuree" },
        { status: 500 }
      );
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Server Error:", errorText);
      return NextResponse.json(
        { error: `Erreur API externe: ${response.statusText}`, detail: errorText },
        { status: response.status }
      );
    }

    const rawPredictionText = await response.text();
    const data = parsePredictionPayload(rawPredictionText);

    if (!data) {
      console.error("Prediction API returned an empty 200 response");
      return NextResponse.json(
        { error: "L'API de prediction a retourne une reponse vide" },
        { status: 502 }
      );
    }

    const result = normalizePredictionResponse(data);

    return NextResponse.json({
      ...result,
      context: contextDecision,
    });
  } catch (error) {
    console.error("Prediction API Proxy Error:", error);
    const message = error instanceof Error ? error.message : "Erreur inconnue";

    return NextResponse.json(
      { error: `Erreur serveur: ${message}` },
      { status: 500 }
    );
  }
}
