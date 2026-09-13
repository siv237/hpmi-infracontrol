// Общие сетевые утилиты ядра (используются ядром и модулями платформ).
import crypto from 'node:crypto';

// Permissive TLS для старого firmware iRMC: разрешаем TLS 1.0/1.1 и legacy
// шифры/SHA-1 подписи. Node по умолчанию TLSv1.2 + security level 2, что
// старый iRMC отвергает (ssl_choose_client_version).
export function permissiveTls(hard) {
  const legacyReneg =
    (crypto.constants && crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION) ||
    0x00040000;
  const opts = {
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    maxVersion: 'TLSv1.2',
    honorCipherOrder: true,
    ciphers: 'ALL:!aNULL:!eNULL:!NULL:@SECLEVEL=0',
    sigalgs: 'RSA-PSS+SHA256:RSA-PSS+SHA384:RSA-PSS+SHA512:'
          + 'RSA+SHA1:RSA+SHA224:RSA+SHA256:RSA+SHA384:RSA+SHA512:'
          + 'ECDSA+SHA1:ECDSA+SHA224:ECDSA+SHA256:ECDSA+SHA384:ECDSA+SHA512',
    // Старый iRMC выполняет TLS-renegotiation в ходе рукопожатия.
    secureOptions: legacyReneg,
  };
  void hard;
  return opts;
}

export function permissiveTlsOptions() { return permissiveTls(false); }
