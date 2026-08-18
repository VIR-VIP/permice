/**
 * sprava.js — záložka Správa: zápasy, typy, permanentky, vydávání a tisk, statistiky.
 *
 * Zásada: **nic se neukládá jen tady.** Každá změna jde rovnou do Google Tabulky,
 * do stejných řádků a sloupců, které jde přepsat i ručně. Když někdo upraví
 * tabulku, stačí dát Načíst znovu a aplikace to uvidí.
 *
 * Připojení (adresa, token, obsluha) je naopak jen v telefonu — do tabulky nepatří.
 */

import * as api from './api.js';
import * as store from './store.js';
import {pripravKarty, vytiskni} from './tisk.js';

const $ = (id) => document.getElementById(id);

const ZALOZKY = [
  {id: 'pripojeni', nazev: 'Připojení'},
  {id: 'zapasy', nazev: 'Zápasy'},
  {id: 'permanentky', nazev: 'Permanentky'},
  {id: 'typy', nazev: 'Typy'},
  {id: 'statistiky', nazev: 'Statistiky'}
];

const STAVY = [
  ['nevydana', 'nevydaná — ještě se neprodala'],
  ['aktivni', 'aktivní — platí'],
  ['blokovana', 'blokovaná'],
  ['ztracena', 'ztracená']
];

let zavislosti = null;   // {obnovSnapshot, odesliFrontu, nastaveniZmenena}
let prehled = null;      // poslední data ze serveru
let statistiky = null;
let aktivni = 'pripojeni';
let nastaveni = null;

// ---- veřejné rozhraní ------------------------------------------------------

export function pripravSpravu(deps) {
  zavislosti = deps;
  $('s-zalozky').innerHTML = '';
  for (const z of ZALOZKY) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.zalozka = z.id;
    b.textContent = z.nazev;
    b.addEventListener('click', () => prepni(z.id));
    $('s-zalozky').append(b);
  }
  $('s-zavrit').addEventListener('click', zavriSpravu);
}

export async function otevriSpravu(zalozka, zprava) {
  nastaveni = await store.nactiNastaveni();
  $('sprava').hidden = false;
  await prepni(zalozka || (nastaveni.api_url && nastaveni.token ? 'zapasy' : 'pripojeni'));
  if (zprava) hlaska(zprava, 'chyba');
}

export function zavriSpravu() {
  $('sprava').hidden = true;
}

// ---- přepínání záložek -----------------------------------------------------

async function prepni(id, zachovejHlasku) {
  aktivni = id;
  for (const b of $('s-zalozky').children) {
    b.classList.toggle('vybrana', b.dataset.zalozka === id);
  }
  // po uložení chceme potvrzení nechat na obrazovce, jinak se maže
  if (!zachovejHlasku) hlaska('');
  nastaveni = await store.nactiNastaveni();

  if (id === 'pripojeni') return vykresliPripojeni();

  if (!nastaveni.api_url || !nastaveni.token) {
    return obsah(zprava('Nejdřív vyplň adresu aplikace a token v záložce Připojení.'));
  }

  obsah(zprava('Načítám…'));
  try {
    if (id === 'statistiky') {
      statistiky = await api.statistiky();
      return vykresliStatistiky();
    }
    prehled = await api.prehled();
    if (id === 'zapasy') return vykresliZapasy();
    if (id === 'permanentky') return vykresliPermanentky();
    if (id === 'typy') return vykresliTypy();
  } catch (e) {
    obsah(zprava('Nepovedlo se načíst data: ' + e.message));
  }
}

/** Překreslí aktuální záložku. `zachovejHlasku` nechá na obrazovce potvrzení. */
async function znovu(zachovejHlasku) {
  await prepni(aktivni, zachovejHlasku);
}

// ---- Připojení -------------------------------------------------------------

