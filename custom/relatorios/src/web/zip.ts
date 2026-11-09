/**
 * Lê um único arquivo de dentro de um .zip no navegador, sem biblioteca e sem carregar o zip
 * inteiro na memória: só o diretório central e o arquivo pedido (a exportação da Strava pode ter
 * centenas de MB de GPX/FIT, e só o activities.csv interessa).
 */
const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const view = async (f: Blob, start: number, end: number) => new DataView(await f.slice(start, end).arrayBuffer());

export async function readFromZip(file: Blob, match: (name: string) => boolean): Promise<string | null> {
  // Fim do diretório central: nos últimos 64 KB (+22 bytes do registro).
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await view(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Não é um arquivo .zip válido.");
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    // ZIP64: o localizador fica logo antes do fim do diretório central.
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error("Formato .zip não suportado.");
    const z64 = Number(tail.getBigUint64(loc + 8, true));
    const rec = await view(file, z64, z64 + 56);
    cdSize = Number(rec.getBigUint64(40, true));
    cdOffset = Number(rec.getBigUint64(48, true));
  }
  const cd = await view(file, cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder();
  for (let p = 0; p + 46 <= cd.byteLength && u32(cd, p) === 0x02014b50; ) {
    const method = u16(cd, p + 10);
    let comp = u32(cd, p + 20);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let local = u32(cd, p + 42);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (comp === 0xffffffff || local === 0xffffffff) {
      // Campos ZIP64 no "extra" (tamanho original, comprimido, posição — só os que estouraram).
      for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
        const id = u16(cd, e);
        const len = u16(cd, e + 2);
        if (id === 0x0001) {
          let o = e + 4;
          if (u32(cd, p + 24) === 0xffffffff) o += 8;
          if (comp === 0xffffffff) {
            comp = Number(cd.getBigUint64(o, true));
            o += 8;
          }
          if (local === 0xffffffff) local = Number(cd.getBigUint64(o, true));
        }
        e += 4 + len;
      }
    }
    if (match(name)) {
      const lh = await view(file, local, local + 30);
      const dataStart = local + 30 + u16(lh, 26) + u16(lh, 28);
      const data = file.slice(dataStart, dataStart + comp);
      if (method === 0) return await data.text();
      if (method !== 8) throw new Error("Compressão do .zip não suportada.");
      const stream = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
