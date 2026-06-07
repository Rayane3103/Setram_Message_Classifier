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

const parseJsonFromText = (text: string) => {
  const jsonText = getJsonFromModelText(text);

  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    const preview = text.trim().slice(0, 80);
    const message = error instanceof Error ? error.message : "invalid JSON";

    throw new Error(`Réponse JSON invalide (${message}). Début reçu: ${preview}`);
  }
};

const localContextFallback = (text: string): ContextDecision => {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const includesAny = (keywords: string[]) =>
    keywords.some((keyword) => normalized.includes(keyword));
  const transportAnchors = [
    "tram",
    "tramway",
    "setram",
    "transport",
  ];
  const serviceSignals = [
    "station",
    "ligne",
    "rame",
    "quai",
    "arret",
    "ticket",
    "carte",
    "abonnement",
    "controle",
    "agent",
    "chauffeur",
    "conducteur",
    "driver",
    "retard",
    "panne",
    "incident",
    "accident",
    "securite",
    "objet perdu",
    "perdu",
    "reclamation",
    "plainte",
    "probleme",
    "agressif",
    "agressive",
    "speeding",
    "vitesse",
    "conduit",
    "driving",
  ];
  const anchorMatches = transportAnchors.filter((keyword) => normalized.includes(keyword));
  const signalMatches = serviceSignals.filter((keyword) => normalized.includes(keyword));
  const safetySignals = ["agressif", "agressive", "speeding", "vitesse", "conduit", "driving"];
  const fareSignals = ["ticket", "billet", "titre", "carte", "abonnement", "paiement", "validation", "valider"];
  const inspectionSignals = ["controle", "controleur", "controler", "verificateur", "amende", "pv"];
  const staffSignals = ["agent", "personnel", "chauffeur", "conducteur", "driver", "controleur"];
  const complaintSignals = [
    "mal parle",
    "mal parler",
    "mal comport",
    "comportement",
    "impoli",
    "agressif",
    "agressive",
    "insulte",
    "menace",
    "plainte",
    "reclamation",
    "probleme",
    "refuse",
  ];
  const hasFareSignal = includesAny(fareSignals);
  const hasInspectionSignal = includesAny(inspectionSignals);
  const hasStaffSignal = includesAny(staffSignals);
  const hasComplaintSignal = includesAny(complaintSignals);
  const hasTransportRoleSafetyIssue =
    hasStaffSignal &&
    signalMatches.some((keyword) => safetySignals.includes(keyword));
  const hasStrongServiceSignal = signalMatches.some((keyword) => !safetySignals.includes(keyword));
  const hasFareInspectionScenario =
    (hasFareSignal && hasInspectionSignal) ||
    (hasInspectionSignal && hasStaffSignal && hasComplaintSignal) ||
    (hasFareSignal && hasStaffSignal && hasComplaintSignal);
  const hasStaffComplaintScenario = hasStaffSignal && hasComplaintSignal;
  const inContext =
    (anchorMatches.length > 0 && hasStrongServiceSignal) ||
    hasTransportRoleSafetyIssue ||
    hasFareInspectionScenario ||
    hasStaffComplaintScenario;
  const matched = [...anchorMatches, ...signalMatches].slice(0, 5);
  const confidence = inContext
    ? hasFareInspectionScenario
      ? 0.82
      : hasStaffComplaintScenario
        ? 0.72
        : 0.75
    : anchorMatches.length > 0
      ? 0.5
      : 0.35;

  return {
    inContext,
    confidence,
    reason: inContext
      ? hasFareInspectionScenario
        ? "Fallback sémantique simple: réclamation liée à une interaction de contrôle/titre de transport"
        : hasStaffComplaintScenario
          ? "Fallback sémantique simple: réclamation liée au comportement d'un membre du personnel"
          : `Fallback sémantique simple: scénario service transport détecté (${matched.join(", ")})`
      : anchorMatches.length > 0
        ? "Fallback sémantique simple: mot transport isolé sans plainte/service clair"
        : "Fallback sémantique simple: aucun lien transport/service détecté",
  };
};

const parseContextDecision = (text: string): ContextDecision => {
  const parsed = parseJsonFromText(text) as Record<string, unknown>;

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

const parsePredictionPayload = (text: string) => {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  return parseJsonFromText(trimmed);
};

const buildContextGuardPrompt = (text: string) => `
Tu es un garde de contexte permissif pour un système de classification des messages envoyés par des clients ou passagers d'une société de tramway.

Ta tâche:
Dire si le message peut être traité par le système SETRAM ou s'il est clairement hors contexte.

Réponds in_context=true si le message peut concerner, même indirectement:
- tramway, transport, station, rame, ligne, arrêt, trajet;
- client, passager, ticket, abonnement, carte, tarif, paiement;
- agent, conducteur, contrôleur, sécurité, vol, agression, objet perdu/trouvé;
- horaire, retard, panne, réclamation, signalement, suggestion, information,demande d'informations, question sur le tramway et la societé du tramway setram,  remerciement;
- emploi, stage, formation, CV ou service lié à la société.

Sois permissif:
Si le message est ambigu mais pourrait venir d'un client/passager ou être traité par une société de tramway, réponds true.

Réponds false seulement si le message est clairement sans lien avec une société de tramway ou ses services.

Réponds uniquement avec un objet JSON valide:
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

  try {
    return parseContextDecision(response.text());
  } catch (error) {
    console.warn("Gemini context guard returned non-JSON, using local fallback:", error);
    return localContextFallback(text);
  }
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
