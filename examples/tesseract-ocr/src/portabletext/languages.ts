import { franc } from "franc-all";

/**
 * Languages the app can OCR and detect. `tesseract` names the model file in
 * tessdata_fast, `franc` is the ISO 639-3 code franc reports, `bcp47` is what
 * goes into the PortableText output.
 */
export type Language = { tesseract: string; franc: string; bcp47: string; name: string };

export const LANGUAGES: Language[] = [
  { tesseract: "eng", franc: "eng", bcp47: "en", name: "English" },
  { tesseract: "deu", franc: "deu", bcp47: "de", name: "German" },
  { tesseract: "fra", franc: "fra", bcp47: "fr", name: "French" },
  { tesseract: "spa", franc: "spa", bcp47: "es", name: "Spanish" },
  { tesseract: "ita", franc: "ita", bcp47: "it", name: "Italian" },
  { tesseract: "por", franc: "por", bcp47: "pt", name: "Portuguese" },
  { tesseract: "nld", franc: "nld", bcp47: "nl", name: "Dutch" },
  { tesseract: "pol", franc: "pol", bcp47: "pl", name: "Polish" },
  { tesseract: "ces", franc: "ces", bcp47: "cs", name: "Czech" },
  { tesseract: "slk", franc: "slk", bcp47: "sk", name: "Slovak" },
  { tesseract: "slv", franc: "slv", bcp47: "sl", name: "Slovenian" },
  { tesseract: "hrv", franc: "hrv", bcp47: "hr", name: "Croatian" },
  { tesseract: "ron", franc: "ron", bcp47: "ro", name: "Romanian" },
  { tesseract: "hun", franc: "hun", bcp47: "hu", name: "Hungarian" },
  { tesseract: "fin", franc: "fin", bcp47: "fi", name: "Finnish" },
  { tesseract: "swe", franc: "swe", bcp47: "sv", name: "Swedish" },
  { tesseract: "dan", franc: "dan", bcp47: "da", name: "Danish" },
  { tesseract: "nor", franc: "nob", bcp47: "nb", name: "Norwegian" },
  { tesseract: "est", franc: "ekk", bcp47: "et", name: "Estonian" },
  { tesseract: "lav", franc: "lvs", bcp47: "lv", name: "Latvian" },
  { tesseract: "lit", franc: "lit", bcp47: "lt", name: "Lithuanian" },
  { tesseract: "tur", franc: "tur", bcp47: "tr", name: "Turkish" },
  { tesseract: "eus", franc: "eus", bcp47: "eu", name: "Basque" },
  { tesseract: "cat", franc: "cat", bcp47: "ca", name: "Catalan" },
  { tesseract: "glg", franc: "glg", bcp47: "gl", name: "Galician" },
  { tesseract: "rus", franc: "rus", bcp47: "ru", name: "Russian" },
  { tesseract: "ukr", franc: "ukr", bcp47: "uk", name: "Ukrainian" },
  { tesseract: "bul", franc: "bul", bcp47: "bg", name: "Bulgarian" },
  { tesseract: "srp", franc: "srp", bcp47: "sr", name: "Serbian" },
  { tesseract: "ell", franc: "ell", bcp47: "el", name: "Greek" },
  { tesseract: "ara", franc: "arb", bcp47: "ar", name: "Arabic" },
  { tesseract: "heb", franc: "heb", bcp47: "he", name: "Hebrew" },
  { tesseract: "hin", franc: "hin", bcp47: "hi", name: "Hindi" },
  { tesseract: "vie", franc: "vie", bcp47: "vi", name: "Vietnamese" },
  { tesseract: "ind", franc: "ind", bcp47: "id", name: "Indonesian" },
  { tesseract: "chi_sim", franc: "cmn", bcp47: "zh", name: "Chinese (simplified)" },
  { tesseract: "jpn", franc: "jpn", bcp47: "ja", name: "Japanese" },
  { tesseract: "kor", franc: "kor", bcp47: "ko", name: "Korean" },
  { tesseract: "tha", franc: "tha", bcp47: "th", name: "Thai" },
];

export const DEFAULT_LANGUAGE = LANGUAGES[0];

const byFranc = new Map(LANGUAGES.map((l) => [l.franc, l]));
const byTesseract = new Map(LANGUAGES.map((l) => [l.tesseract, l]));
const byBcp47 = new Map(LANGUAGES.map((l) => [l.bcp47, l]));
const ONLY = LANGUAGES.map((l) => l.franc);

export function languageByBcp47(code: string): Language | undefined {
  return byBcp47.get(code);
}

export function languageByTesseract(code: string): Language | undefined {
  return byTesseract.get(code);
}

/** Texts with fewer letters are not classified: trigram statistics are too noisy. */
export const MIN_DETECTION_LENGTH = 40;
/** Letters the text layer needs before it sets the document language. */
export const MIN_TEXT_LAYER_LETTERS = 200;
/** Letters an OCR result needs before its detected language may switch the OCR model. */
export const MIN_OCR_LETTERS = 100;

export function letterCount(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

/**
 * Detects the language of `text` with franc (trigram statistics, runs in the
 * browser). Returns `undefined` when the text is too short or undecidable.
 */
export function detectLanguage(
  text: string,
  minLength = MIN_DETECTION_LENGTH,
): Language | undefined {
  // Digits, punctuation and OCR noise only dilute the trigram profile.
  const letters = text
    .replace(/[^\p{L}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (letters.length < minLength) return undefined;
  return byFranc.get(franc(letters, { only: ONLY, minLength }));
}
