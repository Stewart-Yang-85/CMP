/**
 * Generate customer-facing IoT CMP Reseller Platform PPTX (business tone, ≤30 slides).
 * Run: node tools/generate_customer_pptx.mjs
 */
import PptxGenJS from 'pptxgenjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.join(__dirname, '..', 'presentationToCustomers', 'IoT_CMP_Reseller_Platform_Customer_Brief.pptx')

const COLORS = {
  navy: '0B1F33',
  teal: '0D7377',
  accent: '14919B',
  light: 'F4F7F8',
  white: 'FFFFFF',
  dark: '1A1A1A',
  muted: '5A6A75',
  line: 'D0DCE3',
}

const pptx = new PptxGenJS()
pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 })
pptx.layout = 'WIDE'
pptx.author = 'IoT CMP'
pptx.title = 'IoT CMP Reseller Platform — Customer Brief'
pptx.subject = 'Business introduction to IoT Connectivity Management Platform for Resellers'

function addFooter(slide, page, total = 28) {
  slide.addText('IoT CMP Reseller Platform  |  Confidential', {
    x: 0.5,
    y: 7.15,
    w: 10,
    h: 0.25,
    fontSize: 10,
    color: COLORS.muted,
    fontFace: 'Calibri',
  })
  slide.addText(`${page} / ${total}`, {
    x: 11.5,
    y: 7.15,
    w: 1.3,
    h: 0.25,
    fontSize: 10,
    color: COLORS.muted,
    align: 'right',
    fontFace: 'Calibri',
  })
}

function addSectionBar(slide, title) {
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0,
    y: 0,
    w: 13.333,
    h: 0.9,
    fill: { color: COLORS.navy },
  })
  slide.addText(title, {
    x: 0.5,
    y: 0.25,
    w: 12,
    h: 0.45,
    fontSize: 24,
    bold: true,
    color: COLORS.white,
    fontFace: 'Calibri',
  })
}

function bullets(slide, items, opts = {}) {
  const x = opts.x ?? 0.6
  const y = opts.y ?? 1.2
  const w = opts.w ?? 12.1
  slide.addText(
    items.map((t) => ({
      text: t,
      options: { bullet: true, breakLine: true },
    })),
    {
      x,
      y,
      w,
      h: opts.h ?? 5.5,
      fontSize: opts.fontSize ?? 16,
      color: COLORS.dark,
      fontFace: 'Calibri',
      paraSpacing: 8,
    }
  )
}

function card(slide, x, y, w, h, title, bodyLines) {
  slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x,
    y,
    w,
    h,
    fill: { color: COLORS.white },
    shadow: { type: 'outer', color: '000000', blur: 6, opacity: 0.08, offset: 2 },
    line: { color: COLORS.line, width: 1 },
    rectRadius: 0.08,
  })
  slide.addShape(pptx.shapes.RECTANGLE, {
    x,
    y,
    w,
    h: 0.45,
    fill: { color: COLORS.teal },
  })
  slide.addText(title, {
    x: x + 0.15,
    y: y + 0.08,
    w: w - 0.3,
    h: 0.32,
    fontSize: 14,
    bold: true,
    color: COLORS.white,
    fontFace: 'Calibri',
  })
  slide.addText(
    bodyLines.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
    {
      x: x + 0.2,
      y: y + 0.6,
      w: w - 0.4,
      h: h - 0.8,
      fontSize: 13,
      color: COLORS.dark,
      fontFace: 'Calibri',
      paraSpacing: 4,
    }
  )
}

// —— 1 Cover ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.navy } })
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 5.8, w: 13.333, h: 1.7, fill: { color: COLORS.teal } })
  s.addText('IoT Connectivity Management Platform', {
    x: 0.8,
    y: 2.2,
    w: 11.5,
    h: 0.6,
    fontSize: 36,
    bold: true,
    color: COLORS.white,
    fontFace: 'Calibri',
  })
  s.addText('面向物联网连接分销的 CMP Reseller 平台', {
    x: 0.8,
    y: 2.9,
    w: 11.5,
    h: 0.45,
    fontSize: 22,
    color: 'B8D4D8',
    fontFace: 'Calibri',
  })
  s.addText('客户介绍材料  ·  商业模式 · 架构 · 核心能力 · 推荐流程', {
    x: 0.8,
    y: 6.2,
    w: 11.5,
    h: 0.4,
    fontSize: 16,
    color: COLORS.white,
    fontFace: 'Calibri',
  })
  s.addText('V1.1  |  Confidential', {
    x: 0.8,
    y: 6.7,
    w: 11.5,
    h: 0.3,
    fontSize: 12,
    color: 'D0E8EA',
    fontFace: 'Calibri',
  })
}

