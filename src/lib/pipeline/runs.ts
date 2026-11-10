import { localDate } from "../time";

/** Test runs are shared per (sector, city, question set) per calendar month in Toronto. */
export function currentRunLabel(d = new Date()): string {
  return localDate(d).slice(0, 7);
}
