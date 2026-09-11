// Методы проб платформы. Имена перечислены в manifest.probes — ядро вызывает
// их через index.js → probe(). Каждая проба -> { matched, confidence, info }.
//
// Проба должна быть БЫСТРОЙ и ограниченной по времени (таймаут!), только
// «читающие» действия: заголовки HTTP, наличие/сигнатура JNLP, баннеры.
// Креды могут быть пустыми — проба не обязана логиниться.

export default {
  async 'web-title'(cfg, sdk) {
    // Пример: GET / и разбор <title>/Server-заголовка.
    // return { matched: /Vendor Family/i.test(title), confidence: 0.8, info: { title } };
    return { matched: false, confidence: 0 };
  },

  async 'jnlp-args'(cfg, sdk) {
    // Пример: найти avr.jnlp и сверить набор аргументов.
    return { matched: false, confidence: 0 };
  },
};
