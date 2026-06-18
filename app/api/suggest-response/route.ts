import { NextResponse } from "next/server";
import {
  searchClientResponseExamples,
  type RankedClientResponseExample,
} from "@/lib/client-response-rag";
import { generateGeminiText, readGeminiApiKey } from "@/lib/gemini";

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

const cleanModelText = (value: string) =>
  value
    .trim()
    .replace(/^```(?:text|markdown)?/i, "")
    .replace(/```$/i, "")
    .replace(/^"|"$/g, "")
    .trim();

const stripInternalLabels = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*[-*]*\s*\(?\s*(?:status|statut)\s*\/\s*action\s*\)?\s*:?\s*/i, "")
        .replace(/^\s*[-*]*\s*(?:status|statut)\s*:?\s*/i, "")
        .replace(/^\s*[-*]*\s*action\s*:\s*/i, "")
        .trim()
    )
    .filter(Boolean)
    .join("\n")
    .replace(/^.*(?:total body words|nombre de mots|\b\d+\s*words\b).*$/gim, "")
    .replace(/\bCdlt\b\.?/gi, "")
    .replace(/\s+\n/g, "\n")
    .trim();

const ensureClientMessageEnvelope = (value: string) => {
  const cleaned = stripInternalLabels(cleanModelText(value));
  const normalized = normalizeText(cleaned);

  if (!cleaned || cleaned.length < 35) {
    return cleaned;
  }

  if (
    normalized.includes("bonjour") &&
    (normalized.includes("cordialement") || normalized.includes("service client setram"))
  ) {
    return cleaned;
  }

  const withoutGreeting = cleaned
    .replace(/^bonjour\s*[,;:]?\s*/i, "")
    .replace(/(?:cordialement[\s,;:.]*)?service client setram\s*\.?$/i, "")
    .replace(/cordialement\s*[,;:.]?$/i, "")
    .trim();

  if (!withoutGreeting || withoutGreeting.length < 35) {
    return cleaned;
  }

  return [
    "Bonjour,",
    withoutGreeting,
    "Cordialement,",
    "Service client SETRAM",
  ].join("\n\n");
};

const extractResponseBody = (value: string) =>
  value
    .replace(/^bonjour\s*[,;:]?\s*/i, "")
    .replace(/cordialement[\s\S]*$/i, "")
    .trim();

const hasCompleteClientBody = (value: string) => {
  const body = extractResponseBody(value);
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const sentenceCount = (body.match(/[.!?]/g) || []).length;

  return wordCount >= 22 && sentenceCount >= 2 && /[.!?]$/.test(body);
};

const isUsableGeneratedResponse = (value: string) => {
  const normalized = normalizeText(value.trim());
  const containsPhoneNumber = /(?:\+?\d[\s.-]?){6,}/.test(value);
  const forbiddenInternalFormat = [
    "status/action",
    "statut/action",
    "premiere reponse",
    "première réponse",
    "action en cours",
    "cdlt",
    "total body words",
    "nombre de mots",
    "words",
    "coordonnees",
    "coordonnées",
    "nous engageons",
    "engageons a vous recontacter",
  ].some((term) => normalized.includes(normalizeText(term)));

  return (
    value.trim().length >= 120 &&
    hasCompleteClientBody(value) &&
    normalized.includes("bonjour") &&
    (normalized.includes("cordialement") || normalized.includes("setram")) &&
    !containsPhoneNumber &&
    !forbiddenInternalFormat &&
    !normalized.includes("[nom_client]") &&
    !normalized.includes("[numero]") &&
    !normalized.includes("[date]")
  );
};