// —— 2 Agenda ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '目录')
  const agenda = [
    ['01', '平台价值与定位'],
    ['02', '支持的商业模式'],
    ['03', '多租户与组织角色'],
    ['04', '系统架构概览'],
    ['05', '上游集成与下游推送'],
    ['06', '核心功能模块'],
    ['07', '推荐端到端业务流程'],
    ['08', '安全、审计与总结'],
  ]
  agenda.forEach((row, i) => {
    const col = i < 4 ? 0 : 1
    const rowIdx = i % 4
    const x = 0.7 + col * 6.2
    const y = 1.3 + rowIdx * 1.2
    s.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
      x,
      y,
      w: 5.8,
      h: 0.95,
      fill: { color: COLORS.white },
      line: { color: COLORS.line, width: 1 },
      rectRadius: 0.06,
    })
    s.addText(row[0], {
      x: x + 0.25,
      y: y + 0.25,
      w: 0.8,
      h: 0.45,
      fontSize: 20,
      bold: true,
      color: COLORS.teal,
      fontFace: 'Calibri',
    })
    s.addText(row[1], {
      x: x + 1.2,
      y: y + 0.28,
      w: 4.3,
      h: 0.4,
      fontSize: 18,
      color: COLORS.dark,
      fontFace: 'Calibri',
    })
  })
  addFooter(s, 2)
}

// —— 3 Value ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '平台价值：连接分销的运营中枢')
  bullets(s, [
    '帮助代理商（Reseller）统一管理上游连接资源，并向企业客户提供可运营的连接与资费服务',
    '以 API 与 Portal 双通道交付：对接现有业务系统，同时支持日常运营操作',
    '覆盖 SIM 全生命周期、产品与资费、用量批价、出账、告警与审计，形成闭环',
    '多租户隔离与细粒度权限，满足渠道与企业客户并存的商业结构',
    '可扩展的上游适配能力，降低对接不同供应商 / 运营商 CMP 的成本',
  ], { y: 1.3 })
  addFooter(s, 3)
}

// —— 4 Positioning ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '定位：API-first 的 Reseller CMP')
  card(s, 0.5, 1.3, 4, 5.2, '对代理商', [
    '统一库存与客户视图',
    '灵活组装产品包与资费',
    '批价与出账可追溯',
    '白标与渠道运营能力',
  ])
  card(s, 4.7, 1.3, 4, 5.2, '对企业客户', [
    '按权限使用连接资产',
    '用量与告警可视',
    '账单与调账清晰',
    'API / 事件对接业务系统',
  ])
  card(s, 8.9, 1.3, 3.9, 5.2, '对平台运营', [
    '主数据与集成配置',
    '全局审计与任务编排',
    '供应商健康与对账',
    '安全的凭证与租户治理',
  ])
  addFooter(s, 4)
}

// —— 5 Business models title ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '支持的商业模式')
  bullets(s, [
    '平台统一以「供应商 + 运营商 + 上游集成」描述上游能力，租户树从代理商开始向下展开',
    '两种常见供应链形态均可落地，且在系统中保持一致的主数据建模',
    '代理商可同时服务多家企业客户；企业下可再分子部门 / 项目进行授权隔离',
  ], { y: 1.3, h: 2.2 })
  s.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x: 0.5,
    y: 3.6,
    w: 12.3,
    h: 2.9,
    fill: { color: COLORS.white },
    line: { color: COLORS.line, width: 1 },
    rectRadius: 0.08,
  })
  s.addText('统一原则：供应商 / 运营商 / 上游集成 = 平台主数据；RESELLER → ENTERPRISE → DEPARTMENT = 业务租户树', {
    x: 0.8,
    y: 4.5,
    w: 11.7,
    h: 1.0,
    fontSize: 18,
    color: COLORS.navy,
    align: 'center',
    fontFace: 'Calibri',
    bold: true,
  })
  addFooter(s, 5)
}

