import { formatOffset, parseZoneInfo, isUndefined, objToLocalTS } from "../impl/util.js";
import Zone from "../zone.js";

let directOffsetDTFCache = {};
function makeDirectOffsetDTF(zone) {
  if (!directOffsetDTFCache[zone]) {
    directOffsetDTFCache[zone] = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
      year: "numeric",
    });
  }
  return directOffsetDTFCache[zone];
}

let calculatedOffsetDTFCache = {};
function makeCalculatedOffsetDTF(zone) {
  if (!calculatedOffsetDTFCache[zone]) {
    calculatedOffsetDTFCache[zone] = new Intl.DateTimeFormat("en-US", {
      hour12: false,
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      era: "short",
    });
  }
  return calculatedOffsetDTFCache[zone];
}

const typeToPos = {
  year: 0,
  month: 1,
  day: 2,
  era: 3,
  hour: 4,
  minute: 5,
  second: 6,
};

function hackyOffset(dtf, date) {
  const formatted = dtf.format(date).replace(/\u200E/g, ""),
    parsed = /(\d+)\/(\d+)\/(\d+) (AD|BC),? (\d+):(\d+):(\d+)/.exec(formatted),
    [, fMonth, fDay, fYear, fadOrBc, fHour, fMinute, fSecond] = parsed;
  return [fYear, fMonth, fDay, fadOrBc, fHour, fMinute, fSecond];
}

function partsOffset(dtf, date) {
  const formatted = dtf.formatToParts(date);
  const filled = [];
  for (let i = 0; i < formatted.length; i++) {
    const { type, value } = formatted[i];
    const pos = typeToPos[type];

    if (type === "era") {
      filled[pos] = value;
    } else if (!isUndefined(pos)) {
      filled[pos] = parseInt(value, 10);
    }
  }
  return filled;
}

function calculatedOffset(zone, ts) {
  const date = new Date(ts);

  if (isNaN(date)) return NaN;

  const dtf = makeCalculatedOffsetDTF(zone);
  let [year, month, day, adOrBc, hour, minute, second] = dtf.formatToParts
    ? partsOffset(dtf, date)
    : hackyOffset(dtf, date);

  if (adOrBc === "BC") {
    year = -Math.abs(year) + 1;
  }

  // because we're using hour12 and https://bugs.chromium.org/p/chromium/issues/detail?id=1025564&can=2&q=%2224%3A00%22%20datetimeformat
  const adjustedHour = hour === 24 ? 0 : hour;

  const asUTC = objToLocalTS({
    year,
    month,
    day,
    hour: adjustedHour,
    minute,
    second,
    millisecond: 0,
  });

  let asTS = +date;
  const over = asTS % 1000;
  asTS -= over >= 0 ? over : 1000 + over;
  return (asUTC - asTS) / (60 * 1000);
}

function directOffset(zone, ts) {
  const dtf = makeDirectOffsetDTF(zone);

  let formatted;

  try {
    formatted = dtf.format(ts);
  } catch (e) {
    return NaN;
  }

  const idx = formatted.search(/GMT([+-][0-9][0-9]:[0-9][0-9](:[0-9][0-9])?)?/);
  const sign = formatted.charCodeAt(idx + 3);

  if (isNaN(sign)) return 0;

  return (
    (44 - sign) *
    (Number(formatted.slice(idx + 4, idx + 6)) * 60 +
      Number(formatted.slice(idx + 7, idx + 9)) +
      Number(formatted.slice(idx + 10, idx + 12)) / 60)
  );
}

let ianaZoneCache = {};
let offsetFunc;
/**
 * A zone identified by an IANA identifier, like America/New_York
 * @implements {Zone}
 */
export default class IANAZone extends Zone {
  /**
   * @param {string} name - Zone name
   * @return {IANAZone}
   */
  static create(name) {
    if (!ianaZoneCache[name]) {
      ianaZoneCache[name] = new IANAZone(name);
    }
    return ianaZoneCache[name];
  }

  /**
   * Reset local caches. Should only be necessary in testing scenarios.
   * @return {void}
   */
  static resetCache() {
    ianaZoneCache = {};
    calculatedOffsetDTFCache = {};
    directOffsetDTFCache = {};
  }

  /**
   * Returns whether the provided string is a valid specifier. This only checks the string's format, not that the specifier identifies a known zone; see isValidZone for that.
   * @param {string} s - The string to check validity on
   * @example IANAZone.isValidSpecifier("America/New_York") //=> true
   * @example IANAZone.isValidSpecifier("Sport~~blorp") //=> false
   * @deprecated This method returns false for some valid IANA names. Use isValidZone instead.
   * @return {boolean}
   */
  static isValidSpecifier(s) {
    return this.isValidZone(s);
  }

  /**
   * Returns whether the provided string identifies a real zone
   * @param {string} zone - The string to check
   * @example IANAZone.isValidZone("America/New_York") //=> true
   * @example IANAZone.isValidZone("Fantasia/Castle") //=> false
   * @example IANAZone.isValidZone("Sport~~blorp") //=> false
   * @return {boolean}
   */
  static isValidZone(zone) {
    if (!zone) {
      return false;
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
      return true;
    } catch (e) {
      return false;
    }
  }

  constructor(name) {
    super();
    /** @private **/
    this.zoneName = name;
    /** @private **/
    this.valid = IANAZone.isValidZone(name);
  }

  /** @override **/
  get type() {
    return "iana";
  }

  /** @override **/
  get name() {
    return this.zoneName;
  }

  /** @override **/
  get isUniversal() {
    return false;
  }

  /** @override **/
  offsetName(ts, { format, locale }) {
    return parseZoneInfo(ts, format, locale, this.name);
  }

  /** @override **/
  formatOffset(ts, format) {
    return formatOffset(this.offset(ts), format);
  }

  /** @override **/
  offset(ts) {
    if (offsetFunc === undefined) {
      try {
        const ts = Date.now();
        // directOffset will raise an error if not supported by the engine
        // also check it works correctly as it relies on a specific format
        if (
          directOffset("Etc/GMT", ts) !== 0 ||
          directOffset("Etc/GMT+1", ts) !== -60 ||
          directOffset("Etc/GMT-1", ts) !== +60
        )
          throw new Error("Invalid offset");
        offsetFunc = directOffset;
      } catch (e) {
        offsetFunc = calculatedOffset;
      }
    }

    return offsetFunc(this.name, ts);
  }

  /** @override **/
  equals(otherZone) {
    return otherZone.type === "iana" && otherZone.name === this.name;
  }

  /** @override **/
  get isValid() {
    return this.valid;
  }
}
