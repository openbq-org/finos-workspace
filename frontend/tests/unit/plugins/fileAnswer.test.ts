import { describe, expect, it } from "vitest";
import {
  fileAnswerOf,
  fileNameOf,
  MAX_FILE_ANSWER_BYTES,
  toBase64,
} from "~/plugins/fileAnswer";

describe("a file answer", () => {
  it("names the file from Content-Disposition, else from the URL, and keeps the name safe", () => {
    expect(
      fileNameOf('attachment; filename="positions.xlsx"', "https://b.example/x"),
    ).toBe("positions.xlsx");
    expect(
      fileNameOf(
        "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.csv",
        "https://b.example/x",
      ),
    ).toBe("résumé.csv");
    expect(fileNameOf(null, "https://b.example/files/trades.parquet?v=2")).toBe(
      "trades.parquet",
    );
    expect(fileNameOf('attachment; filename="../../etc/passwd"', "/x")).toBe("passwd");
    expect(fileNameOf('attachment; filename="a<script>.csv"', "/x")).toBe(
      "a_script_.csv",
    );
    expect(fileNameOf(null, "https://b.example/")).toBe("file");
  });

  it("encodes the bytes as base64", () => {
    expect(toBase64(new Uint8Array([1, 2, 3, 250]))).toBe("AQID+g==");
    const big = new Uint8Array(100_000).fill(65);
    expect(atob(toBase64(big)).length).toBe(100_000);
  });

  it("reads an answer as { file: { name, mime, base64 } }", async () => {
    const response = new Response(new Uint8Array([104, 105]), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="t.csv"',
      },
    });
    await expect(fileAnswerOf(response, "https://b.example/t")).resolves.toEqual({
      file: { name: "t.csv", mime: "text/csv", base64: "aGk=" },
    });
  });

  it("refuses a file larger than the limit", async () => {
    const response = new Response("x", {
      headers: { "content-length": String(MAX_FILE_ANSWER_BYTES + 1) },
    });
    await expect(fileAnswerOf(response, "/x")).rejects.toThrow(/larger than 25 MB/);
  });
});
