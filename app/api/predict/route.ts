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
  inContext: boolean
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

  return `Similarite Pinecone maximale ${score}, inferieure au seuil ${threshold}. Le message est trop eloigne des messages historiques SETRAM.`;
};

const checkMessageContext = async (text: string): Promise<ContextDecision> => {
  const retrieval = await searchClientResponseExamples(text, CONTEXT_SEARCH_LIMIT);
  const topMatch = retrieval.matches[0];
  const similarity = topMatch?.score ?? 0;
  const inContext = similarity >= CONTEXT_SIMILARITY_THRESHOLD;

  return {
    inContext,
    confidence: similarity,
    threshold: CONTEXT_SIMILARITY_THRESHOLD,
    reason: buildContextReason(topMatch, similarity, inContext),
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
