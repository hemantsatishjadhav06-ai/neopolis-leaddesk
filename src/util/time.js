// Time helpers (IST = UTC+5:30, no DST).
export const IST_OFFSET_MIN = 330;
export function istParts(d = new Date()) {
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return { hour: t.getUTCHours(), minute: t.getUTCMinutes(), day: t.getUTCDay(), date: t.toISOString().slice(0, 10) };
}
export function inSendWindow(startHour, endHour, d = new Date()) {
  const { hour } = istParts(d);
  return hour >= Number(startHour) && hour < Number(endHour);
}
export const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : Infinity);
export const minutesSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 6e4 : Infinity);
export function stampIst(d = new Date()) {
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return t.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
