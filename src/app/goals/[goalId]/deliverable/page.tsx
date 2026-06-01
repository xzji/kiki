import { permanentRedirect } from "next/navigation";

import { legacyGoalDeliverableRedirectPath, type RouteSearchParams } from "@/lib/routes";

export default function LegacyGoalDeliverablePage({
  params,
  searchParams,
}: {
  params: { goalId: string };
  searchParams?: RouteSearchParams;
}) {
  permanentRedirect(legacyGoalDeliverableRedirectPath(params.goalId, searchParams));
}
