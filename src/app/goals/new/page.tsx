import { permanentRedirect } from "next/navigation";

export default function LegacyNewGoalPage({
  searchParams,
}: {
  searchParams?: { title?: string };
}) {
  const title = searchParams?.title?.trim();
  permanentRedirect(title ? `/topics/new?title=${encodeURIComponent(title)}` : "/topics/new");
}
