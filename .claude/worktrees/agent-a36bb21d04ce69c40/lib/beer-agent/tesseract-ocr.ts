import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OCR_TMP = path.join(process.cwd(), "data", "ocr_tmp");

export async function tesseractOcr(dataUrl: string): Promise<string> {
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL for OCR");

  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const buffer = Buffer.from(match[2], "base64");

  await mkdir(OCR_TMP, { recursive: true });
  const filePath = path.join(OCR_TMP, `ocr_${Date.now()}.${ext}`);
  await writeFile(filePath, buffer);

  try {
    // Try PaddleOCR first (best accuracy for Chinese + English)
    try {
      const result = await paddleOcrFile(filePath);
      if (result) return result;
    } catch (err) {
      console.warn("[ocr] PaddleOCR failed, falling back to Tesseract:",
        err instanceof Error ? err.message : String(err));
    }

    // Fallback to Tesseract
    return await tesseractFile(filePath);
  } finally {
    unlink(filePath).catch(() => {});
  }
}

async function paddleOcrFile(filePath: string): Promise<string> {
  const scriptPath = path.join(process.cwd(), "scripts", "paddle_ocr.py");
  const { stdout } = await execFileAsync("python3", [scriptPath, filePath], {
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function tesseractFile(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "tesseract",
    [filePath, "stdout", "-l", "chi_sim+eng", "--psm", "4"],
    {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, TESSDATA_PREFIX: "/opt/homebrew/share/tessdata" },
    }
  );
  return stdout.trim();
}
