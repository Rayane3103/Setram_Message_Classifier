import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { text } = await req.json();

    if (!text) {
      return NextResponse.json({ error: "Texte manquant" }, { status: 400 });
    }

    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Clé API Gemini non configurée dans .env" },
        { status: 500 }
      );
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
      Tu es un assistant de service client pour la SETRAM (Société d'Exploitation des Tramways). 
      Ta tâche est de reformuler le message suivant d'un client de manière concise.
      
      RÈGLES DE REFORMULATION :
      1. Commence obligatoirement par "Le client a dit...", "Le client a déclaré..." ou "Le client a réclamé..." selon le contexte du message.
      2. Utilise un français simple, clair et compréhensible.
      3. Donne uniquement le nécessaire, sans exagérer ni ajouter d'informations non présentes dans le message original.
      4. Garde un ton professionnel et neutre en restant strictement fidèle aux faits.
      5. Ne réponds pas au client, décris simplement et brièvement ce qu'il rapporte.

      MESSAGE DU CLIENT :
      "${text}"
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const reformulatedText = response.text().trim();

    return NextResponse.json({ reformulatedText });
  } catch (error: any) {
    console.error("Gemini API Error Detail:", {
      message: error.message,
      stack: error.stack,
      status: error.status,
    });
    return NextResponse.json(
      { error: `Erreur Gemini: ${error.message || "Inconnue"}` },
      { status: 500 }
    );
  }
}
