/**
 * SIM bulk-import CSV: flexible headers, per-row IME Lock rules.
 */

export const SIM_IMPORT_CANONICAL_COLUMNS = {
  iccid: 'iccid',
  imsi: 'imsi',
  msisdn: 'msisdn',
  secondaryImsi1: 'secondaryimsi1',
  secondaryImsi2: 'secondaryimsi2',
  secondaryImsi3: 'secondaryimsi3',
  formFactor: 'formfactor',
  activationCode: 'activationcode',
  imei: 'imei',
  imeiLockEnabled: 'imeilockenabled',
} as const

/** File must always include these columns (any common spelling). */
export const SIM_IMPORT_REQUIRED_HEADER_KEYS = [
  SIM_IMPORT_CANONICAL_COLUMNS.iccid,
  SIM_IMPORT_CANONICAL_COLUMNS.imsi,
] as const

const HEADER_ALIAS_TO_CANONICAL: Record<string, string> = {
  boundimei: SIM_IMPORT_CANONICAL_COLUMNS.imei,
  deviceimei: SIM_IMPORT_CANONICAL_COLUMNS.imei,
  imeilock: SIM_IMPORT_CANONICAL_COLUMNS.imeiLockEnabled,
  imeilocked: SIM_IMPORT_CANONICAL_COLUMNS.imeiLockEnabled,
  formfactor: SIM_IMPORT_CANONICAL_COLUMNS.formFactor,
  activationcode: SIM_IMPORT_CANONICAL_COLUMNS.activationCode,
  secondaryimsi1: SIM_IMPORT_CANONICAL_COLUMNS.secondaryImsi1,
  secondaryimsi2: SIM_IMPORT_CANONICAL_COLUMNS.secondaryImsi2,
  secondaryimsi3: SIM_IMPORT_CANONICAL_COLUMNS.secondaryImsi3,
}

export const ALLOWED_SIM_FORM_FACTORS = new Set([
  'consumer_removable',
  'industrial_removable',
  'consumer_embedded',
  'industrial_embedded',
])

export const SIM_IMPORT_MAX_DATA_ROWS = 100_000

export type SimImportCsvRow = {
  iccid: string
  primary_imsi: string
  msisdn: string | null
  imsi_secondary_1: string | null
  imsi_secondary_2: string | null
  imsi_secondary_3: string | null
  form_factor: string | null
  activation_code: string | null
  imei_lock_enabled: boolean
  bound_imei: string | null
}

export type ParseSimImportCsvResult =
  | { ok: true; rows: SimImportCsvRow[] }
  | { ok: false; status: number; code: string; message: string }

function toParseError(status: number, code: string, message: string): ParseSimImportCsvResult {
  return { ok: false, status, code, message }
}

function toRowPairingError(status: number, code: string, message: string): Extract<RowImeiLockPairingResult, { ok: false }> {
  return { ok: false, status, code, message }
}

export function normalizeSimImportHeaderKey(raw: string) {
  return String(raw ?? '')
    .trim()
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

export function canonicalizeSimImportHeaderKey(normalized: string) {
  if (!normalized) return ''
  return HEADER_ALIAS_TO_CANONICAL[normalized] ?? normalized
}

export function buildSimImportHeaderIndex(headerCells: string[]) {
  const index = new Map<string, number>()
  for (let i = 0; i < headerCells.length; i++) {
    const normalized = normalizeSimImportHeaderKey(headerCells[i])
    const canonical = canonicalizeSimImportHeaderKey(normalized)
    if (!canonical) continue
    if (index.has(canonical)) {
      return { ok: false as const, message: `Duplicate CSV column: ${headerCells[i]}.` }
    }
    index.set(canonical, i)
  }
  return { ok: true as const, index }
}

export function parseCsvBooleanTrue(value: unknown) {
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'y'
}

export function parseCsvBooleanFalse(value: unknown) {
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'false' || s === '0' || s === 'no' || s === 'n'
}

export function parseCsvText(csvText: string) {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let inQuotes = false
  const text = String(csvText ?? '')
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        value += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      row.push(value)
      value = ''
      continue
    }
    if (ch === '\n') {
      row.push(value)
      value = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      continue
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') continue
      row.push(value)
      value = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      continue
    }
    value += ch
  }
  if (value.length || row.length) {
    row.push(value)
    rows.push(row)
  }
  return rows
}

