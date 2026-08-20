/**
 * app.js — propojení kamery, ověření a odesílání.
 *
 * Průběh jednoho skenu:
 *   1. verdikt se spočítá lokálně (verdikt.js) a **hned se ukáže** — Apps Script
 *      odpovídá 3–6 vteřin a tolik se u vstupu čekat nedá,
 *   2. na pozadí běží zápis na server. Ten ví navíc o skenech z ostatních
 *      telefonů a o změnách po stažení seznamu; když se s námi rozejde,
 *      verdikt na obrazovce se opraví (a znovu pípne),
 *   3. bez signálu nebo při chybě putuje vstup do fronty a odešle se později.
 *
 * Do tabulky se tedy vždycky zapíše to, co si myslí server — obsluha jen nemusí
 * čekat, než to dopočítá.
 */

import * as api from './api.js';
import * as store from './store.js';
import {Ctecka, odezva} from './scan.js';
import {posudek, normalizujKod, VYSLEDEK, VZHLED} from './verdikt.js';
import {pripravSpravu, otevriSpravu} from './sprava.js';

/** Verze skeneru — zvyšuje ji tools/verze.py, needituj ručně. */
const VERZE_SKENERU = 'v16';

const $ = (id) => document.getElementById(id);

const prvek = {
  sit: $('sit'), fronta: $('fronta'), stari: $('stari'), pocitadlo: $('pocitadlo'),
  zapas: $('zapas'), btnNastaveni: $('btn-nastaveni'),
  video: $('video'), hlaska: $('hlaska'), btnKamera: $('btn-kamera'),
  rucni: $('rucni'), rucniKod: $('rucni-kod'),
  verdikt: $('verdikt'), vNadpis: $('v-nadpis'), vJmeno: $('v-jmeno'), vTyp: $('v-typ'),
  vDuvod: $('v-duvod'), vKod: $('v-kod'), vPoznamka: $('v-poznamka'), vDetaily: $('v-detaily'),
  vPustit: $('v-pustit'), vDalsi: $('v-dalsi'),
  vystraha: $('vystraha'), vystrahaSeznam: $('vystraha-seznam'),
  vystrahaOk: $('vystraha-ok'), vystrahaNastaveni: $('vystraha-nastaveni'),
  btnBezKarty: $('btn-bez-karty'), bezKarty: $('bez-karty'),
  bkHledat: $('bk-hledat'), bkVysledky: $('bk-vysledky'),
  bkHlaska: $('bk-hlaska'), bkZavrit: $('bk-zavrit')
};

let nastaveni = null;
let snapshot = null;
let ctecka = null;
let posledniSken = null;   // kvůli tlačítku „Přesto pustit"
let zpracovavam = false;
let cisloSkenu = 0;      // odpověď serveru patří jen tomu skenu, který ji vyvolal
let navstevnostCelkem = null;   // počet ze serveru, přes všechny telefony
let vystrahaOdklikana = false;

// ---- start -----------------------------------------------------------------

start();

async function start() {
  nastaveni = await store.nactiNastaveni();
  snapshot = await store.nactiSnapshot();

  await naplnZapasy();
  prekresliStav();
  navazUdalosti();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* jen offline navíc */ });
  }

  pripravSpravu({
    obnovSnapshot: stahniSeznam,
    odesliFrontu: () => odesliFrontu({tise: false}),
    nastaveniZmenena: (n) => { nastaveni = n; prekresliStav(); },
    verzeSkeneru: VERZE_SKENERU,
    stariSeznamu: stariSnapshotu
  });

  if (!nastaveni.api_url || !nastaveni.token) {
    otevriSpravu('nastaveni', 'Nejdřív vyplň adresu aplikace a token.');
  }

  setInterval(prekresliStav, 30000);
  setInterval(() => odesliFrontu({tise: true}), 60000);
  setInterval(dotahniNavstevnost, 90000);
  odesliFrontu({tise: true});
  dotahniNavstevnost();
  zkontrolujPripravenost();
}

