import { neon } from "@neondatabase/serverless";

export type ClassificationFeedbackStatus = "correct" | "misclassified";

export type ClassificationFeedbackInput = {
  status: ClassificationFeedbackStatus;
  messageOriginal: string;
  messageReformule: string;
  catOriginal: string;
  sousCatOriginal: string;
  typeOriginal: string;
  catCorrige: string;
  sousCatCorrige: string;
  typeCorrige: string;
  reponseGenere: string;
  reponseCorrige: string;
};

let tableReadyPromise: Promise<void> | null = null;

const getSql = () => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  return neon(databaseUrl);
};

const ensureFeedbackTable = async () => {
  if (!tableReadyPromise) {
    const sql = getSql();

    tableReadyPromise = sql`
      CREATE TABLE IF NOT EXISTS classification_feedback (
        id BIGSERIAL PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('correct', 'misclassified')),
        message_original TEXT NOT NULL,
        "message_reformulé" TEXT NOT NULL DEFAULT '',
        cat_original TEXT NOT NULL DEFAULT '',
        sous_cat_original TEXT NOT NULL DEFAULT '',
        type_original TEXT NOT NULL DEFAULT '',
        "cat_corrigé" TEXT NOT NULL DEFAULT '',
        "sous_cat_corrigé" TEXT NOT NULL DEFAULT '',
        "type_corrigé" TEXT NOT NULL DEFAULT '',
        "réponse_generé" TEXT NOT NULL DEFAULT '',
        "réponse_corrigé" TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.then(() => undefined);
  }

  return tableReadyPromise;
};

export const saveClassificationFeedback = async (input: ClassificationFeedbackInput) => {
  await ensureFeedbackTable();

  const sql = getSql();
  const rows = await sql`
    INSERT INTO classification_feedback (
      status,
      message_original,
      "message_reformulé",
      cat_original,
      sous_cat_original,
      type_original,
      "cat_corrigé",
      "sous_cat_corrigé",
      "type_corrigé",
      "réponse_generé",
      "réponse_corrigé"
    )
    VALUES (
      ${input.status},
      ${input.messageOriginal},
      ${input.messageReformule},
      ${input.catOriginal},
      ${input.sousCatOriginal},
      ${input.typeOriginal},
      ${input.catCorrige},
      ${input.sousCatCorrige},
      ${input.typeCorrige},
      ${input.reponseGenere},
      ${input.reponseCorrige}
    )
    RETURNING id, created_at
  `;

  return rows[0] as { id: number; created_at: string };
};