// —— 6 Mode A ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '模式 A：运营商 CMP 即上游对接对象')
  bullets(s, [
    '上游「供应商」与运营商身份在业务上合一，但系统仍显式维护供应商与运营商实体及关联',
    '链路：运营商 CMP（供应商）→ 本平台（Reseller System）→ 企业 Portal / API',
    '适合：直接向运营商采购连接、渠道侧快速开户与分销的场景',
    '价值：缩短对接路径，同时保留标准主数据，便于后续扩展多运营商覆盖',
  ], { y: 1.3 })
  s.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x: 0.6,
    y: 4.6,
    w: 12.1,
    h: 1.9,
    fill: { color: COLORS.navy },
    rectRadius: 0.08,
  })
  s.addText('运营商 CMP  ──►  IoT CMP Reseller  ──►  企业客户', {
    x: 0.8,
    y: 5.2,
    w: 11.7,
    h: 0.6,
    fontSize: 22,
    bold: true,
    color: COLORS.white,
    align: 'center',
    fontFace: 'Calibri',
  })
  addFooter(s, 6)
}

// —— 7 Mode B ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '模式 B：独立供应商 CMP 聚合底层运营商')
  bullets(s, [
    '供应商为独立实体，其侧对接一个或多个运营商 CMP；代理商主要对接供应商 CMP',
    '链路：运营商 CMP → 供应商 CMP → 本平台 → 企业客户',
    '适合：多运营商覆盖、供应商集中供货与结算的渠道结构',
    '平台通过供应商—运营商关联与上游集成配置，清晰表达「向谁下发、按谁计费」',
  ], { y: 1.3 })
  s.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x: 0.6,
    y: 4.6,
    w: 12.1,
    h: 1.9,
    fill: { color: COLORS.navy },
    rectRadius: 0.08,
  })
  s.addText('运营商  →  供应商 CMP  →  IoT CMP Reseller  →  企业客户', {
    x: 0.8,
    y: 5.2,
    w: 11.7,
    h: 0.6,
    fontSize: 20,
    bold: true,
    color: COLORS.white,
    align: 'center',
    fontFace: 'Calibri',
  })
  addFooter(s, 7)
}

// —— 8 Tenants ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '多租户与角色：渠道与客户分层治理')
  card(s, 0.5, 1.25, 4, 5.3, '租户树', [
    '代理商 RESELLER',
    '企业 ENTERPRISE',
    '部门 / 项目 DEPARTMENT',
    '数据默认最小可见、最小可操作',
  ])
  card(s, 4.7, 1.25, 4, 5.3, '代理商侧角色', [
    '管理员：全域运营',
    '销售总监 / 销售：按分配企业',
    '财务：账务只读',
  ])
  card(s, 8.9, 1.25, 3.9, 5.3, '企业侧与平台', [
    '企业管理员 / 运维',
    '平台管理员：初始化与全局运维',
    '支持 API Key / 令牌接入',
  ])
  addFooter(s, 8)
}

// —— 9 Architecture ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '系统架构概览')
  bullets(s, [
    '形态：API-first 模块化单体 — 路由 / 服务 / 上游适配 / 中间件分层清晰',
    '对外：REST API（OpenAPI）+ Swagger，Portal 与第三方系统共用同一契约',
    '对内：异步 Jobs / Worker（开通、用量同步、批价、出账、告警、Webhook 投递等）',
    '数据：多租户业务库（组织、SIM、产品、用量、账单、事件、审计）',
    '集成：Vendor SPI + 上游集成配置（凭证加密），支持入站 Webhook 与出站事件推送',
  ], { y: 1.25 })
  addFooter(s, 9)
}

// —— 10 Architecture layers ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '逻辑分层（商务可读）')
  const layers = [
    ['体验与接入', 'Web Portal · 企业 / 代理商运营台 · 合作方 API'],
    ['业务能力', 'SIM · 产品资费 · 订阅 · 用量批价 · 账单 · 告警 · 报表'],
    ['编排与集成', 'Jobs / Worker · 上游 Adapter · 入站 / 出站 Webhook'],
    ['数据与安全', '租户隔离 · RBAC · 审计 · 凭证加密 · 事件留痕'],
  ]
  layers.forEach((L, i) => {
    const y = 1.25 + i * 1.3
    s.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
      x: 0.6,
      y,
      w: 12.1,
      h: 1.1,
      fill: { color: i % 2 === 0 ? COLORS.navy : COLORS.teal },
      rectRadius: 0.06,
    })
    s.addText(L[0], {
      x: 0.9,
      y: y + 0.3,
      w: 2.8,
      h: 0.45,
      fontSize: 16,
      bold: true,
      color: COLORS.white,
      fontFace: 'Calibri',
    })
    s.addText(L[1], {
      x: 3.8,
      y: y + 0.3,
      w: 8.5,
      h: 0.45,
      fontSize: 15,
      color: COLORS.white,
      fontFace: 'Calibri',
    })
  })
  addFooter(s, 10)
}

