/**
 * Identifies an image from its magic bytes, returning null for anything that
 * isn't one of the formats vision models accept.
 *
 * Extracted out of adoWorkItemService.ts (JIRA-INTEGRATION-DESIGN.md §5 P3):
 * this is generic byte-sniffing with nothing ADO-specific in it, and Jira's
 * attachment fetch needs exactly the same check for exactly the same reason —
 * neither tracker's HTTP `content-type` can be trusted (ADO serves
 * attachments as `application/octet-stream`; Jira's can lag the real type
 * too), and baking an untrusted content-type into a data URL produces
 * `data:application/octet-stream;...`, which providers reject — Gemini with a
 * completely empty 400 that names no cause. The bytes themselves are
 * unambiguous, so sniff them instead.
 */
export function sniffImageMime(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf);
  const startsWith = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  // RIFF....WEBP
  if (startsWith(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  // ISO-BMFF brands at offset 4: 'ftyp' followed by heic/heif/mif1
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand === 'heif') return 'image/heif';
  }
  return null;
}
