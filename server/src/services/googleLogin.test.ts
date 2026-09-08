import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `loginWithGoogle` — le contrôle d'`email_verified`.
 *
 * Ce fichier existe pour une régression précise et invisible autrement : le
 * rattachement de compte, quelques lignes plus bas dans la fonction, se fait sur
 * la SEULE égalité d'adresse e-mail. Une adresse Google non vérifiée qui
 * correspond à un compte mot-de-passe existant en donnerait la maîtrise.
 *
 * ⚠️ **Le refus est PAR DÉFAUT, pas seulement sur `false`.** C'est le point que
 * ces tests verrouillent : quelqu'un qui « simplifie » le garde en
 * `email_verified === false` ne casse aucun parcours — l'endpoint OIDC renvoie
 * toujours le champ — et rouvre le trou en silence le jour où il cesserait de
 * le renvoyer. Deux des quatre cas ci-dessous tomberaient.
 *
 * Le garde s'exécutant AVANT `pool.connect()`, aucune base n'est nécessaire :
 * `connect` lève un marqueur, et « atteindre la base » devient l'assertion du
 * cas passant.
 *
 * ⚠️ Ce que ce fichier NE prouve PAS : ce qui se passe APRÈS le garde — le
 * rattachement, la création, la transaction. Rien ici ne les exécute.
 */

const REACHED_DB = 'FAKE_POOL_CONNECT';

function makeFakePool() {
  const connect = vi.fn(async () => {
    throw new Error(REACHED_DB);
  });
  return { connect };
}

async function loadAuth(fake: ReturnType<typeof makeFakePool>) {
  vi.resetModules();
  vi.doMock('../db/connection', () => ({ pool: fake }));
  return import('./auth.service');
}

const GOOGLE_USER = {
  sub: 'google-123',
  email: 'Victime@Example.com',
  name: 'Victime',
  picture: 'https://example.com/a.png',
};

describe('loginWithGoogle — e-mail non vérifié', () => {
  let fake: ReturnType<typeof makeFakePool>;
  beforeEach(() => { fake = makeFakePool(); });

  it('refuse une adresse explicitement non vérifiée, sans toucher la base', async () => {
    const { loginWithGoogle, GOOGLE_EMAIL_UNVERIFIED } = await loadAuth(fake);

    await expect(
      loginWithGoogle({ ...GOOGLE_USER, email_verified: false } as any),
    ).rejects.toMatchObject({ status: 403, code: GOOGLE_EMAIL_UNVERIFIED });

    // Le point du « sans toucher la base » : le refus doit précéder la
    // transaction, sinon un rattachement partiel resterait possible.
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it('refuse aussi quand le champ est ABSENT — le garde est fail-closed', async () => {
    const { loginWithGoogle, GOOGLE_EMAIL_UNVERIFIED } = await loadAuth(fake);

    await expect(
      loginWithGoogle({ ...GOOGLE_USER } as any),
    ).rejects.toMatchObject({ status: 403, code: GOOGLE_EMAIL_UNVERIFIED });

    expect(fake.connect).not.toHaveBeenCalled();
  });

  it('refuse une valeur qui n’est pas le booléen `true` (chaîne "true" d’un proxy)', async () => {
    const { loginWithGoogle, GOOGLE_EMAIL_UNVERIFIED } = await loadAuth(fake);

    await expect(
      loginWithGoogle({ ...GOOGLE_USER, email_verified: 'true' } as any),
    ).rejects.toMatchObject({ status: 403, code: GOOGLE_EMAIL_UNVERIFIED });
  });

  it('laisse passer une adresse vérifiée jusqu’à la base', async () => {
    const { loginWithGoogle } = await loadAuth(fake);

    // L'erreur attendue est CELLE DU FAUX POOL : si elle remonte, c'est que le
    // garde a laissé passer. Sans ce cas, un garde qui refuserait TOUT LE MONDE
    // passerait les trois tests précédents.
    await expect(
      loginWithGoogle({ ...GOOGLE_USER, email_verified: true } as any),
    ).rejects.toThrow(REACHED_DB);

    expect(fake.connect).toHaveBeenCalledTimes(1);
  });
});
