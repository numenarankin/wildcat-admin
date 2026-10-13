/**
 * OCR via the Mistral OCR API. Turns a PDF or image into Markdown text so it can
 * be embedded and searched. Key is in `.env` (MISTRAL_API_KEY).
 */

const OCR_MODEL = "mistral-ocr-latest";
const OCR_URL = "https://api.mistral.ai/v1/ocr";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff)$/i;

interface OcrPage {
  markdown?: string;
}

/**
 * Run OCR on document bytes and return the extracted Markdown (all pages
 * concatenated). Returns "" if nothing was extracted.
 */
export async function ocrDocument(
  bytes: ArrayBuffer,
  mime: string | null,
  filename: string
): Promise<string> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("ocrDocument: MISTRAL_API_KEY is not set");

  const isImage = (mime?.startsWith("image/") ?? false) || IMAGE_RE.test(filename);
  const base64 = Buffer.from(bytes).toString("base64");
  const dataUri = `data:${mime || (isImage ? "image/png" : "application/pdf")};base64,${base64}`;

  const document = isImage
    ? { type: "image_url" as const, image_url: dataUri }
    : { type: "document_url" as const, document_url: dataUri };

  const res = await fetch(OCR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: OCR_MODEL,
      document,
      include_image_base64: false,
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`ocrDocument: ${res.status} ${detail}`);
  }

  const json = (await res.json()) as { pages?: OcrPage[] };
  return (json.pages ?? [])
    .map((p) => p.markdown ?? "")
    .join("\n\n")
    .trim();
}