function navazUdalosti() {
  prvek.btnKamera.addEventListener('click', spustKameru);
  prvek.btnNastaveni.addEventListener('click', () => otevriSpravu());

  prvek.zapas.addEventListener('change', async () => {
    nastaveni = await store.ulozNastaveni({zapas_id: prvek.zapas.value});
    navstevnostCelkem = null;
    prekresliStav();
    dotahniNavstevnost();
    vystrahaOdklikana = false;      // jiný zápas = znovu prověřit přípravu
    zkontrolujPripravenost();
  });

  prvek.rucni.addEventListener('submit', (e) => {
    e.preventDefault();
    const kod = normalizujKod(prvek.rucniKod.value);
    if (!kod) return;
    prvek.rucniKod.value = '';
    prvek.rucniKod.blur();
    zpracuj(kod, false);
  });

  prvek.vDalsi.addEventListener('click', zavriVerdikt);
  prvek.vPustit.addEventListener('click', () => {
    const kod = posledniSken;
    zavriVerdikt();
    if (kod) zpracuj(kod, true);
  });

  prvek.vystrahaOk.addEventListener('click', () => {
    vystrahaOdklikana = true;
    prvek.vystraha.hidden = true;
  });
  prvek.vystrahaNastaveni.addEventListener('click', () => {
    vystrahaOdklikana = true;
    prvek.vystraha.hidden = true;
    otevriSpravu('nastaveni');
  });

  prvek.btnBezKarty.addEventListener('click', otevriBezKarty);
  prvek.bkZavrit.addEventListener('click', () => { prvek.bezKarty.hidden = true; });
  prvek.bkHledat.addEventListener('input', vykresliBezKarty);

  window.addEventListener('online', () => {
    prekresliStav(); odesliFrontu({tise: true}); dotahniNavstevnost();
  });
  window.addEventListener('offline', prekresliStav);

  // po návratu z pozadí (zhasnutý displej) kameru probudíme
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ctecka?.jeAktivni) prvek.video.play().catch(() => {});
  });
}

// ---- kamera ----------------------------------------------------------------

async function spustKameru() {
  try {
    ctecka = ctecka || new Ctecka(prvek.video, (kod) => zpracuj(kod, false));
    await ctecka.start();
    prvek.btnKamera.hidden = true;
    prvek.hlaska.textContent = 'Namiř kameru na QR kód permanentky.';
  } catch (e) {
    prvek.hlaska.textContent = 'Kamera se nespustila: ' + e.message
      + ' Kód jde zadat ručně dole.';
  }
}

// ---- jádro: zpracování skenu ----------------------------------------------

async function zpracuj(vstupniKod, force, bezKarty) {
  // Dva skeny naráz (kamera + ruční zadání) by se překryly a obsluha by
  // nepoznala, ke kterému kódu verdikt patří.
  if (zpracovavam) return;
  zpracovavam = true;
  try {
    await zpracujJeden(vstupniKod, force, bezKarty);
  } catch (e) {
    // Bez tohohle by na displeji zůstalo viset „OVĚŘUJI…" s nefunkčním tlačítkem
    // a obsluha by nemohla pokračovat.
    ukazVerdikt({vysledek: 'CHYBA', duvod: 'Sken se nepovedlo zpracovat: ' + e.message},
                null, normalizujKod(vstupniKod), 'Zkus to znovu. Pokud to potrvá, zadej kód ručně.');
  } finally {
    zpracovavam = false;
  }
}

