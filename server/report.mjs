// report.mjs -- the two report templates, and the check that a report follows them.
//
// Level 1 (a closed ticket) is composed here from facts the harness holds: gate output,
// review verdict, QA verdict, diff stat. The model only contributes the "what" summary.
// Level 2 (a closed feature) is written by the manager and validated here: headings in
// the right order or it goes back.

const L1_HEADINGS = ['## ทำอะไร', '## หลักฐาน', '## Acceptance criteria', '## ค้าง / ข้อสังเกต', '## Diff'];
const L2_HEADINGS = ['## 1. ขอมาว่าอะไร', '## 2. ได้อะไร', '## 3. Tickets', '## 4. ตัดสินใจระหว่างทาง', '## 5. ของที่เหลือ', '## 6. Diff รวมและการรวมโค้ด', '## 7. ค่าใช้จ่าย'];

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const mins = (ms) => `${Math.max(1, Math.round((ms ?? 0) / 60_000))} นาที`;

/**
 * @param t  { id, title, agent, branch, attempt, ms, usd, what: string[], gates: [{gate,pass,output}],
 *             review: {verdict, standards[], spec[]} | null, verify: {verdict, criteria:[{text,pass,note}], evidence} | null,
 *             criteria: [{text, pass}], open: string[], diffStat }
 */
export function ticketReport(t) {
  const gateLine = t.gates?.length
    ? t.gates.map((g) => `${g.gate}: ${g.pass ? 'ผ่าน' : 'ไม่ผ่าน'}`).join(' · ') + '   (server รันเอง)'
    : 'ไม่มี gate ที่กำหนดใน office.md';
  const reviewLine = t.review?.byHuman
    ? 'review: มนุษย์รับ diff แทน reviewer หลังการ escalate (finding ที่เหลือเป็นเชิงมาตรฐาน)'
    : t.review
    ? `review: Standards ${t.review.standards?.length ?? 0} ข้อ${t.review.standards?.length ? ' (' + t.review.standards.join('; ') + ')' : ''} · Spec ${t.review.spec?.length ? t.review.spec.length + ' ข้อ (' + t.review.spec.join('; ') + ')' : 'ครบ'} → ${t.review.verdict === 'pass' ? 'ผ่าน' : 'ไม่ผ่าน'}`
    : 'review: ไม่ได้รีวิว';
  const verifyLine = t.verify
    ? `verify: ${t.verify.criteria.filter((c) => c.pass).length}/${t.verify.criteria.length} ข้อ${t.verify.evidence ? ' · ' + t.verify.evidence : ''} → ${t.verify.verdict === 'pass' ? 'ผ่าน' : 'ไม่ผ่าน'}`
    : 'verify: ข้าม (verify: none)';
  const criteria = (t.verify?.criteria?.length ? t.verify.criteria : t.criteria ?? [])
    .map((c) => `- [${c.pass ? 'x' : ' '}] ${c.text}${c.note ? ' — ' + c.note : ''}`).join('\n') || '- (ไม่มี criteria ในใบ)';
  return [
    `# ปิดใบ ${t.id}: ${t.title}`,
    `ผู้ทำ: ${t.agent} · worktree: ${t.branch} · รอบ: ${t.attempt ?? 1} · เวลา: ${mins(t.ms)} · ค่าใช้จ่าย: ${money(t.usd)}`,
    '',
    '## ทำอะไร',
    (t.what?.length ? t.what : ['(implementer ไม่ได้สรุป)']).map((w) => `- ${w}`).join('\n'),
    '',
    '## หลักฐาน',
    `- ${reviewLine}`,
    `- ${verifyLine}`,
    `- gates: ${gateLine}`,
    '',
    '## Acceptance criteria',
    criteria,
    '',
    '## ค้าง / ข้อสังเกต',
    (t.open?.length ? t.open : ['ไม่มี']).map((o) => `- ${o}`).join('\n'),
    '',
    '## Diff',
    t.diffStat ? t.diffStat.split('\n').map((l) => `- ${l.trim()}`).join('\n') : '- (ไม่มี diff)',
    '',
  ].join('\n');
}

/** Headings present and in order? Returns [] when valid, else the problems. */
export function validateReport(markdown, level = 1) {
  const want = level === 2 ? L2_HEADINGS : L1_HEADINGS;
  const errs = [];
  let last = -1;
  for (const h of want) {
    const i = markdown.indexOf(h);
    if (i < 0) { errs.push(`ขาดหัวข้อ "${h}"`); continue; }
    if (i < last) errs.push(`หัวข้อ "${h}" อยู่ผิดลำดับ`);
    last = Math.max(last, i);
  }
  if (!/^# /m.test(markdown)) errs.push('ขาดชื่อรายงานบรรทัดแรก (# …)');
  return errs;
}

/** The prompt that asks the manager for a level-2 report, with the facts it must use. */
export function featureReportPrompt({ feature, project, branch, tickets, costs, diffStat, spec }) {
  const rows = tickets.map((t) => `| ${t.id} | ${t.title} | ${t.assignee ?? '-'} | ${t.review ?? '-'} | ${t.verify ?? '-'} | ${t.status} |`).join('\n');
  const costRows = Object.entries(costs).map(([k, v]) => `| ${k} | ${v.sessions} | ${money(v.usd)} |`).join('\n');
  return `เขียนรายงานปิดงานของ feature "${feature}" (โปรเจกต์ ${project}, branch ${branch}) ตาม template ระดับ 2 เป๊ะ: หัวข้อ 7 ข้อตามลำดับนี้ ห้ามเพิ่มหรือข้าม

# รายงานปิดงาน: ${feature}
## 1. ขอมาว่าอะไร
## 2. ได้อะไร
## 3. Tickets
## 4. ตัดสินใจระหว่างทาง
## 5. ของที่เหลือ
## 6. Diff รวมและการรวมโค้ด
## 7. ค่าใช้จ่าย

ข้อเท็จจริงจาก server (ห้ามแต่งเพิ่ม ใช้ตามนี้):
สถานะ tickets (จาก gates/review/verify ที่ server รันเอง):
| ใบ | ชื่อ | ผู้ทำ | review | verify | สถานะ |
${rows}

ค่าใช้จ่ายต่อคน:
| คน | sessions | $ |
${costRows}

git diff --stat ของ ${branch} เทียบ main:
${diffStat || '(ว่าง)'}

spec: ${spec}

กฎ: ข้อ 2 ให้ไล่ user story จาก spec แล้วบอกว่าเสร็จ/ตัดออก/เลื่อน พร้อมอ้างใบ; ข้อ 4 ต้องรวมสมมติฐานที่คุณตัดสินเองโดยไม่ได้ถามมนุษย์; ข้อ 6 ให้บอกว่ารอมนุษย์กด merge; ตอบเป็น markdown ล้วน ไม่มีคำนำหรือคำลงท้ายนอกรายงาน`;
}