function getCsvCell(row: string[], headerIndex: Map<string, number>, canonicalKey: string) {
  const idx = headerIndex.get(canonicalKey)
  if (idx === undefined) return ''
  return row[idx] ?? ''
}

export type RowImeiLockPairingResult =
  | { ok: true; imei_lock_enabled: boolean; bound_imei: string | null }
  | { ok: false; status: number; code: string; message: string }

/**
 * IME Lock: `imeiLockEnabled` and `imei`/`bound_imei` must be supplied together —
 * both on (true + 15-digit imei) or both off (empty / omitted).
 */
export function resolveRowImeiLockPairing(
  row: string[],
  headerIndex: Map<string, number>,
  lineLabel: number | string
): RowImeiLockPairingResult {
  const hasLockCol = headerIndex.has(SIM_IMPORT_CANONICAL_COLUMNS.imeiLockEnabled)
  const hasImeiCol = headerIndex.has(SIM_IMPORT_CANONICAL_COLUMNS.imei)
  const lockRaw = hasLockCol ? String(getCsvCell(row, headerIndex, SIM_IMPORT_CANONICAL_COLUMNS.imeiLockEnabled)).trim() : ''
  const imeiRaw = hasImeiCol ? String(getCsvCell(row, headerIndex, SIM_IMPORT_CANONICAL_COLUMNS.imei)).trim() : ''

  const lockCellPresent = hasLockCol && lockRaw !== ''
  const imeiCellPresent = hasImeiCol && imeiRaw !== ''

  if (lockCellPresent && !parseCsvBooleanTrue(lockRaw) && !parseCsvBooleanFalse(lockRaw)) {
    return toRowPairingError(
      400,
      'INVALID_FORMAT',
      `Row ${lineLabel}: imeiLockEnabled must be true/false (accepted true: true, 1, yes, y).`
    )
  }

  const lockOn = lockCellPresent && parseCsvBooleanTrue(lockRaw)
  const imeiValid = imeiCellPresent && /^\d{15}$/.test(imeiRaw)

  if (imeiCellPresent && !imeiValid) {
    return toRowPairingError(400, 'INVALID_FORMAT', `Row ${lineLabel}: imei (bound_imei) must be 15 digits when provided.`)
  }

  if (lockOn !== imeiValid) {
    return toRowPairingError(
      400,
      'INVALID_FORMAT',
      `Row ${lineLabel}: imeiLockEnabled and imei must be provided together (IME Lock on requires both true and a 15-digit imei; IME Lock off requires both omitted).`
    )
  }

  if (lockOn && imeiValid) {
    return { ok: true, imei_lock_enabled: true, bound_imei: imeiRaw }
  }

  return { ok: true, imei_lock_enabled: false, bound_imei: null }
}

