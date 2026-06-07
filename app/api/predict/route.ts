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
Tu es un garde de contexte permissif pour un système de classification SETRAM.

Objectif:
Décider si le message peut raisonnablement appartenir à l'univers SETRAM, tramway, transport public urbain, service client, vente, information voyageurs, objets perdus, sécurité, exploitation, recrutement, formation ou relation usager.

Ce garde ne classe pas le message. Il décide seulement si le message doit être envoyé au classificateur SETRAM.

Principe:
Évite les faux rejets. Si le message peut plausiblement correspondre à une catégorie ou sous-catégorie SETRAM, réponds in_context=true.

Accepte notamment:
- réclamations, signalements, demandes d'information, suggestions, remerciements;
- horaires, lignes, stations, rames, arrêts, perturbations, mouvement, exploitation;
- tickets, titres de transport, cartes, abonnements, tarifs, paiement, DAT, verbalisation;
- SAV, service voyageurs, modalités, conditions tarifaires;
- objets perdus, objets trouvés, vol;
- sécurité, absence de sécurité, anomalies, nuisances, confort, propreté;
- comportement du personnel, agents, contrôleurs, conducteurs, accueil;
- points de vente, espace vente fermé, manque de monnaie, systèmes indisponibles;
- emploi, stage, formation, CV, offre de service, offre de formation;
- messages courts, implicites, mal écrits, mixtes français/arabe/anglais.

Accepte même si le message ne mentionne pas explicitement SETRAM, tramway ou transport, si le scénario est plausible dans ce domaine.

Refuse seulement si le sujet principal est clairement hors du domaine SETRAM:
- cuisine, sport, météo, politique, santé générale, finance, programmation, devoirs scolaires;
- conversation personnelle sans lien plausible avec transport, service client, vente, emploi ou formation SETRAM;
- phrase absurde où un mot SETRAM/transport est seulement collé sans relation réelle.

Règle de doute:
Si le message pourrait raisonnablement être classé dans au moins une catégorie, sous-catégorie ou type SETRAM, choisis in_context=true.
Si tu hésites, préfère true.

Exemples true:
- "Quels sont les horaires ?"
- "Je veux renouveler mon abonnement"
- "Ma carte ne marche pas"
- "J'ai perdu mon sac"
- "J'ai trouvé un téléphone"
- "Le contrôleur m'a mal parlé"
- "Il n'y a pas de sécurité à la station"
- "Merci pour votre aide"
- "Où se trouve le point de vente ?"
- "Je veux déposer mon CV"
- "Avez-vous des offres de formation ?"
- "Le distributeur ne rend pas la monnaie"
- "La rame est trop sale"
- "Il y a trop de bruit près de la ligne"

Exemples false:
- "donne-moi une recette de pizza"
- "écris un code Python"
- "quel est le président de la France ?"
- "j'ai mal à la tête"
- "le chien a mangé un hamburger avec le mot tramway"

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
