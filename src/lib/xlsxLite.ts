// ============================================================
// 依存追加なしの軽量XLSXパーサ（サーバー専用）。
// XLSXはZIP（DEFLATE）で、Node標準の zlib.inflateRawSync だけで展開できる。
// 政府オープンデータの単純なグリッド（1シート・名称/住所/日付の列）を rows(string[][]) に変換する用途に限定。
// 数式・書式・複数シートの高度な対応はしない（必要十分な最小実装）。
// ============================================================
import { inflateRawSync } from 'node:zlib'

interface ZipEntry { name: string; method: number; compSize: number; offset: number }

/** ZIP中央ディレクトリを読み、指定ファイルの展開後バッファを返す。無ければ null。 */
function readZipFile(buf: Buffer, wanted: (name: string) => boolean): Buffer | null {
  // End of Central Directory (EOCD) を末尾から探す（署名 0x06054b50）
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const cdCount = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16) // 中央ディレクトリ開始オフセット
  const entries: ZipEntry[] = []
  for (let n = 0; n < cdCount && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const fnLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + fnLen)
    entries.push({ name, method, compSize, offset })
    p += 46 + fnLen + extraLen + commentLen
  }
  const ent = entries.find((e) => wanted(e.name))
  if (!ent) return null
  // ローカルヘッダ（署名 0x04034b50）を読み、データ開始位置を求める
  const lp = ent.offset
  if (buf.readUInt32LE(lp) !== 0x04034b50) return null
  const lfnLen = buf.readUInt16LE(lp + 26)
  const lextraLen = buf.readUInt16LE(lp + 28)
  const dataStart = lp + 30 + lfnLen + lextraLen
  const comp = buf.subarray(dataStart, dataStart + ent.compSize)
  try {
    return ent.method === 0 ? Buffer.from(comp) : inflateRawSync(comp)
  } catch {
    return null
  }
}

/** 列参照 "AB" → 0始まりの列番号 */
function colToIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, '')
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

/** <si>…</si> ごとに内包する <t>…</t> を連結して共有文字列テーブルを作る */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const inner = m[1]
    let text = ''
    for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1]
    out.push(decodeXmlEntities(text))
  }
  return out
}

/**
 * XLSXバッファを rows(string[][]) に変換（最初のワークシート）。
 * 解析不能・非XLSXなら空配列。
 */
export function parseXlsxToRows(buf: Buffer): string[][] {
  if (!buf || buf.length < 4 || buf.readUInt16LE(0) !== 0x4b50) return [] // "PK"でなければ非ZIP
  const shared = readZipFile(buf, (n) => n === 'xl/sharedStrings.xml')
  const strings = shared ? parseSharedStrings(shared.toString('utf8')) : []
  // 最初のシート（sheet1.xml 優先、無ければ worksheets 配下の最初）
  const sheetBuf = readZipFile(buf, (n) => /^xl\/worksheets\/sheet1\.xml$/.test(n))
    || readZipFile(buf, (n) => /^xl\/worksheets\/.+\.xml$/.test(n))
  if (!sheetBuf) return []
  const xml = sheetBuf.toString('utf8')
  const rows: string[][] = []
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cm of rm[1].matchAll(/<c\s+r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ci = colToIndex(cm[1])
      const attrs = cm[2]
      const body = cm[3]
      const isShared = /\bt="s"/.test(attrs)
      const isInline = /\bt="inlineStr"/.test(attrs)
      let val = ''
      if (isInline) {
        for (const t of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) val += t[1]
        val = decodeXmlEntities(val)
      } else {
        const v = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)
        const raw = v ? v[1] : ''
        val = isShared ? (strings[Number(raw)] ?? '') : decodeXmlEntities(raw)
      }
      cells[ci] = val
    }
    // 空セルを空文字で埋める
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = ''
    rows.push(cells)
  }
  return rows
}
