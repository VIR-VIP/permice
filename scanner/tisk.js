/**
 * tisk.js — tisknutelné karty permanentek přímo v prohlížeči.
 *
 * QR se generuje tady v telefonu/počítači knihovnou `qrcode-generator`
 * (vendorovaná v lib/), takže tisk funguje i offline a **podpisový klíč
 * nikam nechodí** — kódy už dorazily hotové ze serveru.
 *
 * Karty se nevykreslují do nového okna (blokovaly by je vyskakovací filtry),
 * ale do skrytého `#tisk` v téhle stránce. Při tisku se přes @media print
 * schová všechno ostatní.
 */

const KARTA_MM = {sirka: 85, vyska: 54};

/**
 * @param {string[]} kody
 * @param {{nazev: string, barva: string}} typ
 * @param {{sezona: string, klub: string}} klub
 */
export function pripravKarty(kody, typ, klub) {
  const cil = document.getElementById('tisk');
  cil.innerHTML = '';

  for (const kod of kody) {
    cil.append(karta(kod, typ, klub));
  }

  return kody.length;
}

export function vytiskni() {
  window.print();
}

function karta(kod, typ, klub) {
  const el = document.createElement('div');
  el.className = 'karta';

  const pruh = document.createElement('div');
  pruh.className = 'karta-pruh';
  pruh.style.background = typ.barva || '#444';
  pruh.append(text('span', 'karta-typ', (typ.nazev || '').toUpperCase()));
  pruh.append(text('span', 'karta-sezona', 'SEZÓNA ' + (klub.sezona || '')));
  el.append(pruh);

  const telo = document.createElement('div');
  telo.className = 'karta-telo';

  const qr = document.createElement('div');
  qr.className = 'karta-qr';
  qr.innerHTML = qrSvg(kod);
  telo.append(qr);

  const vpravo = document.createElement('div');
  vpravo.className = 'karta-vpravo';
  vpravo.append(text('div', 'karta-klub', klub.nazev || klub.klub || ''));
  vpravo.append(text('div', 'karta-nadpis', 'PERMANENTKA'));
  vpravo.append(text('div', 'karta-linka', ''));
  vpravo.append(text('div', 'karta-popisek', 'jméno držitele'));
  vpravo.append(text('div', 'karta-kod', kod));
  telo.append(vpravo);

  el.append(telo);
  return el;
}

function text(tag, trida, obsah) {
  const el = document.createElement(tag);
  el.className = trida;
  el.textContent = obsah;
  return el;
}

/**
 * Korekce chyb `M` — stejná jako u PDF z tools/generate.py. Snese ušpinění
 * i mírné přehnutí karty.
 */
function qrSvg(kod) {
  if (typeof window.qrcode !== 'function') {
    return '<div class="karta-chyba">QR se nepodařilo vytvořit</div>';
  }
  const qr = window.qrcode(0, 'M');   // 0 = velikost se dopočítá podle délky
  qr.addData(kod);
  qr.make();
  return qr.createSvgTag({cellSize: 2, margin: 2, scalable: true});
}

export const ROZMER = KARTA_MM;
