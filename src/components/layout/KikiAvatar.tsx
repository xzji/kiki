import { cn } from "@/lib/utils";

export function KikiAvatar({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const sizeClass = size === "sm" ? "h-7 w-7 text-xs" : size === "lg" ? "h-14 w-14 text-base" : "h-10 w-10 text-sm";
  return <div className={cn("flex items-center justify-center rounded-full border border-[#534f69]/25 bg-[#E9E6FF] text-[#5F5AA2]", sizeClass, className)}>K</div>;
}
