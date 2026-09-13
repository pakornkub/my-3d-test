// ui.js -- the HTML overlay: camera toolbar, object card, toast, loading veil.
// Everything is plain DOM; the 3D layer talks to it through this one object.

const STATE_TEXT = {
  idle: 'ว่าง',
  turn: 'กำลังหัน',
  walk: 'กำลังเดิน',
  faceSeat: 'กำลังหัน',
  sitDown: 'กำลังนั่ง',
  seated: 'นั่งอยู่',
  standUp: 'กำลังลุก',
};

export function createUI({ onCamera, onReset, onAction, onSelect }) {
  const card = document.getElementById('card');
  const cardCat = card.querySelector('.cat');
  const cardTitle = card.querySelector('h2');
  const cardNote = card.querySelector('.note');
  const cardActions = card.querySelector('.actions');
  const toast = document.getElementById('toast');
  const loading = document.getElementById('loading');
  const loadingText = loading.querySelector('p');
  const camButtons = [...document.querySelectorAll('[data-cam]')];

  camButtons.forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.cam;
    camButtons.forEach((x) => x.classList.toggle('on', x === b));
    onCamera(mode);
  }));
  document.getElementById('reset').addEventListener('click', onReset);
  document.getElementById('card-close').addEventListener('click', () => hideCard());

  let toastTimer = 0;

  function showCard(name, spot) {
    cardCat.textContent = spot.cat ?? '';
    cardTitle.textContent = spot.label ?? name;
    cardNote.textContent = spot.note ?? '';
    cardActions.replaceChildren(...(spot.actions ?? []).map((a) => {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', () => onAction(a.id, name, spot));
      return b;
    }));
    card.hidden = false;
  }

  function hideCard() { card.hidden = true; }

  function say(text, ms = 2200) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
  }

  function progress(text) { loadingText.textContent = text; }

  const roster = document.getElementById('roster');
  let rosterButtons = [];

  /** Rebuilt on every state change, so it doubles as the crew's status readout. */
  function renderRoster(members, selected) {
    if (rosterButtons.length !== members.length) {
      rosterButtons = members.map((m, i) => {
        const b = document.createElement('button');
        b.className = 'person';
        b.innerHTML = `<span class="key">${i + 1}</span>`
          + `<span class="who"><b></b><em></em></span>`;
        b.addEventListener('click', () => onSelect(i));
        return b;
      });
      roster.replaceChildren(...rosterButtons);
    }
    members.forEach((m, i) => {
      const b = rosterButtons[i];
      b.classList.toggle('on', m === selected);
      b.classList.toggle('ghost', !!m.placeholder);
      b.querySelector('b').textContent = m.label;
      const seat = m.ctl.seat?.name;
      b.querySelector('em').textContent =
        (STATE_TEXT[m.ctl.state] ?? m.ctl.state) + (seat && m.ctl.seated ? ' · ' + seat : '');
      b.title = m.placeholder ? m.label + ' — ยังไม่มีโมเดลจริง ใช้ตัวแทนไปก่อน' : m.label;
    });
  }

  function ready() {
    loading.classList.add('done');
    setTimeout(() => { loading.style.display = 'none'; }, 450);
  }

  function failed(err) {
    loading.classList.remove('done');
    loading.style.display = '';
    loading.querySelector('.bar').style.display = 'none';
    loadingText.textContent = 'โหลดไม่สำเร็จ: ' + err;
    loadingText.style.color = '#b4232a';
  }

  return { showCard, hideCard, say, progress, ready, failed, renderRoster };
}