function vykresliPripojeni() {
  const k = document.createElement('div');

  k.append(nadpis('Tenhle telefon'),
    napoveda('Uloží se jen v tomhle zařízení, do tabulky nic z toho nejde.'),
    pole('p-url', 'Adresa aplikace (Apps Script)', nastaveni.api_url,
         {typ: 'url', placeholder: 'https://script.google.com/macros/s/…/exec'}),
    pole('p-token', 'API token', nastaveni.token, {placeholder: 'token z tabulky'}),
    pole('p-obsluha', 'Obsluha (kdo skenuje)', nastaveni.obsluha, {placeholder: 'např. Pepa'}),
    pole('p-zarizeni', 'Označení telefonu', nastaveni.zarizeni, {placeholder: 'např. vstup A'}));

  k.append(rada([
    tlacitko('Vyzkoušet spojení', 'druhotne', async () => {
      await ulozPripojeni();
      hlaska('Zkouším…', 'ok');
      try { await api.ping(); hlaska('Spojení funguje.', 'ok'); }
      catch (e) { hlaska(e.message, 'chyba'); }
    }),
    tlacitko('Stáhnout seznam', 'hlavni', async () => {
      await ulozPripojeni();
      hlaska('Stahuju…', 'ok');
      try {
        const info = await zavislosti.obnovSnapshot();
        hlaska(`Staženo ${info.permanentky} permanentek a ${info.zapasy} zápasů.`, 'ok');
      } catch (e) { hlaska(e.message, 'chyba'); }
    })
  ]));

  k.append(rada([
    tlacitko('Odeslat frontu', 'druhotne', async () => {
      try { hlaska(await zavislosti.odesliFrontu(), 'ok'); }
      catch (e) { hlaska(e.message, 'chyba'); }
    })
  ]));

  k.append(napoveda('Údaje najdeš v tabulce v menu Permanentky → Zobrazit API údaje.'),
           napoveda('Seznam permanentek stáhni před každým zápasem — bez signálu '
                  + 'se kontroluje proti němu.'));

  // klubová nastavení už žijí v tabulce
  if (prehled?.nastaveni) k.append(sekceKlub());

  obsah(k);
}

function sekceKlub() {
  const n = prehled.nastaveni;
  const k = document.createElement('div');
  k.append(nadpis('Klub a sezóna'),
    napoveda('Tohle je uložené v tabulce v listu Nastaveni — mění se pro všechny.'),
    pole('k-nazev', 'Název klubu (text na kartě)', n.nazev_klubu || ''),
    pole('k-klub', 'Předpona kódu', n.klub || '', {placeholder: 'RCE'}),
    pole('k-sezona', 'Sezóna v nově vydávaných kódech', n.sezona || '', {placeholder: '2026'}),
    rada([tlacitko('Uložit do tabulky', 'hlavni', async () => {
      try {
        await api.ulozNastaveni({
          nazev_klubu: $('k-nazev').value.trim(),
          klub: $('k-klub').value.trim().toUpperCase(),
          sezona: $('k-sezona').value.trim()
        });
        hlaska('Uloženo.', 'ok');
        prehled = await api.prehled();
      } catch (e) { hlaska(e.message, 'chyba'); }
    })]));
  return k;
}

async function ulozPripojeni() {
  nastaveni = await store.ulozNastaveni({
    api_url: $('p-url').value.trim(),
    token: $('p-token').value.trim(),
    obsluha: $('p-obsluha').value.trim(),
    zarizeni: $('p-zarizeni').value.trim()
  });
  zavislosti.nastaveniZmenena(nastaveni);
}

// ---- Zápasy ----------------------------------------------------------------

function vykresliZapasy() {
  const k = document.createElement('div');
  const aktivniZapas = String(prehled.nastaveni.aktivni_zapas || '');

  k.append(nadpis('Zápasy'),
    napoveda('Zápas musí být v seznamu dřív, než se u něj začne skenovat. '
           + 'Označený zápas se skeneru předvybere.'));

  if (!prehled.zapasy.length) k.append(zprava('Zatím žádný zápas.'));

  for (const z of prehled.zapasy) {
    const r = document.createElement('div');
    r.className = 'polozka' + (z.id === aktivniZapas ? ' vybrana-polozka' : '');
    r.append(text('div', 'polozka-nazev',
                  [z.datum, z.cas, z.souper].filter(Boolean).join(' · ') || z.id),
             text('div', 'polozka-popis', [z.soutez, z.id].filter(Boolean).join(' · ')));

    const akce = document.createElement('div');
    akce.className = 'polozka-akce';
    if (z.id !== aktivniZapas) {
      akce.append(tlacitko('Nastavit aktivní', 'druhotne maly', async () => {
        try {
          await api.ulozNastaveni({aktivni_zapas: z.id});
          hlaska('Aktivní zápas: ' + z.id, 'ok');
          await zavislosti.obnovSnapshot().catch(() => {});
          await znovu(true);
        } catch (e) { hlaska(e.message, 'chyba'); }
      }));
    } else {
      akce.append(text('span', 'znacka', '✓ aktivní'));
    }
    akce.append(tlacitko('Upravit', 'druhotne maly', () => formZapas(z)));
    akce.append(tlacitko('Smazat', 'druhotne maly', async () => {
      if (!confirm(`Opravdu smazat zápas ${z.id}?`)) return;
      try { await api.smazZapas(z.id); hlaska('Smazáno.', 'ok'); await znovu(true); }
      catch (e) { hlaska(e.message, 'chyba'); }
    }));
    r.append(akce);
    k.append(r);
  }

  k.append(rada([tlacitko('Přidat zápas', 'hlavni', () => formZapas(null))]));
  obsah(k);
}

