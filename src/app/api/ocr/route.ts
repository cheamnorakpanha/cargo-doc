import { NextRequest } from "next/server";

const OCR_SPACE_URL = "https://api.ocr.space/parse/image";

/** Max retries for transient network/server errors (NOT rate-limit errors). */
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 503 from OCR.Space means the free key is throttled.
 * OCR.Space says to "retry in a few minutes" — seconds-level retries are useless.
 * Fail fast and let the user know they need a PRO key.
 */
function isThrottled(status: number, body: string): boolean {
  if (status !== 503) return false;
  try {
    const json = JSON.parse(body);
    // Detect the specific E571 throttle error code
    return typeof json.error === "string" && json.error.includes("E571");
  } catch {
    return false;
  }
}

/** True for transient server errors worth retrying with backoff. */
function isRetryable(status: number): boolean {
  // 502 Bad Gateway / 504 Gateway Timeout — transient infra errors
  // Exclude 503 — that's rate-limiting and needs minutes, not seconds
  return status === 502 || status === 504;
}

export async function POST(request: NextRequest) {
  try {
    const incomingForm = await request.formData();

    // Priority: key from client settings → server env var → public env var → demo key
    const clientApiKey = incomingForm.get("apiKey");
    const apiKey =
      (typeof clientApiKey === "string" && clientApiKey) ||
      process.env.OCR_SPACE_API_KEY ||
      process.env.NEXT_PUBLIC_OCR_SPACE_API_KEY ||
      "helloworld";

    const formData = new FormData();
    // Forward the image blob sent by the client
    const file = incomingForm.get("file");
    if (!file || !(file instanceof Blob)) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }
    formData.append("file", file, "page.png");
    formData.append("apikey", apiKey);
    formData.append("language", "eng");
    formData.append("isOverlayRequired", "false");
    formData.append("detectOrientation", "true");
    formData.append("scale", "true");
    formData.append("OCREngine", "2"); // Engine 2 is optimised for tabular data and receipts

    let lastError: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[OCR proxy] retrying (attempt ${attempt}/${MAX_RETRIES}) after ${delay}ms…`
        );
        await sleep(delay);
      }

      let response: Response;
      try {
        response = await fetch(OCR_SPACE_URL, {
          method: "POST",
          body: formData,
        });
      } catch (networkError) {
        // ENOBUFS / ECONNRESET / fetch failure — always retryable
        lastError = String(networkError);
        console.error(
          `[OCR proxy] network error (attempt ${attempt + 1}):`,
          networkError
        );
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");

        // --- Rate-limit / throttle: fail immediately with actionable message ---
        if (isThrottled(response.status, body)) {
          console.error("[OCR proxy] free API key throttled (E571).");
          return Response.json(
            {
              error:
                "The free OCR.Space API key is currently overloaded. " +
                "Please add your own PRO API key in Settings → OCR API Key to continue.",
              throttled: true,
            },
            { status: 429 }
          );
        }

        lastError = body;
        console.error(
          `[OCR proxy] upstream error ${response.status} (attempt ${attempt + 1}):`,
          body
        );

        if (isRetryable(response.status)) {
          continue;
        }

        // Non-retryable upstream error (e.g. 400, 401, 500) — forward it immediately
        return Response.json(
          { error: `OCR.Space error ${response.status}`, detail: body },
          { status: response.status }
        );
      }

      // Success — return the OCR response to the client
      const data = await response.json();
      return Response.json(data);
    }

    // All retries exhausted (network-level failures)
    return Response.json(
      { error: "OCR.Space unavailable after retries", detail: lastError },
      { status: 502 }
    );
  } catch (err) {
    console.error("[OCR proxy] unexpected error:", err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