const redactSensitiveDetails = (value: string) =>
  value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/(?:\+?\d[\s.-]?){8,}/g, "[NUMERO]")
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "[DATE]")
    .replace(/\b\d{1,2}\s*h\s*\d{0,2}\b/gi, "[HEURE]")
    .replace(/\b((?:au\s+nom\s+de|nom\s+de|sous\s+le\s+nom\s+de)\s+)([A-ZÀ-ÖØ-Þ' -]{3,})/g, "$1[NOM_CLIENT]")
    .replace(/\s+/g, " ")
    .trim();

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

const inferCurrentIssue = (
  body: SuggestionRequest,
  matches: RankedClientResponseExample[]
) => {
  const text = normalizeText(readString(body.text));
  const topic = inferTopic(body, matches);

  if (includesAny(text, ["perdu", "perdue", "perte", "oublie", "oubliee"])) {
    if (text.includes("sachet noir")) {
      return "la perte d'un sachet noir à bord du tramway";
    }

    if (text.includes("sachet")) {
      return "la perte d'un sachet à bord du tramway";
    }

    return "la perte d'un objet à bord du tramway";
  }

  if (topic === "votre demande") {
    return "votre demande";
  }

  return `votre demande liée à ${topic.toLowerCase()}`;
};

const buildReceiptSentence = (
  body: SuggestionRequest,
  matches: RankedClientResponseExample[]
) => {
  const issue = inferCurrentIssue(body, matches);

  if (issue.startsWith("la ")) {
    return `Nous accusons réception de votre signalement concernant ${issue}.`;
  }

  return `Nous accusons réception de ${issue}.`;
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
  const action = inferServiceAction(matches);

  return [
    "Bonjour,",
    buildReceiptSentence(body, matches),
    action,
    "Nous vous remercions pour votre retour et restons à votre écoute pour tout complément d'information.",
    "Cordialement,",
    "Service client SETRAM",
  ].join("\n\n");
};

const cleanHistoricalTextForPrompt = (value: string) =>
  stripInternalLabels(redactSensitiveDetails(value))
    .replace(/\bSAV\s+SETRAM\s+SBA\b/gi, "SETRAM")
    .replace(/\bSETRAM\s+SBA\b/gi, "SETRAM")
    .replace(/\b(?:Salam|Salem)\b\s*[;,:-]?\s*/gi, "")
    .replace(/\bpremi[eè]re r[eé]ponse donn[eé]e\b/gi, "")
    .replace(/\bCdlt\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

const formatHistoricalResponse = (match: RankedClientResponseExample, index: number) => {
  const classification = [
    match.category,
    match.subCategory,
    match.type,
  ].filter(Boolean).join(" / ");

  return [
    `Exemple ${index + 1}`,
    `Classification: ${classification || "Non classé"}`,
    `Doléance historique: ${cleanHistoricalTextForPrompt(match.description).slice(0, 260)}`,
    `Réponse historique nettoyée: ${cleanHistoricalTextForPrompt(match.response).slice(0, 420)}`,
  ].join("\n");
};

const buildGeminiPrompt = (
  body: SuggestionRequest,
  matches: RankedClientResponseExample[]
) => {
  const classification = body.classification || {};
  const text = redactSensitiveDetails(readString(body.text));

  return `
Tu es un assistant SAV pour la SETRAM.

Objectif:
Rédiger une réponse professionnelle prête à envoyer au client.

Message actuel du client:
${JSON.stringify(text)}

Classification actuelle:
- Catégorie: ${readString(classification.category) || "Non analysée"}
- Sous-catégorie: ${readString(classification.subCategory) || "Non analysée"}
- Type: ${readString(classification.type) || "Non analysé"}

Réponses historiques similaires récupérées depuis la base RAG:
${matches.slice(0, 3).map(formatHistoricalResponse).join("\n\n")}

Brouillon opérationnel à reformuler:
${buildSuggestedResponse(body, matches)}

Important:
Les exemples RAG sont des traces historiques internes. Ils servent uniquement à comprendre la procédure SETRAM et le vocabulaire métier.
Ne reproduis jamais leur format interne, leurs labels ou leurs abréviations.

Format obligatoire:
- Commence par "Bonjour,"
- Le corps de la réponse doit contenir 3 phrases complètes avant la signature.
- Chaque phrase du corps doit se terminer par un point.
- Termine par "Cordialement," puis "Service client SETRAM".
- Structure attendue:
Bonjour,

Nous accusons réception de votre message concernant le cas actuel.
Votre demande sera orientée selon la procédure indiquée par les exemples RAG pertinents, sans ajouter de détail non confirmé.
Nous vous remercions pour votre retour et restons à votre écoute pour tout complément d'information.

Cordialement,
Service client SETRAM

Règles:
1. Utilise les réponses historiques et le brouillon comme inspiration métier.
2. Reformule une nouvelle réponse adaptée au message actuel; ne copie pas le brouillon ni une ancienne réponse mot à mot.
3. Ne mentionne aucun nom, date, numéro, téléphone, identifiant, montant ou détail privé qui vient des exemples historiques.
4. Ne promets pas un remboursement, une restitution, une sanction ou une intervention si ce n'est pas explicitement confirmé.
5. Si l'information est insuffisante, indique que la demande est prise en charge et transmise au service concerné.
6. Réponds directement au client avec un ton professionnel, clair et court.
7. Reste court et naturel.
8. La réponse doit être complète; ne retourne jamais une phrase fragmentée.
9. Retourne uniquement le texte final de la réponse, sans titre, sans markdown et sans explication.
10. N'écris jamais "Status/Action", "Action:", "première réponse donnée", "SAV SETRAM SBA", "Cdlt", ni aucun statut interne.
11. N'affiche jamais un calcul, un nombre de mots ou une vérification des contraintes.
12. N'invente jamais de numéro de téléphone, adresse, horaire, agence ou procédure qui n'apparaît pas dans le message actuel ou les exemples RAG nettoyés.
13. Ne dis jamais que les coordonnées du client sont enregistrées et ne promets jamais de le recontacter; utilise plutôt une formule prudente comme "nous restons à votre écoute".
`;
};

const buildGeminiRepairPrompt = (
  body: SuggestionRequest,
  matches: RankedClientResponseExample[],
  rejectedResponse: string
) => `
Tu es un assistant SAV pour la SETRAM.

Le brouillon ci-dessous a été construit à partir des résultats RAG Pinecone et doit être reformulé en réponse client finale.

Brouillon RAG:
${buildSuggestedResponse(body, matches)}

Réponse précédente rejetée:
${JSON.stringify(rejectedResponse)}

Consigne:
Réécris uniquement le brouillon RAG en français professionnel, clair et directement envoyable au client.
Le corps doit contenir 3 phrases complètes, puis la signature:

Cordialement,
Service client SETRAM

Ne coupe aucun mot. Ne retourne aucun titre, aucune liste, aucun markdown, aucun calcul et aucun statut interne.
`;

const generateSuggestedResponse = async (
  body: SuggestionRequest,
  matches: RankedClientResponseExample[]
) => {
  const apiKey = readGeminiApiKey();

  if (!apiKey) {
    throw new Error("Cle API Gemini non configuree");
  }

  const generationConfig = {
    temperature: 0.4,
    maxOutputTokens: 768,
    thinkingConfig: { thinkingBudget: 0 },
  };
  const prompt = buildGeminiPrompt(body, matches);
  const result = await generateGeminiText({
    apiKey,
    generationConfig,
    prompt,
  });
  const firstResponse = ensureClientMessageEnvelope(result.text);

  if (isUsableGeneratedResponse(firstResponse)) {
    return firstResponse;
  }

  const retryResult = await generateGeminiText({
    apiKey,
    generationConfig,
    prompt: `
${prompt}

La reponse precedente etait incomplete ou inutilisable:
${JSON.stringify(firstResponse)}

Elle etait trop courte, incomplete, ou ressemblait a un statut interne au lieu d'un message client.
Reecris maintenant une reponse directement envoyable au client avec 3 phrases completes dans le corps, puis la signature obligatoire.
`,
  });
  const secondResponse = ensureClientMessageEnvelope(retryResult.text);

  if (isUsableGeneratedResponse(secondResponse)) {
    return secondResponse;
  }

  const repairResult = await generateGeminiText({
    apiKey,
    generationConfig,
    prompt: buildGeminiRepairPrompt(body, matches, secondResponse),
  });

  return ensureClientMessageEnvelope(repairResult.text);
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

    let suggestedResponse = buildSuggestedResponse(body, matches);
    let generationMode = "template-fallback";
    let generationDebug: string | undefined;

    try {
      const generatedResponse = await generateSuggestedResponse(body, matches);
      if (isUsableGeneratedResponse(generatedResponse)) {
        suggestedResponse = generatedResponse;
        generationMode = "gemini-rag-reformulation";
      } else {
        generationDebug = `Gemini output rejected: ${generatedResponse.slice(0, 500)}`;
      }
    } catch (generationError) {
      console.error("Gemini RAG reformulation error:", generationError);
      generationDebug = generationError instanceof Error
        ? generationError.message
        : "Unknown Gemini generation error";
    }

    return NextResponse.json({
      suggestedResponse,
      matches: matches.map(toClientMatch),
      retrievalStats: {
        ...retrieval.stats,
        generationMode,
        ...(process.env.NODE_ENV !== "production" && generationDebug ? { generationDebug } : {}),
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
