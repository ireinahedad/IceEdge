// ============================================================
//  Notification « pari réglé » — APPLE_PLAN 4.1
// ============================================================
// Après une passe de règlement, chaque utilisateur dont au moins un coupon vient
// d'être réglé reçoit UNE notification sur son iPhone : le détail si c'est un
// seul coupon, un résumé s'il y en a plusieurs (une soirée à 4 coupons ne doit
// pas faire vibrer le téléphone 4 fois à 23 h).
//
// Canal APNs seulement : l'abonnement Web Push a été pris pour les alertes
// value bet (Réglages → « Alertes value bets »), pas pour celles-ci. Sur iOS,
// activer les notifications dans l'app vaut pour les deux.
//
// Fire-and-forget : un envoi raté ne doit jamais faire échouer ni ralentir la
// passe de règlement — l'XP est déjà écrite quand on arrive ici.

import { logger } from '../logger';
import { sendMessages, type LocalizedPayload, type PushMessage } from './push.service';

export interface SettledSlip {
  userId:  string;
  outcome: 'win' | 'loss' | 'void';
  /** XP appliquée (négative sur une perte, 0 sur une annulation). */
  xp:      number;
  /** Nombre de jambes du coupon. */
  legs:    number;
}

const fmtXp = (xp: number) => (xp > 0 ? `+${xp}` : `${xp}`) + ' XP';

function single(s: SettledSlip, url: string): LocalizedPayload {
  const parlay = s.legs > 1;
  if (s.outcome === 'win') {
    return {
      fr: { title: 'Pari gagné ✅', body: `${parlay ? `Ton combiné de ${s.legs} paris` : 'Ton pari'} est gagné · ${fmtXp(s.xp)}`, url },
      en: { title: 'Bet won ✅',    body: `${parlay ? `Your ${s.legs}-leg parlay` : 'Your bet'} won · ${fmtXp(s.xp)}`, url },
    };
  }
  if (s.outcome === 'loss') {
    return {
      fr: { title: 'Pari perdu', body: `${parlay ? `Ton combiné de ${s.legs} paris` : 'Ton pari'} est perdu · ${fmtXp(s.xp)}`, url },
      en: { title: 'Bet lost',   body: `${parlay ? `Your ${s.legs}-leg parlay` : 'Your bet'} lost · ${fmtXp(s.xp)}`, url },
    };
  }
  return {
    fr: { title: 'Pari annulé', body: 'Ton pari a été annulé — aucun XP gagné ni perdu.', url },
    en: { title: 'Bet voided',  body: 'Your bet was voided — no XP won or lost.', url },
  };
}

function summary(list: SettledSlip[], url: string): LocalizedPayload {
  const n = list.length;
  const w = list.filter((s) => s.outcome === 'win').length;
  const l = list.filter((s) => s.outcome === 'loss').length;
  const v = list.filter((s) => s.outcome === 'void').length;
  const xp = list.reduce((sum, s) => sum + s.xp, 0);
  const pl = (k: number, one: string, many: string) => `${k} ${k > 1 ? many : one}`;

  const fr = [w && pl(w, 'gagné', 'gagnés'), l && pl(l, 'perdu', 'perdus'), v && pl(v, 'annulé', 'annulés')].filter(Boolean).join(', ');
  const en = [w && `${w} won`, l && `${l} lost`, v && `${v} voided`].filter(Boolean).join(', ');
  return {
    fr: { title: `${n} paris réglés`,  body: `${fr} · ${fmtXp(xp)}`, url },
    en: { title: `${n} bets settled`, body: `${en} · ${fmtXp(xp)}`, url },
  };
}

/** Un message par utilisateur. Pur — testé sans base ni réseau. */
export function settledMessages(slips: SettledSlip[]): PushMessage[] {
  const byUser = new Map<string, SettledSlip[]>();
  for (const s of slips) {
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }
  return [...byUser.entries()].map(([userId, list]) => {
    const url = `/player/${userId}`;
    return { userId, payload: list.length === 1 ? single(list[0], url) : summary(list, url) };
  });
}

/** Envoie les notifications d'une passe. Ne lève jamais. */
export function notifySettled(slips: SettledSlip[]): void {
  if (slips.length === 0) return;
  void sendMessages(settledMessages(slips), { channels: ['apns'] })
    .then((res) => { if (res.sent || res.failed) logger.info({ users: new Set(slips.map((s) => s.userId)).size, ...res }, '[Settlement] notifications envoyées'); })
    .catch((err: any) => logger.warn({ err: err?.message }, '[Settlement] notifications non envoyées'));
}
