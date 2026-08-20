/**
 * Client-side image compression helper.
 *
 * Browsers only — uses Canvas to downscale + JPEG-encode large images before
 * they're POSTed to /api/chat. Pure browser API, no dependencies.
 *
 * Triggers when:
 *   - dataUrl size > MAX_DATAURL_BYTES (default 2 MB), OR
 *   - decoded naturalWidth/Height > MAX_DIM (default 1600 px on longest side)
 *
 * Quality is reduced progressively until either size budget is met or quality
 * hits MIN_QUALITY. Returns the ORIGINAL dataUrl unchanged if no resampling
 * is needed (cheap fast-path).
 */

export interface CompressOpts {
  maxBytes?: number;
  maxDim?: number;
  minQuality?: number;
  startQuality?: number;
}

const DEFAULTS = {
  maxBytes: 2 * 1024 * 1024,
  maxDim: 1600,
  minQuality: 0.5,
  startQuality: 0.85,
};

export interface CompressResult {
  dataUrl: string;
  compressed: boolean;
  reason?: "size" | "dimension";
  originalBytes: number;
  compressedBytes: number;
  quality: number;
}

export async function compressImage(
  dataUrl: string,
  opts: CompressOpts = {},
): Promise<CompressResult> {
  const cfg = { ...DEFAULTS, ...opts };
  const originalBytes = approxDataUrlBytes(dataUrl);

  // Fast-path: under size budget AND presumably under dimension budget (we
  // can't know dimension without decoding, so decode the header only via
  // createImageBitmap which is cheap).
  let needsCompress = originalBytes > cfg.maxBytes;
  let bitmap: ImageBitmap | null = null;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
    if (!needsCompress && (bitmap.width > cfg.maxDim || bitmap.height > cfg.maxDim)) {
      needsCompress = true;
    }
  } catch {
    // Cannot decode (corrupt, non-image). Return original.
    return {
      dataUrl,
      compressed: false,
      originalBytes,
      compressedBytes: originalBytes,
      quality: 1,
    };
  }
  if (!needsCompress) {
    if (bitmap) bitmap.close();
    return {
      dataUrl,
      compressed: false,
      originalBytes,
      compressedBytes: originalBytes,
      quality: 1,
    };
  }

  // Compute target dimensions preserving aspect ratio.
  const scale = Math.min(cfg.maxDim / bitmap!.width, cfg.maxDim / bitmap!.height, 1);
  const w = Math.round(bitmap!.width * scale);
  const h = Math.round(bitmap!.height * scale);

  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    bitmap!.close();
    return {
      dataUrl,
      compressed: false,
      originalBytes,
      compressedBytes: originalBytes,
      quality: 1,
    };
  }
  ctx.drawImage(bitmap!, 0, 0, w, h);
  bitmap!.close();

  // Iterate quality to meet size budget. Always JPEG (smaller than PNG for
  // photos) so non-photo PNGs may grow — accept that and let the size guard
  // pass through unchanged.
  let q = cfg.startQuality;
  let out = await canvasToDataUrl(canvas, "image/jpeg", q);
  let bytes = approxDataUrlBytes(out);
  while (bytes > cfg.maxBytes && q > cfg.minQuality) {
    q = Math.max(cfg.minQuality, q - 0.1);
    out = await canvasToDataUrl(canvas, "image/jpeg", q);
    bytes = approxDataUrlBytes(out);
  }
  return {
    dataUrl: out,
    compressed: true,
    reason: originalBytes > cfg.maxBytes ? "size" : "dimension",
    originalBytes,
    compressedBytes: bytes,
    quality: q,
  };
}

function approxDataUrlBytes(dataUrl: string): number {
  // base64 segment starts after the first comma; every 4 chars → 3 bytes.
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const b64 = dataUrl.slice(comma + 1);
  // Strip padding
  let pad = 0;
  if (b64.endsWith("==")) pad = 2;
  else if (b64.endsWith("=")) pad = 1;
  return Math.floor((b64.length * 3) / 4) - pad;
}

async function canvasToDataUrl(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
): Promise<string> {
  if ("convertToBlob" in canvas) {
    const blob = await (canvas as OffscreenCanvas).convertToBlob({ type, quality });
    return await blobToDataUrl(blob);
  }
  return (canvas as HTMLCanvasElement).toDataURL(type, quality);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}