// —— 11 Upstream ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '与上游系统集成')
  bullets(s, [
    '按「供应商 + 运营商」配置上游集成：端点、适配器类型、API 凭证与 Webhook 密钥',
    '凭证采用应用层加密保管，避免明文落库',
    '典型能力：SIM 状态变更下发、用量 / 诊断查询、批量同步任务',
    '入站 Webhook：接收上游异步通知，进入统一目录与分发逻辑',
    '能力矩阵按适配器声明：上游全量 / 部分 / 本地拼装 / 不支持，避免虚假承诺',
  ], { y: 1.25 })
  addFooter(s, 11)
}

// —— 12 Downstream ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '向下游推送：事件与 Webhook')
  card(s, 0.5, 1.25, 6, 5.3, '业务事件', [
    'SIM 状态变更、任务完成',
    '企业状态、账单相关事件等',
    '可供门户订阅与审计追溯',
  ])
  card(s, 6.8, 1.25, 6, 5.3, '出站 Webhook', [
    '代理商 / 企业可订阅事件类型',
    '失败重试与投递记录可查',
    '支持人工重试（授权角色）',
    '与告警投递通道可协同',
  ])
  addFooter(s, 12)
}

// —— 13 Module map ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '核心功能模块总览')
  const mods = [
    ['组织与权限', '租户 · 用户 · RBAC'],
    ['主数据', '供应商 · 运营商 · 公共信息'],
    ['SIM 资产', '入库 · 生命周期 · 诊断'],
    ['产品与资费', '价计划 · 网络档案 · 产品包'],
    ['订阅', '开通 · 变更 · 取消编排'],
    ['用量与批价', '日汇总 · Rating · 月固化'],
    ['账单', '出账 · 发布 · 调账 · 催收'],
    ['告警与报表', '规则 · 投递 · 经营分析'],
    ['集成', '上游 · 出入站 Webhook'],
    ['任务与审计', 'Jobs · 审计日志 · 可观测'],
  ]
  mods.forEach((m, i) => {
    const col = i % 5
    const row = Math.floor(i / 5)
    const x = 0.45 + col * 2.55
    const y = 1.35 + row * 2.6
    s.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
      x,
      y,
      w: 2.4,
      h: 2.2,
      fill: { color: COLORS.white },
      line: { color: COLORS.line, width: 1 },
      rectRadius: 0.08,
    })
    s.addText(m[0], {
      x: x + 0.1,
      y: y + 0.55,
      w: 2.2,
      h: 0.5,
      fontSize: 14,
      bold: true,
      color: COLORS.navy,
      align: 'center',
      fontFace: 'Calibri',
    })
    s.addText(m[1], {
      x: x + 0.1,
      y: y + 1.15,
      w: 2.2,
      h: 0.7,
      fontSize: 12,
      color: COLORS.muted,
      align: 'center',
      fontFace: 'Calibri',
    })
  })
  addFooter(s, 13)
}

// —— 14 SIM ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '模块：SIM 资产与生命周期')
  bullets(s, [
    '以物理 SIM 为主线：入库、查询、分配企业、状态变更、导出与审计',
    '状态涵盖库存、测试就绪、激活、停用、拆机等关键节点',
    '关键变更可异步下发上游，任务状态可追踪',
    '诊断能力：连接状态、拜访网络等（按上游能力矩阵组合本地与上游数据）',
    'eSIM Profile 提供轻量管理，与物理 SIM 生命周期编排解耦（V1.1）',
  ], { y: 1.25 })
  addFooter(s, 14)
}

