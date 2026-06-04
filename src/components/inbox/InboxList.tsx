import type { InboxItem } from "@/types/kiki";
import { InboxCard } from "@/components/inbox/InboxCard";

export function InboxList({ items, variant = "active" }: { items: InboxItem[]; variant?: "active" | "snoozed" }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <InboxCard key={item.id} item={item} variant={variant} />
      ))}
    </div>
  );
}
