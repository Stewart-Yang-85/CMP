import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

function toStr(v) {
  return v === undefined || v === null ? null : String(v)
}

async function ensureSupplier(supabase, name) {
  const rows = await supabase.select('suppliers', `select=supplier_id,name,status&name=eq.${encodeURIComponent(name)}&limit=1`)
  const existing = Array.isArray(rows) ? rows[0] : null
  if (existing) return existing
  const created = await supabase.insert('suppliers', { name, status: 'ACTIVE' })
  return Array.isArray(created) ? created[0] : null
}

async function ensureBusinessOperator(supabase, mcc, mnc, name = null) {
  const rows = await supabase.select(
    'business_operators',
    `select=operator_id,mcc,mnc,name&mcc=eq.${encodeURIComponent(mcc)}&mnc=eq.${encodeURIComponent(mnc)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (existing) return existing
  const created = await supabase.insert('business_operators', { mcc, mnc, name })
  return Array.isArray(created) ? created[0] : null
}

async function ensureOperator(supabase, supplierId, businessOperatorId, name = null) {
  const rows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id,business_operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (existing) return existing
  const created = await supabase.insert('operators', {
    supplier_id: supplierId,
    business_operator_id: businessOperatorId,
    name,
  })
  return Array.isArray(created) ? created[0] : null
}

async function ensureSim(supabase, iccid, primaryImsi, msisdn, supplierId, operatorId) {
  const rows = await supabase.select('sims', `select=sim_id,iccid,primary_imsi,msisdn,operator_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
  const existing = Array.isArray(rows) ? rows[0] : null
  if (existing) {
    const updates = {}
    if (!existing.primary_imsi && primaryImsi) updates.primary_imsi = primaryImsi
    if (!existing.msisdn && msisdn) updates.msisdn = msisdn
    if (!existing.operator_id && operatorId) updates.operator_id = operatorId
    if (Object.keys(updates).length > 0) {
      await supabase.update('sims', `sim_id=eq.${encodeURIComponent(existing.sim_id)}`, updates, { returning: 'minimal' })
    }
    return existing
  }
  const created = await supabase.insert('sims', {
    iccid,
    primary_imsi: primaryImsi,
    msisdn,
    supplier_id: supplierId,
    operator_id: operatorId,
    status: 'INVENTORY'
  })
  return Array.isArray(created) ? created[0] : null
}

async function main() {
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const supplier = await ensureSupplier(supabase, 'WXZHONGGENG')
  if (!supplier) throw new Error('Failed to ensure supplier WXZHONGGENG')
  const bo = await ensureBusinessOperator(supabase, '204', '08', 'MCC 204 MNC 08')
  if (!bo) throw new Error('Failed to ensure business_operator 204/08')
  const operator = await ensureOperator(supabase, supplier.supplier_id, bo.operator_id, bo.name)
  if (!operator) throw new Error('Failed to ensure operator link')

  const sims = [
    { iccid: '893107032536638540', imsi: '204080936638540', msisdn: '3197093407905' },
    { iccid: '893107032536638542', imsi: '204080936638542', msisdn: '3197093587962' },
    { iccid: '893107032536638543', imsi: '204080936638543', msisdn: '3197093409581' },
    { iccid: '893107032536638550', imsi: '204080936638550', msisdn: '3197093512064' },
    { iccid: '893107032536638556', imsi: '204080936638556', msisdn: '3197093471902' },
    { iccid: '893107032536638559', imsi: '204080936638559', msisdn: '3197092818483' },
    { iccid: '893107032536638560', imsi: '204080936638560', msisdn: '3197092819131' },
    { iccid: '893107032536638561', imsi: '204080936638561', msisdn: '3197092853082' },
    { iccid: '893107032536638672', imsi: '204080936638672', msisdn: '3197092881678' },
    { iccid: '893107032536638673', imsi: '204080936638673', msisdn: '3197092860546' },
    { iccid: '893107032536638674', imsi: '204080936638674', msisdn: '3197092864208' },
    { iccid: '893107032536640861', imsi: '204080936640861', msisdn: '3197030645040' },
    { iccid: '893107032536642026', imsi: '204080936642026', msisdn: '3197093469494' },
    { iccid: '893107032536642107', imsi: '204080936642107', msisdn: '3197090012712' },
    { iccid: '893107032536642108', imsi: '204080936642108', msisdn: '3197090012720' },
    { iccid: '893107032536642109', imsi: '204080936642109', msisdn: '3197090018023' },
    { iccid: '893107032536642110', imsi: '204080936642110', msisdn: '3197090043158' },
    { iccid: '893107032536642111', imsi: '204080936642111', msisdn: '3197090091141' },
    { iccid: '893107032536642331', imsi: '204080936642331', msisdn: '3197092808046' },
    { iccid: '893107032536642332', imsi: '204080936642332', msisdn: '3197092809195' },
    { iccid: '893107032536642333', imsi: '204080936642333', msisdn: '3197092810669' },
    { iccid: '893107032536642334', imsi: '204080936642334', msisdn: '3197092813043' },
    { iccid: '893107032536642335', imsi: '204080936642335', msisdn: '3197092813164' },
    { iccid: '893107032536642336', imsi: '204080936642336', msisdn: '3197092897805' },
    { iccid: '893107032536642337', imsi: '204080936642337', msisdn: '3197092812113' },
    { iccid: '893107032536642338', imsi: '204080936642338', msisdn: '3197092811824' },
    { iccid: '893107032536642339', imsi: '204080936642339', msisdn: '3197092813526' },
    { iccid: '893107032536642340', imsi: '204080936642340', msisdn: '3197092813607' },
    { iccid: '893107032536642341', imsi: '204080936642341', msisdn: '3197092865768' },
    { iccid: '893107032536642342', imsi: '204080936642342', msisdn: '3197092873106' },
    { iccid: '893107032536642493', imsi: '204080936642493', msisdn: '3197093269450' },
    { iccid: '893107032536642494', imsi: '204080936642494', msisdn: '3197093245023' },
    { iccid: '893107032536642495', imsi: '204080936642495', msisdn: '3197093252170' },
    { iccid: '893107032536642496', imsi: '204080936642496', msisdn: '3197093243320' },
    { iccid: '893107032536642831', imsi: '204080936642831', msisdn: '3197093264312' },
    { iccid: '893107032536648559', imsi: '204080936648559', msisdn: '3197030033610' },
    { iccid: '893107032536648560', imsi: '204080936648560', msisdn: '3197030668390' },
    { iccid: '893107032536648561', imsi: '204080936648561', msisdn: '3197030036228' },
    { iccid: '893107032536648562', imsi: '204080936648562', msisdn: '3197030621882' },
    { iccid: '893107032536648563', imsi: '204080936648563', msisdn: '3197030655604' },
    { iccid: '893107032536649602', imsi: '204080936649602', msisdn: '3197093575179' },
    { iccid: '893107032536649603', imsi: '204080936649603', msisdn: '3197093575201' },
    { iccid: '893107032536649621', imsi: '204080936649621', msisdn: '3197032873150' },
    { iccid: '893107032536649622', imsi: '204080936649622', msisdn: '3197032873152' },
    { iccid: '893107032536649623', imsi: '204080936649623', msisdn: '3197032873155' },
    { iccid: '893107032536649624', imsi: '204080936649624', msisdn: '3197032873173' },
    { iccid: '893107032536651314', imsi: '204080936651314', msisdn: '3197093237880' },
    { iccid: '893107032536651315', imsi: '204080936651315', msisdn: '3197093202053' },
    { iccid: '893107032536651316', imsi: '204080936651316', msisdn: '3197093261051' },
    { iccid: '893107032536651317', imsi: '204080936651317', msisdn: '3197093303599' },
    { iccid: '893107032536651318', imsi: '204080936651318', msisdn: '3197093293863' },
    { iccid: '893107999900155563', imsi: '204080930497065', msisdn: '3197092675730' },
    { iccid: '893107999900155684', imsi: '204080930497186', msisdn: '3197030275141' },
    { iccid: '893107999900155685', imsi: '204080930497187', msisdn: '3197030160220' },
    { iccid: '893107999900155686', imsi: '204080930497188', msisdn: '3197030108380' },
    { iccid: '893107999900155761', imsi: '204080930497263', msisdn: '3197090657425' },
    { iccid: '893107999900155762', imsi: '204080930497264', msisdn: '3197090657443' },
    { iccid: '8965012004140729132', imsi: '525016126002953', msisdn: '65144095014986' },
    { iccid: '8965012004140729348', imsi: '525016126002974', msisdn: '65144095015007' },
    { iccid: '8965012006266286367', imsi: '525016126013676', msisdn: '65144095009461' },
    { iccid: '8965012309280009348', imsi: '525016126439671', msisdn: '65144095224070' },
    { iccid: '8965012309280009355', imsi: '525016126439672', msisdn: '65144095224071' },
    { iccid: '8965012309280009363', imsi: '525016126439673', msisdn: '65144095224072' },
    { iccid: '8965012309280009371', imsi: '525016126439674', msisdn: '65144095224073' },
    { iccid: '8965012309280009389', imsi: '525016126439675', msisdn: '65144095224074' },
    { iccid: '8965012309280009397', imsi: '525016126439676', msisdn: '65144095224075' },
    { iccid: '8965012309280009405', imsi: '525016126439677', msisdn: '65144095224076' },
    { iccid: '8965012309280009413', imsi: '525016126439678', msisdn: '65144095224077' },
    { iccid: '8965012309280009421', imsi: '525016126439679', msisdn: '65144095224078' },
    { iccid: '8965012309280009439', imsi: '525016126439680', msisdn: '65144095224079' },
    { iccid: '8965012309280009447', imsi: '525016126439681', msisdn: '65144095224080' },
    { iccid: '8965012309280009454', imsi: '525016126439682', msisdn: '65144095224081' },
    { iccid: '8965012309280009462', imsi: '525016126439683', msisdn: '65144095224082' },
    { iccid: '8965012309280009470', imsi: '525016126439684', msisdn: '65144095224083' },
    { iccid: '8965012309280009488', imsi: '525016126439685', msisdn: '65144095224084' },
    { iccid: '8965012309280009496', imsi: '525016126439686', msisdn: '65144095224085' },
    { iccid: '8965012309280009504', imsi: '525016126439687', msisdn: '65144095224086' },
    { iccid: '8965012309280009512', imsi: '525016126439688', msisdn: '65144095224087' },
    { iccid: '8965012309280009520', imsi: '525016126439689', msisdn: '65144095224088' },
    { iccid: '8965012309280009868', imsi: '525016126439723', msisdn: '65144095224122' },
    { iccid: '8965012309280009876', imsi: '525016126439724', msisdn: '65144095225004' },
    { iccid: '8965012309280009884', imsi: '525016126439725', msisdn: '65144095225005' },
    { iccid: '8965012309280009918', imsi: '525016126439728', msisdn: '65144095225008' },
    { iccid: '8965012309280009926', imsi: '525016126439729', msisdn: '65144095225009' }
  ]

  const results = []
  for (const entry of sims) {
    const iccid = toStr(entry.iccid)
    const imsi = toStr(entry.imsi)
    const msisdn = toStr(entry.msisdn)
    if (!iccid) continue
    const sim = await ensureSim(supabase, iccid, imsi, msisdn, supplier.supplier_id, operator.operator_id)
    if (!sim) throw new Error(`Failed to ensure sim ${iccid}`)
    results.push({ iccid, simId: sim.sim_id })
  }

  process.stdout.write(JSON.stringify({
    supplierId: supplier.supplier_id,
    operatorId: operator.operator_id,
    sims: results
  }) + '\n')
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  process.exit(1)
})