function formZapas(z) {
  const k = document.createElement('div');
  const novy = !z;
  z = z || {id: '', datum: '', cas: '', souper: '', soutez: '', poznamka: ''};

  k.append(nadpis(novy ? 'Nový zápas' : 'Úprava zápasu'),
    pole('z-datum', 'Datum', z.datum, {typ: 'date'}),
    pole('z-cas', 'Začátek', z.cas, {typ: 'time'}),
    pole('z-souper', 'Soupeř', z.souper, {placeholder: 'Kladno'}),
    pole('z-soutez', 'Soutěž', z.soutez, {placeholder: 'Extraliga'}),
    pole('z-id', 'Id zápasu', z.id,
         {placeholder: '2026-09-14-KLADNO', readonly: !novy}),
    napoveda(novy ? 'Id se dopočítá z data a soupeře — můžeš ho přepsat. '
                  + 'Pod tímhle id se zapisují vstupy.'
                  : 'Id se u existujícího zápasu měnit nedá — jsou pod ním zapsané vstupy.'),
    pole('z-poznamka', 'Poznámka', z.poznamka));

  k.append(rada([
    tlacitko('Zpět', 'druhotne', znovu),
    tlacitko('Uložit', 'hlavni', async () => {
      try {
        await api.ulozZapas({
          id: $('z-id').value.trim(), datum: $('z-datum').value,
          cas: $('z-cas').value, souper: $('z-souper').value.trim(),
          soutez: $('z-soutez').value.trim(), poznamka: $('z-poznamka').value.trim()
        });
        hlaska('Uloženo.', 'ok');
        await zavislosti.obnovSnapshot().catch(() => {});
        await znovu(true);
      } catch (e) { hlaska(e.message, 'chyba'); }
    })
  ]));

  obsah(k);

  // Posluchače až teď — dokud formulář není v dokumentu, getElementById vrací null.
  if (novy) {
    const dopln = () => {
      const datum = $('z-datum').value;
      // NFD rozloží písmeno s diakritikou na základ + háček, druhý filtr háček
      // (a mezery s tečkami) zahodí: „Ústí nad Labem" → „USTINADLABEM"
      const souper = $('z-souper').value.trim().toUpperCase()
        .normalize('NFD').replace(/[^A-Z0-9]+/g, '');
      if (datum && souper && !$('z-id').dataset.rucne) {
        $('z-id').value = `${datum}-${souper}`;
      }
    };
    $('z-datum').addEventListener('change', dopln);
    $('z-souper').addEventListener('input', dopln);
    $('z-id').addEventListener('input', () => { $('z-id').dataset.rucne = '1'; });
  }
}

// ---- Typy ------------------------------------------------------------------

function vykresliTypy() {
  const k = document.createElement('div');
  k.append(nadpis('Typy permanentek'),
    napoveda('VIP, zlevněná, partnerská… Barva se používá na vytištěné kartě '
           + 'a u verdiktu ve skeneru.'));

  for (const t of prehled.typy) {
    const r = document.createElement('div');
    r.className = 'polozka';
    const puntik = document.createElement('span');
    puntik.className = 'puntik';
    puntik.style.background = t.barva || '#444';
    const nazev = text('div', 'polozka-nazev', t.nazev || t.kod);
    nazev.prepend(puntik);
    r.append(nazev, text('div', 'polozka-popis',
      [t.kod, t.cena !== '' ? t.cena + ' Kč' : '', t.poznamka].filter(Boolean).join(' · ')));

    const akce = document.createElement('div');
    akce.className = 'polozka-akce';
    akce.append(tlacitko('Upravit', 'druhotne maly', () => formTyp(t)));
    akce.append(tlacitko('Vydat…', 'druhotne maly', () => formVydej(t)));
    akce.append(tlacitko('Smazat', 'druhotne maly', async () => {
      if (!confirm(`Opravdu smazat typ ${t.kod}?`)) return;
      try { await api.smazTyp(t.kod); hlaska('Smazáno.', 'ok'); await znovu(true); }
      catch (e) { hlaska(e.message, 'chyba'); }
    }));
    r.append(akce);
    k.append(r);
  }

  k.append(rada([tlacitko('Přidat typ', 'hlavni', () => formTyp(null))]));
  obsah(k);
}

