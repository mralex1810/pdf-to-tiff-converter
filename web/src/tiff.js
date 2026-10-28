// A small classic TIFF writer. Each strip has its own TIFF LZW dictionary;
// PackBits packets are bounded by scanlines as required by TIFF.
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

function tiffPackBits(input, rowBytes) {
  const bytes = [];
  for (let row = 0; row < input.length; row += rowBytes) {
    const end = row + rowBytes;
    let position = row;
    function runLength(at) {
      let count = 1;
      while (at + count < end && count < 128 && input[at + count] === input[at]) count++;
      return count;
    }
    while (position < end) {
      const repeated = runLength(position);
      if (repeated >= 3) {
        bytes.push(257 - repeated, input[position]);
        position += repeated;
      } else {
        const start = position++;
        while (position < end && position - start < 128 && runLength(position) < 3) position++;
        bytes.push(position - start - 1);
        for (let i = start; i < position; i++) bytes.push(input[i]);
      }
    }
  }
  return Uint8Array.from(bytes);
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
 * Encode pages immediately, retaining only compressed strips and TIFF metadata.
 * Callers may release/reuse an RGBA buffer as soon as addPage returns.
 * byteLength is the exact eventual TIFF length, including directories.
 */
export function createTiffEncoder({ dpi = 400, colorMode = 'bw', compression = 'packbits', threshold = 180, maxBytes = TIFF_LIMIT } = {}) {
  integer(dpi, 'DPI', 1, 65535);
  integer(threshold, 'Threshold', 0, 255);
  integer(maxBytes, 'TIFF byte limit', 1, TIFF_LIMIT);
  if (['black-and-white', 'bw', 'blackWhite', 'blackAndWhite'].includes(colorMode)) colorMode = 'bitonal';
  if (!['color', 'grayscale', 'bitonal'].includes(colorMode)) throw new RangeError('Unknown color mode');
  if (!['lzw', 'none', 'packbits'].includes(compression)) throw new RangeError('Unknown TIFF compression');

  const channels = colorMode === 'color' ? 3 : 1;
  const bits = colorMode === 'bitonal' ? 1 : 8;
  const records = [];
  let byteLength = 8;
  let closed = false;

  function ensureOpen() {
    if (closed) throw new Error('TIFF encoder is closed');
  }
  function ensureSize(size) {
    if (size <= maxBytes) return;
    records.length = 0;
    byteLength = 0;
    closed = true;
    const error = new Error('Готовый TIFF превышает допустимый размер. Уменьшите DPI или разделите PDF.');
    error.code = 'TIFF_SIZE_LIMIT';
    error.maxBytes = maxBytes;
    throw error;
  }

  return {
    get byteLength() { return byteLength; },
    addPage(page) {
      ensureOpen();
      integer(records.length + 1, 'Page count', 1, 65535);
      integer(page.width, 'Width', 1, TIFF_LIMIT);
      integer(page.height, 'Height', 1, TIFF_LIMIT);
      if (!(page.data instanceof Uint8Array || page.data instanceof Uint8ClampedArray) || page.data.length !== page.width * page.height * 4) {
        throw new TypeError('Page data must contain width * height * 4 RGBA bytes');
      }
      const rowBytes = Math.ceil(page.width * channels * bits / 8);
      const rowsPerStrip = Math.max(1, Math.min(page.height, Math.floor(STRIP_BYTES / rowBytes)));
      const stripCount = Math.ceil(page.height / rowsPerStrip);
      // Fifteen entries, two DPI rationals, optional RGB bits and strip tables.
      let addedBytes = 2 + 15 * 12 + 4 + 16 + (channels === 3 ? 6 : 0) + (stripCount > 1 ? stripCount * 8 : 0);
      ensureSize(byteLength + addedBytes);
      const strips = [];
      for (let row = 0; row < page.height; row += rowsPerStrip) {
        const raw = encodeStrip(page, row, Math.min(rowsPerStrip, page.height - row), colorMode, threshold, rowBytes);
        const strip = compression === 'lzw' ? tiffLzw(raw) : compression === 'packbits' ? tiffPackBits(raw, rowBytes) : raw;
        addedBytes += strip.length;
        ensureSize(byteLength + addedBytes);
        strips.push(strip);
      }
      const stripOffsets = new Array(strips.length).fill(0);
      const entries = [
        [256, 4, [page.width]], [257, 4, [page.height]],
        [258, 3, new Array(channels).fill(bits)],
        [259, 3, [compression === 'lzw' ? 5 : compression === 'packbits' ? 32773 : 1]],
        [262, 3, [colorMode === 'color' ? 2 : colorMode === 'grayscale' ? 1 : 0]],
        [273, 4, stripOffsets], [274, 3, [1]], [277, 3, [channels]],
        [278, 4, [rowsPerStrip]], [279, 4, strips.map(strip => strip.length)],
        [282, 5, [dpi, 1]], [283, 5, [dpi, 1]], [284, 3, [1]],
        [296, 3, [2]], [297, 3, [records.length, 0]],
      ].map(([tag, type, values]) => ({ tag, type, values, count: type === 5 ? values.length / 2 : values.length }));
      records.push({ entries, strips, stripOffsets });
      byteLength += addedBytes;
    },
    finish() {
      ensureOpen();
      if (records.length === 0) throw new TypeError('At least one page is required');
      ensureSize(byteLength);
      closed = true;
      try {
        return serializeTiff(records, byteLength);
      } finally {
        // No strip buffers remain retained alongside the finished Uint8Array.
        records.length = 0;
      }
    },
  };
}

function serializeTiff(records, expectedSize) {
  let size = 8;
  for (const record of records) {
    record.entries.find(entry => entry.tag === 297).values[1] = records.length;
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
    }
  }
  if (size !== expectedSize) throw new Error('TIFF size accounting mismatch');
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

/** Encode an existing array of RGBA pages using the same incremental writer. */
export function encodeTiff(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new TypeError('At least one page is required');
  integer(pages.length, 'Page count', 1, 65535);
  const encoder = createTiffEncoder(options);
  for (const page of pages) encoder.addPage(page);
  return encoder.finish();
}