// —— 15 Pricing ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '模块：产品、资费与装配')
  bullets(s, [
    '可复用能力（代理商级）：网络档案、运营商服务、商务条款、控制策略等',
    '敏感资费（企业级）：Price Plan 按企业定制，保障价格隔离与合规',
    '产品包（Package）是唯一装配点：绑定企业 + 资费 + 网络 / 条款等一次性交付',
    '发布与停用流程清晰，避免草稿资费误用于生产计费',
    '支持 Fallback 产品映射：无有效订阅时仍可按约定规则批价',
  ], { y: 1.25 })
  addFooter(s, 15)
}

// —— 16 Subscription ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '模块：订阅与开通编排')
  bullets(s, [
    '订阅将 SIM 与产品包关联，形成计费与上游开通的业务契约',
    '开通任务可映射上游产品，失败可追踪、可重试',
    '支持预约取消等生命周期操作，降低人工差错',
    '与 SIM 状态、批价范围联动，保证「卡上有什么、怎么计费」一致',
  ], { y: 1.25 })
  addFooter(s, 16)
}

// —— 17 Usage rating ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '模块：用量、批价与月度固化')
  card(s, 0.5, 1.25, 4, 5.3, '日汇总（事实）', [
    'usage_daily_summary',
    'SIM × 日 × 拜访网络',
    '上游同步 / 迟到 CDR 写入',
  ])
  card(s, 4.7, 1.25, 4, 5.3, 'Rating（批价）', [
    '生成 rating_results',
    '回写包内 / OOP 分类',
    '可手工或定时重跑',
    '与出账任务解耦',
  ])
  card(s, 8.9, 1.25, 3.9, 5.3, '月汇总（固化）', [
    '按自然月快照',
    '服务经营报表',
    '不替代套餐配额账本',
  ])
  addFooter(s, 17)
}

// —— 18 Billing ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '模块：出账、发布与调账')
  bullets(s, [
    '出账任务基于批价结果生成账单及明细，状态从生成到发布可控',
    '支持账单查询、导出与支付登记等运营动作（按权限）',
    '调账单（CREDIT / DEBIT）支持审批与下期结算，应对迟到话单与争议',
    '催收 / 欠费相关能力可与企业状态、业务策略协同',
    '强调可追溯：calculationId、明细行与用量事实可对齐',
  ], { y: 1.25 })
  addFooter(s, 18)
}

// —— 19 Alerts reports ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '模块：告警、诊断与报表')
  card(s, 0.5, 1.25, 6, 5.3, '告警与诊断', [
    '多层规则配置（平台 / 代理商 / 企业）',
    '池用量、静默卡、拜访异常、话单延迟等',
    '投递记录与确认处理',
    'SIM 诊断与上游能力对齐',
  ])
  card(s, 6.8, 1.25, 6, 5.3, '经营报表', [
    'SIM 汇总与拜访地分布',
    '用量趋势（企业 / MCC）',
    '高用量与异常 SIM',
    '完整自然月可读月表加速',
  ])
  addFooter(s, 19)
}

// —— 20 Process overview ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '推荐业务流程总览')
  const steps = [
    '① 主数据与上游集成',
    '② 产品包与资费配置',
    '③ SIM 入库与分配',
    '④ 订阅开通',
    '⑤ 用量接入与批价',
    '⑥ 出账与发布',
    '⑦ 告警、审计与报表',
  ]
  steps.forEach((t, i) => {
    const y = 1.25 + i * 0.75
    s.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
      x: 1.5,
      y,
      w: 10.3,
      h: 0.6,
      fill: { color: i % 2 === 0 ? COLORS.navy : COLORS.teal },
      rectRadius: 0.05,
    })
    s.addText(t, {
      x: 1.7,
      y: y + 0.12,
      w: 10,
      h: 0.4,
      fontSize: 16,
      bold: true,
      color: COLORS.white,
      fontFace: 'Calibri',
    })
  })
  addFooter(s, 20)
}

// —— 21 Process master data ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '流程①：加载供应商、运营商与上游集成')
  bullets(s, [
    '创建 / 维护供应商与运营商，建立多对多关联（覆盖哪些网络）',
    '配置上游集成：选择适配器、填写连接与凭证、验证连通性',
    '按需订阅入站 Webhook 事件，确保异步通知可达',
    '补齐公共信息目录（如 MCC/MNC 参考），服务拜访地展示与分析',
    '输出标准：主数据完整、集成可用，方可进入规模化开卡与计费',
  ], { y: 1.25 })
  addFooter(s, 21)
}

