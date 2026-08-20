/**
 * store.js — trvalé úložiště skeneru v telefonu (IndexedDB).
 *
 * Tři úložiště:
 *   kv     — nastavení a stažený snapshot (klíč → hodnota)
 *   fronta — vstupy, které ještě nedošly na server (offline režim)
 *   skeny  — co tenhle telefon na daný zápas už načetl (kvůli duplicitám offline)
 */

const DB_NAZEV = 'permanentky';
const DB_VERZE = 1;

let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((splneno, chyba) => {
    const req = indexedDB.open(DB_NAZEV, DB_VERZE);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('fronta')) d.createObjectStore('fronta', {keyPath: 'vstup_id'});
      if (!d.objectStoreNames.contains('skeny')) {
        const s = d.createObjectStore('skeny', {keyPath: 'id'});
        s.createIndex('zapas', 'zapas_id');
      }
    };
    req.onsuccess = () => splneno(req.result);
    req.onerror = () => chyba(req.error);
  });
  return dbPromise;
}

/**
 * Obal nad transakcí. `prace` dostane objectStore a může vrátit IDBRequest —
 * ten se rozbalí na svůj výsledek. Chybějící záznam tak vrátí undefined,
 * ne objekt požadavku (na tom se dá pěkně naletět).
 */
async function tx(sklad, rezim, prace) {
  const d = await db();
  return new Promise((splneno, chyba) => {
    const t = d.transaction(sklad, rezim);
    const vysledek = prace(t.objectStore(sklad));
    t.oncomplete = () => splneno(vysledek instanceof IDBRequest ? vysledek.result : vysledek);
    t.onerror = () => chyba(t.error);
    t.onabort = () => chyba(t.error);
  });
}

// ---- kv --------------------------------------------------------------------

export async function dej(klic, vychozi = null) {
  const r = await tx('kv', 'readonly', (s) => s.get(klic));
  return r === undefined || r === null ? vychozi : r;
}

export async function uloz(klic, hodnota) {
  return tx('kv', 'readwrite', (s) => s.put(hodnota, klic));
}

// ---- nastavení -------------------------------------------------------------

const VYCHOZI_NASTAVENI = {
  api_url: '',
  token: '',
  obsluha: '',
  zarizeni: '',
  zapas_id: '',
  // Poslední aktivní zápas, jaký přišel ze serveru. Podle něj se pozná,
  // jestli ho správce mezitím přepnul — viz naplnZapasy() v app.js.
  nasledovany_zapas: '',

  // Co se po skenu ukáže pod verdiktem. Vypnuté ve výchozím stavu — obrazovka
  // u vstupu má být přehledná a kontakty se nemají zbytečně promítat na veřejnosti.
  zobrazit_kontakt: false,
  zobrazit_poznamku: false,
  zobrazit_platnost: false,
  zobrazit_kartu: false,

  // Má kamera hledat další kód, i když je na obrazovce verdikt? Zapnuto je to
  // rychlejší (další karta verdikt rovnou nahradí), vypnuto jistější
  // (verdikt počká, dokud ho obsluha neodklikne).
  kamera_pri_verdiktu: true,

  // Verze serveru z posledního staženého seznamu — ukazuje se v Nastavení,
  // ať jde poznat, jestli je nasazená ta správná.
  verze_serveru: ''
};

export async function nactiNastaveni() {
  return {...VYCHOZI_NASTAVENI, ...(await dej('nastaveni', {}))};
}

/** Uloží změněné položky a vrátí CELÁ nastavení — volající si jimi přepisuje svou kopii. */
export async function ulozNastaveni(n) {
  const nove = {...(await nactiNastaveni()), ...n};
  await uloz('nastaveni', nove);
  return nove;
}

// ---- snapshot --------------------------------------------------------------

export async function ulozSnapshot(s) {
  const index = {};
  (s.permanentky || []).forEach((p) => { index[p.kod] = p; });
  return uloz('snapshot', {...s, index, ulozeno: new Date().toISOString()});
}

export async function nactiSnapshot() {
  return dej('snapshot', null);
}

// ---- fronta neodeslaných vstupů -------------------------------------------

export async function doFronty(vstup) {
  return tx('fronta', 'readwrite', (s) => s.put(vstup));
}

export async function fronta() {
  return tx('fronta', 'readonly', (s) => s.getAll()).then((r) => r || []);
}

export async function zFronty(idcka) {
  return tx('fronta', 'readwrite', (s) => idcka.forEach((id) => s.delete(id)));
}

export async function pocetVeFronte() {
  return tx('fronta', 'readonly', (s) => s.count()).then((r) => r || 0);
}

// ---- lokální log skenů (duplicity offline) ---------------------------------

/**
 * Zapamatuje si úspěšný vstup, aby se duplicita poznala i bez signálu.
 * Drží se PRVNÍ vstup — ten se ukazuje obsluze.
 */
export async function zapamatujVstup(zapasId, kod, cas) {
  const id = `${zapasId}|${kod}`;
  const d = await db();
  return new Promise((splneno, chyba) => {
    const t = d.transaction('skeny', 'readwrite');
    const s = t.objectStore('skeny');
    const req = s.get(id);
    req.onsuccess = () => {
      if (!req.result) s.put({id, zapas_id: zapasId, kod, cas});
    };
    t.oncomplete = () => splneno();
    t.onerror = () => chyba(t.error);
  });
}

export async function prvniVstup(zapasId, kod) {
  return tx('skeny', 'readonly', (s) => s.get(`${zapasId}|${kod}`))
    .then((r) => r || null);
}

/** Kolik lidí tenhle telefon na daný zápas pustil. */
export async function pocetVstupu(zapasId) {
  return tx('skeny', 'readonly', (s) => s.index('zapas').count(IDBKeyRange.only(zapasId)))
    .then((r) => r || 0);
}

/** Vygeneruje id vstupu — server podle něj pozná už zapsaný záznam. */
export function noveVstupId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'v-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}
