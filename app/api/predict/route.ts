import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { normalizePredictionResponse } from "@/lib/prediction";

const OUT_OF_CONTEXT_ERROR = "MESSAGE_OUT_OF_CONTEXT";
const OUT_OF_CONTEXT_MESSAGE = "Message out of context.";
const CONTEXT_CONFIDENCE_THRESHOLD = 0.65;
const GEMINI_FLASH_MODEL = "gemini-3.5-flash";

type ContextDecision = {
  inContext: boolean;
  confidence: number;
  reason: string;
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

const parseContextDecision = (text: string): ContextDecision => {
  const parsed = JSON.parse(getJsonFromModelText(text)) as Record<string, unknown>;

  if (typeof parsed.in_context !== "boolean") {
    throw new Error("Gemini context guard returned invalid JSON");
  }

  return {
    inContext: parsed.in_context,
    confidence: typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? parsed.confidence
      : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
};

const buildContextGuardPrompt = (text: string) => `
Tu es un garde de contexte strict pour un classificateur de doléances SETRAM.

Objectif:
Déterminer si le message peut raisonnablement venir d'un client/usager à propos du tramway, du transport public urbain ou d'un service client lié au tramway.

Contexte accepté:
- tramway, station, ligne, trajet, arrêt, quai, rame, transport public, correspondance;
- ticket, carte, abonnement, paiement, validation, contrôle;
- horaires, retard, panne, incident, accident, sécurité, agents, personnel;
- propreté, accessibilité, information voyageur, objet perdu, réclamation client;
- messages courts, mal écrits ou en français/arabe/anglais s'ils parlent clairement du tramway ou d'un service de transport.

Hors contexte:
- cuisine, sport, météo, politique, santé générale, finance, code informatique, devoirs scolaires;
- conversation personnelle ou sujet sans lien avec un client/usager de tramway/transport public.

Règles de décision:
- Mets "in_context": true seulement si la probabilité de lien avec le tramway/transport public est >= ${CONTEXT_CONFIDENCE_THRESHOLD}.
- Si le message contient un problème de client lié au transport public même sans dire SETRAM, accepte.
- Si le lien transport/tramway/service client est absent ou très vague, refuse.
- Ne classe pas la demande. Ne corrige pas le texte. Ne réponds pas au client.

Réponds uniquement avec un objet JSON valide, sans markdown, exactement sous cette forme:
{
  "in_context": boolean,
  "confidence": number,
  "reason": string
}

Message:
${JSON.stringify(text)}
`;

const checkMessageContext = async (text: string): Promise<ContextDecision> => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Clé API Gemini non configurée");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_FLASH_MODEL,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 180,
      responseMimeType: "application/json",
    },
  });

  const result = await model.generateContent(buildContextGuardPrompt(text));
  const response = await result.response;

  return parseContextDecision(response.text());
};

export async function POST(req: Request) {
  try {
    const body = await req.json() as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";

    if (!text.trim()) {
      return NextResponse.json({ error: "Texte manquant" }, { status: 400 });
    }

    const contextDecision = await checkMessageContext(text);
    const isInContext =
      contextDecision.inContext &&
      contextDecision.confidence >= CONTEXT_CONFIDENCE_THRESHOLD;

    if (!isInContext) {
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
        { error: "URL de l'API de prédiction non configurée" },
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

    const data = await response.json();

    const result = normalizePredictionResponse(data);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Prediction API Proxy Error:", error);
    const message = error instanceof Error ? error.message : "Erreur inconnue";

    return NextResponse.json(
      { error: `Erreur serveur: ${message}` },
      { status: 500 }
    );
  }
}
