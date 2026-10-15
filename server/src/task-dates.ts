export type Period = "date" | "week" | "month";
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "1900-01-01" && value <= "9998-12-31" &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function localDate(timezone: string, timestamp = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
  return ["year", "month", "day"].map(key => parts.find(p => p.type === key)!.value).join("-");
}
export function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10);
}
export function periodStart(date: string, period: Period): string {
  if (period === "month") return `${date.slice(0, 7)}-01`;
  return period === "week" ? addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7)) : date;
}
export function periodEnd(date: string, period: Period): string {
  const start = periodStart(date, period);
  if (period === "week") return addDays(start, 6);
  if (period === "month") { const d = new Date(`${start}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return addDays(d.toISOString().slice(0, 10), -1); }
  return start;
}
export function overdueCount(planned: string, period: Period, today: string): number {
  const current = periodStart(today, period);
  if (planned >= current) return 0;
  if (period === "month") return (Number(current.slice(0, 4)) - Number(planned.slice(0, 4))) * 12 + Number(current.slice(5, 7)) - Number(planned.slice(5, 7));
  return Math.round((Date.parse(current) - Date.parse(planned)) / 86400000 / (period === "week" ? 7 : 1));
}
