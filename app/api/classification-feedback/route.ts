import { NextResponse } from "next/server";
import {
  saveClassificationFeedback,
  type ClassificationFeedbackStatus,
} from "@/lib/classification-feedback-db";

export const runtime = "nodejs";

type FeedbackRequest = {
  status?: unknown;
  messageOriginal?: unknown;
  messageReformule?: unknown;
  messageReformuleOriginal?: unknown;
  messageReformuleCorrige?: unknown;
  originalClassification?: {
    category?: unknown;
    subCategory?: unknown;
    type?: unknown;
  };
  correctedClassification?: {
    category?: unknown;
    subCategory?: unknown;
    type?: unknown;
  };
  generatedResponse?: unknown;
  correctedResponse?: unknown;
};

const readString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const readStatus = (value: unknown): ClassificationFeedbackStatus | null => {
  if (value === "correct" || value === "misclassified") {
    return value;
  }

  return null;
};

const readClassification = (value: FeedbackRequest["originalClassification"]) => ({
  category: readString(value?.category),
  subCategory: readString(value?.subCategory),
  type: readString(value?.type),
});

export async function POST(req: Request) {
  try {
    const body = await req.json() as FeedbackRequest;
    const status = readStatus(body.status);
    const messageOriginal = readString(body.messageOriginal);

    if (!status) {
      return NextResponse.json({ error: "Statut invalide" }, { status: 400 });
    }

    if (!messageOriginal) {
      return NextResponse.json({ error: "Message original manquant" }, { status: 400 });
    }

    const originalClassification = readClassification(body.originalClassification);
    const correctedClassification = readClassification(body.correctedClassification);
    const messageReformule = readString(body.messageReformule);
    const messageReformuleOriginal =
      readString(body.messageReformuleOriginal) || messageReformule;
    const messageReformuleCorrige =
      readString(body.messageReformuleCorrige) || messageReformule;
    const generatedResponse = readString(body.generatedResponse);
    const correctedResponse = readString(body.correctedResponse);
    const responseToSave = correctedResponse || generatedResponse;

    if (
      status === "misclassified" &&
      (!correctedClassification.category ||
        !correctedClassification.subCategory ||
        !correctedClassification.type)
    ) {
      return NextResponse.json(
        { error: "Les trois classes corrigées sont obligatoires" },
        { status: 400 }
      );
    }

    const saved = await saveClassificationFeedback({
      status,
      messageOriginal,
      messageReformule,
      messageReformuleOriginal,
      messageReformuleCorrige,
      catOriginal: originalClassification.category,
      sousCatOriginal: originalClassification.subCategory,
      typeOriginal: originalClassification.type,
      catCorrige: status === "correct"
        ? originalClassification.category
        : correctedClassification.category,
      sousCatCorrige: status === "correct"
        ? originalClassification.subCategory
        : correctedClassification.subCategory,
      typeCorrige: status === "correct"
        ? originalClassification.type
        : correctedClassification.type,
      reponseGenere: generatedResponse,
      reponseCorrige: responseToSave,
    });

    return NextResponse.json({ ok: true, id: saved.id });
  } catch (error) {
    console.error("Classification feedback save error:", error);
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    const status = message.includes("DATABASE_URL") ? 503 : 500;

    return NextResponse.json(
      { error: `Erreur serveur: ${message}` },
      { status }
    );
  }
}