function formTyp(t) {
  const novy = !t;
  t = t || {kod: '', nazev: '', barva: '#2d6cdf', cena: '', poznamka: ''};
  const k = document.createElement('div');

  k.append(nadpis(novy ? 'Nový typ' : 'Úprava typu'),
    pole('t-kod', 'Kód', t.kod, {placeholder: 'VIP', readonly: !novy}),
    napoveda(novy ? 'Velká písmena bez diakritiky, číslice a podtržítko. '
                  + 'Používá se v listu Permanentky.'
                  : 'Kód se měnit nedá — odkazují se na něj vydané permanentky.'),
    pole('t-nazev', 'Název', t.nazev, {placeholder: 'VIP'}),
    pole('t-barva', 'Barva', t.barva || '#2d6cdf', {typ: 'color'}),
    pole('t-cena', 'Cena', t.cena, {typ: 'number', placeholder: '1200'}),
    pole('t-poznamka', 'Poznámka', t.poznamka));

  k.append(rada([
    tlacitko('Zpět', 'druhotne', znovu),
    tlacitko('Uložit', 'hlavni', async () => {
      try {
        await api.ulozTyp({
          kod: $('t-kod').value.trim().toUpperCase(), nazev: $('t-nazev').value.trim(),
          barva: $('t-barva').value, cena: $('t-cena').value,
          poznamka: $('t-poznamka').value.trim()
        });
        hlaska('Uloženo.', 'ok');
        await zavislosti.obnovSnapshot().catch(() => {});
        await znovu(true);
      } catch (e) { hlaska(e.message, 'chyba'); }
    })
  ]));

  obsah(k);
}

// ---- Vydání a tisk ---------------------------------------------------------

function formVydej(t) {
  const k = document.createElement('div');
  const rok = new Date().getFullYear();

  k.append(nadpis('Vydat permanentky — ' + (t.nazev || t.kod)),
    napoveda('Vytvoří nové kódy ve stavu „nevydaná". Jméno se doplní až při prodeji.'),
    pole('v-pocet', 'Počet', '10', {typ: 'number', placeholder: '10'}),
    pole('v-od', 'Platnost od', `${rok}-08-01`, {typ: 'date'}),
    pole('v-do', 'Platnost do', `${rok + 1}-06-30`, {typ: 'date'}));

  k.append(rada([
    tlacitko('Zpět', 'druhotne', znovu),
    tlacitko('Vydat', 'hlavni', async () => {
      const pocet = Number($('v-pocet').value);
      if (!(pocet >= 1)) return hlaska('Zadej počet.', 'chyba');
      hlaska('Vydávám…', 'ok');
      try {
        const v = await api.vydej({
          pocet, typ: t.kod,
          platnost_od: $('v-od').value, platnost_do: $('v-do').value
        });
        prehled = await api.prehled();
        vysledekVydeje(v.kody, t);
      } catch (e) { hlaska(e.message, 'chyba'); }
    })
  ]));

  obsah(k);
}

function vysledekVydeje(kody, t) {
  const k = document.createElement('div');
  k.append(nadpis(`Vydáno ${kody.length} `
                + sklonuj(kody.length, 'permanentka', 'permanentky', 'permanentek')),
    zprava(`${kody[0]} … ${kody[kody.length - 1]}`),
    napoveda('Kódy jsou v tabulce v listu Permanentky ve stavu „nevydaná". '
           + 'Vytiskni je a při prodeji u každé dopiš jméno a přepni na aktivní.'));

  k.append(rada([
    tlacitko('Hotovo', 'druhotne', znovu),
    tlacitko('Vytisknout karty', 'hlavni', () => {
      pripravKarty(kody, t, {
        sezona: prehled.nastaveni.sezona || '',
        klub: prehled.nastaveni.klub || '',
        nazev: prehled.nastaveni.nazev_klubu || ''
      });
      vytiskni();
    })
  ]));

  k.append(napoveda('Tiskni na 100 %, bez „přizpůsobit stránce" — zmenšený QR se hůř čte. '
                  + 'Než vytiskneš celou sérii, zkus jednu stránku naskenovat.'));

  const seznam = document.createElement('pre');
  seznam.className = 'vypis';
  seznam.textContent = kody.join('\n');
  k.append(seznam);

  obsah(k);
}

