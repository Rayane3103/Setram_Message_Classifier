"use client";

import React, { useState, useRef } from 'react';
import Image from 'next/image';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  OUT_OF_CONTEXT_NOTE,
  formatConfidence,
  normalizePredictionResponse,
  type PredictionResult
} from '@/lib/prediction';
import {
  Send,
  Upload,
  FileText,
  Layers,
  Tag,
  ArrowRight,
  Activity,
  AlertCircle,
  Mic,
  MicOff,
  Download,
  Sparkles,
  Check,
  X,
  Copy
} from 'lucide-react';

const fileToGenerativePart = async (file: File) => {
  const base64EncodedDataPromise = new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.readAsDataURL(file);
  });
  return {
    inlineData: {
      data: await base64EncodedDataPromise,
      mimeType: file.type
    },
  };
};

const OUT_OF_CONTEXT_API_ERROR = "MESSAGE_OUT_OF_CONTEXT";

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const readResponseString = (value: unknown, fallback: string) => {
  return typeof value === "string" && value.trim() ? value : fallback;
};

const readNumberValue = (value: unknown, fallback = 0) => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
};

type SuggestedResponseMatch = {
  id: string;
  score: number;
  category: string;
  subCategory: string;
  type: string;
  description: string;
};

type SuggestedResponseResult = {
  suggestedResponse: string;
  matches: SuggestedResponseMatch[];
  retrievalStats: {
    corpusSize: number;
    usedExamples: number;
    sourceColumn: string;
    mode?: string;
  };
};

const normalizeSuggestedResponse = (data: Record<string, unknown>): SuggestedResponseResult => {
  const stats = asRecord(data.retrievalStats);
  const matches = Array.isArray(data.matches)
    ? data.matches.map((item) => {
      const match = asRecord(item);

      return {
        id: readResponseString(match.id, ""),
        score: readNumberValue(match.score),
        category: readResponseString(match.category, "Non classé"),
        subCategory: readResponseString(match.subCategory, ""),
        type: readResponseString(match.type, "Non classé"),
        description: readResponseString(match.description, ""),
      };
    }).filter((match) => match.id && match.description)
    : [];

  return {
    suggestedResponse: readResponseString(data.suggestedResponse, ""),
    matches,
    retrievalStats: {
      corpusSize: readNumberValue(stats.corpusSize),
      usedExamples: readNumberValue(stats.usedExamples, matches.length),
      sourceColumn: readResponseString(stats.sourceColumn, "Réponse client"),
      mode: readResponseString(stats.mode, ""),
    },
  };
};

type BrowserSpeechRecognitionResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type BrowserSpeechRecognitionErrorEvent = {
  error: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type WindowWithSpeechRecognition = Window & typeof globalThis & {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
};

const GEMINI_FLASH_MODEL = "gemini-3.5-flash";

export default function Dashboard() {
  const [inputText, setInputText] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [results, setResults] = useState<PredictionResult | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isOCRLoading, setIsOCRLoading] = useState(false);
  const [isReformulating, setIsReformulating] = useState(false);
  const [showReformulateModal, setShowReformulateModal] = useState(false);
  const [reformulatedText, setReformulatedText] = useState("");
  const [isSuggestingResponse, setIsSuggestingResponse] = useState(false);
  const [suggestedResponse, setSuggestedResponse] = useState<SuggestedResponseResult | null>(null);
  const [suggestionCopied, setSuggestionCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAnalyse = async () => {
    if (!inputText.trim()) return;

    setIsAnalyzing(true);
    try {
      const response = await fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: inputText }),
      });

      const rawText = await response.text();
      console.log("Raw Prediction response:", response.status, rawText);
      const data = parseJsonObject(rawText);

      if (!response.ok) {
        if (response.status === 422 && data?.error === OUT_OF_CONTEXT_API_ERROR) {
          setResults(null);
          alert(readResponseString(data.message, "Message out of context."));
          return;
        }

        throw new Error(readResponseString(data?.error, `API responded with ${response.status}: ${rawText}`));
      }

      if (!data) {
        throw new Error("La route /api/predict a retourne une reponse vide. Relancez l'application avec next dev ou next start.");
      }

      setResults(normalizePredictionResponse(data));
    } catch (error) {
      console.error("Analysis error:", error);
      alert(error instanceof Error && error.message
        ? error.message
        : "Une erreur est survenue lors de l'analyse.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const toggleListening = () => {
    if (typeof window !== 'undefined') {
      const speechWindow = window as WindowWithSpeechRecognition;
      const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;

      if (!SpeechRecognition) {
        alert("Désolé, votre navigateur ne supporte pas la reconnaissance vocale.");
        return;
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'fr-FR'; // Default to French for SETRAM

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript;
        if (!transcript) return;

        setInputText((prev) => prev ? `${prev} ${transcript}` : transcript);
        setIsListening(false);
      };

      recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      if (isListening) {
        recognition.stop();
      } else {
        recognition.start();
      }
    }
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsOCRLoading(true);
    try {
      const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (!apiKey) throw new Error("Clé API Gemini non configurée");

      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: GEMINI_FLASH_MODEL });

      const imagePart = await fileToGenerativePart(file);
      const prompt = "Extrais tout le texte de cette image de manière précise. Si c'est manuscrit, lis-le attentivement. Le texte peut être en français, anglais ou arabe. Renvoie uniquement le texte extrait tel quel, sans commentaires ni traduction.";

      const result = await model.generateContent([prompt, imagePart]);
      const response = await result.response;
      let text = response.text().trim();
      
      // Nettoyer les guillemets si Gemini en a ajouté
      text = text.replace(/^"|"$/g, '').trim();

      setInputText(text);
    } catch (error) {
      console.error("OCR (Gemini) Error:", error);
      alert("Erreur lors de l'extraction du texte. Veuillez vérifier votre clé API ou réessayer.");
    } finally {
      setIsOCRLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleReformulate = async () => {
    if (!inputText.trim()) return;

    setIsReformulating(true);
    try {
      const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (!apiKey) throw new Error("Clé API Gemini non configurée");

      const genAI = new GoogleGenerativeAI(apiKey);
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
        "${inputText}"
      `;

      const model = genAI.getGenerativeModel({ model: GEMINI_FLASH_MODEL });
      const result = await model.generateContent(prompt);
      const response = await result.response;

      const text = response.text().trim();

      setReformulatedText(text);
      setShowReformulateModal(true);
    } catch (error) {
      console.error("Reformulation error:", error);
      alert("Une erreur est survenue lors de la reformulation. Vos limites Gemini sont peut-être épuisées.");
    } finally {
      setIsReformulating(false);
    }
  };

  const handleSuggestResponse = async () => {
    if (!inputText.trim()) return;

    setIsSuggestingResponse(true);
    setSuggestionCopied(false);
    try {
      const response = await fetch('/api/suggest-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText,
          classification: results ? {
            category: results.category,
            subCategory: results.subCategory,
            type: results.type,
          } : undefined,
        }),
      });

      const rawText = await response.text();
      const data = parseJsonObject(rawText);

      if (!response.ok) {
        throw new Error(readResponseString(data?.error, `API responded with ${response.status}: ${rawText}`));
      }

      if (!data) {
        throw new Error("API returned an empty response");
      }

      const normalizedSuggestion = normalizeSuggestedResponse(data);
      if (!normalizedSuggestion.suggestedResponse) {
        throw new Error("La route RAG n'a pas renvoyé de réponse suggérée.");
      }

      setSuggestedResponse(normalizedSuggestion);
    } catch (error) {
      console.error("Suggested response error:", error);
      alert("Une erreur est survenue lors de la génération de la réponse suggérée.");
    } finally {
      setIsSuggestingResponse(false);
    }
  };

  const handleCopySuggestedResponse = async () => {
    if (!suggestedResponse?.suggestedResponse) return;

    try {
      await navigator.clipboard.writeText(suggestedResponse.suggestedResponse);
      setSuggestionCopied(true);
      window.setTimeout(() => setSuggestionCopied(false), 1800);
    } catch (error) {
      console.error("Copy suggested response error:", error);
      alert("Impossible de copier la réponse suggérée.");
    }
  };

  const triggerUpload = () => {
    fileInputRef.current?.click();
  };

  const handleExportJSON = () => {
    if (!results) return;

    const exportData = {
      timestamp: new Date().toISOString(),
      message: inputText,
      classification: {
        category: results.category,
        subCategory: results.subCategory,
        type: results.type,
        outOfContext: results.outOfContext,
        threshold: results.threshold,
        overallConfidence: results.overallConfidence,
        confidence: results.confidence,
        bestGuess: results.bestGuess
      }
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    link.download = `setram_doleance_${dateStr}_${timeStr}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* Navigation */}
      <nav className="bg-white border-b border-gray-100 px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <Image
            src="/setram_logo.png"
            alt="SETRAM Logo"
            width={120}
            height={40}
            className="object-contain w-[80px] sm:w-[120px] shrink-0"
            priority
          />
          <div className="h-6 w-px bg-gray-200 hidden sm:block"></div>
          <h1 className="text-sm sm:text-xl font-bold text-brand-navy tracking-tight truncate">Classificateur de Doléances</h1>
        </div>

        <button className="bg-brand-cyan hover:bg-cyan-500 text-white px-3 sm:px-5 py-2 rounded-full text-xs sm:text-sm font-semibold transition-all duration-200 shadow-sm items-center gap-2 hidden sm:flex">
          Transmettre une doléance
        </button>
      </nav>

      <main className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-8 space-y-5 sm:space-y-8">
        {/* Header Section */}
        <div className="space-y-2">
          <h2 className="text-xl sm:text-3xl font-extrabold text-brand-navy">Dashboard d&apos;Analyse</h2>
          <p className="text-sm sm:text-base text-gray-500 max-w-2xl">
            Utilisez notre intelligence artificielle pour classifier automatiquement vos requêtes et documents selon les normes SETRAM.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* AI Input Section */}
          <section className="lg:col-span-12">
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-4 sm:space-y-6">
              <div className="flex items-center gap-3 pb-2 border-b border-gray-50">
                <Activity size={20} className="text-brand-navy" />
                <h3 className="font-bold text-brand-navy text-lg">Nouvelle Analyse</h3>
              </div>

              <div className="space-y-4">
                <textarea
                  value={inputText}
                  onChange={(e) => {
                    setInputText(e.target.value);
                    setSuggestedResponse(null);
                    setSuggestionCopied(false);
                  }}
                  placeholder="Décrivez votre requête ou le contenu du document ici..."
                  className="w-full min-h-[120px] sm:min-h-[160px] p-3 sm:p-4 bg-gray-50 border border-gray-100 rounded-lg focus:ring-2 focus:ring-brand-cyan focus:border-transparent outline-none transition-all resize-none text-sm sm:text-base text-gray-700"
                />

                <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-between gap-3 sm:gap-4">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleImageUpload}
                      className="hidden"
                      accept="image/*"
                    />
                    <button
                      onClick={triggerUpload}
                      disabled={isOCRLoading}
                      className={`
                        flex items-center gap-2 font-semibold transition-all px-3 sm:px-4 py-2 rounded-lg group text-sm
                        ${isOCRLoading
                          ? 'bg-gray-100 text-gray-400 cursor-wait'
                          : 'bg-cyan-50 text-brand-cyan hover:bg-cyan-100'}
                      `}
                    >
                      {isOCRLoading ? (
                        <div className="w-4 h-4 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin"></div>
                      ) : (
                        <Upload size={16} />
                      )}
                      <span className="hidden xs:inline">{isOCRLoading ? "Extraction..." : "Upload"}</span>
                      {!isOCRLoading && <ArrowRight size={14} className="group-hover:translate-x-1 transition-transform hidden sm:block" />}
                    </button>

                    <button
                      onClick={toggleListening}
                      className={`
                        flex items-center gap-2 font-semibold transition-all px-3 sm:px-4 py-2 rounded-lg text-sm
                        ${isListening
                          ? 'bg-red-50 text-red-500 ring-2 ring-red-100 animate-[pulse-mic_2s_infinite]'
                          : 'bg-brand-cyan/10 text-brand-cyan hover:bg-brand-cyan/20'}
                      `}
                    >
                      {isListening ? <MicOff size={16} /> : <Mic size={16} />}
                      <span className="hidden xs:inline">{isListening ? "Écoute..." : "Vocal"}</span>
                    </button>
                  </div>

                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
                    <button
                      onClick={handleSuggestResponse}
                      disabled={isSuggestingResponse || !inputText.trim()}
                      className={`
                        px-4 sm:px-6 py-2.5 sm:py-3 rounded-lg font-bold transition-all duration-300 text-sm sm:text-base border flex items-center justify-center gap-2
                        ${isSuggestingResponse
                          ? 'bg-cyan-50 text-brand-cyan border-brand-cyan/20 cursor-wait'
                          : 'bg-white text-brand-navy border-brand-cyan/30 hover:bg-cyan-50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed'}
                      `}
                    >
                      {isSuggestingResponse ? (
                        <div className="w-4 h-4 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin"></div>
                      ) : (
                        <Sparkles size={16} />
                      )}
                      {isSuggestingResponse ? "Suggestion..." : "Suggérer réponse"}
                    </button>

                    <button
                      onClick={handleReformulate}
                      disabled={isReformulating || !inputText.trim()}
                      className={`
                        relative overflow-hidden px-4 sm:px-6 py-2.5 sm:py-3 rounded-lg font-bold text-white transition-all duration-300 text-sm sm:text-base
                        ${isReformulating
                          ? 'bg-brand-cyan/50 cursor-wait'
                          : 'bg-gradient-to-r from-brand-cyan to-brand-navy hover:shadow-lg active:scale-95 disabled:opacity-50'}
                      `}
                    >
                      <span className="relative z-10 flex items-center justify-center gap-2">
                        {isReformulating ? (
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                          <Sparkles size={16} />
                        )}
                        {isReformulating ? "Reformulation..." : "Reformuler avec IA"}
                      </span>
                    </button>

                    <button
                      onClick={handleAnalyse}
                      disabled={isAnalyzing || !inputText.trim()}
                      className={`
                        relative overflow-hidden px-5 sm:px-8 py-2.5 sm:py-3 rounded-lg font-bold text-white transition-all duration-300 text-sm sm:text-base
                        ${isAnalyzing ? 'bg-brand-navy/80 cursor-wait' : 'bg-brand-navy hover:bg-navy-900 active:scale-95 shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed'}
                      `}
                    >
                      {isAnalyzing && (
                        <div className="absolute inset-0 bg-brand-navy animate-[pulse-custom_1.5s_infinite] opacity-50"></div>
                      )}
                      <span className="relative z-10 flex items-center justify-center gap-2">
                        {isAnalyzing ? "Analyse en cours..." : "Lancer l'analyse"}
                        {!isAnalyzing && <Send size={16} />}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {(isSuggestingResponse || suggestedResponse) && (
            <section className="lg:col-span-12">
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-4 sm:space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-50 pb-4">
                  <div className="flex items-center gap-3">
                    <Sparkles size={20} className="text-brand-cyan" />
                    <h3 className="font-bold text-brand-navy text-lg">Réponse suggérée</h3>
                  </div>
                  {suggestedResponse && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-gray-500">
                      <span className="rounded-lg border border-brand-cyan/20 bg-cyan-50 px-3 py-1 text-brand-navy">
                        {suggestedResponse.retrievalStats.usedExamples} exemples RAG
                      </span>
                      <span className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-1">
                        {suggestedResponse.retrievalStats.sourceColumn}
                      </span>
                    </div>
                  )}
                </div>

                {isSuggestingResponse ? (
                  <div className="flex items-center gap-3 rounded-lg border border-brand-cyan/20 bg-cyan-50/40 p-4 text-sm font-semibold text-brand-navy">
                    <div className="w-4 h-4 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin"></div>
                    Génération de la réponse...
                  </div>
                ) : suggestedResponse && (
                  <>
                    <div className="rounded-lg border border-brand-cyan/20 bg-cyan-50/30 p-4 text-sm sm:text-base leading-7 text-brand-navy whitespace-pre-line">
                      {suggestedResponse.suggestedResponse}
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 sm:gap-3">
                      <button
                        onClick={handleCopySuggestedResponse}
                        className="px-4 py-2.5 rounded-lg font-bold text-sm border border-gray-200 text-brand-navy hover:bg-gray-50 transition-all flex items-center justify-center gap-2"
                      >
                        {suggestionCopied ? <Check size={16} /> : <Copy size={16} />}
                        {suggestionCopied ? "Copié" : "Copier"}
                      </button>
                      <button
                        onClick={handleSuggestResponse}
                        disabled={isSuggestingResponse || !inputText.trim()}
                        className="px-4 py-2.5 rounded-lg font-bold text-sm bg-brand-navy text-white hover:bg-navy-900 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                      >
                        <Sparkles size={16} />
                        Régénérer
                      </button>
                    </div>

                    {suggestedResponse.matches.length > 0 && (
                      <div className="border-t border-gray-50 pt-4 space-y-3">
                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                          Exemples RAG retenus
                        </p>
                        <div className="divide-y divide-gray-100">
                          {suggestedResponse.matches.slice(0, 3).map((match) => (
                            <div key={match.id} className="py-3 flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                              <div className="min-w-0 space-y-1">
                                <p className="text-sm font-bold text-brand-navy">{match.type}</p>
                                <p className="text-xs sm:text-sm text-gray-500 leading-5">{match.description}</p>
                              </div>
                              <span className="shrink-0 text-[11px] font-bold text-brand-cyan bg-cyan-50 border border-brand-cyan/20 rounded-lg px-2.5 py-1">
                                score {match.score}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
          )}

          {/* Results Section */}
          <section className="lg:col-span-12 space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between px-2 gap-3">
              <h3 className="font-bold text-brand-navy text-sm sm:text-lg uppercase tracking-wider flex items-center gap-2">
                <div className="w-2 h-5 sm:h-6 bg-brand-cyan rounded-full"></div>
                Résultats de Classification
              </h3>
              <div className="flex flex-wrap items-center gap-3">
                {results && (
                  <>
                    {typeof results.overallConfidence === "number" && (
                      <span className="text-xs font-bold text-brand-navy bg-cyan-50 border border-brand-cyan/20 px-3 sm:px-4 py-2 rounded-lg">
                        Confiance {formatConfidence(results.overallConfidence)}
                      </span>
                    )}
                    <button
                      onClick={handleExportJSON}
                      className="flex items-center gap-2 text-brand-navy font-bold text-xs bg-gray-100 hover:bg-gray-200 px-3 sm:px-4 py-2 rounded-lg transition-all border border-gray-200"
                    >
                      <Download size={14} />
                      <span className="hidden sm:inline">EXPORTER</span> (JSON)
                    </button>
                    <span className="text-xs font-medium text-gray-400 hidden sm:inline">ANALYSE TERMINÉE</span>
                  </>
                )}
              </div>
            </div>

            {results?.outOfContext && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700">
                <AlertCircle size={18} className="mt-0.5 shrink-0" />
                <span>{results.note || OUT_OF_CONTEXT_NOTE}</span>
              </div>
            )}

            <div className="relative">
              {/* Step indicator line */}
              <div className="hidden md:block absolute top-[60px] left-[15%] right-[15%] h-[2px] bg-brand-navy/10 z-0"></div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6 relative z-10">
                {/* Card 1: Catégorie */}
                <div className="bg-white border border-gray-100 rounded-xl p-5 sm:p-8 shadow-sm text-center space-y-3 sm:space-y-4 group hover:border-brand-cyan/30 transition-all duration-300">
                  <div className="mx-auto w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-white border-2 border-brand-navy flex items-center justify-center text-brand-navy group-hover:bg-brand-navy group-hover:text-white transition-colors duration-300 shadow-sm relative z-10">
                    <FileText size={22} className="sm:hidden" strokeWidth={1.5} />
                    <FileText size={28} className="hidden sm:block" strokeWidth={1.5} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] sm:text-xs font-bold text-gray-400 uppercase tracking-widest">Catégorie</p>
                    <p className={`text-lg sm:text-2xl font-black text-brand-navy min-h-[1.5rem] sm:min-h-[2rem] transition-opacity duration-500 ${results ? 'opacity-100' : 'opacity-20'}`}>
                      {results?.category || "---"}
                    </p>
                  </div>
                </div>

                {/* Card 2: Sous-Catégorie */}
                <div className="bg-white border border-gray-100 rounded-xl p-5 sm:p-8 shadow-sm text-center space-y-3 sm:space-y-4 group hover:border-brand-cyan/30 transition-all duration-300">
                  <div className="mx-auto w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-white border-2 border-brand-navy flex items-center justify-center text-brand-navy group-hover:bg-brand-navy group-hover:text-white transition-colors duration-300 shadow-sm relative z-10">
                    <Layers size={22} className="sm:hidden" strokeWidth={1.5} />
                    <Layers size={28} className="hidden sm:block" strokeWidth={1.5} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] sm:text-xs font-bold text-gray-400 uppercase tracking-widest">Sous-Catégorie</p>
                    <p className={`text-lg sm:text-2xl font-black text-brand-navy min-h-[1.5rem] sm:min-h-[2rem] transition-opacity duration-500 ${results ? 'opacity-100' : 'opacity-20'}`}>
                      {results?.subCategory || "---"}
                    </p>
                  </div>
                </div>

                {/* Card 3: Type */}
                <div className="bg-white border border-gray-100 rounded-xl p-5 sm:p-8 shadow-sm text-center space-y-3 sm:space-y-4 group hover:border-brand-cyan/30 transition-all duration-300">
                  <div className="mx-auto w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-white border-2 border-brand-navy flex items-center justify-center text-brand-navy group-hover:bg-brand-navy group-hover:text-white transition-colors duration-300 shadow-sm relative z-10">
                    <Tag size={22} className="sm:hidden" strokeWidth={1.5} />
                    <Tag size={28} className="hidden sm:block" strokeWidth={1.5} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] sm:text-xs font-bold text-gray-400 uppercase tracking-widest">Type</p>
                    <p className={`text-lg sm:text-2xl font-black text-brand-navy min-h-[1.5rem] sm:min-h-[2rem] transition-opacity duration-500 ${results ? 'opacity-100' : 'opacity-20'}`}>
                      {results?.type || "---"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 py-6 sm:py-8 pt-8 sm:pt-12 border-t border-gray-100 mt-8 sm:mt-12 mb-4 sm:mb-8">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 sm:gap-6">
          <div className="flex items-center gap-3 opacity-60 hover:opacity-100 transition-all">
            <Image
              src="/setram_logo.png"
              alt="SETRAM Logo"
              width={100}
              height={32}
              className="object-contain w-[80px] sm:w-[100px]"
            />
          </div>
          <div className="text-center space-y-1">
            <p className="text-[10px] sm:text-xs text-gray-400 font-medium tracking-wide">
              &copy; 2026 SETRAM AI. TOUS DROITS RÉSERVÉS.
            </p>
            <p className="text-[10px] sm:text-xs text-gray-400">
              Développé par <span className="font-semibold text-brand-navy">Rayane Moumine</span> &amp; <span className="font-semibold text-brand-navy">Taha Ghermaoui</span>
            </p>
          </div>
          <div className="flex gap-4 sm:gap-6">
            <a href="#" className="text-[10px] sm:text-xs font-bold text-gray-400 hover:text-brand-cyan transition-colors">POLITIQUE</a>
            <a href="#" className="text-[10px] sm:text-xs font-bold text-gray-400 hover:text-brand-cyan transition-colors">AIDE</a>
            <a href="#" className="text-[10px] sm:text-xs font-bold text-gray-400 hover:text-brand-cyan transition-colors">CONNEXION</a>
          </div>
        </div>
      </footer>

      {/* Reformulation Confirmation Modal */}
      {showReformulateModal && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-brand-navy/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-gray-100 max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-300">
            <div className="p-4 sm:p-6 border-b border-gray-50 flex items-center justify-between bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-brand-cyan/10 rounded-full flex items-center justify-center text-brand-cyan">
                  <Sparkles size={20} />
                </div>
                <div>
                  <h3 className="font-bold text-brand-navy text-lg">Reformulation IA</h3>
                  <p className="text-xs text-gray-500 font-medium">Voulez-vous remplacer le texte original ?</p>
                </div>
              </div>
              <button
                onClick={() => setShowReformulateModal(false)}
                className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-full transition-all"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 sm:p-6 grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
              <div className="space-y-2">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Texte Original</p>
                <div className="p-4 bg-gray-50 rounded-xl border border-gray-100 text-sm italic text-gray-500 min-h-[150px] max-h-[250px] overflow-y-auto">
                  {inputText}
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-bold text-brand-cyan uppercase tracking-widest flex items-center gap-2">
                  Nouvelle Version
                  <span className="bg-brand-cyan/10 text-[10px] px-2 py-0.5 rounded-full">Gemini 3.5 Flash</span>
                </p>
                <div className="p-4 bg-cyan-50/30 rounded-xl border border-brand-cyan/20 text-sm font-medium text-brand-navy min-h-[150px] max-h-[250px] overflow-y-auto">
                  {reformulatedText}
                </div>
              </div>
            </div>

            <div className="p-4 sm:p-6 bg-gray-50/50 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-3 sm:gap-4 border-t border-gray-50">
              <button
                onClick={() => setShowReformulateModal(false)}
                className="px-6 py-2.5 rounded-lg font-bold text-gray-500 hover:bg-gray-100 transition-all text-sm text-center"
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  setInputText(reformulatedText);
                  setShowReformulateModal(false);
                }}
                className="bg-brand-navy hover:bg-navy-900 text-white px-8 py-2.5 rounded-lg font-bold shadow-md hover:shadow-lg active:scale-95 transition-all text-sm flex items-center justify-center gap-2"
              >
                <Check size={18} />
                Confirmer & Remplacer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