// —— 22 Process package ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '流程②：产品包与资费配置')
  bullets(s, [
    '在代理商域准备可复用网络 / 服务 / 条款模块',
    '为企业创建并发布 Price Plan（草稿 → 发布）',
    '组装 Package：绑定企业、资费与必要网络服务，完成发布',
    '按需配置 Rating Fallback，覆盖「有用量无订阅」边界',
    '输出标准：可售产品包清单清晰，价格与规则可审计',
  ], { y: 1.25 })
  addFooter(s, 22)
}

// —— 23 Process CDR ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '流程③：SIM 开通、CDR / 用量与批价')
  bullets(s, [
    'SIM 入库并分配企业 → 创建订阅并触发开通任务',
    '用量经上游同步或话单导入写入日汇总（含拜访网络维度）',
    '执行 Rating 任务：生成批价明细并回写分类用量',
    '迟到 CDR：先更新日汇总，再重跑 Rating，必要时走调账',
    '自然月结束后固化月汇总，支撑经营报表（与出账解耦）',
  ], { y: 1.25 })
  addFooter(s, 23)
}

// —— 24 Process billing ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '流程④：出账与发布')
  bullets(s, [
    '账期结束且批价就绪后，发起出账任务生成账单',
    '业务审核无误后发布账单，开放给企业侧查询 / 下载',
    '登记收款或处理欠费策略，保持财务与运营状态一致',
    '若有争议或迟到话单，通过调账单纳入后续结算周期',
    '输出标准：账单可解释、可导出、状态可追踪',
  ], { y: 1.25 })
  addFooter(s, 24)
}

// —— 25 Process alert ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '流程⑤：告警、审计与持续运营')
  bullets(s, [
    '配置平台 / 代理商 / 企业告警规则与投递通道',
    'Worker 周期评估并生成告警实例，支持确认与处理闭环',
    '关键操作写入审计日志（谁、在何时、对何对象、做了什么）',
    '结合报表与对账任务，持续优化资费、库存与上游质量',
    '输出标准：异常可发现、操作可追责、经营可复盘',
  ], { y: 1.25 })
  addFooter(s, 25)
}

// —— 26 Security ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '安全、合规与可信运营')
  bullets(s, [
    '租户与权限双隔离，企业侧默认不暴露渠道商业机密字段',
    '上游凭证加密存储；管理接口与业务接口分权',
    '幂等键与任务状态机降低重复出账 / 重复开通风险',
    '事件、审计、投递记录构成完整证据链',
    'OpenAPI 契约驱动，便于客户安全评估与对接验收',
  ], { y: 1.25 })
  addFooter(s, 26)
}

// —— 27 Summary ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.light } })
  addSectionBar(s, '总结：为什么选择本平台')
  bullets(s, [
    '一套系统覆盖「进货—分销—计费—运营」全链路',
    '兼容运营商直连与供应商聚合两种商业模式',
    '批价与出账可追溯，迟到话单有明确处置路径',
    '上下游集成与事件推送就绪，易于嵌入客户生态',
    '多租户、审计与 API 契约，满足企业级交付期望',
  ], { y: 1.25 })
  addFooter(s, 27)
}

// —— 28 Closing ——
{
  const s = pptx.addSlide()
  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: COLORS.navy } })
  s.addText('谢谢', {
    x: 0.8,
    y: 2.6,
    w: 11.5,
    h: 0.7,
    fontSize: 40,
    bold: true,
    color: COLORS.white,
    align: 'center',
    fontFace: 'Calibri',
  })
  s.addText('欢迎进一步交流试点范围、对接清单与实施路径', {
    x: 0.8,
    y: 3.5,
    w: 11.5,
    h: 0.5,
    fontSize: 18,
    color: 'B8D4D8',
    align: 'center',
    fontFace: 'Calibri',
  })
  s.addText('IoT CMP Reseller Platform  ·  V1.1', {
    x: 0.8,
    y: 5.8,
    w: 11.5,
    h: 0.4,
    fontSize: 14,
    color: COLORS.accent,
    align: 'center',
    fontFace: 'Calibri',
  })
}

await pptx.writeFile({ fileName: outPath })
console.log('Wrote', outPath)
console.log('Slides:', pptx._slides?.length ?? 'see file')
