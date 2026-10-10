/** Reject truncated or malformed source content before preserving it as transaction evidence. */
export function decodeAttachmentBase64(value: string): Buffer {
  const encoded = value.replace(/\s/g, '');
  if (!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(encoded)) throw new Error('Source attachment content is incomplete or has an invalid encoding; retry the sync');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Source attachment content has an invalid encoding; retry the sync');
  return bytes;
}
