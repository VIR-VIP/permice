/**
 * verdikt.js — offline rozhodnutí o vstupu.
 *
 * Zrcadlí apps-script/Overeni.gs. Rozdíly, které z toho plynou a které musí
 * obsluha znát:
 *   • Nekontroluje podpis kódu — tajný klíč v telefonu záměrně není.
 *     Místo toho se kód hledá ve staženém seznamu, což pokrývá totéž.
 *   • Duplicitu vidí jen podle skenů TOHOTO telefonu. Když u vstupu stojí dva
 *     lidé s telefony a nemají signál, jeden o skenech druhého neví.
 */

export const VYSLEDEK = {
  OK: 'OK',
  DUPLICITA: 'DUPLICITA',
  DUPLICITA_POVOLENA: 'DUPLICITA_POVOLENA',
  NEPLATNA: 'NEPLATNA',
  BLOKOVANA: 'BLOKOVANA',
  NEZNAMA: 'NEZNAMA',
  SPATNY_PODPIS: 'SPATNY_PODPIS'
};

/** Jak se verdikt tváří — barva panelu a co má obsluha udělat. */
export const VZHLED = {
  OK:                 {barva: 'ok',    nadpis: 'PUSTIT',      zvuk: 'ok'},
  DUPLICITA_POVOLENA: {barva: 'ok',    nadpis: 'PUSTIT',      zvuk: 'ok'},
  DUPLICITA:          {barva: 'pozor', nadpis: 'UŽ VSTOUPIL', zvuk: 'pozor'},
  NEPLATNA:           {barva: 'chyba', nadpis: 'NEPLATNÁ',    zvuk: 'chyba'},
  BLOKOVANA:          {barva: 'chyba', nadpis: 'BLOKOVANÁ',   zvuk: 'chyba'},
  NEZNAMA:            {barva: 'chyba', nadpis: 'NEZNÁMÁ',     zvuk: 'chyba'},
  SPATNY_PODPIS:      {barva: 'chyba', nadpis: 'PADĚLEK?',    zvuk: 'chyba'},
  JIZ_ZAPSANO:        {barva: 'ok',    nadpis: 'ZAPSÁNO',     zvuk: 'ok'}
};

const TVAR_KODU = /^([A-Z]{2,5})-(\d{4})-(\d{4})-([0-9A-Z]{4})$/;

/**
 * Srovná kód do kanonické podoby. Ruční opis na telefonu je nepohodlný, tak jsme
 * shovívaví: velká písmena, mezery a podtržítka se berou jako pomlčka,
 * a v podpisové části I/L→1, O→0, U→V (znaky, které Crockford Base32 nepoužívá).
 */
export function normalizujKod(vstup) {
  if (!vstup) return '';
  let s = String(vstup).trim().toUpperCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const kus = s.split('-');
  if (kus.length === 4) {
    kus[3] = kus[3].replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
    s = kus.join('-');
  }
  return s;
}

function jenDatum(h) {
  if (!h) return '';
  return String(h).slice(0, 10);
}

function hhmm(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString('cs-CZ', {hour: '2-digit', minute: '2-digit'});
}

/**
 * @param {string} vstupniKod
 * @param {Object|null} permanentka záznam ze staženého snapshotu
 * @param {Object|null} predchozi   první vstup na tenhle zápas z tohoto telefonu
 * @param {Date} kdy
 */
export function posudek(vstupniKod, permanentka, predchozi, kdy = new Date()) {
  const kod = normalizujKod(vstupniKod);

  if (!TVAR_KODU.test(kod)) {
    return {vysledek: VYSLEDEK.NEZNAMA, duvod: 'Tohle není kód permanentky.'};
  }

  if (!permanentka) {
    return {vysledek: VYSLEDEK.NEZNAMA,
            duvod: 'Kód není ve staženém seznamu — permanentka nebyla vydána.'};
  }

  const stav = String(permanentka.stav || '').trim().toLowerCase();
  if (stav === 'blokovana' || stav === 'ztracena') {
    return {vysledek: VYSLEDEK.BLOKOVANA,
            duvod: stav === 'ztracena' ? 'Permanentka je nahlášená jako ztracená.'
                                       : 'Permanentka je zablokovaná.'};
  }
  if (stav === 'nevydana') {
    return {vysledek: VYSLEDEK.NEPLATNA,
            duvod: 'Permanentka se ještě neprodala — pošli ho k pokladně.'};
  }
  if (stav && stav !== 'aktivni') {
    return {vysledek: VYSLEDEK.NEPLATNA, duvod: 'Stav permanentky: ' + permanentka.stav};
  }

  const den = kdy.toISOString().slice(0, 10);
  const od = jenDatum(permanentka.platnost_od);
  const doo = jenDatum(permanentka.platnost_do);
  if (od && den < od) {
    return {vysledek: VYSLEDEK.NEPLATNA, duvod: 'Platnost začíná až ' + od + '.'};
  }
  if (doo && den > doo) {
    return {vysledek: VYSLEDEK.NEPLATNA, duvod: 'Platnost skončila ' + doo + '.'};
  }

  if (predchozi) {
    return {vysledek: VYSLEDEK.DUPLICITA,
            duvod: 'Na tenhle zápas už permanentka prošla v ' + hhmm(predchozi.cas) + '.'};
  }

  return {vysledek: VYSLEDEK.OK, duvod: ''};
}
