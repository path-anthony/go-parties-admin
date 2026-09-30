// How a text will be counted by the carriers. Plain characters fit 160 to
// a message (153 each once it takes more than one); anything outside the
// standard GSM set (emoji, curly quotes, some accents) switches the whole
// text to a wider encoding, 70 and 67. Extension characters cost two.
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

export type SmsCount = { characters: number; segments: number; encoding: "GSM-7" | "Unicode"; perSegment: number };

export function countSms(text: string): SmsCount {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    const segments = units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153);
    return { characters: units, segments, encoding: "GSM-7", perSegment: units <= 160 ? 160 : 153 };
  }
  const chars = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const segments = chars === 0 ? 0 : chars <= 70 ? 1 : Math.ceil(chars / 67);
  return { characters: chars, segments, encoding: "Unicode", perSegment: chars <= 70 ? 70 : 67 };
}
