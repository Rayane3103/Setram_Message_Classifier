"use client";

import React, { useState, useRef } from 'react';
import Tesseract from 'tesseract.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  Send,
  Upload,
  FileText,
  Layers,
  Tag,
  ArrowRight,
  ChevronRight,
  Activity,
  AlertCircle,
  Mic,
  MicOff,
  Download,
  Sparkles,
  Check,
  X
} from 'lucide-react';

export default function Dashboard() {
  const [inputText, setInputText] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [results, setResults] = useState<{ category: string, subCategory: string, type: string } | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isOCRLoading, setIsOCRLoading] = useState(false);
  const [isReformulating, setIsReformulating] = useState(false);
  const [showReformulateModal, setShowReformulateModal] = useState(false);
  const [reformulatedText, setReformulatedText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAnalyse = async () => {
    if (!inputText.trim()) return;

    setIsAnalyzing(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_PREDICTION_API_URL;
      if (!apiUrl) throw new Error("URL de l'API de prédiction non configurée");

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: inputText }),
      });

      const rawText = await response.text();
      console.log("Raw Prediction response:", response.status, rawText);

      if (!response.ok) {
        throw new Error(`API responded with ${response.status}: ${rawText}`);
      }

      if (!rawText) {
        throw new Error("API returned an empty response");
      }

      const data = JSON.parse(rawText);
      setResults({
        category: data["catégorie"] || "Inconnu",
        subCategory: data["sous_catégorie"] || "Inconnu",
        type: data["type"] || "Inconnu",
      });
    } catch (error) {
      console.error("Analysis error:", error);
      alert("Une erreur est survenue lors de l'analyse.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const toggleListening = () => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

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

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInputText((prev) => prev ? `${prev} ${transcript}` : transcript);
        setIsListening(false);
      };

      recognition.onerror = (event: any) => {
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
      const result = await Tesseract.recognize(file, 'fra+eng', {
        logger: m => console.log(m)
      });
      setInputText(result.data.text);
    } catch (error) {
      console.error("OCR Error:", error);
      alert("Erreur lors de l'extraction du texte. Veuillez réessayer.");
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
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const prompt = `
        Tu es un assistant de service client pour la SETRAM (Société d'Exploitation des Tramways). 
        Ta tâche est de reformuler le message suivant d'un client. 
        
        RÈGLES DE REFORMULATION :
        1. Commence obligatoirement par "Le client a dit...", "Le client a déclaré..." ou "Le client a réclamé..." selon le contexte du message.
        2. Utilise un ton narratif et descriptif.
        3. Développe un scénario clair basé sur le message si nécessaire pour le rendre plus complet.
        4. Garde l'aspect professionnel tout en restant fidèle aux faits.
        5. Ne réponds pas au client, décris simplement ce qu'il rapporte.

        MESSAGE DU CLIENT :
        "${inputText}"
      `;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text().trim();

      setReformulatedText(text);
      setShowReformulateModal(true);
    } catch (error) {
      console.error("Reformulation error:", error);
      alert("Une erreur est survenue lors de la reformulation.");
    } finally {
      setIsReformulating(false);
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
        type: results.type
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
      <nav className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-brand-navy rounded-md flex items-center justify-center text-white font-bold text-xl">
            S
          </div>
          <h1 className="text-xl font-bold text-brand-navy tracking-tight">Classification IA</h1>
        </div>

        <button className="bg-brand-cyan hover:bg-cyan-500 text-white px-5 py-2 rounded-full text-sm font-semibold transition-all duration-200 shadow-sm flex items-center gap-2">
          Transmettre une doléance
        </button>
      </nav>

      <main className="max-w-6xl mx-auto p-8 space-y-8">
        {/* Header Section */}
        <div className="space-y-2">
          <h2 className="text-3xl font-extrabold text-brand-navy">Dashboard d'Analyse</h2>
          <p className="text-gray-500 max-w-2xl">
            Utilisez notre intelligence artificielle pour classifier automatiquement vos requêtes et documents selon les normes SETRAM.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* AI Input Section */}
          <section className="lg:col-span-12">
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 space-y-6">
              <div className="flex items-center gap-3 pb-2 border-b border-gray-50">
                <Activity size={20} className="text-brand-navy" />
                <h3 className="font-bold text-brand-navy text-lg">Nouvelle Analyse</h3>
              </div>

              <div className="space-y-4">
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Décrivez votre requête ou le contenu du document ici..."
                  className="w-full min-h-[160px] p-4 bg-gray-50 border border-gray-100 rounded-lg focus:ring-2 focus:ring-brand-cyan focus:border-transparent outline-none transition-all resize-none text-gray-700"
                />

                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
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
                        flex items-center gap-2 font-semibold transition-all px-4 py-2 rounded-lg group
                        ${isOCRLoading
                          ? 'bg-gray-100 text-gray-400 cursor-wait'
                          : 'bg-cyan-50 text-brand-cyan hover:bg-cyan-100'}
                      `}
                    >
                      {isOCRLoading ? (
                        <div className="w-4 h-4 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin"></div>
                      ) : (
                        <Upload size={18} />
                      )}
                      <span>{isOCRLoading ? "Extraction..." : "Upload Image"}</span>
                      {!isOCRLoading && <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />}
                    </button>

                    <button
                      onClick={toggleListening}
                      className={`
                        flex items-center gap-2 font-semibold transition-all px-4 py-2 rounded-lg
                        ${isListening
                          ? 'bg-red-50 text-red-500 ring-2 ring-red-100 animate-[pulse-mic_2s_infinite]'
                          : 'bg-brand-cyan/10 text-brand-cyan hover:bg-brand-cyan/20'}
                      `}
                    >
                      {isListening ? <MicOff size={18} /> : <Mic size={18} />}
                      <span>{isListening ? "Écoute..." : "Vocal / Mic"}</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleReformulate}
                      disabled={isReformulating || !inputText.trim()}
                      className={`
                        relative overflow-hidden px-6 py-3 rounded-lg font-bold text-white transition-all duration-300
                        ${isReformulating
                          ? 'bg-brand-cyan/50 cursor-wait'
                          : 'bg-gradient-to-r from-brand-cyan to-brand-navy hover:shadow-lg active:scale-95 disabled:opacity-50'}
                      `}
                    >
                      <span className="relative z-10 flex items-center gap-2">
                        {isReformulating ? (
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                          <Sparkles size={18} />
                        )}
                        {isReformulating ? "Reformulation..." : "Reformuler avec IA"}
                      </span>
                    </button>

                    <button
                      onClick={handleAnalyse}
                      disabled={isAnalyzing || !inputText.trim()}
                      className={`
                        relative overflow-hidden px-8 py-3 rounded-lg font-bold text-white transition-all duration-300
                        ${isAnalyzing ? 'bg-brand-navy/80 cursor-wait' : 'bg-brand-navy hover:bg-navy-900 active:scale-95 shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed'}
                      `}
                    >
                      {isAnalyzing && (
                        <div className="absolute inset-0 bg-brand-navy animate-[pulse-custom_1.5s_infinite] opacity-50"></div>
                      )}
                      <span className="relative z-10 flex items-center gap-2">
                        {isAnalyzing ? "Analyse en cours..." : "Lancer l'analyse"}
                        {!isAnalyzing && <Send size={18} />}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Results Section */}
          <section className="lg:col-span-12 space-y-4">
            <div className="flex items-center justify-between px-2">
              <h3 className="font-bold text-brand-navy text-lg uppercase tracking-wider flex items-center gap-2">
                <div className="w-2 h-6 bg-brand-cyan rounded-full"></div>
                Résultats de Classification
              </h3>
              <div className="flex items-center gap-3">
                {results && (
                  <>
                    <button
                      onClick={handleExportJSON}
                      className="flex items-center gap-2 text-brand-navy font-bold text-xs bg-gray-100 hover:bg-gray-200 px-4 py-2 rounded-lg transition-all border border-gray-200"
                    >
                      <Download size={14} />
                      EXPORTER (JSON)
                    </button>
                    <span className="text-xs font-medium text-gray-400">ANALYSE TERMINÉE</span>
                  </>
                )}
              </div>
            </div>

            <div className="relative">
              {/* Step indicator line */}
              <div className="hidden md:block absolute top-[60px] left-[15%] right-[15%] h-[2px] bg-brand-navy/10 z-0"></div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative z-10">
                {/* Card 1: Catégorie */}
                <div className="bg-white border border-gray-100 rounded-xl p-8 shadow-sm text-center space-y-4 group hover:border-brand-cyan/30 transition-all duration-300">
                  <div className="mx-auto w-16 h-16 rounded-full bg-white border-2 border-brand-navy flex items-center justify-center text-brand-navy group-hover:bg-brand-navy group-hover:text-white transition-colors duration-300 shadow-sm relative z-10">
                    <FileText size={28} strokeWidth={1.5} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Catégorie</p>
                    <p className={`text-2xl font-black text-brand-navy min-h-[2rem] transition-opacity duration-500 ${results ? 'opacity-100' : 'opacity-20'}`}>
                      {results?.category || "---"}
                    </p>
                  </div>
                </div>

                {/* Card 2: Sous-Catégorie */}
                <div className="bg-white border border-gray-100 rounded-xl p-8 shadow-sm text-center space-y-4 group hover:border-brand-cyan/30 transition-all duration-300">
                  <div className="mx-auto w-16 h-16 rounded-full bg-white border-2 border-brand-navy flex items-center justify-center text-brand-navy group-hover:bg-brand-navy group-hover:text-white transition-colors duration-300 shadow-sm relative z-10">
                    <Layers size={28} strokeWidth={1.5} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Sous-Catégorie</p>
                    <p className={`text-2xl font-black text-brand-navy min-h-[2rem] transition-opacity duration-500 ${results ? 'opacity-100' : 'opacity-20'}`}>
                      {results?.subCategory || "---"}
                    </p>
                  </div>
                </div>

                {/* Card 3: Type */}
                <div className="bg-white border border-gray-100 rounded-xl p-8 shadow-sm text-center space-y-4 group hover:border-brand-cyan/30 transition-all duration-300">
                  <div className="mx-auto w-16 h-16 rounded-full bg-white border-2 border-brand-navy flex items-center justify-center text-brand-navy group-hover:bg-brand-navy group-hover:text-white transition-colors duration-300 shadow-sm relative z-10">
                    <Tag size={28} strokeWidth={1.5} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Type</p>
                    <p className={`text-2xl font-black text-brand-navy min-h-[2rem] transition-opacity duration-500 ${results ? 'opacity-100' : 'opacity-20'}`}>
                      {results?.type || "---"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="max-w-6xl mx-auto p-8 pt-12 border-t border-gray-100 mt-12 mb-8">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3 opacity-60 grayscale hover:grayscale-0 transition-all">
            <div className="w-8 h-8 bg-brand-navy rounded flex items-center justify-center text-white text-xs font-bold">S</div>
            <span className="text-sm font-bold text-brand-navy">SETRAM.DZ</span>
          </div>
          <p className="text-xs text-gray-400 font-medium tracking-wide">
            &copy; 2026 SETRAM AI. TOUS DROITS RÉSERVÉS.
          </p>
          <div className="flex gap-6">
            <a href="#" className="text-xs font-bold text-gray-400 hover:text-brand-cyan transition-colors">POLITIQUE</a>
            <a href="#" className="text-xs font-bold text-gray-400 hover:text-brand-cyan transition-colors">AIDE</a>
            <a href="#" className="text-xs font-bold text-gray-400 hover:text-brand-cyan transition-colors">CONNEXION</a>
          </div>
        </div>
      </footer>

      {/* Reformulation Confirmation Modal */}
      {showReformulateModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-brand-navy/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 max-w-2xl w-full overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="p-6 border-b border-gray-50 flex items-center justify-between bg-gray-50/50">
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

            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Texte Original</p>
                <div className="p-4 bg-gray-50 rounded-xl border border-gray-100 text-sm italic text-gray-500 min-h-[150px] max-h-[250px] overflow-y-auto">
                  {inputText}
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-bold text-brand-cyan uppercase tracking-widest flex items-center gap-2">
                  Nouvelle Version
                  <span className="bg-brand-cyan/10 text-[10px] px-2 py-0.5 rounded-full">Gemini 1.5 Flash</span>
                </p>
                <div className="p-4 bg-cyan-50/30 rounded-xl border border-brand-cyan/20 text-sm font-medium text-brand-navy min-h-[150px] max-h-[250px] overflow-y-auto">
                  {reformulatedText}
                </div>
              </div>
            </div>

            <div className="p-6 bg-gray-50/50 flex items-center justify-end gap-4 border-t border-gray-50">
              <button
                onClick={() => setShowReformulateModal(false)}
                className="px-6 py-2.5 rounded-lg font-bold text-gray-500 hover:bg-gray-100 transition-all text-sm"
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  setInputText(reformulatedText);
                  setShowReformulateModal(false);
                }}
                className="bg-brand-navy hover:bg-navy-900 text-white px-8 py-2.5 rounded-lg font-bold shadow-md hover:shadow-lg active:scale-95 transition-all text-sm flex items-center gap-2"
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