async function zpracujJeden(vstupniKod, force, bezKarty) {
  const kod = normalizujKod(vstupniKod);
  posledniSken = kod;
  const mujSken = ++cisloSkenu;

  // Dokud nevíme výsledek, nesmí na obrazovce zůstat verdikt od předchozího
  // člověka — ten by se dal přečíst jako verdikt tohohle.
  ukazCekani(kod);

  const zapasId = nastaveni.zapas_id || '';
  if (!zapasId) {
    ukazVerdikt({vysledek: 'CHYBA', duvod: 'Nahoře vyber zápas — bez něj se vstup nezapíše.'},
                null, kod, '');
    return;
  }

  const permanentka = snapshot?.index?.[kod] || null;
  const predchozi = await store.prvniVstup(zapasId, kod);
  let v = posudek(kod, permanentka, force ? null : predchozi);
  if (force && v.vysledek === VYSLEDEK.OK && predchozi) {
    v = {vysledek: VYSLEDEK.DUPLICITA_POVOLENA, duvod: 'Obsluha pustila i přes duplicitu.'};
  }
  // bez karty nahrazuje jen chybějící kartu, ne její platnost — stejně jako na serveru
  if (bezKarty && v.vysledek === VYSLEDEK.OK) {
    v = {vysledek: VYSLEDEK.BEZ_KARTY, duvod: 'Permanentku neměl u sebe.'};
  }

  const vstup = {
    vstup_id: store.noveVstupId(),
    kod,
    zapas_id: zapasId,
    cas_skenu: new Date().toISOString(),
    obsluha: nastaveni.obsluha || '',
    zarizeni: nastaveni.zarizeni || '',
    force: !!force,
    bez_karty: !!bezKarty
  };

  if (v.vysledek === VYSLEDEK.OK || v.vysledek === VYSLEDEK.DUPLICITA_POVOLENA
      || v.vysledek === VYSLEDEK.BEZ_KARTY) {
    await store.zapamatujVstup(zapasId, kod, vstup.cas_skenu);
  }

  // Součet ze serveru se obnovuje jednou za půldruhé minuty. Kdybychom na to
  // čekali, ukazovalo by počítadlo nesmysl typu „1 · celkem 0" — proto si nově
  // vpuštěného člověka připočteme rovnou a server to při dalším dotazu srovná.
  if (navstevnostCelkem !== null && !predchozi
      && (v.vysledek === VYSLEDEK.OK || v.vysledek === VYSLEDEK.BEZ_KARTY)) {
    navstevnostCelkem++;
  }

  // Verdikt ukážeme HNED z místních dat. Apps Script odpovídá 3–6 vteřin a tolik
  // se u vstupu čekat nedá; místní seznam přitom zná platnost, stav i duplicity
  // z tohohle telefonu, takže je skoro vždycky správný.
  ukazVerdikt(v, permanentka, kod, '⏳ ověřuji u serveru…');

  if (!navigator.onLine) {
    await store.doFronty({...vstup, offline: true});
    ukazVerdikt(v, permanentka, kod, '⚠ Ověřeno offline — ' + stariSnapshotu(), true);
    prekresliStav();
    return;
  }

  // Server běží na pozadí. Ví navíc o skenech z ostatních telefonů a o změnách
  // provedených po stažení seznamu — když se s námi rozejde, verdikt opravíme.
  // Nechceme panel znovu otevřít, když ho obsluha už odklikla a míří kamerou
  // na dalšího člověka — do tabulky se pravda zapíše tak jako tak.
  const jesteNaObrazovce = () => mujSken === cisloSkenu && !prvek.verdikt.hidden;

  api.checkin(vstup).then(async (odpoved) => {
    if (!jesteNaObrazovce()) return;

    const serverovy = {vysledek: odpoved.vysledek, duvod: odpoved.duvod};
    if (serverovy.vysledek === v.vysledek) {
      ukazVerdikt(v, odpoved.permanentka || permanentka, kod, '', true);
      return;
    }

    if (serverovy.vysledek === VYSLEDEK.OK
        || serverovy.vysledek === VYSLEDEK.DUPLICITA_POVOLENA) {
      await store.zapamatujVstup(zapasId, kod, vstup.cas_skenu);
    }
    ukazVerdikt(serverovy, odpoved.permanentka || permanentka, kod,
                '↻ Opraveno podle serveru');
  }).catch(async () => {
    await store.doFronty({...vstup, offline: true});
    if (!jesteNaObrazovce()) return;
    ukazVerdikt(v, permanentka, kod, '⚠ Ověřeno offline — ' + stariSnapshotu(), true);
  }).finally(prekresliStav);
}

// ---- pojistky před zápasem -------------------------------------------------

/**
 * Dvě chyby, které se u vstupu dělají a člověk si jich všimne pozdě: zapomenutý
 * seznam (bez signálu se pak kontroluje proti starým datům) a špatně vybraný
 * zápas (vstupy padají celý večer jinam). Odznaky ve stavové liště na to sice
 * upozorňují, ale při frontě lidí je nikdo nečte — tohle se musí odkliknout.
 */
