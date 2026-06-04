import { NextResponse } from "next/server";
import {
  searchClientResponseExamples,
  type RankedClientResponseExample,
} from "@/lib/client-response-rag";

export const runtime = "nodejs";

type SuggestionRequest = {
  text?: unknown;
  classification?: {
    category?: unknown;
    subCategory?: unknown;
    type?: unknown;
  };
};

const readString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const includesAny = (value: string, terms: string[]) =>
  terms.some((term) => value.includes(term));

const buildRetrievalQuery = (body: SuggestionRequest) => {
  const text = readString(body.text);
  const classification = body.classification || {};

  return [
    text,
    readString(classification.category),
    readString(classification.subCategory),
    readString(classification.type),
  ]
    .filter(Boolean)
    .join(" ");
};

const inferTopic = (body: SuggestionRequest, matches: RankedClientResponseExample[]) => {
  const classification = body.classification || {};

  return (
    readString(classification.type) ||
    readString(classification.subCategory) ||
    readString(classification.category) ||
    matches[0]?.type ||
    "votre demande"
  );
};

const inferServiceAction = (matches: RankedClientResponseExample[]) => {
  const combined = normalizeText(
    matches
      .map((match) => [
        match.category,
        match.subCategory,
        match.type,
        match.description,
        match.response,
      ].join(" "))
      .join(" ")
  );

  if (includesAny(combined, ["objet", "perdu", "trouve"])) {
    return "Votre demande sera orientée vers le service compétent afin de vérifier les éléments disponibles.";
  }

  if (includesAny(combined, ["vente", "commercial", "abonnement", "carte"])) {
    return "Votre demande sera transmise au service commercial afin de vérifier votre dossier et de vous orienter vers la suite appropriée.";
  }

  if (includesAny(combined, ["exploitation", "ligne", "station", "rame", "retard", "panne"])) {
    return "Votre signalement sera transmis au service exploitation afin de vérifier la situation sur la ligne concernée.";
  }

  if (includesAny(combined, ["securite", "controle", "agent"])) {
    return "Votre réclamation sera remontée au service concerné afin d'examiner les faits signalés.";
  }

  return "Votre demande a bien été prise en charge et sera transmise au service concerné pour traitement.";
};

const buildSuggestedResponse = (
  body: SuggestionRequest,
  matches: RankedClientResponseExample[]
) => {
  const topic = inferTopic(body, matches);
  const topicLabel = topic === "votre demande"
    ? "votre demande"
    : `votre demande liée à ${topic.toLowerCase()}`;
  const action = inferServiceAction(matches);

  return [
    "Bonjour,",
    `Nous accusons réception de ${topicLabel}.`,
    action,
    "Nous vous remercions pour votre retour et restons à votre écoute pour tout complément d'information.",
    "Cordialement,",
    "Service client SETRAM",
  ].join("\n\n");
};

const toClientMatch = (example: RankedClientResponseExample) => ({
  id: example.id,
  score: Number(example.score.toFixed(3)),
  category: example.category,
  subCategory: example.subCategory,
  type: example.type,
  description: example.description.slice(0, 180),
});

export async function POST(req: Request) {
  try {
    const body = await req.json() as SuggestionRequest;
    const text = readString(body.text);

    if (!text) {
      return NextResponse.json({ error: "Texte manquant" }, { status: 400 });
    }

    const retrieval = await searchClientResponseExamples(buildRetrievalQuery(body), 5);
    const matches = retrieval.matches;

    if (!matches.length) {
      return NextResponse.json(
        { error: "Aucun exemple RAG pertinent trouvé" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      suggestedResponse: buildSuggestedResponse(body, matches),
      matches: matches.map(toClientMatch),
      retrievalStats: {
        ...retrieval.stats,
      },
    });
  } catch (error) {
    console.error("Suggested response API error:", error);
    const message = error instanceof Error ? error.message : "Erreur inconnue";

    return NextResponse.json(
      { error: `Erreur serveur: ${message}` },
      { status: 500 }
    );
  }
}