export function parseSimImportCsv(
  csvText: string,
  options?: {
    normalizeIccid?: (value: unknown) => string
    isValidIccid?: (value: unknown) => boolean
  }
): ParseSimImportCsvResult {
  const normalizeIccid =
    options?.normalizeIccid ??
    ((value: unknown) => (value === undefined || value === null ? '' : String(value).trim()))
  const isValidIccid =
    options?.isValidIccid ??
    ((value: unknown) => /^\d{18,20}$/.test(normalizeIccid(value)))

  const matrix = parseCsvText(csvText)
  if (!matrix.length) {
    return toParseError(400, 'INVALID_FORMAT', 'CSV file is empty.')
  }

  const headerBuilt = buildSimImportHeaderIndex(matrix[0])
  if (!headerBuilt.ok) {
    return toParseError(400, 'INVALID_FORMAT', headerBuilt.message)
  }
  const headerIndex = headerBuilt.index

  for (const required of SIM_IMPORT_REQUIRED_HEADER_KEYS) {
    if (!headerIndex.has(required)) {
      return toParseError(400, 'INVALID_FORMAT', `CSV missing required column: ${required}.`)
    }
  }

  const dataRows = matrix.slice(1).filter((r) => r.some((c) => String(c ?? '').trim().length > 0))
  if (!dataRows.length) {
    return toParseError(400, 'INVALID_FORMAT', 'CSV has no data rows.')
  }
  if (dataRows.length > SIM_IMPORT_MAX_DATA_ROWS) {
    return toParseError(400, 'FILE_TOO_LARGE', 'CSV row limit exceeded.')
  }

  const parsed: SimImportCsvRow[] = []
  const seenIccids = new Set<string>()

  for (let rowNum = 0; rowNum < dataRows.length; rowNum++) {
    const row = dataRows[rowNum]
    const lineLabel = rowNum + 2
    const iccid = normalizeIccid(getCsvCell(row, headerIndex, SIM_IMPORT_CANONICAL_COLUMNS.iccid))
    const imsiValue = String(getCsvCell(row, headerIndex, SIM_IMPORT_CANONICAL_COLUMNS.imsi)).trim()

    if (!iccid || !isValidIccid(iccid)) {
      return toParseError(400, 'INVALID_FORMAT', `Row ${lineLabel}: iccid must be 18-20 digits.`)
    }
    if (!imsiValue) {
      return toParseError(400, 'INVALID_FORMAT', `Row ${lineLabel}: imsi is required.`)
    }
    if (seenIccids.has(iccid)) {
      return toParseError(400, 'INVALID_FORMAT', `Row ${lineLabel}: duplicate iccid in file: ${iccid}.`)
    }
    seenIccids.add(iccid)

    const pairing = resolveRowImeiLockPairing(row, headerIndex, lineLabel)
    if (!pairing.ok) {
      return pairing
    }

    const formFactorRaw = String(getCsvCell(row, headerIndex, SIM_IMPORT_CANONICAL_COLUMNS.formFactor)).trim()
    if (formFactorRaw && !ALLOWED_SIM_FORM_FACTORS.has(formFactorRaw)) {
      return toParseError(400, 'INVALID_FORMAT', `Row ${lineLabel}: formFactor is invalid.`)
    }

    const optionalTrim = (key: string) => {
      const v = String(getCsvCell(row, headerIndex, key)).trim()
      return v || null
    }

    parsed.push({
      iccid,
      primary_imsi: imsiValue,
      msisdn: optionalTrim(SIM_IMPORT_CANONICAL_COLUMNS.msisdn),
      imsi_secondary_1: optionalTrim(SIM_IMPORT_CANONICAL_COLUMNS.secondaryImsi1),
      imsi_secondary_2: optionalTrim(SIM_IMPORT_CANONICAL_COLUMNS.secondaryImsi2),
      imsi_secondary_3: optionalTrim(SIM_IMPORT_CANONICAL_COLUMNS.secondaryImsi3),
      form_factor: formFactorRaw || null,
      activation_code: optionalTrim(SIM_IMPORT_CANONICAL_COLUMNS.activationCode),
      imei_lock_enabled: pairing.imei_lock_enabled,
      bound_imei: pairing.bound_imei,
    })
  }

  return { ok: true, rows: parsed }
}

export type ParseAssignIccidsResult =
  | { ok: true; iccids: string[] }
  | { ok: false; status: number; code: string; message: string }

