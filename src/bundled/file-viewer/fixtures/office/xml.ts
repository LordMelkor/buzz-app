// Independent byte encoder; retains lone surrogates for malformed-input tests.
export function utf16(text: string, little: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(2 + text.length * 2),
    view = new DataView(bytes.buffer);
  bytes.set(little ? [255, 254] : [254, 255]);
  for (let index = 0; index < text.length; index++)
    view.setUint16(2 + index * 2, text.charCodeAt(index), little);
  return bytes;
}
