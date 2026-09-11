// Контракты ядра (SDK) для модулей платформ. Ядро вызывает ТОЛЬКО эти методы;
// модули не лезут во внутренности ядра и работают через переданный `sdk`.
//
// Это документация-как-код. Типы — JSDoc (проект на чистом ESM JS).

export const SDK_VERSION = 1;

/**
 * Интерфейс, который реализует модуль (server/platforms/<id>/index.js).
 * Реализуйте только то, что объявили в manifest.capabilities.
 *
 * @typedef {Object} PlatformModule
 * @property {(cfg: ConnCfg, sdk: Sdk) => Promise<ProbeResult>} [probe]
 * @property {(cfg: ConnCfg, sdk: Sdk) => Promise<any>} [login]
 * @property {(sessionCfg: any, events: ConsoleEvents, sdk: Sdk) => ConsoleClient} [createConsole]
 * @property {(sessionCfg: any, opts: {isoPath?: string}, sdk: Sdk) => MediaRedirector} [createMedia]
 */

/**
 * @typedef {Object} ConnCfg
 * @property {string} host
 * @property {number} port
 * @property {boolean} secure
 * @property {string} username
 * @property {string} password
 */

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} matched
 * @property {number} [confidence]   // 0..1
 * @property {Object} [info]
 */

/**
 * @typedef {Object} ConsoleClient
 * @property {() => Promise<void>} start
 * @property {() => void} close
 * @property {(hid: number, down: boolean) => void} [keyEvent]
 * @property {(x: number, y: number) => void} [mouseAbs]
 * @property {(x: number, y: number, mask: number, wheel?: number) => void} [mouseButtons]
 * @property {() => {width:number,height:number,pix:Uint32Array}} fb  // канон 0x00RRGGBB
 */

/**
 * @typedef {Object} MediaRedirector
 * @property {() => Promise<void>} start
 * @property {() => void} close
 * @property {() => {active:boolean,bytes:number,bps:number}} [stats]
 */

/**
 * @typedef {Object} ConsoleEvents
 * @property {(s: string) => void} [onStatus]
 * @property {(fb: {width:number,height:number,pix:Uint32Array}) => void} [onFrame]
 * @property {(e: string|Error) => void} [onError]
 * @property {() => void} [onExit]
 */

/**
 * @typedef {Object} Sdk
 * @property {(msg: string) => void} log
 * @property {number} version
 * @property {Object} [http]   // общие HTTP-примитивы ядра (digest/basic/get/post)
 */

// Обязательные методы модуля при загрузке отсутствуют — все опциональны:
// наличие проверяется по объявленным capabilities. Реализовывать нечего —
// модуль просто не объявляет capability.
export const REQUIRED_BY_CAP = {
  'kvm-avr': ['login', 'createConsole'],
  'kvm-ivtp': ['login', 'createConsole'],
  'iso-m2': ['login', 'createMedia'],
  'iso-cdmedia': ['login', 'createMedia'],
};