function zkontrolujPripravenost() {
  // Dokud není vyplněná adresa a token, není co kontrolovat — a panel Nastavení
  // už uživateli říká, co má udělat.
  if (!nastaveni?.api_url || !nastaveni?.token) return;

  const potize = [];
  const dnes = new Date().toLocaleDateString('sv-SE');   // sv-SE dává YYYY-MM-DD

  if (!snapshot?.ulozeno) {
    potize.push('Seznam permanentek není stažený. Bez signálu neprojde nikdo.');
  } else if (snapshot.ulozeno.slice(0, 10) !== dnes) {
    potize.push('Seznam permanentek není z dneška (' + stariSnapshotu() + '). '
              + 'Permanentky prodané mezitím v něm chybí.');
  }

  const zapasId = nastaveni.zapas_id || '';
  if (!zapasId) {
    potize.push('Není vybraný zápas — vstupy se nezapíšou.');
  } else {
    const zapas = (snapshot?.zapasy || []).find((z) => z.id === zapasId);
    if (zapas && zapas.datum && zapas.datum !== dnes) {
      potize.push('Vybraný zápas je na ' + zapas.datum + ', ne na dnešek. '
                + 'Zkontroluj, že skenuješ na správný zápas.');
    }
  }

  // Když se závada mezitím spravila (třeba se stáhl seznam), výstraha zmizí.
  if (!potize.length) {
    prvek.vystraha.hidden = true;
    return;
  }
  if (vystrahaOdklikana) return;

  prvek.vystrahaSeznam.innerHTML = '';
  for (const text of potize) {
    const li = document.createElement('li');
    li.textContent = text;
    prvek.vystrahaSeznam.append(li);
  }
  prvek.vystraha.hidden = false;
}

// ---- vstup bez karty -------------------------------------------------------

function otevriBezKarty() {
  prvek.bkHledat.value = '';
  prvek.bkVysledky.innerHTML = '';
  bkHlaska('');
  prvek.bezKarty.hidden = false;
  prvek.bkHledat.focus();
}

function bkHlaska(text, druh) {
  prvek.bkHlaska.textContent = text || '';
  prvek.bkHlaska.className = 'n-hlaska ' + (druh || '');
}

function vykresliBezKarty() {
  const dotaz = prvek.bkHledat.value.trim().toLowerCase();
  prvek.bkVysledky.innerHTML = '';
  if (dotaz.length < 2) {
    bkHlaska(dotaz ? 'Napiš aspoň dvě písmena.' : '');
    return;
  }

  const nalezeni = (snapshot?.permanentky || []).filter((p) =>
    String(p.jmeno || '').toLowerCase().includes(dotaz));

  if (!nalezeni.length) {
    bkHlaska('Nikdo takový ve staženém seznamu není.', 'chyba');
    return;
  }
  bkHlaska('');

  for (const p of nalezeni.slice(0, 20)) {
    const r = document.createElement('div');
    r.className = 'polozka';
    r.append(text('div', 'polozka-nazev', p.jmeno || '(bez jména)'),
             text('div', 'polozka-popis',
                  [p.typ_nazev, p.stav, p.kod].filter(Boolean).join(' · ')));

    const akce = document.createElement('div');
    akce.className = 'polozka-akce';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tl-hlavni maly';
    b.textContent = 'Pustit';
    b.addEventListener('click', () => {
      if (!confirm(`Pustit ${p.jmeno} bez karty?`)) return;
      prvek.bezKarty.hidden = true;
      zpracuj(p.kod, false, true);
    });
    akce.append(b);
    r.append(akce);
    prvek.bkVysledky.append(r);
  }
  if (nalezeni.length > 20) {
    bkHlaska(`Nalezeno ${nalezeni.length}, ukazuju prvních 20 — zpřesni hledání.`);
  }
}

function text(tag, trida, obsah) {
  const el = document.createElement(tag);
  el.className = trida;
  el.textContent = obsah;
  return el;
}

// ---- návštěvnost -----------------------------------------------------------

/** Kolik lidí už na zápas přišlo celkem — ze všech telefonů, ne jen z tohohle. */
async function dotahniNavstevnost() {
  if (!navigator.onLine || !nastaveni?.api_url || !nastaveni?.zapas_id) return;
  // Když je otevřená Správa, obsluha neskenuje a počítadlo stejně nevidí —
  // zbytečný dotaz by se řadil před její akci a zdržel ji.
  if (!$('sprava').hidden) return;
  try {
    const d = await api.navstevnost(nastaveni.zapas_id);
    if (d && d.zapas_id === nastaveni.zapas_id) navstevnostCelkem = d.unikatnich;
    prekresliStav();
  } catch { /* nevadí, ukáže se jen počet z tohohle telefonu */ }
}

// ---- verdikt ---------------------------------------------------------------

