"use strict";

const maxBytes = 10 * 1024 * 1024;
const maxPixels = 40_000_000;
const maxSide = 8192;
const profiles = {
  thumb: { bytes: 65_536, target: 30 * 1024, attempts: [[256, 76], [256, 64], [256, 50], [256, 36]] },
  display: { bytes: 524_288, target: 524_288, attempts: [[2048, 76], [2048, 46], [1024, 42]] },
};
const maxRss = 512 * 1024 * 1024;
const formats = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };

function stillImage(bytes, format) {
  if (format === "jpeg") {
    return bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (format === "png") {
    if (bytes.length < 20 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      const kind = bytes.toString("ascii", offset + 4, offset + 8);
      offset += size + 12;
      if (offset > bytes.length || kind === "acTL" || kind === "fcTL" || kind === "fdAT") return false;
      if (kind === "IEND") return size === 0 && offset === bytes.length;
    }
    return false;
  }
  if (format !== "webp" || bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (kind === "ANIM" || kind === "ANMF" || (kind === "VP8X" && size > 0 && (bytes[offset + 8] & 2))) return false;
    offset += 8 + size + (size & 1);
  }
  return offset === bytes.length;
}

async function main() {
  const started = performance.now();
  let peakRss = process.memoryUsage.rss();
  const watchdog = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    if (peakRss > maxRss) process.exit(4);
  }, 10);
  try {
    const { default: sharp } = await import("sharp").catch(() => process.exit(3));
    sharp.cache(false);
    sharp.concurrency(1);
    sharp.block({ operation: ["VipsForeignLoad"] });
    sharp.unblock({ operation: ["VipsForeignLoadJpegBuffer", "VipsForeignLoadPngBuffer", "VipsForeignLoadWebpBuffer"] });
    const format = formats[process.argv[2]];
    const length = Number(process.argv[3]);
    const variant = process.argv[4] ?? "thumb";
    if (variant !== "thumb" && variant !== "display") return;
    const profile = profiles[variant];
    if (!format || !Number.isSafeInteger(length) || length < 1 || length > maxBytes) return;
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    for await (const chunk of process.stdin) {
      if (chunk.length > length - offset) return;
      offset += chunk.copy(bytes, offset);
    }
    if (offset !== length || !stillImage(bytes, format)) return;
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: maxPixels, pages: 1, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1 || metadata.channels > 4
      || !["uchar", "ushort"].includes(metadata.depth) || metadata.width < 1 || metadata.height < 1
      || metadata.width > maxSide || metadata.height > maxSide || metadata.width * metadata.height > maxPixels) return;

    // Apply EXIF orientation before fitting. Sharp removes input metadata by default.
    const oriented = image.autoOrient();
    let candidate;
    for (const [side, quality] of profile.attempts) {
      const output = await oriented.clone().resize(side, side, { fit: "inside", withoutEnlargement: true }).timeout({ seconds: 2 })
        .webp({ quality, alphaQuality: quality, effort: 3 }).toBuffer({ resolveWithObject: true });
      if (output.data.length <= profile.bytes) candidate = output;
      if (output.data.length <= profile.target) break;
    }
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    if (peakRss > maxRss) process.exit(4);
    if (!candidate) {
      process.exitCode = 3;
      return;
    }
    process.stdout.write(JSON.stringify({
      webp: candidate.data.toString("base64"), width: candidate.info.width, height: candidate.info.height,
      elapsedMs: Math.round(performance.now() - started), peakRss,
    }));
  } finally {
    clearInterval(watchdog);
  }
}

main().catch(() => { process.exitCode = 2; });
