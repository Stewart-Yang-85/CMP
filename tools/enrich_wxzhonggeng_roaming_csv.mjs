/**
 * Enrich docs/WXZHONGGENG Roaming Profile.csv with MCC (from public mcc-mnc-table) and mnc=*.
 * Usage: node tools/enrich_wxzhonggeng_roaming_csv.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCsvText } from '../dist/services/simImportCsv.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = path.join(root, 'docs', 'WXZHONGGENG Roaming Profile.csv')
const refPath = path.join(root, 'docs', 'mcc-mnc-table-ref.csv')
const outputPath = path.join(root, 'docs', 'WXZHONGGENG Roaming Profile.import-ready.csv')
const reportPath = path.join(root, 'docs', 'WXZHONGGENG Roaming Profile.mcc-report.txt')

function normCountryKey(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[()]/g, '')
}

/** WXZG / legacy names → reference table country key */
const COUNTRY_ALIASES = {
  'viet nam': 'vietnam',
  'russian federation': 'russia',
  'ivory coast': "cote d'ivoire",
  'democratic republic of the congo': 'democratic republic of the congo',
  'congo republic': 'congo',
  'macedonia': 'north macedonia',
  'north macedonia': 'macedonia, the former yugoslav republic of',
  'palestinian territory': 'palestine, state of',
  'swaziland': 'eswatini',
  'turks and caicos islands': 'turks and caicos islands',
  'st kitts and nevis': 'saint kitts and nevis',
  'st lucia': 'saint lucia',
  'st vincent and the grenadines': 'saint vincent and the grenadines',
  'sao tome and principe': 'sao tome and principe',
  'virgin islands british': 'british virgin islands',
  'uk channel islands - guernsey': 'guernsey',
  'uk channel islands - isle of man': 'isle of man',
  'uk channel islands - jersey': 'jersey',
  'netherlands antilles': 'bonaire, sint eustatius and saba',
  'cable adn wireless': 'dominica',
  'cble and wireless': 'turks and caicos islands',
  'digiccel': 'trinidad and tobago',
}

/** US PLMN uses MCC 310–316; one row per MCC with mnc=* (same WXZG rate). */
const US_MCC_CODES = ['310', '311', '312', '313', '314', '315', '316']

/** When reference table is ambiguous or WXZG name absent */
const MANUAL_MCC = {
  'united kingdom': '234',
  'ivory coast': '612',
  "cote d'ivoire": '612',
  'democratic republic of the congo': '630',
  'congo republic': '629',
  macedonia: '294',
  'north macedonia': '294',
  'netherlands antilles': '362',
  'palestinian territory': '425',
  swaziland: '653',
  eswatini: '653',
  turkey: '286',
  'uk channel islands - guernsey': '234',
  'uk channel islands - isle of man': '234',
  'uk channel islands - jersey': '234',
  guernsey: '234',
  'isle of man': '234',
  jersey: '234',
  kosovo: '221',
  'south sudan': '659',
  'faroe islands': '288',
  'french guiana': '742',
  'french polynesia': '547',
  reunion: '647',
  guadeloupe: '340',
  gibraltar: '266',
  monaco: '212',
  liechtenstein: '295',
  andorra: '213',
  'hong kong': '454',
  taiwan: '466',
  macau: '455',
}

function escapeCsvCell(value) {
  const s = String(value ?? '')
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function buildMccByCountryFromRef(refCsv) {
  const rows = parseCsvText(refCsv)
  const byCountry = new Map()
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const mcc = String(row[0] ?? '').trim()
    const country = String(row[5] ?? '').trim()
    if (!mcc || !country) continue
    const key = normCountryKey(country)
    if (!byCountry.has(key)) byCountry.set(key, new Set())
    byCountry.get(key).add(mcc)
  }
  const pick = new Map()
  for (const [key, mccs] of byCountry) {
    const sorted = [...mccs].sort((a, b) => Number(a) - Number(b))
    pick.set(key, sorted[0])
  }
  return pick
}

function resolveMcc(countryRaw, mccByCountry) {
  const trimmed = String(countryRaw ?? '').trim()
  const origKey = normCountryKey(trimmed)
  if (MANUAL_MCC[origKey]) return { mcc: MANUAL_MCC[origKey], source: 'manual' }
  let key = origKey
  if (COUNTRY_ALIASES[key]) key = normCountryKey(COUNTRY_ALIASES[key])
  if (MANUAL_MCC[key]) return { mcc: MANUAL_MCC[key], source: 'manual' }
  if (mccByCountry.has(key)) return { mcc: mccByCountry.get(key), source: 'ref' }
  // fuzzy: reference country starts with key or key starts with ref
  for (const [refKey, mcc] of mccByCountry) {
    if (refKey.includes(key) || key.includes(refKey)) return { mcc, source: `fuzzy:${refKey}` }
  }
  return { mcc: null, source: 'missing' }
}

async function main() {
  const [inputCsv, refCsv] = await Promise.all([
    readFile(inputPath, 'utf8'),
    readFile(refPath, 'utf8'),
  ])
  const mccByCountry = buildMccByCountryFromRef(refCsv)
  const matrix = parseCsvText(inputCsv)
  const header = matrix[0]
  const outLines = ['mcc,mnc,country,network,ratePerMb']
  const missing = []
  const fuzzy = []

  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row.some((c) => String(c ?? '').trim())) continue
    const country = String(row[2] ?? row[header.indexOf('Country')] ?? '').trim()
    const network = String(row[3] ?? '').trim()
    const ratePerMb = String(row[4] ?? row[header.length - 1] ?? '').trim()
    const countryKey = normCountryKey(country)
    const { mcc, source } = resolveMcc(country, mccByCountry)
    const mccList =
      countryKey === 'united states' ? US_MCC_CODES : mcc ? [mcc] : []
    if (!mccList.length) {
      missing.push({ line: i + 1, country })
    } else if (source.startsWith('fuzzy')) {
      fuzzy.push({ line: i + 1, country, mcc: mccList[0], source })
    }
    for (const mccCode of mccList) {
      outLines.push(
        [
          escapeCsvCell(mccCode),
          escapeCsvCell('*'),
          escapeCsvCell(country),
          escapeCsvCell(network),
          escapeCsvCell(ratePerMb),
        ].join(',')
      )
    }
  }

  await writeFile(outputPath, `${outLines.join('\n')}\n`, 'utf8')
  const report = [
    `Generated: ${outputPath}`,
    `Rows: ${outLines.length - 1}`,
    `Missing MCC: ${missing.length}`,
    ...missing.map((m) => `  line ${m.line}: ${m.country}`),
    `Fuzzy matches: ${fuzzy.length}`,
    ...fuzzy.slice(0, 30).map((m) => `  line ${m.line}: ${m.country} -> ${m.mcc} (${m.source})`),
    fuzzy.length > 30 ? `  ... and ${fuzzy.length - 30} more` : '',
  ].join('\n')
  await writeFile(reportPath, `${report}\n`, 'utf8')
  console.log(report)
  if (missing.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