/** Assign-inventory / assign-department CSV: required column **iccid**; optional **imsi** (ignored). Max 100 data rows; de-duplicates ICCIDs. Blank ICCID rows (incl. IMSI-only) are skipped. */
export function parseIccidsFromAssignInventoryCsv(csvText: string): ParseAssignIccidsResult {
  const matrix = parseCsvText(csvText)
  if (!matrix.length) {
    return { ok: false, status: 400, code: 'INVALID_FORMAT', message: 'CSV file is empty.' }
  }
  const headerBuilt = buildSimImportHeaderIndex(matrix[0])
  if (!headerBuilt.ok) {
    return { ok: false, status: 400, code: 'INVALID_FORMAT', message: headerBuilt.message }
  }
  const headerIndex = headerBuilt.index
  if (!headerIndex.has(SIM_IMPORT_CANONICAL_COLUMNS.iccid)) {
    return { ok: false, status: 400, code: 'INVALID_FORMAT', message: 'CSV missing required column: iccid.' }
  }
  const dataRows = matrix.slice(1).filter((r) => r.some((c) => String(c ?? '').trim().length > 0))
  if (!dataRows.length) {
    return { ok: false, status: 400, code: 'INVALID_FORMAT', message: 'CSV has no data rows.' }
  }
  if (dataRows.length > 100) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'CSV must not exceed 100 data rows.' }
  }
  const iccids: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const lineNo = i + 2 // 1-based file line including header
    const iccid = String(getCsvCell(row, headerIndex, SIM_IMPORT_CANONICAL_COLUMNS.iccid)).trim()
    // Skip blank ICCID rows (empty line remnants or IMSI-only); assignment is ICCID-keyed.
    if (!iccid) continue
    if (!/^\d{18,20}$/.test(iccid)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_FORMAT',
        message: `Row ${lineNo}: invalid iccid: ${iccid}`,
      }
    }
    if (!seen.has(iccid)) {
      seen.add(iccid)
      iccids.push(iccid)
    }
  }
  if (!iccids.length) {
    return { ok: false, status: 400, code: 'INVALID_FORMAT', message: 'CSV has no valid ICCIDs.' }
  }
  return { ok: true, iccids }
}

export const ROAMING_RATES_CSV_MAX_DATA_ROWS = 10_000

const ROAMING_RATES_HEADER_MCC = 'mcc'
const ROAMING_RATES_HEADER_MNC = 'mnc'
const ROAMING_RATES_HEADER_RATE = 'ratepermb'
const ROAMING_RATES_HEADER_COUNTRY = 'country'
const ROAMING_RATES_HEADER_NETWORK = 'network'

const ROAMING_RATES_REQUIRED_HEADERS = [
  ROAMING_RATES_HEADER_MCC,
  ROAMING_RATES_HEADER_MNC,
  ROAMING_RATES_HEADER_RATE,
] as const

const ROAMING_RATES_HEADER_ALIAS: Record<string, string> = {
  ratepermb: ROAMING_RATES_HEADER_RATE,
  rate_per_mb: ROAMING_RATES_HEADER_RATE,
}

export type RoamingRatesCsvEntry = {
  mcc: string
  mnc: string
  ratePerMb: number
  country?: string
  network?: string
}

export type ParseRoamingProfileRatesCsvResult =
  | { ok: true; entries: RoamingRatesCsvEntry[]; rowCount: number }
  | { ok: false; status: number; code: string; message: string }

function toRoamingCsvError(status: number, code: string, message: string): ParseRoamingProfileRatesCsvResult {
  return { ok: false, status, code, message }
}

export function canonicalizeRoamingRatesHeaderKey(normalized: string) {
  if (!normalized) return ''
  return ROAMING_RATES_HEADER_ALIAS[normalized] ?? normalized
}

export function buildRoamingRatesHeaderIndex(headerCells: string[]) {
  const index = new Map<string, number>()
  for (let i = 0; i < headerCells.length; i++) {
    const normalized = normalizeSimImportHeaderKey(headerCells[i])
    const canonical = canonicalizeRoamingRatesHeaderKey(normalized)
    if (!canonical) continue
    if (index.has(canonical)) {
      return { ok: false as const, message: `Duplicate CSV column: ${headerCells[i]}.` }
    }
    index.set(canonical, i)
  }
  return { ok: true as const, index }
}

function getRoamingRatesCsvCell(row: string[], headerIndex: Map<string, number>, key: string) {
  const idx = headerIndex.get(key)
  if (idx === undefined) return ''
  return row[idx] ?? ''
}

/**
 * Parse roaming profile rate CSV (columns mcc, mnc, ratePerMb; optional country, network).
 * Display fields are passed through for {@link createRoamingProfile} normalization.
 */
