// Minimal dependency-free ZIP writer (STORE method, no compression).
// Usage: const z = new ZipWriter(); z.add("a.txt", uint8array); const blob = z.blob();
(function (global) {
  "use strict";
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  class ZipWriter {
    constructor() { this.files = []; }
    add(name, data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      this.files.push({ name: new TextEncoder().encode(name), bytes, crc: crc32(bytes) });
    }
    blob() {
      const parts = [];
      const central = [];
      let offset = 0;
      const { time, date } = dosTime(new Date());
      for (const f of this.files) {
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true);
        h.setUint16(4, 20, true);
        h.setUint16(6, 0x0800, true); // UTF-8 names
        h.setUint16(8, 0, true);      // store
        h.setUint16(10, time, true);
        h.setUint16(12, date, true);
        h.setUint32(14, f.crc, true);
        h.setUint32(18, f.bytes.length, true);
        h.setUint32(22, f.bytes.length, true);
        h.setUint16(26, f.name.length, true);
        h.setUint16(28, 0, true);
        parts.push(h.buffer, f.name, f.bytes);

        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true);
        c.setUint16(4, 20, true);
        c.setUint16(6, 20, true);
        c.setUint16(8, 0x0800, true);
        c.setUint16(10, 0, true);
        c.setUint16(12, time, true);
        c.setUint16(14, date, true);
        c.setUint32(16, f.crc, true);
        c.setUint32(20, f.bytes.length, true);
        c.setUint32(24, f.bytes.length, true);
        c.setUint16(28, f.name.length, true);
        c.setUint32(42, offset, true);
        central.push(c.buffer, f.name);
        offset += 30 + f.name.length + f.bytes.length;
      }
      const centralSize = central.reduce((s, p) => s + p.byteLength, 0);
      const e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true);
      e.setUint16(8, this.files.length, true);
      e.setUint16(10, this.files.length, true);
      e.setUint32(12, centralSize, true);
      e.setUint32(16, offset, true);
      return new Blob([...parts, ...central, e.buffer], { type: "application/zip" });
    }
  }
  global.ZipWriter = ZipWriter;
  global.crc32 = crc32;
})(window);
