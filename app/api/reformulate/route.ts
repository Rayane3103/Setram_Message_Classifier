import { generateGeminiText, readGeminiApiKey } from "@/lib/gemini";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ReformulateRequest = {
  text?: unknown;
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

const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, " ").trim();

const buildFallbackReformulation = (text: string) => {
  const cleaned = normalizeWhitespace(text).replace(/[.!?]+$/g, "");
  const intro = /(?:reclam|plainte|probleme|panne|retard|perdu|perte|vol|incident)/i.test(cleaned)
    ? "Le client a reclame"
    : "Le client a declare";

  return `${intro} que ${cleaned}.`;
};

const isUsableReformulation = (value: string) => {
  const cleaned = normalizeWhitespace(value);

  return (
    cleaned.length >= 20 &&
    /^(Le client a dit|Le client a declare|Le client a reclame)/i.test(
      cleaned
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
    )
  );
};

const buildGeminiPrompt = (text: string) => `
Tu es un assistant de service client pour la SETRAM (Societe d'Exploitation des Tramways).
Ta tache est de reformuler le message suivant d'un client de maniere concise.

REGLES DE REFORMULATION :
1. Commence obligatoirement par "Le client a dit...", "Le client a declare..." ou "Le client a reclame..." selon le contexte du message.
2. Utilise un francais simple, clair et comprehensible.
3. Donne uniquement le necessaire, sans exagerer ni ajouter d'informations non presentes dans le message original.
4. Garde un ton professionnel et neutre en restant strictement fidele aux faits.
5. Ne reponds pas au client, decris simplement et brievement ce qu'il rapporte.

MESSAGE DU CLIENT :
${JSON.stringify(text)}
`;

const generateReformulation = async (text: string) => {
  const apiKey = readGeminiApiKey();

  if (!apiKey) {
    throw new Error("Cle API Gemini non configuree");
  }

  const generationConfig = {
    temperature: 0.2,
    maxOutputTokens: 256,
    thinkingConfig: { thinkingBudget: 0 },
  };

  const firstResult = await generateGeminiText({
    apiKey,
    generationConfig,
    prompt: buildGeminiPrompt(text),
  });
  const reformulatedText = cleanModelText(firstResult.text);

  if (isUsableReformulation(reformulatedText)) {
    return reformulatedText;
  }

  const retryResult = await generateGeminiText({
    apiKey,
    generationConfig,
    prompt: `
${buildGeminiPrompt(text)}

La reformulation precedente etait inutilisable:
${JSON.stringify(reformulatedText)}

Reecris uniquement une reformulation courte qui commence par "Le client a dit...", "Le client a declare..." ou "Le client a reclame...".
`,
  });

  return cleanModelText(retryResult.text);
};

export async function POST(req: Request) {
  try {
    const body = await req.json() as ReformulateRequest;
    const text = readString(body.text);

    if (!text) {
      return NextResponse.json({ error: "Texte manquant" }, { status: 400 });
    }

    let reformulatedText = buildFallbackReformulation(text);
    let generationMode = "template-fallback";
    let generationDebug: string | undefined;

    try {
      const generatedReformulation = await generateReformulation(text);
      if (isUsableReformulation(generatedReformulation)) {
        reformulatedText = generatedReformulation;
        generationMode = "gemini-reformulation";
      } else {
        generationDebug = `Gemini output rejected: ${generatedReformulation.slice(0, 500)}`;
      }
    } catch (generationError) {
      console.error("Gemini reformulation error:", generationError);
      generationDebug = generationError instanceof Error
        ? generationError.message
        : "Unknown Gemini reformulation error";
    }

    return NextResponse.json({
      reformulatedText,
      generationMode,
      ...(process.env.NODE_ENV !== "production" && generationDebug ? { generationDebug } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Inconnue";
    const stack = error instanceof Error ? error.stack : undefined;
    const status = error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;

    console.error("Reformulation API Error Detail:", {
      message,
      stack,
      status,
    });
    return NextResponse.json(
      { error: `Erreur reformulation: ${message}` },
      { status: 500 }
    );
  }
}
