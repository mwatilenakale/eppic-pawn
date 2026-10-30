/** File identification at the public messaging boundary. A file arriving is
 * not evidence that it is a readable photo or proves ownership. AI extraction
 * and human verification remain separate steps. Never trust a filename alone.
 */
import type { DownloadedMedia } from './transport.ts';
import type { InboundEvent } from './webhook.ts';

export type EvidenceFormat = { mimeType: string; extension: string; type: 'image' | 'document' };

export function evidenceFormat(content: Buffer): EvidenceFormat | null {
  if (content.length >= 24 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      content.toString('ascii', 12, 16) === 'IHDR' && content.readUInt32BE(16) > 0 && content.readUInt32BE(20) > 0) {
    return { mimeType: 'image/png', extension: 'png', type: 'image' };
  }
  if (content.length >= 4 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg', type: 'image' };
  }
  if (content.length >= 16 && content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp', type: 'image' };
  }
  if (content.length >= 8 && content.toString('ascii', 0, 5) === '%PDF-') {
    return { mimeType: 'application/pdf', extension: 'pdf', type: 'document' };
  }
  return null;
}

/** Header identification is not a full decoder, malware scan or readability
 * assessment. It prevents audio/arbitrary blobs being counted as item photos.
 */
export function validateDownloadedEvidence(event: InboundEvent, media: DownloadedMedia): DownloadedMedia {
  const format = evidenceFormat(media.content);
  const declared = media.mimeType.split(';')[0]!.trim().toLowerCase();
  if (media.content.length > 20_000_000 || !format || format.type !== event.type || declared !== format.mimeType) {
    throw new Error('Attachment type does not match a supported image or PDF');
  }
  return { content: media.content, mimeType: format.mimeType, extension: format.extension };
}

export const VOICE_FALLBACK = 'I cannot reliably understand voice notes here yet. Please send the details as a text message. Your application has not moved forward.';
export const MEDIA_FALLBACK = 'I could not accept that attachment as a photo or document. Please send a clear JPEG, PNG or WebP photo, or a PDF for a document. Your application has not moved forward.';
