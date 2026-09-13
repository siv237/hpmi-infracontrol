// Вход платформы mahogany-avr (S2/S3): Digest GET / → ссылка avr.jnlp →
// аргументы (VncPort/httpdata/digest). Креды даёт ядро. Реализация
// переиспользует проверенный сценарий (server/discover.js → s2Session).
import { s2Session } from '../../discover.js';

export default async function login(cfg, sdk) {
  const sessionCfg = await s2Session(cfg);
  if (!sessionCfg) throw new Error('mahogany-avr: S2-вход не удался (нет avr.jnlp/креды)');
  sdk?.log?.(`[mahogany-avr] сессия: VncPort=${sessionCfg.port} httpdata=${String(sessionCfg.httpdata || '').slice(0, 6)}…`);
  return sessionCfg;
}