// ---- Permanentky -----------------------------------------------------------

let hledane = '';

function vykresliPermanentky() {
  const k = document.createElement('div');
  k.append(nadpis('Permanentky'));

  const h = pole('pm-hledat', 'Hledat (jméno, kód, typ)', hledane,
                 {placeholder: 'Novák nebo 0042'});
  k.append(h);

  const vysledky = document.createElement('div');
  k.append(vysledky);

  const prekresli = () => {
    const dotaz = hledane.trim().toLowerCase();
    vysledky.innerHTML = '';

    const nalezene = prehled.permanentky.filter((p) => {
      if (!dotaz) return false;
      return [p.kod, p.jmeno, p.prijmeni, p.typ, p.stav, p.email, p.telefon]
        .join(' ').toLowerCase().includes(dotaz);
    });

    if (!dotaz) {
      vysledky.append(zprava(`V evidenci je ${prehled.permanentky.length} permanentek. `
                           + 'Napiš, koho hledáš.'));
      return;
    }
    if (!nalezene.length) {
      vysledky.append(zprava('Nic nenalezeno.'));
      return;
    }

    for (const p of nalezene.slice(0, 40)) {
      const r = document.createElement('div');
      r.className = 'polozka';
      r.append(text('div', 'polozka-nazev',
                    [p.jmeno, p.prijmeni].filter(Boolean).join(' ') || '(bez jména)'),
               text('div', 'polozka-popis',
                    [p.kod, nazevTypu(p.typ), p.stav].filter(Boolean).join(' · ')));
      const akce = document.createElement('div');
      akce.className = 'polozka-akce';
      akce.append(tlacitko('Upravit', 'druhotne maly', () => formPermanentka(p)));
      r.append(akce);
      vysledky.append(r);
    }
    if (nalezene.length > 40) {
      vysledky.append(zprava(`… a dalších ${nalezene.length - 40}. Zpřesni hledání.`));
    }
  };

  obsah(k);
  $('pm-hledat').addEventListener('input', (e) => { hledane = e.target.value; prekresli(); });
  prekresli();
}

function formPermanentka(p) {
  const k = document.createElement('div');
  k.append(nadpis(p.kod),
    pole('m-jmeno', 'Jméno', p.jmeno),
    pole('m-prijmeni', 'Příjmení', p.prijmeni),
    pole('m-email', 'E-mail', p.email, {typ: 'email'}),
    pole('m-telefon', 'Telefon', p.telefon, {typ: 'tel'}),
    vyber('m-typ', 'Typ', prehled.typy.map((t) => [t.kod, t.nazev || t.kod]), p.typ),
    vyber('m-stav', 'Stav', STAVY, p.stav),
    pole('m-od', 'Platnost od', p.platnost_od, {typ: 'date'}),
    pole('m-do', 'Platnost do', p.platnost_do, {typ: 'date'}),
    pole('m-poznamka', 'Poznámka', p.poznamka),
    napoveda('Při přepnutí na „aktivní" se doplní datum vydání, pokud ještě chybí.'));

  k.append(rada([
    tlacitko('Zpět', 'druhotne', znovu),
    tlacitko('Uložit', 'hlavni', async () => {
      try {
        await api.ulozPermanentku({
          kod: p.kod, jmeno: $('m-jmeno').value.trim(),
          prijmeni: $('m-prijmeni').value.trim(), email: $('m-email').value.trim(),
          telefon: $('m-telefon').value.trim(), typ: $('m-typ').value,
          stav: $('m-stav').value, platnost_od: $('m-od').value,
          platnost_do: $('m-do').value, poznamka: $('m-poznamka').value.trim()
        });
        hlaska('Uloženo.', 'ok');
        await zavislosti.obnovSnapshot().catch(() => {});
        await znovu(true);
      } catch (e) { hlaska(e.message, 'chyba'); }
    })
  ]));

  obsah(k);
}

function sklonuj(n, jeden, dva, pet) {
  if (n === 1) return jeden;
  if (n >= 2 && n <= 4) return dva;
  return pet;
}

function nazevTypu(kod) {
  const t = prehled.typy.find((x) => x.kod === kod);
  return t ? (t.nazev || t.kod) : kod;
}

// ---- Statistiky ------------------------------------------------------------