export function parseRoamingProfileRatesCsv(csvText: string): ParseRoamingProfileRatesCsvResult {
  const matrix = parseCsvText(csvText)
  if (!matrix.length) {
    return toRoamingCsvError(400, 'INVALID_FORMAT', 'CSV file is empty.')
  }
  const headerBuilt = buildRoamingRatesHeaderIndex(matrix[0])
  if (!headerBuilt.ok) {
    return toRoamingCsvError(400, 'INVALID_FORMAT', headerBuilt.message)
  }
  const headerIndex = headerBuilt.index
  for (const required of ROAMING_RATES_REQUIRED_HEADERS) {
    if (!headerIndex.has(required)) {
      const label = required === ROAMING_RATES_HEADER_RATE ? 'ratePerMb' : required
      return toRoamingCsvError(400, 'INVALID_FORMAT', `CSV missing required column: ${label}.`)
    }
  }
  const dataRows = matrix.slice(1).filter((r) => r.some((c) => String(c ?? '').trim().length > 0))
  if (!dataRows.length) {
    return toRoamingCsvError(400, 'INVALID_FORMAT', 'CSV has no data rows.')
  }
  if (dataRows.length > ROAMING_RATES_CSV_MAX_DATA_ROWS) {
    return toRoamingCsvError(
      400,
      'BAD_REQUEST',
      `CSV must not exceed ${ROAMING_RATES_CSV_MAX_DATA_ROWS} data rows.`
    )
  }
  const entries: RoamingRatesCsvEntry[] = []
  for (let i = 0; i < dataRows.length; i++) {
    const lineNo = i + 2
    const row = dataRows[i]
    const mcc = String(getRoamingRatesCsvCell(row, headerIndex, ROAMING_RATES_HEADER_MCC)).trim()
    const mnc = String(getRoamingRatesCsvCell(row, headerIndex, ROAMING_RATES_HEADER_MNC)).trim()
    const rateRaw = String(getRoamingRatesCsvCell(row, headerIndex, ROAMING_RATES_HEADER_RATE)).trim()
    if (!mcc) {
      return toRoamingCsvError(400, 'INVALID_FORMAT', `CSV row ${lineNo}: mcc is required.`)
    }
    if (!mnc) {
      return toRoamingCsvError(400, 'INVALID_FORMAT', `CSV row ${lineNo}: mnc is required (use * for wildcard).`)
    }
    if (!rateRaw) {
      return toRoamingCsvError(400, 'INVALID_FORMAT', `CSV row ${lineNo}: ratePerMb is required.`)
    }
    const ratePerMb = Number(rateRaw)
    if (!Number.isFinite(ratePerMb) || ratePerMb < 0) {
      return toRoamingCsvError(
        400,
        'INVALID_FORMAT',
        `CSV row ${lineNo}: ratePerMb must be a non-negative number.`
      )
    }
    const entry: RoamingRatesCsvEntry = { mcc, mnc, ratePerMb }
    if (headerIndex.has(ROAMING_RATES_HEADER_COUNTRY)) {
      entry.country = String(getRoamingRatesCsvCell(row, headerIndex, ROAMING_RATES_HEADER_COUNTRY)).trim()
    }
    if (headerIndex.has(ROAMING_RATES_HEADER_NETWORK)) {
      entry.network = String(getRoamingRatesCsvCell(row, headerIndex, ROAMING_RATES_HEADER_NETWORK)).trim()
    }
    entries.push(entry)
  }
  return { ok: true, entries, rowCount: entries.length }
}

function escapeRoamingRatesCsvCell(value: unknown) {
  const s = String(value ?? '')
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Serialize mccmnc rows for POST /roaming-profiles:import-csv (round-trip with parseRoamingProfileRatesCsv). */
export function serializeRoamingProfileRatesCsv(entries: RoamingRatesCsvEntry[]) {
  const lines = ['mcc,mnc,country,network,ratePerMb']
  for (const entry of entries) {
    lines.push(
      [
        escapeRoamingRatesCsvCell(entry.mcc),
        escapeRoamingRatesCsvCell(entry.mnc),
        escapeRoamingRatesCsvCell(entry.country ?? ''),
        escapeRoamingRatesCsvCell(entry.network ?? ''),
        escapeRoamingRatesCsvCell(entry.ratePerMb),
      ].join(',')
    )
  }
  return `${lines.join('\n')}\n`
}
