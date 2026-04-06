import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { text } = await req.json();

    if (!text) {
      return NextResponse.json({ error: "Texte manquant" }, { status: 400 });
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

    // Map French fields to English camelCase for frontend consistency
    const result = {
      category: data["catégorie"] || "Inconnu",
      subCategory: data["sous_catégorie"] || "Inconnu",
      type: data["type"] || "Inconnu",
    };

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Prediction API Proxy Error:", error);
    return NextResponse.json(
      { error: `Erreur serveur: ${error.message}` },
      { status: 500 }
    );
  }
}
