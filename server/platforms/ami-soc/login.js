// Вход платформы S4 (AMI/SOC): Digest за формой → 302 sid → avr.jnlp →
// параметры сессии (kvmtoken/webcookie/kvmport/websecureport).
// Схема входа — платформенная; креды даёт ядро. Реализация переиспользует
// проверенный сценарий (server/discover.js → s4Session), чтобы не дублировать
// протокол; со временем перенесём сюда целиком.
import { s4Session } from '../../discover.js';

export default async function login(cfg, sdk) {
  const sessionCfg = await s4Session(cfg);
  if (!sessionCfg) throw new Error('ami-soc: S4-вход не удался (не S4 или креды)');
  sdk?.log?.(`[ami-soc] сессия получена (sid ${String(sessionCfg.s4Sid || '').slice(0, 6)}…)`);
  return sessionCfg;
}
