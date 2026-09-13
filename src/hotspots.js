// hotspots.js -- what each object in the office is, and what clicking it could do.
//
// The office GLB is 63 flat, meaningfully-named nodes, so this is pure data. Only the
// `sit` action is wired to real behaviour today; everything else raises an event with its
// id so the real behaviour can be dropped in later without touching the rest of the app.
//
// Note: GLTFLoader strips dots from node names, so `Picture.001` arrives as `Picture001`
// and `Window_1.6` as `Window_16`. Keys below use the loaded spelling.

const seat = (label, note) => ({
  label, cat: 'ที่นั่ง', note,
  actions: [{ id: 'sit', label: 'เดินไปนั่ง', primary: true },
            { id: 'inspect', label: 'ดูใครนั่งตรงนี้' }],
});

const desk = (label, note) => ({
  label, cat: 'โต๊ะทำงาน', note,
  actions: [{ id: 'goto', label: 'เดินไปที่โต๊ะ', primary: true },
            { id: 'owner', label: 'ดูเจ้าของโต๊ะ' },
            { id: 'tasks', label: 'เปิดรายการงาน' }],
});

export const HOTSPOTS = {
  // ---- desk chairs -------------------------------------------------------
  ChairA1: seat('เก้าอี้ A1', 'โซนทำงาน A แถวหน้า'),
  ChairA2: seat('เก้าอี้ A2', 'โซนทำงาน A แถวหน้า'),
  ChairA3: seat('เก้าอี้ A3', 'โซนทำงาน A แถวหลัง'),
  ChairA4: seat('เก้าอี้ A4', 'โซนทำงาน A แถวหลัง'),
  ChairB1: seat('เก้าอี้ B1', 'โซนทำงาน B แถวหน้า'),
  ChairB2: seat('เก้าอี้ B2', 'โซนทำงาน B แถวหน้า'),
  ChairB3: seat('เก้าอี้ B3', 'โซนทำงาน B แถวหลัง'),
  ChairB4: seat('เก้าอี้ B4', 'โซนทำงาน B แถวหลัง'),
  ManagerChair: seat('เก้าอี้ผู้จัดการ', 'มุมผู้บริหาร ท้ายห้อง'),
  MC1: seat('เก้าอี้ประชุม 1', 'รอบโต๊ะประชุม'),
  MC2: seat('เก้าอี้ประชุม 2', 'รอบโต๊ะประชุม'),
  MC3: seat('เก้าอี้ประชุม 3', 'รอบโต๊ะประชุม'),
  MC4: seat('เก้าอี้ประชุม 4', 'รอบโต๊ะประชุม'),

  // ---- desks -------------------------------------------------------------
  DeskA1: desk('โต๊ะ A1', 'โต๊ะเดี่ยว 1.3 × 0.7 ม. สูง 0.74 ม.'),
  DeskA2: desk('โต๊ะ A2', 'โต๊ะเดี่ยว 1.3 × 0.7 ม. สูง 0.74 ม.'),
  DeskA3: desk('โต๊ะ A3', 'โต๊ะเดี่ยว 1.3 × 0.7 ม. สูง 0.74 ม.'),
  DeskA4: desk('โต๊ะ A4', 'โต๊ะเดี่ยว 1.3 × 0.7 ม. สูง 0.74 ม.'),
  DeskB1: desk('โต๊ะ B1', 'โต๊ะเดี่ยว 1.3 × 0.7 ม. สูง 0.74 ม.'),
  DeskB2: desk('โต๊ะ B2', 'โต๊ะเดี่ยว 1.3 × 0.7 ม. สูง 0.74 ม.'),
  DeskB3: desk('โต๊ะ B3', 'โต๊ะเดี่ยว 1.3 × 0.7 ม. สูง 0.74 ม.'),
  DeskB4: desk('โต๊ะ B4', 'โต๊ะเดี่ยว 1.3 × 0.7 ม. สูง 0.74 ม.'),
  ManagerDesk: {
    label: 'โต๊ะผู้จัดการ', cat: 'โต๊ะทำงาน', note: 'โต๊ะ 1.6 × 0.8 ม. มุมท้ายห้อง',
    actions: [{ id: 'sit-manager', label: 'เดินไปนั่งที่โต๊ะนี้', primary: true },
              { id: 'report', label: 'ส่งรายงาน' }],
  },

  // ---- meeting -----------------------------------------------------------
  MeetingTable: {
    label: 'โต๊ะประชุม', cat: 'พื้นที่ประชุม', note: '1.8 × 0.9 ม. รองรับ 4 ที่นั่ง',
    actions: [{ id: 'meet', label: 'เริ่มประชุม', primary: true },
              { id: 'gather', label: 'เรียกทีมมารวมตัว' }],
  },

  // ---- lounge ------------------------------------------------------------
  Sofa: {
    label: 'โซฟา', cat: 'มุมพักผ่อน', note: 'โซฟายาว 1.8 ม. นั่งได้ 3 ที่',
    actions: [{ id: 'sit:Sofa_seat2', label: 'นั่งตรงกลาง', primary: true },
              { id: 'sit:Sofa_seat1', label: 'นั่งฝั่งซ้าย' },
              { id: 'sit:Sofa_seat3', label: 'นั่งฝั่งขวา' }],
  },
  CoffeeTable: {
    label: 'โต๊ะกลาง', cat: 'มุมพักผ่อน', note: 'มีนิตยสารวางอยู่',
    actions: [{ id: 'read', label: 'หยิบนิตยสารอ่าน' }],
  },
  Rug: {
    label: 'พรม', cat: 'มุมพักผ่อน', note: 'พรม 2.5 × 2.0 ม. หน้าโซฟา',
    actions: [{ id: 'walk-here', label: 'เดินมาตรงนี้', primary: true }],
  },

  // ---- equipment ---------------------------------------------------------
  TV: {
    label: 'จอทีวี', cat: 'อุปกรณ์', note: 'จอติดผนัง 1.3 × 0.75 ม.',
    actions: [{ id: 'present', label: 'ฉายงานนำเสนอ', primary: true },
              { id: 'toggle-tv', label: 'เปิด / ปิดจอ' }],
  },
  Printer: {
    label: 'เครื่องพิมพ์', cat: 'อุปกรณ์', note: 'วางบนตู้เก็บของท้ายห้อง',
    actions: [{ id: 'print', label: 'สั่งพิมพ์งาน', primary: true },
              { id: 'printer-status', label: 'เช็คสถานะ / หมึก' }],
  },
  WaterCooler: {
    label: 'ตู้กดน้ำ', cat: 'อุปกรณ์', note: 'มุมขวาหน้าห้อง',
    actions: [{ id: 'drink', label: 'ไปกดน้ำดื่ม', primary: true },
              { id: 'chat', label: 'ยืนคุยเล่น' }],
  },
  Trash: {
    label: 'ถังขยะ', cat: 'อุปกรณ์', note: 'ท้ายห้อง ข้างตู้เก็บของ',
    actions: [{ id: 'throw', label: 'ทิ้งขยะ' }],
  },

  // ---- storage -----------------------------------------------------------
  Bookshelf: {
    label: 'ชั้นหนังสือ', cat: 'ที่เก็บของ', note: 'สูง 1.9 ม. มุมซ้ายท้ายห้อง',
    actions: [{ id: 'browse', label: 'ดูของบนชั้น', primary: true }],
  },
  Credenza: {
    label: 'ตู้เก็บเอกสาร', cat: 'ที่เก็บของ', note: 'ตู้เตี้ย 1.8 ม. ท้ายห้อง',
    actions: [{ id: 'browse', label: 'เปิดดูเอกสาร', primary: true }],
  },
  LowCabinet: {
    label: 'ตู้เตี้ย', cat: 'ที่เก็บของ', note: 'ตู้ 1.3 ม. ริมผนังท้ายห้อง',
    actions: [{ id: 'browse', label: 'เปิดดูของข้างใน', primary: true }],
  },

  // ---- wall --------------------------------------------------------------
  Logo_UBE: {
    label: 'โลโก้ UBE', cat: 'ผนัง', note: 'โลโก้นูนบนผนังท้ายห้อง',
    actions: [{ id: 'about', label: 'เกี่ยวกับ UBE', primary: true }],
  },
  Logo_Sub: {
    label: 'UBE Group (Thailand)', cat: 'ผนัง', note: 'ข้อความใต้โลโก้',
    actions: [{ id: 'about', label: 'เกี่ยวกับ UBE', primary: true }],
  },
  NoticeBoard: {
    label: 'บอร์ดประกาศ', cat: 'ผนัง', note: 'บอร์ด 1.4 × 0.8 ม.',
    actions: [{ id: 'notices', label: 'อ่านประกาศ', primary: true },
              { id: 'post', label: 'ติดประกาศใหม่' }],
  },
  Picture: {
    label: 'ภาพติดผนัง (ฝั่งหน้า)', cat: 'ผนัง', note: 'ผนังซ้าย ใกล้มุมพักผ่อน',
    actions: [{ id: 'admire', label: 'ดูภาพใกล้ๆ' }],
  },
  Picture001: {
    label: 'ภาพติดผนัง (ฝั่งหลัง)', cat: 'ผนัง', note: 'ผนังซ้าย ใกล้โซนทำงาน',
    actions: [{ id: 'admire', label: 'ดูภาพใกล้ๆ' }],
  },
  Window_16: {
    label: 'หน้าต่างบานที่ 1', cat: 'ผนัง', note: 'ผนังซ้าย 1.6 × 1.8 ม.',
    actions: [{ id: 'blinds', label: 'เปิด / ปิดม่าน', primary: true },
              { id: 'time', label: 'เปลี่ยนช่วงเวลาของวัน' }],
  },
  Window_42: {
    label: 'หน้าต่างบานที่ 2', cat: 'ผนัง', note: 'ผนังซ้าย 1.6 × 1.8 ม.',
    actions: [{ id: 'blinds', label: 'เปิด / ปิดม่าน', primary: true },
              { id: 'time', label: 'เปลี่ยนช่วงเวลาของวัน' }],
  },
  Window_68: {
    label: 'หน้าต่างบานที่ 3', cat: 'ผนัง', note: 'ผนังซ้าย 1.6 × 1.8 ม.',
    actions: [{ id: 'blinds', label: 'เปิด / ปิดม่าน', primary: true },
              { id: 'time', label: 'เปลี่ยนช่วงเวลาของวัน' }],
  },

  // ---- plants ------------------------------------------------------------
  Ficus_L: { label: 'ต้นไม้ (มุมพักผ่อน)', cat: 'ต้นไม้', note: 'ไทรใบใหญ่ สูง 1.36 ม.',
             actions: [{ id: 'water', label: 'รดน้ำต้นไม้' }] },
  Ficus_R: { label: 'ต้นไม้ (มุมขวา)', cat: 'ต้นไม้', note: 'ไทรใบใหญ่ สูง 1.21 ม.',
             actions: [{ id: 'water', label: 'รดน้ำต้นไม้' }] },
  Ficus_Mgr: { label: 'ต้นไม้ (มุมผู้จัดการ)', cat: 'ต้นไม้', note: 'ไทรใบใหญ่ สูง 1.31 ม.',
               actions: [{ id: 'water', label: 'รดน้ำต้นไม้' }] },
};

// Structure and clutter: never worth a click at isometric zoom.
export const SKIP = new Set([
  'Floor', 'FloorShell', 'BackWall', 'BackWallShell', 'LeftWall', 'LeftWallShell',
  'CapBack', 'CapLeft', 'SkirtBack', 'SkirtLeft',
  'Screen_A', 'Screen_B', 'Books', 'Vine', 'CabPlant', 'DeskPlantA', 'DeskPlantB',
  'Sconce_36', 'Sconce_795',
]);

/** Map a clicked mesh name to its hotspot record, or null. */
export function hotspotFor(name) {
  if (!name || SKIP.has(name)) return null;
  return HOTSPOTS[name] ?? null;
}

/** Chairs the character can actually sit on -- seat names that exist in seats.json. */
export const SEAT_OF = {
  ManagerDesk: 'ManagerChair',
};
