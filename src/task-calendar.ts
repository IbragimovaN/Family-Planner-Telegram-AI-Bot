export type Period = "date" | "week" | "month";
export function compactDateLabel(date: string): string {
  const [year, month, day] = date.split("-");
  const weekday = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"][new Date(`${date}T12:00:00Z`).getUTCDay()];
  return `${day}.${month}.${year} ${weekday}`;
}
export function todayIn(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map(key => parts.find(p => p.type === key)!.value).join("-");
}
export function shiftDay(date: string, n: number): string { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); }
export function startOf(date: string, period: Period): string {
  if (period === "month") return date.slice(0,7) + "-01";
  return period === "week" ? shiftDay(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7)) : date;
}
export function movePeriod(date: string, period: Period, n: number): string {
  if (period !== "month") return shiftDay(date, n * (period === "week" ? 7 : 1));
  const d = new Date(`${startOf(date, "month")}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0,10);
}
export function daysOf(date: string, period: Period): string[] {
  const start = startOf(date, period);
  const count = period === "date" ? 1 : period === "week" ? 7 : new Date(`${movePeriod(date, "month", 1)}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime();
  return Array.from({ length: period === "month" ? count / 86400000 : count }, (_, i) => shiftDay(start,i));
}
export const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long", weekday: "short" });