/** Neutrální mezistav, než dorazí odpověď ze serveru. */
function ukazCekani(kod) {
  prvek.verdikt.className = 'verdikt ceka';
  prvek.vNadpis.textContent = 'OVĚŘUJI…';
  prvek.vJmeno.textContent = '';
  prvek.vTyp.textContent = '';
  prvek.vDuvod.textContent = '';
  prvek.vKod.textContent = kod || '';
  prvek.vPoznamka.textContent = '';
  prvek.vPustit.hidden = true;
  prvek.vDalsi.disabled = true;
  prvek.verdikt.hidden = false;
}

function ukazVerdikt(v, permanentka, kod, poznamka, tise) {
  prvek.vDalsi.disabled = false;
  const vzhled = VZHLED[v.vysledek] || {barva: 'chyba', nadpis: 'CHYBA', zvuk: 'chyba'};

  prvek.verdikt.className = 'verdikt ' + vzhled.barva;
  prvek.vNadpis.textContent = vzhled.nadpis;
  prvek.vJmeno.textContent = permanentka?.jmeno || '';
  // Když se celá platnost ukazuje v detailech, nemá smysl ji psát dvakrát.
  const platnostVDetailech = !!nastaveni?.zobrazit_platnost;
  prvek.vTyp.textContent = permanentka?.typ_nazev
    ? permanentka.typ_nazev
      + (!platnostVDetailech && permanentka.platnost_do
          ? ` · platí do ${permanentka.platnost_do}` : '')
    : '';
  vykresliDetaily(permanentka);
  prvek.vDuvod.textContent = v.duvod || '';
  prvek.vKod.textContent = kod || '';
  prvek.vPoznamka.textContent = poznamka || '';

  prvek.vPustit.hidden = v.vysledek !== VYSLEDEK.DUPLICITA;
  prvek.verdikt.hidden = false;
  if (!tise) odezva(vzhled.zvuk);
}

/**
 * Volitelné údaje z tabulky pod verdiktem. Co se ukáže, si obsluha zapíná
 * v Nastavení — u vstupu se hodí něco jiného než u pokladny.
 */
function vykresliDetaily(permanentka) {
  prvek.vDetaily.innerHTML = '';
  if (!permanentka) return;

  const radky = [];
  if (nastaveni?.zobrazit_kontakt) {
    radky.push(['Telefon', permanentka.telefon, 'tel:']);
    radky.push(['E-mail', permanentka.email, 'mailto:']);
  }
  if (nastaveni?.zobrazit_poznamku) {
    radky.push(['Poznámka', permanentka.poznamka]);
  }
  if (nastaveni?.zobrazit_platnost) {
    const od = permanentka.platnost_od;
    const doo = permanentka.platnost_do;
    radky.push(['Platnost', od && doo ? `${od} – ${doo}` : (od || doo)]);
    radky.push(['Vydáno', permanentka.vydano_dne]);
  }
  if (nastaveni?.zobrazit_kartu) {
    radky.push(['Číslo karty', permanentka.poradi]);
    radky.push(['Stav', permanentka.stav]);
  }

  for (const [popisek, hodnota, protokol] of radky) {
    if (hodnota === '' || hodnota === undefined || hodnota === null) continue;
    const dt = document.createElement('dt');
    dt.textContent = popisek;
    const dd = document.createElement('dd');
    if (protokol) {
      // ať jde z verdiktu rovnou zavolat nebo napsat, když je potřeba něco řešit
      const a = document.createElement('a');
      a.href = protokol + String(hodnota).replace(/\s+/g, '');
      a.textContent = String(hodnota);
      dd.append(a);
    } else {
      dd.textContent = String(hodnota);
    }
    prvek.vDetaily.append(dt, dd);
  }
}

function zavriVerdikt() {
  prvek.verdikt.hidden = true;
  ctecka?.zapomenPosledni();
}

// ---- stavová lišta ---------------------------------------------------------

async function prekresliStav() {
  const online = navigator.onLine;
  prvek.sit.textContent = online ? 'online' : 'offline';
  prvek.sit.className = 'odznak ' + (online ? 'online' : 'offline');

  const ceka = await store.pocetVeFronte();
  prvek.fronta.hidden = ceka === 0;
  prvek.fronta.textContent = `⏳ ${ceka} k odeslání`;
  prvek.fronta.className = 'odznak ceka';

  prvek.stari.textContent = stariSnapshotu();

  if (nastaveni.zapas_id) {
    const n = await store.pocetVstupu(nastaveni.zapas_id);
    // vlevo skeny z tohohle telefonu, vpravo součet ze všech
    prvek.pocitadlo.textContent = navstevnostCelkem === null
      ? `${n} ${sklonuj(n, 'vstup', 'vstupy', 'vstupů')}`
      : `${n} · celkem ${navstevnostCelkem}`;
  } else {
    prvek.pocitadlo.textContent = '';
  }
}

