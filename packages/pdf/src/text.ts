import { spawn } from "node:child_process";

/** Extract one bounded native text page. Image-only and protected documents
 * refuse; extraction never invents text or silently invokes OCR. */
export async function extractPdfPageText(bytes: Uint8Array, page: number): Promise<string> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 2000)
    throw new Error("Select a PDF page from 1 through 2000.");
  if (
    bytes.length === 0 ||
    bytes.length > 10_000_000 ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  ) {
    throw new Error("Retained PDF evidence must be a PDF of at most 10 MB.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ "pdftotext",
      [
        "-f",
        String(page),
        "-l",
        String(page),
        "-layout",
        "-enc",
        "UTF-8",
        "-eol",
        "unix",
        "-",
        "-",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: process.env.NODE_ENV },
      },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    let refusal: string | undefined;
    let diagnostic = "";
    const stop = (message: string) => {
      refusal ??= message;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop("PDF page extraction exceeded its 15-second limit."),
      15_000,
    );
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 1_000_000) stop("The selected PDF page exceeds the supported text size.");
      else chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(0, 1000);
    });
    child.stdin.on("error", () => {
      /* Process exit reports a refused input. */
    });
    child.on("error", () => {
      refusal ??= "PDF text extraction is unavailable; install the native poppler-utils runtime.";
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (refusal || code !== 0)
        return reject(
          new Error(refusal ?? `The retained PDF page could not be read (${diagnostic.trim()}).`),
        );
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        if (!text.trim() || text.includes("\uFFFD"))
          throw new Error(
            "The selected PDF page has no verifiable text; retain a readable original document.",
          );
        resolve(text);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(bytes);
  });
}
