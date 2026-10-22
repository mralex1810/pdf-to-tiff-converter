// A small classic TIFF writer. Each strip has its own TIFF LZW dictionary.
// No browser APIs are used, so the same encoder is exercised by the Node tests.
const TIFF_LIMIT = 0xffffffff;
const STRIP_BYTES = 64 * 1024;

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label}: expected an integer from ${min} to ${max}`);
  }
}

function tiffLzw(input) {
  // TIFF uses MSB-first packing and early code-width changes. The encoder's
  // dictionary is one entry ahead of the decoder, hence the 2**width boundary.
  const bytes = [];
  let buffer = 0;
  let bufferedBits = 0;
  let width = 9;
  let nextCode = 258;
  const dictionary = new Map();
  function emit(code) {
    buffer = (buffer << width) | code;
    bufferedBits += width;
    while (bufferedBits >= 8) {
      bufferedBits -= 8;
      bytes.push((buffer >>> bufferedBits) & 255);
    }
    buffer &= (1 << bufferedBits) - 1;
  }
  function clear() {
    emit(256);
    dictionary.clear();
    nextCode = 258;
    width = 9;
  }
  clear();
  if (input.length) {
    let prefix = input[0];
    for (let i = 1; i < input.length; i++) {
      const suffix = input[i];
      const key = prefix * 256 + suffix;
      const found = dictionary.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      dictionary.set(key, nextCode++);
      if (nextCode === 1 << width && width < 12) width++;
      if (nextCode === 4096) clear();
      prefix = suffix;
    }
    emit(prefix);
    // The decoder adds one final dictionary entry before reading EOI.
    if (nextCode === (1 << width) - 1 && width < 12) width++;
  }
  emit(257);
  if (bufferedBits) bytes.push((buffer << (8 - bufferedBits)) & 255);
  return Uint8Array.from(bytes);
}

function whiteComposite(channel, alpha) {
  return alpha === 255 ? channel : Math.floor((channel * alpha + 255 * (255 - alpha) + 127) / 255);
}

function encodeStrip(page, firstRow, rows, mode, threshold, rowBytes) {
  const output = new Uint8Array(rowBytes * rows);
  let destination = 0;
  for (let y = firstRow; y < firstRow + rows; y++) {
    let source = y * page.width * 4;
    const rowStart = destination;
    for (let x = 0; x < page.width; x++, source += 4) {
      const alpha = page.data[source + 3];
      const red = whiteComposite(page.data[source], alpha);
      const green = whiteComposite(page.data[source + 1], alpha);
      const blue = whiteComposite(page.data[source + 2], alpha);
      if (mode === 'color') {
        output[destination++] = red;
        output[destination++] = green;
        output[destination++] = blue;
      } else {
        const gray = Math.floor((299 * red + 587 * green + 114 * blue + 500) / 1000);
        if (mode === 'grayscale') output[destination++] = gray;
        else if (gray < threshold) output[rowStart + (x >>> 3)] |= 0x80 >>> (x & 7);
      }
    }
    destination = rowStart + rowBytes;
  }
  return output;
}

/**
 * Encode RGBA pages as a little-endian, strip-based classic TIFF.
 * Bitonal pages use 0=white, 1=black; unused bits at each row's end are white.
 * @param {{width:number,height:number,data:Uint8Array|Uint8ClampedArray}[]} pages
 * @param {{dpi?:number,colorMode?:string,compression?:string,threshold?:number}} options
 * @returns {Uint8Array}
 */
export function encodeTiff(pages, { dpi = 200, colorMode = 'color', compression = 'lzw', threshold = 180 } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new TypeError('At least one page is required');
  integer(pages.length, 'Page count', 1, 65535);
  integer(dpi, 'DPI', 1, 65535);
  integer(threshold, 'Threshold', 0, 255);
  if (['black-and-white', 'bw', 'blackWhite', 'blackAndWhite'].includes(colorMode)) colorMode = 'bitonal';
  if (!['color', 'grayscale', 'bitonal'].includes(colorMode)) throw new RangeError('Unknown color mode');
  if (!['lzw', 'none'].includes(compression)) throw new RangeError('Unknown TIFF compression');

  const channels = colorMode === 'color' ? 3 : 1;
  const bits = colorMode === 'bitonal' ? 1 : 8;
  const records = pages.map((page, pageIndex) => {
    integer(page.width, 'Width', 1, TIFF_LIMIT);
    integer(page.height, 'Height', 1, TIFF_LIMIT);
    if (!(page.data instanceof Uint8Array || page.data instanceof Uint8ClampedArray) || page.data.length !== page.width * page.height * 4) {
      throw new TypeError('Page data must contain width * height * 4 RGBA bytes');
    }
    const rowBytes = Math.ceil(page.width * channels * bits / 8);
    const rowsPerStrip = Math.max(1, Math.min(page.height, Math.floor(STRIP_BYTES / rowBytes)));
    const strips = [];
    for (let row = 0; row < page.height; row += rowsPerStrip) {
      const raw = encodeStrip(page, row, Math.min(rowsPerStrip, page.height - row), colorMode, threshold, rowBytes);
      strips.push(compression === 'lzw' ? tiffLzw(raw) : raw);
    }
    const stripOffsets = new Array(strips.length).fill(0);
    const entries = [
      [256, 4, [page.width]], [257, 4, [page.height]],
      [258, 3, new Array(channels).fill(bits)],
      [259, 3, [compression === 'lzw' ? 5 : 1]],
      [262, 3, [colorMode === 'color' ? 2 : colorMode === 'grayscale' ? 1 : 0]],
      [273, 4, stripOffsets], [274, 3, [1]], [277, 3, [channels]],
      [278, 4, [rowsPerStrip]], [279, 4, strips.map(strip => strip.length)],
      [282, 5, [dpi, 1]], [283, 5, [dpi, 1]], [284, 3, [1]],
      [296, 3, [2]], [297, 3, [pageIndex, pages.length]],
    ].map(([tag, type, values]) => ({ tag, type, values, count: type === 5 ? values.length / 2 : values.length }));
    return { entries, strips, stripOffsets };
  });

  let size = 8;
  for (const record of records) {
    record.offset = size;
    size += 2 + record.entries.length * 12 + 4;
  }
  for (const record of records) {
    for (const entry of record.entries) {
      entry.byteLength = entry.values.length * (entry.type === 3 ? 2 : 4);
      if (entry.byteLength > 4) {
        entry.offset = size;
        size += entry.byteLength;
      }
    }
  }
  for (const record of records) {
    for (let i = 0; i < record.strips.length; i++) {
      record.stripOffsets[i] = size;
      size += record.strips[i].length;
      if (size > TIFF_LIMIT) throw new RangeError('TIFF exceeds the classic TIFF 4 GiB limit');
    }
  }
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  output.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, records[0].offset, true);
  for (let pageIndex = 0; pageIndex < records.length; pageIndex++) {
    const record = records[pageIndex];
    view.setUint16(record.offset, record.entries.length, true);
    for (let i = 0; i < record.entries.length; i++) {
      const entry = record.entries[i];
      const offset = record.offset + 2 + i * 12;
      view.setUint16(offset, entry.tag, true);
      view.setUint16(offset + 2, entry.type, true);
      view.setUint32(offset + 4, entry.count, true);
      if (entry.byteLength > 4) view.setUint32(offset + 8, entry.offset, true);
      let destination = entry.byteLength > 4 ? entry.offset : offset + 8;
      for (const value of entry.values) {
        if (entry.type === 3) {
          view.setUint16(destination, value, true);
          destination += 2;
        } else {
          view.setUint32(destination, value, true);
          destination += 4;
        }
      }
    }
    view.setUint32(record.offset + 2 + record.entries.length * 12, records[pageIndex + 1]?.offset ?? 0, true);
    for (let i = 0; i < record.strips.length; i++) output.set(record.strips[i], record.stripOffsets[i]);
  }
  return output;
}
