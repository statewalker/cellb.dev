// Downloads the test images (openly licensed, OCRmyPDF test resources) and the tesseract
// models into fixtures/ (not committed). Runtimes under test get the models from a local server,
// so no runtime needs outbound network access.
//   node scripts/fetch-fixtures.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../fixtures", import.meta.url));
mkdirSync(join(dir, "models"), { recursive: true });

const OCRMYPDF = "https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources";
const TESSDATA = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0";

// Licenses: https://github.com/ocrmypdf/OCRmyPDF/blob/main/REUSE.toml
export const IMAGES = [
  {
    file: "linn.png",
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics, via Wikimedia Commons (LinnSequencer)",
  },
  {
    file: "linn.txt",
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "transcript of linn.png",
  },
  {
    file: "typewriter.png",
    license: "GFDL-1.2-or-later OR CC-BY-SA-1.0/2.0/2.5/3.0",
    attribution: "(C) 2005 Ellywa, via Wikimedia Commons (Triumph typewriter text Linzensoep)",
  },
  ...["baiona.png", "baiona_gray.png", "baiona_colormapped.png", "baiona_alpha.png"].map(
    (file) => ({
      file,
      license: "CC-BY-SA-4.0",
      attribution: "(C) 2014 Euskaldunaa, via Wikimedia Commons (Baionako udalerri mugakideak)",
    }),
  ),
  {
    file: "c03-29.pdf",
    license: "public domain",
    attribution: "Project Gutenberg, Adventures of Huckleberry Finn, page 29",
  },
];
const PYPDF = "https://raw.githubusercontent.com/py-pdf/sample-files/main";
// PDFs for the /api/pdf scenario (licenses as in the pdf-portabletext corpus manifest).
export const PDFS = [
  { file: "linn.pdf", url: `${OCRMYPDF}/linn.pdf`, license: "GFDL-1.2-or-later OR CC-BY-SA-3.0" },
  { file: "francais.pdf", url: `${OCRMYPDF}/francais.pdf`, license: "CC-BY-SA-4.0" },
  {
    file: "graph_ocred.pdf",
    url: `${OCRMYPDF}/graph_ocred.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
  },
  { file: "jbig2.pdf", url: `${OCRMYPDF}/jbig2.pdf`, license: "GFDL-1.2-or-later OR CC-BY-SA-3.0" },
  {
    file: "lichtenstein.pdf",
    url: `${OCRMYPDF}/lichtenstein.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
  },
  {
    file: "multicolumn.pdf",
    url: `${PYPDF}/026-latex-multicolumn/multicolumn.pdf`,
    license: "CC-BY-SA-4.0",
  },
  {
    file: "GeoTopo.pdf",
    url: `${PYPDF}/009-pdflatex-geotopo/GeoTopo.pdf`,
    license: "CC-BY-SA-4.0",
  },
];
const MODELS = ["eng", "nld", "fra", "deu"];

async function download(url, path) {
  if (existsSync(path)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
  console.log(`fetched ${url}`);
}

for (const { file } of IMAGES) await download(`${OCRMYPDF}/${file}`, join(dir, file));
for (const { file, url } of PDFS) await download(url, join(dir, file));
for (const lang of MODELS) {
  await download(`${TESSDATA}/${lang}.traineddata`, join(dir, "models", `${lang}.traineddata`));
}

// c03-29.pdf holds its scan as a plain JPEG stream: cut it out (SOI … EOI) as the JPEG fixture.
const jpegPath = join(dir, "c03-29.jpg");
if (!existsSync(jpegPath)) {
  const pdf = readFileSync(join(dir, "c03-29.pdf"));
  const start = pdf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  const end = pdf.indexOf(Buffer.from("endstream"), start);
  const eoi = pdf.lastIndexOf(Buffer.from([0xff, 0xd9]), end);
  if (start < 0 || eoi < 0) throw new Error("no JPEG stream in c03-29.pdf");
  writeFileSync(jpegPath, pdf.subarray(start, eoi + 2));
  console.log("wrote c03-29.jpg");
}

// Built from the fixtures above (pdf-lib) for the PDF job suites:
//   scan-4.pdf  linn.pdf's scanned page four times: four pages to OCR at once
//   big-34mb.pdf  GeoTopo.pdf's first 3 pages plus 32 MB of random bytes in an unreferenced
//                 stream: an upload above the synchronous route's 20 MB, of which pdf.js
//                 needs only a little
const { PDFDocument, PDFName } = await import("pdf-lib");
const scanPath = join(dir, "scan-4.pdf");
if (!existsSync(scanPath)) {
  const src = await PDFDocument.load(readFileSync(join(dir, "linn.pdf")));
  const out = await PDFDocument.create();
  for (let i = 0; i < 4; i++) out.addPage((await out.copyPages(src, [0]))[0]);
  writeFileSync(scanPath, await out.save({ useObjectStreams: false }));
  console.log("built scan-4.pdf");
}
const bigPath = join(dir, "big-34mb.pdf");
if (!existsSync(bigPath)) {
  const src = await PDFDocument.load(readFileSync(join(dir, "GeoTopo.pdf")));
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(src, [0, 1, 2])) out.addPage(page);
  // Deterministic noise (xorshift), so the file is the same on every machine.
  const noise = new Uint8Array(32 * 1024 * 1024);
  let x = 0x2545f491;
  for (let i = 0; i < noise.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    noise[i] = x & 0xff;
  }
  const filler = out.context.stream(noise, { Type: PDFName.of("XObject") });
  out.context.register(filler);
  writeFileSync(bigPath, await out.save({ useObjectStreams: false }));
  console.log("built big-34mb.pdf");
}

writeFileSync(
  join(dir, "LICENSES.txt"),
  IMAGES.map(
    (i) =>
      `${i.file}\n  source: ${OCRMYPDF}/${i.file}\n  license: ${i.license}\n  attribution: ${i.attribution}\n`,
  ).join("\n") +
    "\nc03-29.jpg\n  the JPEG stream of c03-29.pdf (public domain)\n" +
    PDFS.map((p) => `\n${p.file}\n  source: ${p.url}\n  license: ${p.license}\n`).join("") +
    "\nscan-4.pdf, big-34mb.pdf\n  built from linn.pdf and GeoTopo.pdf (licenses as above)\n" +
    `\nmodels/*.traineddata\n  source: ${TESSDATA}\n  license: Apache-2.0 (tesseract-ocr/tessdata_fast)\n`,
);
console.log(`fixtures ready in ${dir}`);
