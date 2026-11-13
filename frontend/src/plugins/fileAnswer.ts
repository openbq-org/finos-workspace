/**
 * A plugin widget whose handle `accepts: "file"` gets its endpoint's answer as a file: the host
 * reads the bytes and gives the module `{ file: { name, mime, base64 } }`, so a CSV, a workbook or
 * a Parquet file reaches the frame as data, through the same `data` trait as JSON.
 */

export const MAX_FILE_ANSWER_BYTES = 25 * 1024 * 1024;

export interface FileAnswer {
  file: { name: string; mime: string; base64: string };
}

const SAFE_NAME = /[^\p{L}\p{N}_.\- ()]+/gu;

/** The file's name: the Content-Disposition filename, else the URL's last path segment. */
export function fileNameOf(disposition: string | null, url: string): string {
  const header = disposition ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(header)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header)?.[1];
  let name = "";
  try {
    name = star ? decodeURIComponent(star) : (plain ?? "");
  } catch {
    name = plain ?? "";
  }
  if (!name) {
    try {
      name = decodeURIComponent(
        new URL(url, "http://localhost").pathname.split("/").pop() ?? "",
      );
    } catch {
      name = "";
    }
  }
  const clean = name
    .replace(/^.*[\\/]/, "")
    .replace(SAFE_NAME, "_")
    .slice(0, 200)
    .trim();
  return clean || "file";
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** Reads an answer as a file, or rejects when it is larger than MAX_FILE_ANSWER_BYTES. */
export async function fileAnswerOf(
  response: Response,
  url: string,
): Promise<FileAnswer> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_FILE_ANSWER_BYTES)
    throw new Error(
      `The file is larger than ${MAX_FILE_ANSWER_BYTES / 1024 / 1024} MB`,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_ANSWER_BYTES)
    throw new Error(
      `The file is larger than ${MAX_FILE_ANSWER_BYTES / 1024 / 1024} MB`,
    );
  const mime = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .slice(0, 100);
  return {
    file: {
      name: fileNameOf(response.headers.get("content-disposition"), url),
      mime: mime || "application/octet-stream",
      base64: toBase64(bytes),
    },
  };
}
