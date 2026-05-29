import type { ResultCell } from "@/types/taskResult";

export function cellText(cell: ResultCell) {
  if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return cell.text;
}

export function cellClassName(cell: ResultCell) {
  if (typeof cell !== "object" || cell === null || !("tone" in cell)) return "";
  if (cell.tone === "good") return "text-[#25663A]";
  if (cell.tone === "bad") return "text-[#B42318]";
  if (cell.tone === "warn") return "text-[#8A6D3B]";
  return "";
}