function sklonuj(n, jeden, dva, pet) {
  if (n === 1) return jeden;
  if (n >= 2 && n <= 4) return dva;
  return pet;
}

function stariSnapshotu() {
  if (!snapshot?.ulozeno) return 'seznam nestažen';
  const minuty = Math.floor((Date.now() - new Date(snapshot.ulozeno).getTime()) / 60000);
  if (minuty < 1) return 'seznam právě stažen';
  if (minuty < 90) return `seznam starý ${minuty} min`;
  const d = new Date(snapshot.ulozeno);
  return 'seznam z ' + d.toLocaleString('cs-CZ', {day: 'numeric', month: 'numeric',
                                                  hour: '2-digit', minute: '2-digit'});
}

async function naplnZapasy() {
  const zapasy = snapshot?.zapasy || [];
  prvek.zapas.innerHTML = '<option value="">— vyber zápas —</option>';
  for (const z of zapasy) {
    const o = document.createElement('option');
    o.value = z.id;
    o.textContent = [z.datum, z.souper].filter(Boolean).join(' · ') || z.id;
    prvek.zapas.append(o);
  }

  // Když správce v tabulce přepne aktivní zápas, telefony ho mají následovat.
  // Ale když si obsluha nahoře vybere jiný zápas ručně, nesmí jí to přepsat —
  // proto se pamatuje, jaký aktivní zápas ze serveru už jsme viděli.
  const serverovy = String(snapshot?.aktivni_zapas || '');
  const prepnulSe = serverovy && serverovy !== nastaveni.nasledovany_zapas;
  const vybrany = prepnulSe ? serverovy : (nastaveni.zapas_id || serverovy);

  const platny = vybrany && zapasy.some((z) => z.id === vybrany) ? vybrany : '';
  prvek.zapas.value = platny;

  // Výběr je potřeba i uložit — jinak v seznamu zápas svítí, ale skenování
  // ho nevidí a odmítá zapsat vstup.
  if (platny !== nastaveni.zapas_id || serverovy !== nastaveni.nasledovany_zapas) {
    nastaveni = await store.ulozNastaveni({zapas_id: platny, nasledovany_zapas: serverovy});
  }
}

// ---- fronta ----------------------------------------------------------------
//
// Obě funkce vracejí text pro obsluhu; kam se ten text vypíše, řeší volající
// (v tichém režimu na pozadí nikam).

async function odesliFrontu({tise}) {
  const cekajici = await store.fronta();
  if (!cekajici.length) return 'Fronta je prázdná.';
  if (!navigator.onLine) {
    if (tise) return '';
    throw new Error('Není signál — fronta počká.');
  }

  try {
    const odpoved = await api.sync(cekajici);
    await store.zFronty(cekajici.map((v) => v.vstup_id));

    // Server vidí i skeny z ostatních telefonů — může některé vyhodnotit jinak.
    const jinak = (odpoved.vysledky || []).filter(
      (r) => r.vysledek !== VYSLEDEK.OK && r.vysledek !== 'JIZ_ZAPSANO'
             && r.vysledek !== VYSLEDEK.DUPLICITA_POVOLENA).length;

    return `Odesláno ${cekajici.length} `
      + `${sklonuj(cekajici.length, 'vstup', 'vstupy', 'vstupů')}.`
      + (jinak ? ` ${jinak} z nich server vyhodnotil jinak — viz list Vstupy.` : '');
  } catch (e) {
    if (tise) return '';
    throw new Error('Odeslání selhalo: ' + e.message);
  } finally {
    prekresliStav();
  }
}

/** Stáhne seznam permanentek pro offline provoz. Volá se i ze záložky Správa. */
async function stahniSeznam() {
  const data = await api.stahniSnapshot();
  await store.ulozSnapshot(data);
  snapshot = await store.nactiSnapshot();
  if (data.verze) nastaveni = await store.ulozNastaveni({verze_serveru: data.verze});
  await naplnZapasy();
  prekresliStav();
  dotahniNavstevnost();
  zkontrolujPripravenost();   // stažením mohla závada zmizet, nebo se objevit jiná
  return {permanentky: data.permanentky.length, zapasy: data.zapasy.length};
}
