/**
 * api.js — komunikace s Apps Script webovou aplikací.
 *
 * POZOR na CORS: Apps Script neumí odbavit preflight (OPTIONS). Proto se POST
 * posílá s Content-Type: text/plain;charset=utf-8 — takový požadavek prohlížeč
 * považuje za „simple" a preflight nedělá. Nikdy sem nedávej application/json.
 */

import {nactiNastaveni} from './store.js';

const TIMEOUT_MS = 12000;

export class ChybaApi extends Error {}

async function poslat(action, telo, {method = 'POST', timeout = TIMEOUT_MS} = {}) {
  const {api_url: url, token} = await nactiNastaveni();
  if (!url) throw new ChybaApi('Není nastavená adresa aplikace (viz Nastavení).');

  const prerus = new AbortController();
  const casovac = setTimeout(() => prerus.abort(), timeout);

  try {
    let odpoved;
    if (method === 'GET') {
      const q = new URLSearchParams({action, token, ...(telo || {})});
      odpoved = await fetch(`${url}?${q}`, {method: 'GET', signal: prerus.signal,
                                            redirect: 'follow'});
    } else {
      odpoved = await fetch(url, {
        method: 'POST',
        // text/plain schválně — viz poznámka o CORS nahoře
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify({action, token, ...(telo || {})}),
        signal: prerus.signal,
        redirect: 'follow'
      });
    }

    if (!odpoved.ok) throw new ChybaApi(`Server odpověděl ${odpoved.status}.`);

    const text = await odpoved.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Typicky přihlašovací stránka Googlu — špatně nasazená aplikace.
      throw new ChybaApi('Server nevrátil JSON. Zkontroluj, že je aplikace nasazená '
                       + 'jako „Web app / Anyone with the link".');
    }

    if (!data.ok) throw new ChybaApi(data.chyba || 'Neznámá chyba serveru.');
    return data.data;
  } catch (e) {
    if (e.name === 'AbortError') throw new ChybaApi('Server neodpovídá.');
    if (e instanceof ChybaApi) throw e;

    // Sem spadne i nejčastější chyba při nasazování: když nasazení není
    // publikované pro „Kdokoli", Google odpoví přesměrováním na přihlašovací
    // stránku. Ta je na jiné doméně, prohlížeč ji kvůli CORS zablokuje a my
    // se o důvodu nedozvíme nic — proto na něj radši upozorníme rovnou.
    throw new ChybaApi('Nedaří se spojit se serverem. Zkontroluj adresu '
                     + 'a signál. Když adresa sedí, bývá příčinou nasazení, '
                     + 'které nemá „Kdo má přístup: Kdokoli" — Google pak místo '
                     + 'dat vrací přihlašovací stránku.');
  } finally {
    clearTimeout(casovac);
  }
}

export const ping = () => poslat('ping', null, {method: 'GET', timeout: 6000});

export const stahniSnapshot = () => poslat('snapshot', null, {method: 'GET', timeout: 30000});

export const checkin = (vstup) => poslat('checkin', vstup);

export const sync = (vstupy) => poslat('sync', {vstupy}, {timeout: 30000});

/** Kolik lidí už na zápas přišlo — přes všechny telefony dohromady. */
export const navstevnost = (zapas_id) =>
  poslat('navstevnost', {zapas_id}, {method: 'GET', timeout: 20000});

// ---- správa ----------------------------------------------------------------
//
// Všechny tyhle akce zapisují do stejných listů tabulky, které jde editovat ručně.

export const prehled = () => poslat('admin.prehled', null, {timeout: 30000});
export const statistiky = () => poslat('admin.statistiky', null, {timeout: 30000});

export const ulozZapas = (z) => poslat('admin.ulozZapas', z);
export const smazZapas = (id) => poslat('admin.smazZapas', {id});
export const ulozTyp = (t) => poslat('admin.ulozTyp', t);
export const smazTyp = (kod) => poslat('admin.smazTyp', {kod});
export const ulozPermanentku = (p) => poslat('admin.ulozPermanentku', p);
export const vydej = (v) => poslat('admin.vydej', v, {timeout: 60000});
export const ulozNastaveni = (hodnoty) => poslat('admin.nastaveni', {hodnoty});
export const novyToken = () => poslat('admin.novyToken', null, {timeout: 30000});