function vykresliStatistiky() {
  const s = statistiky;
  const k = document.createElement('div');

  k.append(nadpis('Souhrn'));
  k.append(tabulka(['', ''], [
    ['Vydaných permanentek', s.souhrn.vydano],
    ...s.typy.map((t) => ['  ' + t.nazev, t.vydano]),
    ['Zápasů se vstupy', s.souhrn.zapasu],
    ['Vstupů celkem', s.souhrn.vstupu]
  ]));

  k.append(nadpis('Návštěvnost po zápasech'));
  if (!s.zapasy.length) k.append(zprava('Zatím žádné vstupy.'));
  else k.append(tabulka(
    ['zápas', 'vstupů', 'unikát.', 'odmít.', ...s.typy.map((t) => t.nazev)],
    s.zapasy.map((z) => [
      [z.datum, z.souper].filter(Boolean).join(' ') || z.id,
      z.vstupu, z.unikatnich, z.odmitnuto, ...z.podleTypu
    ])));

  if (s.odmitnuti.length) {
    k.append(nadpis('Odmítnuté skeny'));
    k.append(tabulka(['důvod', 'počet'], s.odmitnuti.map((o) => [o.duvod, o.pocet])));
  }

  k.append(nadpis('Využití po permanentkách'));
  k.append(napoveda('Seřazeno od nejaktivnějších. Nulové využití = permanentka, '
                  + 'která na zápasy nechodí.'));
  k.append(tabulka(['kód', 'jméno', 'typ', 'navštíveno', 'využití'],
    s.permanentky.slice(0, 200).map((p) => [
      p.kod, p.jmeno || '—', p.typ,
      `${p.navstiveno}/${p.zOdehranych}`,
      Math.round(p.vyuziti * 100) + ' %'
    ])));

  k.append(napoveda('Stejná čísla najdeš i v listu Statistiky v tabulce '
                  + '(menu Permanentky → Přestavět statistiky).'));
  obsah(k);
}

// ---- stavební prvky --------------------------------------------------------

function obsah(el) {
  $('s-obsah').innerHTML = '';
  $('s-obsah').append(el);
  $('s-obsah').scrollTop = 0;
}

function hlaska(text, druh) {
  $('s-hlaska').textContent = text || '';
  $('s-hlaska').className = 'n-hlaska ' + (druh || '');
}

function nadpis(t) {
  return text('h2', 's-nadpis', t);
}

function zprava(t) {
  return text('p', 's-zprava', t);
}

function napoveda(t) {
  return text('p', 'napoveda', t);
}

function text(tag, trida, obsahText) {
  const el = document.createElement(tag);
  el.className = trida;
  el.textContent = obsahText;
  return el;
}

function pole(id, popisek, hodnota, volby = {}) {
  const l = document.createElement('label');
  l.append(document.createTextNode(popisek));
  const i = document.createElement('input');
  i.id = id;
  i.type = volby.typ || 'text';
  i.value = hodnota === undefined || hodnota === null ? '' : String(hodnota);
  if (volby.placeholder) i.placeholder = volby.placeholder;
  if (volby.readonly) i.readOnly = true;
  i.autocomplete = 'off';
  l.append(i);
  return l;
}

function vyber(id, popisek, moznosti, hodnota) {
  const l = document.createElement('label');
  l.append(document.createTextNode(popisek));
  const s = document.createElement('select');
  s.id = id;
  for (const [v, t] of moznosti) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    s.append(o);
  }
  s.value = hodnota || '';
  l.append(s);
  return l;
}

function tlacitko(popis, trida, akce) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tl-' + trida.split(' ')[0] + (trida.includes('maly') ? ' maly' : '');
  b.textContent = popis;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await akce(); } finally { b.disabled = false; }
  });
  return b;
}

function rada(tlacitka) {
  const d = document.createElement('div');
  d.className = 'tlacitka';
  tlacitka.forEach((t) => d.append(t));
  return d;
}

function tabulka(hlavicka, radky) {
  const obal = document.createElement('div');
  obal.className = 'tabulka-obal';
  const t = document.createElement('table');
  t.className = 'tabulka';

  if (hlavicka.some(Boolean)) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    hlavicka.forEach((h) => tr.append(text('th', '', h)));
    thead.append(tr);
    t.append(thead);
  }

  const tbody = document.createElement('tbody');
  for (const r of radky) {
    const tr = document.createElement('tr');
    r.forEach((b) => tr.append(text('td', '', b === '' || b === null ? '—' : String(b))));
    tbody.append(tr);
  }
  t.append(tbody);
  obal.append(t);
  return obal;
}
