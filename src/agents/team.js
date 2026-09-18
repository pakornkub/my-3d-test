// team.js -- who does what in the agent office, and where they belong in the room.
//
// Pure data. The ids are the same strings as CREW in main.js and, later, the subagent
// names on the server, so nothing anywhere needs a mapping table.

export const ROLE = {
  manager: 'manager',   // holds the upstream session: grill, spec, tickets, reports
  eng_m1: 'impl',       // implementers take one ticket each in a fresh session
  eng_f1: 'impl',
  eng_m2: 'impl',
  eng_f2: 'review',     // two-axis code review of every diff
  eng_m3: 'qa',         // opens the real thing and ticks acceptance criteria
};

export const ROLE_LABEL = {
  manager: 'ผู้จัดการ', impl: 'implementer', review: 'reviewer', qa: 'QA',
};

/** Where each person sits when they are working. */
export const HOME_SEAT = {
  manager: 'ManagerChair',
  eng_m1: 'ChairA1',
  eng_f1: 'ChairA2',
  eng_m2: 'ChairB1',
  eng_f2: 'ChairB2',
  eng_m3: 'ChairB3',
};

/** Meeting chairs handed out in this order; anyone left over stands by the table. */
export const MEETING_SEATS = ['MC1', 'MC2', 'MC3', 'MC4'];

/** The object a role goes to when it is "at work" somewhere other than its desk. */
export const WORK_SPOT = {
  qa: 'TV',               // verify: the page under test is on the big screen
  research: 'Bookshelf',  // wayfinder research tickets
};

export const PHASES = ['onboard', 'grill', 'spec', 'tickets', 'implement', 'architecture', 'done'];
export const PHASE_LABEL = {
  onboard: 'ตั้งค่า', grill: 'สัมภาษณ์', spec: 'สเปก', tickets: 'แตกงาน',
  implement: 'ลงมือ', architecture: 'ทบทวนโครงสร้าง', done: 'ปิดงาน',
};

/** Agent status, as shown on the roster and the bubble colour. */
export const STATUS_LABEL = {
  idle: 'ว่าง',
  meeting: 'ประชุม',
  grilling: 'รอคำตอบคุณ',
  working: 'กำลังทำ',
  reviewing: 'กำลังรีวิว',
  verifying: 'กำลังเช็คของจริง',
  researching: 'ค้นคว้า',
  waiting: 'รออนุมัติ',
  stalled: 'ค้าง',
  done: 'เสร็จ',
  error: 'ผิดพลาด',
};
