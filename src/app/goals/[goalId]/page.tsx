import { permanentRedirect } from "next/navigation";

import { legacyGoalDetailRedirectPath, type RouteSearchParams } from "@/lib/routes";

export default function LegacyGoalDetailPage({
  params,
  searchParams,
}: {
  params: { goalId: string };
  searchParams?: RouteSearchParams;
}) {
  permanentRedirect(legacyGoalDetailRedirectPath(params.goalId, searchParams));
}
