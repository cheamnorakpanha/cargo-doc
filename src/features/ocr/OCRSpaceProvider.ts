import { BaseOCRProvider } from "./BaseOCRProvider";

/**
 * How many times to retry when the free OCR.Space key is throttled.
 * Each retry waits THROTTLE_RETRY_DELAY_MS before trying again.
 * OCR.Space says throttling is "temporary" (seconds to low minutes),
 * so patient client-side retries are more effective than switching engines.
 */
const THROTTLE_MAX_RETRIES = 3;
const THROTTLE_RETRY_DELAY_MS = 10_000; // 10 s per attempt → 30 s max wait

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OCRSpaceProvider implements BaseOCRProvider {
  name = "OCR.Space";

  async parseImage(imageBlob: Blob, apiKey?: string): Promise<string> {
    for (let attempt = 0; attempt <= THROTTLE_MAX_RETRIES; attempt++) {
      const result = await this.#attempt(imageBlob, apiKey);

      if (result.ok) {
        return result.text;
      }

      if (result.isThrottled && attempt < THROTTLE_MAX_RETRIES) {
        console.warn(
          `[OCR] OCR.Space throttled — waiting ${THROTTLE_RETRY_DELAY_MS / 1000}s before retry ` +
            `(${attempt + 1}/${THROTTLE_MAX_RETRIES})…`
        );
        await sleep(THROTTLE_RETRY_DELAY_MS);
        continue;
      }

      // Non-throttle error, or throttle retries exhausted — throw
      throw result.error;
    }

    // Should be unreachable, but satisfies TypeScript
    throw new Error("OCR failed after all retries.");
  }

  async #attempt(
    imageBlob: Blob,
    apiKey?: string
  ): Promise<
    | { ok: true; text: string }
    | { ok: false; isThrottled: boolean; error: Error }
  > {
    const formData = new FormData();
    // We name the file 'page.png' to ensure the OCR engine recognises it as a valid image
    formData.append("file", imageBlob, "page.png");

    // apiKey is forwarded to the server so it can override the env-var default
    if (apiKey) {
      formData.append("apiKey", apiKey);
    }

    // Call our own server-side proxy — avoids CORS and keeps the API key
    // out of the browser bundle.
    const response = await fetch("/api/ocr", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      let errorMessage = "";
      let isThrottled = false;
      try {
        const errJson = await response.json();
        errorMessage = errJson.error || "";
        isThrottled = errJson.throttled === true || response.status === 429;
      } catch {
        errorMessage = await response.text().catch(() => "");
      }
      const err = new Error(
        errorMessage ||
          `OCR.Space API request failed with status: ${response.status}.`
      );
      return { ok: false, isThrottled, error: err };
    }

    const data = await response.json();

    if (data.IsErroredOnProcessing) {
      const errorMsg = data.ErrorMessage
        ? data.ErrorMessage.join(", ")
        : "Unknown OCR.Space error";
      return {
        ok: false,
        isThrottled: false,
        error: new Error(`OCR processing error: ${errorMsg}`),
      };
    }

    if (!data.ParsedResults || data.ParsedResults.length === 0) {
      return { ok: true, text: "" };
    }

    // Merge text from all parsed pages/results
    const text = data.ParsedResults.map(
      (result: { ParsedText?: string }) => result.ParsedText || ""
    ).join("\n");

    return { ok: true, text };
  }
}
